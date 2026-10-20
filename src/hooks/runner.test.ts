import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterHooks,
  parseHookDecision,
  runHooks,
  setSpawnHookImplForTesting,
  HOOK_ENV_PAYLOAD_MAX_BYTES,
  type SpawnHookImpl,
} from "./runner.js";
import type { HookConfig, HookPayload } from "./types.js";

const samplePayload: HookPayload = {
  event: "PreToolUse",
  session_id: "sess_abc",
  cwd: "/tmp/proj",
  tool: "edit",
  args: { path: "/tmp/proj/foo.ts" },
};

beforeEach(() => {
  setSpawnHookImplForTesting(null);
});

afterEach(() => {
  setSpawnHookImplForTesting(null);
});

function mockSpawn(behavior: {
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  capture?: (args: { command: string; payload: string; env: NodeJS.ProcessEnv }) => void;
}): void {
  const impl: SpawnHookImpl = async (command, payloadJson, env) => {
    behavior.capture?.({ command, payload: payloadJson, env });
    return {
      exitCode: behavior.exitCode ?? 0,
      stdout: behavior.stdout ?? "",
      stderr: behavior.stderr ?? "",
      timedOut: behavior.timedOut ?? false,
    };
  };
  setSpawnHookImplForTesting(impl);
}

describe("filterHooks", () => {
  it("returns [] for undefined or empty", () => {
    assert.deepStrictEqual(filterHooks(undefined, "x"), []);
    assert.deepStrictEqual(filterHooks([], "x"), []);
  });

  it("drops disabled hooks", () => {
    const a: HookConfig = { id: "a", command: "echo a", enabled: false };
    const b: HookConfig = { id: "b", command: "echo b", enabled: true };
    assert.deepStrictEqual(filterHooks([a, b], null), [b]);
  });

  it("keeps a hook with no matcher regardless of tool name", () => {
    const h: HookConfig = { id: "x", command: "x" };
    assert.strictEqual(filterHooks([h], "anything").length, 1);
    assert.strictEqual(filterHooks([h], null).length, 1);
  });

  it("filters by matcher regex when tool name is provided", () => {
    const editOnly: HookConfig = { id: "edit", command: "x", matcher: "^edit$" };
    const writeOrEdit: HookConfig = { id: "ew", command: "y", matcher: "^(edit|write)$" };
    const hooks = [editOnly, writeOrEdit];
    assert.deepStrictEqual(filterHooks(hooks, "edit").map((h) => h.id), ["edit", "ew"]);
    assert.deepStrictEqual(filterHooks(hooks, "write").map((h) => h.id), ["ew"]);
    assert.deepStrictEqual(filterHooks(hooks, "bash"), []);
  });

  it("treats a malformed regex as matching nothing rather than throwing", () => {
    const h: HookConfig = { id: "bad", command: "x", matcher: "([" };
    assert.deepStrictEqual(filterHooks([h], "edit"), []);
  });
});

describe("runHooks — informational events (Stop, PostToolUse)", () => {
  it("runs every matching hook, ignores exit codes for non-veto events", async () => {
    let calls = 0;
    mockSpawn({
      exitCode: 1, // would veto if this were a veto event
      capture: () => {
        calls += 1;
      },
    });
    const hooks: HookConfig[] = [
      { id: "h1", command: "echo 1" },
      { id: "h2", command: "echo 2" },
    ];
    const outcome = await runHooks(
      "Stop",
      hooks,
      { event: "Stop", session_id: "s", cwd: "/tmp" },
      null,
    );
    assert.strictEqual(calls, 2);
    assert.strictEqual(outcome.vetoed, false);
  });

  it("captures stdout (trimmed)", async () => {
    mockSpawn({ stdout: "  hello world  \n" });
    const outcome = await runHooks(
      "Stop",
      [{ id: "h", command: "echo" }],
      { event: "Stop", session_id: "s", cwd: "/tmp" },
    );
    assert.strictEqual(outcome.outcomes[0]!.stdout, "hello world");
  });
});

