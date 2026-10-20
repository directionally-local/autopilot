/**
 * #889 (hook failures are visible, failClosed) and #891 (PostToolUseFailure,
 * PermissionRequest), driven through real shells, real settings files, the
 * HooksManager and the ToolExecutor's permission path.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classifyHookFailure, parseHookDecision, runHooks, setSpawnHookImplForTesting } from "./runner.js";
import { HooksManager, formatHookFailureNotice, hookFailureEvent, type HookFailureNotice } from "./manager.js";
import { projectSettingsPath } from "./settings.js";
import type { HookConfig, HookPayload, KimiflareSettings } from "./types.js";
import { ToolExecutor, ALL_TOOLS, permissionFromHook, type PermissionAsker, type PermissionRequest } from "../tools/executor.js";
import { flushOtelSink, initOtelSink, resetOtelSinkForTesting, setFetchForTesting } from "../util/otel-sink.js";

const prePayload = (cwd: string): HookPayload => ({
  event: "PreToolUse",
  session_id: "sess_fail",
  cwd,
  tool: "write",
  tool_call_id: "call_1",
  args: { path: "a.txt", content: "x" },
});

let root: string;
let savedXdg: string | undefined;

before(() => {
  root = mkdtempSync(join(tmpdir(), "ap-hook-failures-"));
  savedXdg = process.env.XDG_CONFIG_HOME;
  // Keep the user's real global hooks out of these tests.
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
});

after(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => setSpawnHookImplForTesting(null));
afterEach(() => setSpawnHookImplForTesting(null));

let projectCounter = 0;
/** A fresh project dir whose settings file holds `hooks`. */
function project(hooks: KimiflareSettings["hooks"]): string {
  const cwd = join(root, `proj-${projectCounter++}`);
  mkdirSync(cwd, { recursive: true });
  const path = projectSettingsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ hooks }), "utf8");
  return cwd;
}