describe("runHooks — blocking events (PreToolUse, UserPromptSubmit)", () => {
  it("exit 2 blocks a PreToolUse with stderr as the reason, and stops further hooks", async () => {
    let callCount = 0;
    setSpawnHookImplForTesting(async () => {
      callCount += 1;
      return callCount === 1
        ? { exitCode: 2, stdout: "ignored stdout", stderr: "no thanks", timedOut: false }
        : { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    });
    const hooks: HookConfig[] = [
      { id: "deny", command: "exit 2" },
      { id: "after", command: "echo never" },
    ];
    const outcome = await runHooks("PreToolUse", hooks, samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.vetoReason, "no thanks");
    assert.strictEqual(callCount, 1, "second hook must not run after a block");
  });

  it("exit 2 falls back to stdout, then a synthetic message", async () => {
    mockSpawn({ exitCode: 2, stdout: "from stdout", stderr: "" });
    let outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoReason, "from stdout");
    mockSpawn({ exitCode: 2, stdout: "", stderr: "" });
    outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, true);
    assert.match(outcome.vetoReason, /hook x exited 2/);
  });

  it("exit 2 blocks UserPromptSubmit too", async () => {
    mockSpawn({ exitCode: 2, stderr: "no passwords" });
    const outcome = await runHooks(
      "UserPromptSubmit",
      [{ id: "x", command: "x" }],
      { event: "UserPromptSubmit", session_id: "s", cwd: "/tmp", prompt: "hi" },
    );
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.vetoReason, "no passwords");
  });

  for (const [label, behavior] of [
    ["exit 1 (crashing hook)", { exitCode: 1, stdout: "boom", stderr: "panic" }],
    ["exit 127 (command not found)", { exitCode: 127, stderr: "sh: nope: command not found" }],
    ["a timeout", { exitCode: null, timedOut: true }],
    ["a spawn error", { exitCode: null, stderr: "spawn failed: EACCES" }],
  ] as const) {
    it(`${label} fails open: allows and keeps running later hooks`, async () => {
      let calls = 0;
      mockSpawn({ ...behavior, capture: () => void (calls += 1) });
      const outcome = await runHooks(
        "PreToolUse",
        [
          { id: "a", command: "x" },
          { id: "b", command: "y" },
        ],
        samplePayload,
        "edit",
      );
      assert.strictEqual(outcome.vetoed, false);
      assert.strictEqual(outcome.vetoReason, "");
      assert.strictEqual(calls, 2);
    });
  }

  it("a thrown spawn implementation fails open", async () => {
    setSpawnHookImplForTesting(async () => {
      throw new Error("E2BIG");
    });
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, false);
  });

  it("an aborted turn blocks", async () => {
    const ac = new AbortController();
    setSpawnHookImplForTesting(async () => {
      ac.abort();
      return { exitCode: null, stdout: "", stderr: "", timedOut: true };
    });
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit", ac.signal);
    assert.strictEqual(outcome.vetoed, true);
    assert.match(outcome.vetoReason, /aborted/);
  });

  it("zero exit with plain stdout allows the call (no decision)", async () => {
    mockSpawn({ exitCode: 0, stdout: "ok" });
    const outcome = await runHooks("PreToolUse", [{ id: "ok", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, false);
    assert.strictEqual(outcome.permissionDecision, undefined);
  });
});

describe("runHooks — JSON decisions on stdout", () => {
  const json = (decision: string, reason?: string) =>
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        ...(reason ? { permissionDecisionReason: reason } : {}),
      },
    });

  it("deny blocks with permissionDecisionReason", async () => {
    mockSpawn({ exitCode: 0, stdout: json("deny", "policy: no writes to prod") });
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.vetoReason, "policy: no writes to prod");
    assert.strictEqual(outcome.permissionDecision, "deny");
  });

  it("deny without a reason still blocks", async () => {
    mockSpawn({ exitCode: 0, stdout: json("deny") });
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, true);
    assert.match(outcome.vetoReason, /hook x denied/);
  });

  it("ask is reported (not a block); allow is reported", async () => {
    mockSpawn({ exitCode: 0, stdout: json("ask", "confirm this") });
    let outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, false);
    assert.strictEqual(outcome.permissionDecision, "ask");
    assert.strictEqual(outcome.permissionDecisionReason, "confirm this");
    mockSpawn({ exitCode: 0, stdout: json("allow") });
    outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, false);
    assert.strictEqual(outcome.permissionDecision, "allow");
  });

  it("precedence across hooks: deny > ask > allow", async () => {
    const queue = [json("allow"), json("ask", "why"), json("allow")];
    setSpawnHookImplForTesting(async () => ({ exitCode: 0, stdout: queue.shift() ?? "", stderr: "", timedOut: false }));
    const hooks: HookConfig[] = [{ id: "a", command: "a" }, { id: "b", command: "b" }, { id: "c", command: "c" }];
    let outcome = await runHooks("PreToolUse", hooks, samplePayload, "edit");
    assert.strictEqual(outcome.permissionDecision, "ask");
    assert.strictEqual(outcome.permissionDecisionReason, "why");

    const queue2 = [json("ask"), json("deny", "nope")];
    setSpawnHookImplForTesting(async () => ({ exitCode: 0, stdout: queue2.shift() ?? "", stderr: "", timedOut: false }));
    outcome = await runHooks("PreToolUse", hooks.slice(0, 2), samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.permissionDecision, "deny");
  });

  it("ignores a JSON decision on a non-zero exit (only exit 0 stdout is parsed)", async () => {
    mockSpawn({ exitCode: 1, stdout: json("deny", "would block") });
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(outcome.vetoed, false);
  });

  it("legacy {decision: block} blocks UserPromptSubmit", async () => {
    mockSpawn({ exitCode: 0, stdout: JSON.stringify({ decision: "block", reason: "nope" }) });
    const outcome = await runHooks(
      "UserPromptSubmit",
      [{ id: "x", command: "x" }],
      { event: "UserPromptSubmit", session_id: "s", cwd: "/tmp", prompt: "hi" },
    );
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.vetoReason, "nope");
  });

  it("decisions on informational events are ignored", async () => {
    mockSpawn({ exitCode: 0, stdout: json("deny", "x") });
    const outcome = await runHooks("Stop", [{ id: "x", command: "x" }], { event: "Stop", session_id: "s", cwd: "/tmp" });
    assert.strictEqual(outcome.vetoed, false);
  });
});

describe("parseHookDecision", () => {
  it("returns null for non-JSON, unrelated JSON, and unknown decisions", () => {
    assert.strictEqual(parseHookDecision("all good"), null);
    assert.strictEqual(parseHookDecision("{not json"), null);
    assert.strictEqual(parseHookDecision("[1,2]"), null);
    assert.strictEqual(parseHookDecision(JSON.stringify({ ok: true })), null);
    assert.strictEqual(
      parseHookDecision(JSON.stringify({ hookSpecificOutput: { permissionDecision: "maybe" } })),
      null,
    );
  });

  it("parses hookSpecificOutput and the legacy form", () => {
    assert.deepStrictEqual(
      parseHookDecision(
        JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "r" } }),
      ),
      { decision: "deny", reason: "r" },
    );
    assert.deepStrictEqual(parseHookDecision(JSON.stringify({ decision: "approve" })), { decision: "allow" });
    assert.deepStrictEqual(parseHookDecision(JSON.stringify({ decision: "block", reason: "x" })), {
      decision: "deny",
      reason: "x",
    });
  });
});

describe("runHooks — real shell processes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hooks-real-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers a >1 MB payload on stdin and omits the env copy (no E2BIG)", async () => {
    // 1.2 MB of tool input: over Linux's 128 KiB per-variable limit and
    // macOS's ~1 MiB ARG_MAX, so duplicating it into the env used to fail
    // the spawn on both.
    const big = "x".repeat(1_200_000);
    const payload: HookPayload = { ...samplePayload, cwd: dir, args: { path: "big.txt", content: big } };
    const out = join(dir, "out");
    const outcome = await runHooks(
      "PreToolUse",
      [
        {
          id: "reader",
          command: `wc -c > "${out}"; printf '%s' "\${KIMIFLARE_HOOK_PAYLOAD_OMITTED:-no}|\${#KIMIFLARE_HOOK_PAYLOAD}" > "${out}.env"`,
        },
      ],
      payload,
      "write",
    );
    assert.strictEqual(outcome.outcomes[0]!.exitCode, 0, outcome.outcomes[0]!.stderr);
    assert.ok(Number(readFileSync(out, "utf8").trim()) > big.length, "full payload arrives on stdin");
    assert.strictEqual(readFileSync(`${out}.env`, "utf8"), "1|0");
    assert.strictEqual(outcome.vetoed, false);
  });

  it("a hook that never reads stdin still exits cleanly with a big payload (no EPIPE crash)", async () => {
    const payload: HookPayload = { ...samplePayload, cwd: dir, args: { content: "y".repeat(600_000) } };
    const outcome = await runHooks("PreToolUse", [{ id: "x", command: "echo 'nope' >&2; exit 2" }], payload, "write");
    assert.strictEqual(outcome.vetoed, true);
    assert.strictEqual(outcome.vetoReason, "nope");
  });

  it("small payloads are still in KIMIFLARE_HOOK_PAYLOAD", async () => {
    const out = join(dir, "env.json");
    await runHooks(
      "PreToolUse",
      [{ id: "x", command: `printf '%s' "$KIMIFLARE_HOOK_PAYLOAD" > "${out}"` }],
      { ...samplePayload, cwd: dir },
      "edit",
    );
    const parsed = JSON.parse(readFileSync(out, "utf8")) as { tool_name: string; autopilot_tool_name: string };
    assert.strictEqual(parsed.tool_name, "Edit");
    assert.strictEqual(parsed.autopilot_tool_name, "edit");
    assert.ok(HOOK_ENV_PAYLOAD_MAX_BYTES <= 64 * 1024);
  });

  it("missing command (127) and exit 1 allow; exit 2 and a deny JSON block", async () => {
    const script = join(dir, "deny.sh");
    writeFileSync(
      script,
      `#!/bin/sh\ncat >/dev/null\necho '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy says no"}}'\n`,
    );
    chmodSync(script, 0o755);
    const run = (command: string) =>
      runHooks("PreToolUse", [{ id: "h", command }], { ...samplePayload, cwd: dir }, "edit");
    const missing = await run(join(dir, "does-not-exist.sh"));
    assert.strictEqual(missing.outcomes[0]!.exitCode, 127);
    assert.strictEqual(missing.vetoed, false);
    assert.strictEqual((await run("exit 1")).vetoed, false);
    const two = await run("echo 'blocked by policy' >&2; exit 2");
    assert.deepStrictEqual([two.vetoed, two.vetoReason], [true, "blocked by policy"]);
    const deny = await run(script);
    assert.deepStrictEqual([deny.vetoed, deny.vetoReason], [true, "policy says no"]);
  });
});