describe("hook failures fail open, and are reported (#889)", () => {
  it("a hook that times out is a `timeout` failure and the call is allowed", async () => {
    const cwd = project({});
    const hook: HookConfig = { id: "slow", command: "sleep 5", timeoutMs: 150 };
    const out = await runHooks("PreToolUse", [hook], prePayload(cwd), "write");
    assert.strictEqual(out.vetoed, false);
    assert.strictEqual(out.failures.length, 1);
    const f = out.failures[0]!;
    assert.deepStrictEqual(
      { hookId: f.hookId, event: f.event, kind: f.kind, allowed: f.allowed, failClosed: f.failClosed },
      { hookId: "slow", event: "PreToolUse", kind: "timeout", allowed: true, failClosed: false },
    );
    assert.match(f.reason, /timed out after 150 ms/);
  });

  it("a non-zero exit (other than 2) is a `nonzero_exit` failure with stderr in the reason", async () => {
    const cwd = project({});
    const out = await runHooks("PreToolUse", [{ id: "crash", command: "echo kaboom >&2; exit 1" }], prePayload(cwd), "write");
    assert.strictEqual(out.vetoed, false);
    assert.strictEqual(out.failures[0]!.kind, "nonzero_exit");
    assert.strictEqual(out.failures[0]!.reason, "exited 1: kaboom");
  });

  it("a missing binary is a `command_not_found` failure", async () => {
    const cwd = project({});
    const out = await runHooks("PreToolUse", [{ id: "gone", command: "ap-no-such-binary-889 --check" }], prePayload(cwd), "write");
    assert.strictEqual(out.vetoed, false);
    assert.strictEqual(out.failures[0]!.kind, "command_not_found");
    assert.match(out.failures[0]!.reason, /^command not found \(exit 127\)/);
  });

  it("a spawn error is a `spawn_failed` failure", async () => {
    setSpawnHookImplForTesting(async () => ({ exitCode: null, stdout: "", stderr: "spawn failed: E2BIG", timedOut: false }));
    const out = await runHooks("PreToolUse", [{ id: "big", command: "x" }], prePayload("/tmp"), "write");
    assert.strictEqual(out.vetoed, false);
    assert.strictEqual(out.failures[0]!.kind, "spawn_failed");
    assert.match(out.failures[0]!.reason, /E2BIG/);
  });

  it("exit 0 and exit 2 are answers, not failures", async () => {
    const cwd = project({});
    const ok = await runHooks("PreToolUse", [{ id: "ok", command: "exit 0" }], prePayload(cwd), "write");
    assert.deepStrictEqual(ok.failures, []);
    const blocked = await runHooks("PreToolUse", [{ id: "no", command: "echo nope >&2; exit 2" }], prePayload(cwd), "write");
    assert.strictEqual(blocked.vetoed, true);
    assert.deepStrictEqual(blocked.failures, []);
    assert.strictEqual(classifyHookFailure({ id: "x", exitCode: 2, stdout: "", stderr: "", timedOut: false, durationMs: 1 }, { command: "x" }), null);
  });

  it("failClosed: a crashing hook blocks, and the reason names the hook and the failure", async () => {
    const cwd = project({});
    const out = await runHooks(
      "PreToolUse",
      [{ id: "policy", command: "echo segfault >&2; exit 139", failClosed: true }, { id: "after", command: "exit 0" }],
      prePayload(cwd),
      "write",
    );
    assert.strictEqual(out.vetoed, true);
    assert.match(out.vetoReason, /^hook policy failed \(exited 139: segfault\) and is set to failClosed/);
    assert.strictEqual(out.failures[0]!.allowed, false);
    assert.strictEqual(out.failures[0]!.failClosed, true);
    assert.strictEqual(out.outcomes.length, 1, "later hooks don't run after a block");
  });

  it("failClosed: a timeout and a missing binary block too", async () => {
    const cwd = project({});
    const t = await runHooks("UserPromptSubmit", [{ id: "slow", command: "sleep 5", timeoutMs: 150, failClosed: true }], { event: "UserPromptSubmit", session_id: null, cwd, prompt: "hi" });
    assert.strictEqual(t.vetoed, true);
    assert.match(t.vetoReason, /timed out/);
    const m = await runHooks("PreToolUse", [{ id: "gone", command: "ap-no-such-binary-889", failClosed: true }], prePayload(cwd), "write");
    assert.strictEqual(m.vetoed, true);
    assert.match(m.vetoReason, /command not found/);
  });

  it("failClosed has no effect on informational events", async () => {
    const out = await runHooks("Stop", [{ id: "s", command: "exit 1", failClosed: true }], { event: "Stop", session_id: null, cwd: root });
    assert.strictEqual(out.vetoed, false);
    assert.strictEqual(out.failures[0]!.allowed, true);
    assert.strictEqual(out.failures[0]!.failClosed, false);
  });

  it("the settings loader keeps failClosed: true and drops anything else", () => {
    const cwd = project({
      PreToolUse: [
        { id: "a", command: "true", failClosed: true },
        { id: "b", command: "true", failClosed: "yes" as never },
        { id: "c", command: "true" },
      ],
    });
    const hooks = new HooksManager(cwd).hooksFor("PreToolUse");
    assert.deepStrictEqual(hooks.map((h) => [h.id, h.failClosed]), [["a", true], ["b", undefined], ["c", undefined]]);
  });

  it("HooksManager tells listeners about every failure, flagging only the first per hook", async () => {
    const cwd = project({
      PreToolUse: [
        { id: "flaky", command: "exit 1" },
        { id: "gone", command: "ap-no-such-binary-889" },
      ],
    });
    const hooks = new HooksManager(cwd);
    const seen: HookFailureNotice[] = [];
    const off = hooks.onFailure((n) => seen.push(n));
    for (let i = 0; i < 3; i++) await hooks.fire("PreToolUse", prePayload(cwd), "write");
    assert.deepStrictEqual(
      seen.map((n) => [n.hookId, n.count, n.firstInSession]),
      [
        ["flaky", 1, true],
        ["gone", 1, true],
        ["flaky", 2, false],
        ["gone", 2, false],
        ["flaky", 3, false],
        ["gone", 3, false],
      ],
    );
    assert.strictEqual(hooks.failureCount("flaky"), 3);
    hooks.resetFailureCounts();
    assert.strictEqual(hooks.failureCount("flaky"), 0);
    off();
    await hooks.fire("PreToolUse", prePayload(cwd), "write");
    assert.strictEqual(seen.length, 6, "unsubscribed listeners hear nothing");
  });

  it("a listener that throws doesn't break the hook path", async () => {
    const cwd = project({ PreToolUse: [{ id: "flaky", command: "exit 1" }] });
    const hooks = new HooksManager(cwd);
    hooks.onFailure(() => {
      throw new Error("ui exploded");
    });
    const out = await hooks.fire("PreToolUse", prePayload(cwd), "write");
    assert.strictEqual(out.vetoed, false);
  });

  it("the notice names the hook, the event, the reason and the outcome", () => {
    const base = { hookId: "policy", event: "PreToolUse" as const, kind: "timeout" as const, reason: "timed out after 30000 ms", count: 1, firstInSession: true };
    assert.strictEqual(
      formatHookFailureNotice({ ...base, allowed: true, failClosed: false }),
      "hook policy (PreToolUse) failed: timed out after 30000 ms; Autopilot allowed it anyway (fail-open). Further failures of this hook this session are counted, not shown.",
    );
    assert.match(formatHookFailureNotice({ ...base, allowed: false, failClosed: true }), /blocked it \(failClosed\)/);
    assert.match(formatHookFailureNotice({ ...base, event: "PermissionRequest", allowed: true, failClosed: false }), /normal permission prompt/);
    assert.match(formatHookFailureNotice({ ...base, event: "Stop", allowed: true, failClosed: false }), /carried on/);
    assert.deepStrictEqual(
      Object.keys(hookFailureEvent({ ...base, allowed: true, failClosed: false })),
      ["hook_id", "hook_event", "failure", "reason", "allowed", "fail_closed", "count", "message"],
    );
  });

  it("emits autopilot.hook.failed at WARN for every failure", async () => {
    const bodies: unknown[] = [];
    resetOtelSinkForTesting();
    setFetchForTesting(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("ok", { status: 200 });
    });
    try {
      initOtelSink({ endpoint: "http://127.0.0.1:1" });
      const cwd = project({ PreToolUse: [{ id: "flaky", command: "exit 1" }] });
      const hooks = new HooksManager(cwd);
      await hooks.fire("PreToolUse", prePayload(cwd), "write");
      await hooks.fire("PreToolUse", prePayload(cwd), "write");
      await flushOtelSink();
      const records = (bodies as Array<{ resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }> }> }>)
        .flatMap((b) => b.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)));
      const hookEvents = records.filter((r) => JSON.stringify(r).includes("autopilot.hook.failed"));
      assert.strictEqual(hookEvents.length, 2);
      const first = hookEvents[0]!;
      assert.strictEqual(first.severityText, "WARN");
      const attrs = Object.fromEntries(
        (first.attributes as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [a.key, Object.values(a.value)[0]]),
      );
      assert.strictEqual(attrs["hook.id"], "flaky");
      assert.strictEqual(attrs["hook.event"], "PreToolUse");
      assert.strictEqual(attrs["hook.failure"], "nonzero_exit");
      assert.strictEqual(attrs["hook.allowed"], true);
      assert.strictEqual(attrs["session.id"], "sess_fail");
    } finally {
      resetOtelSinkForTesting();
      setFetchForTesting(null);
    }
  });
});