describe("runHooks — env var exposure", () => {
  it("exposes KIMIFLARE_HOOK_PATH for tool-args.path", async () => {
    let env: NodeJS.ProcessEnv = {};
    mockSpawn({
      capture: (args) => {
        env = args.env;
      },
    });
    await runHooks("PreToolUse", [{ id: "x", command: "x" }], samplePayload, "edit");
    assert.strictEqual(env.KIMIFLARE_HOOK_PATH, "/tmp/proj/foo.ts");
    assert.strictEqual(env.KIMIFLARE_HOOK_TOOL, "edit");
    assert.strictEqual(env.KIMIFLARE_HOOK_EVENT, "PreToolUse");
    assert.strictEqual(env.KIMIFLARE_HOOK_SESSION_ID, "sess_abc");
    assert.ok(env.KIMIFLARE_HOOK_PAYLOAD, "full JSON payload should be in env");
    assert.strictEqual(env.KIMIFLARE_HOOK_PAYLOAD_OMITTED, undefined);
  });

  it("omits KIMIFLARE_HOOK_PAYLOAD above the cap and sets a marker; stdin keeps the full payload", async () => {
    let env: NodeJS.ProcessEnv = {};
    let stdin = "";
    mockSpawn({
      capture: (args) => {
        env = args.env;
        stdin = args.payload;
      },
    });
    const payload: HookPayload = { ...samplePayload, args: { path: "/tmp/x", content: "z".repeat(250_000) } };
    await runHooks("PreToolUse", [{ id: "x", command: "x" }], payload, "write");
    assert.strictEqual(env.KIMIFLARE_HOOK_PAYLOAD, undefined);
    assert.strictEqual(env.KIMIFLARE_HOOK_PAYLOAD_OMITTED, "1");
    assert.strictEqual(Number(env.KIMIFLARE_HOOK_PAYLOAD_BYTES), Buffer.byteLength(stdin));
    assert.strictEqual(env.KIMIFLARE_HOOK_PATH, "/tmp/x", "small per-field vars still set");
    assert.ok(stdin.length > 250_000);
  });

  it("exposes KIMIFLARE_HOOK_RESULT_OK on PostToolUse", async () => {
    let env: NodeJS.ProcessEnv = {};
    mockSpawn({
      capture: (args) => {
        env = args.env;
      },
    });
    const payload: HookPayload = {
      event: "PostToolUse",
      session_id: "s",
      cwd: "/tmp",
      tool: "edit",
      args: { path: "/tmp/x.ts" },
      result: { ok: false, content: "boom", errorCode: "unknown" },
    };
    await runHooks("PostToolUse", [{ id: "x", command: "x" }], payload, "edit");
    assert.strictEqual(env.KIMIFLARE_HOOK_RESULT_OK, "false");
    assert.strictEqual(env.KIMIFLARE_HOOK_RESULT_ERROR_CODE, "unknown");
  });
});