describe("PermissionRequest and PostToolUseFailure (#891)", () => {
  const writeTool = ALL_TOOLS.filter((t) => t.name === "write");

  /** A host asker: PermissionRequest hooks first, then the "prompt". */
  function asker(mode: string, prompts: PermissionRequest[]): PermissionAsker {
    return async (req) => {
      const fromHook = await permissionFromHook(req, mode);
      if (fromHook) return fromHook;
      prompts.push(req);
      return { decision: "allow", scope: "once" };
    };
  }

  it("a deny (exit 2) answers the prompt: the user isn't asked and the model hears why", async () => {
    const cwd = project({
      PermissionRequest: [{ id: "guard", matcher: "^write$", command: "echo 'no writes to a.txt' >&2; exit 2" }],
    });
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    const prompts: PermissionRequest[] = [];
    const res = await exec.run({ id: "w1", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", prompts), { cwd });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "policy_rejection");
    assert.match(res.content, /PermissionRequest hook: no writes to a\.txt/);
  });

  it("a JSON deny works, including Claude Code's decision.behavior form", async () => {
    for (const out of [
      `{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy says no"}}`,
      `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"policy says no"}}}`,
    ]) {
      const cwd = project({ PermissionRequest: [{ id: "guard", command: `echo '${out}'` }] });
      const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
      const prompts: PermissionRequest[] = [];
      const res = await exec.run({ id: "w2", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", prompts), { cwd });
      assert.strictEqual(prompts.length, 0);
      assert.strictEqual(res.errorCode, "policy_rejection");
      assert.match(res.content, /policy says no/);
    }
  });

  it("an allow skips the prompt and the call runs", async () => {
    const cwd = project({ PermissionRequest: [{ id: "ok", command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] });
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    const prompts: PermissionRequest[] = [];
    const res = await exec.run({ id: "w3", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", prompts), { cwd });
    assert.strictEqual(prompts.length, 0);
    assert.strictEqual(res.ok, true, res.content);
  });

  it("an allow never overrides plan mode: the prompt still shows", async () => {
    const cwd = project({ PermissionRequest: [{ id: "ok", command: `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] });
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    const prompts: PermissionRequest[] = [];
    await exec.run({ id: "w4", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("plan", prompts), { cwd });
    assert.strictEqual(prompts.length, 1);
  });

  it("ask, no output, or a failing hook shows the normal prompt; failClosed denies", async () => {
    for (const command of [`echo '{"hookSpecificOutput":{"permissionDecision":"ask"}}'`, "true", "exit 1"]) {
      const cwd = project({ PermissionRequest: [{ id: "h", command }] });
      const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
      const prompts: PermissionRequest[] = [];
      await exec.run({ id: "w5", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", prompts), { cwd });
      assert.strictEqual(prompts.length, 1, command);
    }
    const cwd = project({ PermissionRequest: [{ id: "h", command: "exit 1", failClosed: true }] });
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    const prompts: PermissionRequest[] = [];
    const res = await exec.run({ id: "w6", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", prompts), { cwd });
    assert.strictEqual(prompts.length, 0);
    assert.match(res.content, /hook h failed \(exited 1\) and is set to failClosed/);
  });

  it("the hook gets the tool, input, call id and mode, in Autopilot's and Claude Code's names", async () => {
    const out = join(root, "perm-payload.json");
    const cwd = project({ PermissionRequest: [{ id: "spy", command: `cat > '${out}'; echo "$KIMIFLARE_HOOK_MODE" > '${out}.mode'` }] });
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    await exec.run({ id: "w7", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, asker("edit", []), { cwd, sessionId: "s1" });
    const { readFileSync } = await import("node:fs");
    const p = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    assert.strictEqual(p.hook_event_name, "PermissionRequest");
    assert.strictEqual(p.tool, "write");
    assert.strictEqual(p.tool_name, "Write");
    assert.deepStrictEqual(p.tool_input, { file_path: join(cwd, "a.txt"), content: "x" });
    assert.strictEqual(p.tool_use_id, "w7");
    assert.strictEqual(p.mode, "edit");
    assert.strictEqual(p.permission_mode, "default");
    assert.strictEqual(readFileSync(`${out}.mode`, "utf8").trim(), "edit");
  });

  it("no PermissionRequest hooks: no firePermissionHook on the request", async () => {
    const cwd = project({});
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    let seen: PermissionRequest | undefined;
    await exec.run({ id: "w8", name: "write", arguments: JSON.stringify({ path: "a.txt", content: "x" }) }, async (req) => {
      seen = req;
      return "deny";
    }, { cwd });
    assert.strictEqual(seen?.firePermissionHook, undefined);
  });

  it("PostToolUseFailure fires on a failing write with error and tool_use_id; PostToolUse still fires", async () => {
    const failOut = join(root, "failure-payload.json");
    const postOut = join(root, "post-payload.json");
    const cwd = project({
      // Write then rename, so the file only appears once it is complete.
      PostToolUse: [{ id: "post", command: `cat > '${postOut}.tmp' && mv '${postOut}.tmp' '${postOut}'` }],
      PostToolUseFailure: [{ id: "fail", matcher: "^write$", command: `cat > '${failOut}.tmp' && mv '${failOut}.tmp' '${failOut}'` }],
    });
    // Writing to a path whose parent is a regular file fails.
    writeFileSync(join(cwd, "blocker"), "file");
    const exec = new ToolExecutor(writeTool, { hooks: new HooksManager(cwd) });
    const res = await exec.run(
      { id: "w9", name: "write", arguments: JSON.stringify({ path: "blocker/child.txt", content: "x" }) },
      async () => "allow",
      { cwd },
    );
    assert.strictEqual(res.ok, false);
    const { existsSync, readFileSync } = await import("node:fs");
    // The hooks are fire-and-forget; wait for both files.
    for (let i = 0; i < 100 && !(existsSync(failOut) && existsSync(postOut)); i++) await new Promise((r) => setTimeout(r, 20));
    const p = JSON.parse(readFileSync(failOut, "utf8")) as Record<string, unknown>;
    assert.strictEqual(p.hook_event_name, "PostToolUseFailure");
    assert.strictEqual(p.tool_use_id, "w9");
    assert.strictEqual(p.tool, "write");
    assert.strictEqual(p.tool_name, "write", "a failed write keeps its own name (see docs/beacon.md)");
    assert.deepStrictEqual(p.tool_input, { file_path: join(cwd, "blocker/child.txt"), content: "x" });
    assert.match(String(p.error), /Error running write/);
    assert.strictEqual(p.is_interrupt, false);
    assert.strictEqual((JSON.parse(readFileSync(postOut, "utf8")) as Record<string, unknown>).hook_event_name, "PostToolUse");
  });

  it("PostToolUseFailure doesn't fire for a successful call, and does for a non-zero bash exit", async () => {
    const events: string[] = [];
    const fake = {
      hasEnabledHooks: () => true,
      fire: async (event: string) => {
        events.push(event);
        return { outcomes: [], vetoed: false, vetoReason: "", failures: [] };
      },
    };
    const bash = ALL_TOOLS.filter((t) => t.name === "bash");
    const exec = new ToolExecutor(bash, { hooks: fake as never });
    const cwd = project({});
    await exec.run({ id: "b1", name: "bash", arguments: JSON.stringify({ command: "true" }) }, async () => "allow", { cwd });
    assert.deepStrictEqual(events, ["PreToolUse", "PostToolUse"]);
    events.length = 0;
    await exec.run({ id: "b2", name: "bash", arguments: JSON.stringify({ command: "exit 3" }) }, async () => "allow", { cwd });
    assert.deepStrictEqual(events, ["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
  });

  it("parseHookDecision reads the decision.behavior form", () => {
    assert.deepStrictEqual(parseHookDecision(`{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}`), { decision: "allow" });
    assert.deepStrictEqual(parseHookDecision(`{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"m"}}}`), { decision: "deny", reason: "m" });
    assert.strictEqual(parseHookDecision(`{"hookSpecificOutput":{"decision":{"behavior":"maybe"}}}`), null);
  });
});

describe("failure tracking and the new events with Claude-style matchers (#896 + #889/#891)", () => {
  it("a failing hook matched by its Claude name is reported, and failClosed blocks", async () => {
    const cwd = project({
      PreToolUse: [
        { id: "claude-name", matcher: "Write", command: "exit 1" },
        { id: "policy", matcher: "Bash|Write", command: "ap-no-such-binary-889", failClosed: true },
      ],
    });
    const hooks = new HooksManager(cwd);
    const seen: HookFailureNotice[] = [];
    hooks.onFailure((n) => seen.push(n));
    const out = await hooks.fire("PreToolUse", prePayload(cwd), "write");
    assert.strictEqual(out.vetoed, true);
    assert.match(out.vetoReason, /^hook policy failed \(command not found/);
    assert.deepStrictEqual(seen.map((n) => [n.hookId, n.kind, n.allowed]), [
      ["claude-name", "nonzero_exit", true],
      ["policy", "command_not_found", false],
    ]);
    assert.strictEqual(hooks.failureCount("policy"), 1);
  });

  it("PermissionRequest and PostToolUseFailure hooks match Claude names, MultiEdit included", async () => {
    const cwd = project({
      PermissionRequest: [{ id: "deny-bash", matcher: "^Bash$", command: "echo no >&2; exit 2" }],
      PostToolUseFailure: [{ id: "multi", matcher: "^MultiEdit$", command: "exit 1" }],
    });
    const hooks = new HooksManager(cwd);
    const seen: HookFailureNotice[] = [];
    hooks.onFailure((n) => seen.push(n));
    const perm = await hooks.fire(
      "PermissionRequest",
      { event: "PermissionRequest", session_id: null, cwd, tool: "bash", args: { command: "ls" }, mode: "edit" },
      "bash",
    );
    assert.strictEqual(perm.vetoed, true);
    const notBash = await hooks.fire(
      "PermissionRequest",
      { event: "PermissionRequest", session_id: null, cwd, tool: "write", args: { path: "a" }, mode: "edit" },
      "write",
    );
    assert.strictEqual(notBash.vetoed, false);
    assert.strictEqual(notBash.outcomes.length, 0);
    const failure = (args: Record<string, unknown>): HookPayload => ({
      event: "PostToolUseFailure",
      session_id: null,
      cwd,
      tool: "edit",
      args,
      error: "boom",
      result: { ok: false, content: "boom" },
    });
    await hooks.fire("PostToolUseFailure", failure({ path: "a", old_string: "x", new_string: "y" }), "edit");
    assert.strictEqual(seen.length, 0, "a single edit isn't MultiEdit");
    await hooks.fire("PostToolUseFailure", failure({ path: "a", edits: [] }), "edit");
    assert.deepStrictEqual(seen.map((n) => [n.hookId, n.event]), [["multi", "PostToolUseFailure"]]);
  });
});
