import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { isDiffCommand, ToolExecutor, toPermissionResult, getWorkerTools, ALL_TOOLS } from "./executor.js";
import { ToolError } from "./tool-error.js";
import type { ToolSpec, ToolContext } from "./registry.js";
import type { PermissionAsker, PermissionDecisionResult } from "./executor.js";
import { HooksManager } from "../hooks/manager.js";
import { setSpawnHookImplForTesting } from "../hooks/runner.js";
import type { HookEvent } from "../hooks/types.js";

describe("isDiffCommand", () => {
  it("matches `git show` and its argument forms", () => {
    assert.strictEqual(isDiffCommand("git show"), true);
    assert.strictEqual(isDiffCommand("git show abc123"), true);
    assert.strictEqual(isDiffCommand("git show abc123:path/to/file.ts"), true);
    assert.strictEqual(isDiffCommand("  git show HEAD~1  "), true);
  });

  it("does not match `git show-ref` or `git show-branch`", () => {
    assert.strictEqual(isDiffCommand("git show-ref"), false);
    assert.strictEqual(isDiffCommand("git show-branch"), false);
    assert.strictEqual(isDiffCommand("git show-ref --heads"), false);
  });

  it("matches `git diff` with various flags", () => {
    assert.strictEqual(isDiffCommand("git diff"), true);
    assert.strictEqual(isDiffCommand("git diff --cached"), true);
    assert.strictEqual(isDiffCommand("git diff HEAD~1 HEAD"), true);
    assert.strictEqual(isDiffCommand("git diff -- src/"), true);
  });

  it("does not match commands that merely start with `git diff` as a substring", () => {
    assert.strictEqual(isDiffCommand("git diffx"), false);
    assert.strictEqual(isDiffCommand("git difftool"), false);
  });

  it("matches `git log` only when -p / --patch is present", () => {
    assert.strictEqual(isDiffCommand("git log"), false);
    assert.strictEqual(isDiffCommand("git log --oneline"), false);
    assert.strictEqual(isDiffCommand("git log -p"), true);
    assert.strictEqual(isDiffCommand("git log --patch"), true);
    assert.strictEqual(isDiffCommand("git log -p -- src/"), true);
    assert.strictEqual(isDiffCommand("git log --patch -- src/"), true);
  });

  it("matches `git format-patch`", () => {
    assert.strictEqual(isDiffCommand("git format-patch HEAD~3"), true);
    assert.strictEqual(isDiffCommand("git format-patch -1 HEAD"), true);
  });

  it("matches `git stash show` only when -p / --patch is present", () => {
    assert.strictEqual(isDiffCommand("git stash show"), false);
    assert.strictEqual(isDiffCommand("git stash show -p"), true);
    assert.strictEqual(isDiffCommand("git stash show --patch"), true);
    assert.strictEqual(isDiffCommand("git stash show -p stash@{0}"), true);
  });

  it("rejects unrelated commands", () => {
    assert.strictEqual(isDiffCommand(""), false);
    assert.strictEqual(isDiffCommand("git status"), false);
    assert.strictEqual(isDiffCommand("npm test"), false);
    assert.strictEqual(isDiffCommand("ls -la"), false);
    assert.strictEqual(isDiffCommand("show diff"), false);
  });
});

describe("getWorkerTools", () => {
  it("keeps the default tool list compatible and restricts research to safe repository reads", async () => {
    assert.strictEqual(getWorkerTools(), ALL_TOOLS);
    const researchTools = getWorkerTools("research");
    assert.ok(researchTools.length > 0);
    assert.ok(researchTools.every((tool) => tool.isReadOnly === true));
    assert.ok(researchTools.every((tool) => ["read", "glob", "grep", "github_read_pr", "github_read_issue", "github_read_code", "github_list_merged_prs", "github_list_releases"].includes(tool.name)));
    for (const forbidden of ["bash", "write", "edit", "github_create_pr", "spawn_worker", "memory_forget"]) {
      assert.ok(!researchTools.some((tool) => tool.name === forbidden), `${forbidden} must not be exposed`);
    }

    const read = researchTools.find((tool) => tool.name === "read")!;
    await assert.rejects(() => read.run({ path: "/etc/passwd" }, { cwd: process.cwd() }), /inside their cloned repository/);
    await assert.rejects(() => read.run({ path: ".env" }, { cwd: process.cwd() }), /credential.*paths is blocked/);
    const glob = researchTools.find((tool) => tool.name === "glob")!;
    await assert.rejects(() => glob.run({ pattern: "../.env" }, { cwd: process.cwd() }), /cannot traverse outside/);
  });
});

// ── M2.1: ToolError classification on ToolResult ─────────────────────────

function makeTool(opts: {
  name?: string;
  needsPermission?: boolean;
  run: ToolSpec["run"];
}): ToolSpec {
  return {
    name: opts.name ?? "test_tool",
    description: "test",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    needsPermission: opts.needsPermission ?? false,
    run: opts.run,
  };
}

const allowAll = async () => "allow" as const;
const ctx = { cwd: process.cwd() };

describe("ToolExecutor — typed error classification", () => {
  it("lifts ToolError code / recoverable / suggestion onto the result", async () => {
    const tool = makeTool({
      run: async () => {
        throw new ToolError({
          code: "timeout",
          message: "took too long",
          suggestion: "retry with a smaller request",
        });
      },
    });
    const exec = new ToolExecutor([tool]);
    const res = await exec.run(
      { id: "c1", name: "test_tool", arguments: "{}" },
      allowAll,
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "timeout");
    assert.strictEqual(res.recoverable, true);
    assert.strictEqual(res.suggestion, "retry with a smaller request");
    assert.match(res.content, /took too long/);
  });

  it("classifies a plain Error from the tool as 'unknown', not recoverable", async () => {
    const tool = makeTool({
      run: async () => {
        throw new Error("kaboom");
      },
    });
    const exec = new ToolExecutor([tool]);
    const res = await exec.run(
      { id: "c2", name: "test_tool", arguments: "{}" },
      allowAll,
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "unknown");
    assert.strictEqual(res.recoverable, false);
    assert.strictEqual(res.suggestion, undefined);
  });

  it("classifies invalid JSON arguments as recoverable and does not echo the payload", async () => {
    let ran = false;
    const tool = makeTool({ run: async () => { ran = true; return "ok"; } });
    const exec = new ToolExecutor([tool]);
    const raw = '{"content":"<h1>private generated content';
    const res = await exec.run(
      { id: "c3", name: "test_tool", arguments: raw },
      allowAll,
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "invalid_args");
    assert.strictEqual(res.recoverable, true);
    assert.match(res.content, /No tool action was performed/);
    assert.ok(!res.content.includes("private generated content"));
    assert.strictEqual(ran, false);
  });

  it("rejects empty tool arguments instead of treating them as an empty object", async () => {
    let ran = false;
    const exec = new ToolExecutor([makeTool({ run: async () => { ran = true; return "ok"; } })]);
    const res = await exec.run({ id: "c-empty", name: "test_tool", arguments: "" }, allowAll, ctx);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "invalid_args");
    assert.strictEqual(res.recoverable, true);
    assert.match(res.content, /arguments were empty/);
    assert.strictEqual(ran, false);
  });

  it("classifies unknown tool name as 'not_found'", async () => {
    const exec = new ToolExecutor([]);
    const res = await exec.run(
      { id: "c4", name: "missing", arguments: "{}" },
      allowAll,
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "not_found");
    assert.strictEqual(res.recoverable, false);
  });

  it("classifies a denied permission as 'permission_denied'", async () => {
    const tool = makeTool({
      needsPermission: true,
      run: async () => "ok",
    });
    const exec = new ToolExecutor([tool]);
    const res = await exec.run(
      { id: "c5", name: "test_tool", arguments: "{}" },
      async () => "deny",
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "permission_denied");
    assert.strictEqual(res.recoverable, false);
  });

  it("leaves successful results without classification fields", async () => {
    const tool = makeTool({ run: async () => "happy path" });
    const exec = new ToolExecutor([tool]);
    const res = await exec.run(
      { id: "c6", name: "test_tool", arguments: "{}" },
      allowAll,
      ctx,
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.errorCode, undefined);
    assert.strictEqual(res.recoverable, undefined);
    assert.strictEqual(res.suggestion, undefined);
  });
});

// ── M2.2: typed PermissionDecisionResult ─────────────────────────────────

describe("toPermissionResult", () => {
  it("maps legacy 'allow' to { allow, once }", () => {
    assert.deepStrictEqual(toPermissionResult("allow"), {
      decision: "allow",
      scope: "once",
    });
  });

  it("maps legacy 'allow_session' to { allow, session }", () => {
    assert.deepStrictEqual(toPermissionResult("allow_session"), {
      decision: "allow",
      scope: "session",
    });
  });

  it("maps legacy 'deny' to { deny, once }", () => {
    assert.deepStrictEqual(toPermissionResult("deny"), {
      decision: "deny",
      scope: "once",
    });
  });

  it("passes the typed shape through unchanged", () => {
    const typed: PermissionDecisionResult = { decision: "allow", scope: "pattern" };
    assert.strictEqual(toPermissionResult(typed), typed);
  });
});

describe("ToolExecutor — typed PermissionDecisionResult handling", () => {
  function makeTool(name = "needs_perm"): ToolSpec {
    return {
      name,
      description: "test",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      needsPermission: true,
      run: async () => "ok",
    };
  }
  const ctx2: ToolContext = { cwd: process.cwd() };

  it("scope 'once' does NOT cache — re-asks on the next call", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    let prompts = 0;
    const ask: PermissionAsker = async () => {
      prompts += 1;
      return { decision: "allow", scope: "once" };
    };
    await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    await exec.run({ id: "b", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(prompts, 2);
  });

  it("scope 'session' caches — skips the asker on the second call", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    let prompts = 0;
    const ask: PermissionAsker = async () => {
      prompts += 1;
      return { decision: "allow", scope: "session" };
    };
    await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    await exec.run({ id: "b", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(prompts, 1);
  });

  it("scope 'pattern' does NOT cache — the pattern itself lives in settings.json", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    let prompts = 0;
    const ask: PermissionAsker = async () => {
      prompts += 1;
      return { decision: "allow", scope: "pattern" };
    };
    await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    await exec.run({ id: "b", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(prompts, 2);
  });

  it("deny is honored regardless of scope", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    const ask: PermissionAsker = async () => ({ decision: "deny", scope: "once" });
    const res = await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "permission_denied");
  });

  it("legacy 'allow_session' string is still cached (back-compat)", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    let prompts = 0;
    const ask: PermissionAsker = async () => {
      prompts += 1;
      return "allow_session";
    };
    await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    await exec.run({ id: "b", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(prompts, 1);
  });

  it("legacy 'allow' string is NOT cached (back-compat)", async () => {
    const tool = makeTool();
    const exec = new ToolExecutor([tool]);
    let prompts = 0;
    const ask: PermissionAsker = async () => {
      prompts += 1;
      return "allow";
    };
    await exec.run({ id: "a", name: tool.name, arguments: "{}" }, ask, ctx2);
    await exec.run({ id: "b", name: tool.name, arguments: "{}" }, ask, ctx2);
    assert.strictEqual(prompts, 2);
  });
});

// ── M6.1 amendment: executor-level hooks fire for every caller ──────────
//
// These tests cover the audit-driven fix that moves PreToolUse /
// PostToolUse out of the loop wrapper and into `executor.run`. The
// guarantee is: every path that calls `executor.run` (standard loop,
// code-mode sandbox, init turn, SDK, CLI print mode) fires hooks
// automatically without needing to wrap manually.

interface CapturedFire {
  event: HookEvent;
  payload: unknown;
  toolName: string | null;
}

class CapturingHooks {
  fired: CapturedFire[] = [];
  vetoNext = false;

  hasEnabledHooks(_event: HookEvent): boolean {
    return true;
  }
  hooksFor(_event: HookEvent) {
    return [];
  }
  reload(): void {}
  async fire(event: HookEvent, payload: unknown, toolName: string | null) {
    this.fired.push({ event, payload, toolName });
    if (this.vetoNext && event === "PreToolUse") {
      this.vetoNext = false;
      return {
        outcomes: [],
        vetoed: true,
        vetoReason: "test veto",
      };
    }
    return { outcomes: [], vetoed: false, vetoReason: "" };
  }
}

describe("ToolExecutor — M6.1 executor-level hooks", () => {
  function makeTool(): ToolSpec {
    return {
      name: "echo",
      description: "test",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      needsPermission: false,
      run: async () => "ok",
    };
  }
  const allowAll: PermissionAsker = async () => ({ decision: "allow", scope: "once" });

  it("fires PreToolUse + PostToolUse on a successful call", async () => {
    const hooks = new CapturingHooks();
    const exec = new ToolExecutor([makeTool()]);
    exec.setHooks(hooks as never);
    const res = await exec.run(
      { id: "c1", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(hooks.fired.length, 2);
    assert.strictEqual(hooks.fired[0]!.event, "PreToolUse");
    assert.strictEqual(hooks.fired[1]!.event, "PostToolUse");
  });

  it("fires PostToolUse on a failing call too", async () => {
    const hooks = new CapturingHooks();
    const tool: ToolSpec = {
      ...makeTool(),
      run: async () => {
        throw new ToolError({ code: "unknown", message: "boom" });
      },
    };
    const exec = new ToolExecutor([tool]);
    exec.setHooks(hooks as never);
    const res = await exec.run(
      { id: "c2", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(hooks.fired.length, 2);
    assert.strictEqual(hooks.fired[1]!.event, "PostToolUse");
    const post = hooks.fired[1]!.payload as { result: { ok: boolean; errorCode?: string } };
    assert.strictEqual(post.result.ok, false);
    assert.strictEqual(post.result.errorCode, "unknown");
  });

  it("fires PostToolUse when permission is denied", async () => {
    const hooks = new CapturingHooks();
    const tool: ToolSpec = { ...makeTool(), needsPermission: true };
    const exec = new ToolExecutor([tool]);
    exec.setHooks(hooks as never);
    const res = await exec.run(
      { id: "c3", name: "echo", arguments: "{}" },
      async () => ({ decision: "deny", scope: "once" }),
      { cwd: "/tmp" },
    );
    assert.strictEqual(res.errorCode, "permission_denied");
    // PreToolUse + PostToolUse — confirms hooks fire even on the
    // permission-denied path so the user can observe denials.
    assert.strictEqual(hooks.fired.length, 2);
    const post = hooks.fired[1]!.payload as { result: { errorCode?: string } };
    assert.strictEqual(post.result.errorCode, "permission_denied");
  });

  it("vetoed PreToolUse synthesizes a policy_rejection result AND does NOT fire PostToolUse", async () => {
    const hooks = new CapturingHooks();
    hooks.vetoNext = true;
    const exec = new ToolExecutor([makeTool()]);
    exec.setHooks(hooks as never);
    const res = await exec.run(
      { id: "c4", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.errorCode, "policy_rejection");
    assert.match(res.content, /test veto/);
    // Only PreToolUse fired — PostToolUse is meaningless when the
    // action never ran.
    assert.strictEqual(hooks.fired.length, 1);
    assert.strictEqual(hooks.fired[0]!.event, "PreToolUse");
  });

  it("propagates intentTier into PreToolUse + PostToolUse payloads", async () => {
    const hooks = new CapturingHooks();
    const exec = new ToolExecutor([makeTool()]);
    exec.setHooks(hooks as never);
    await exec.run(
      { id: "c5", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp", intentTier: "heavy" },
    );
    const pre = hooks.fired[0]!.payload as { tier?: string };
    const post = hooks.fired[1]!.payload as { tier?: string };
    assert.strictEqual(pre.tier, "heavy");
    assert.strictEqual(post.tier, "heavy");
  });

  it("omits tier from payload when not provided", async () => {
    const hooks = new CapturingHooks();
    const exec = new ToolExecutor([makeTool()]);
    exec.setHooks(hooks as never);
    await exec.run(
      { id: "c6", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    const pre = hooks.fired[0]!.payload as { tier?: string };
    assert.strictEqual(pre.tier, undefined);
  });

  it("caps PostToolUse content at 4 KB to fit env var limits", async () => {
    const hooks = new CapturingHooks();
    // 10 KB of payload content
    const big = "x".repeat(10 * 1024);
    const tool: ToolSpec = { ...makeTool(), run: async () => big };
    const exec = new ToolExecutor([tool]);
    exec.setHooks(hooks as never);
    await exec.run(
      { id: "c7", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    const post = hooks.fired[1]!.payload as { result: { content: string } };
    const capped = post.result.content;
    assert.ok(
      Buffer.byteLength(capped, "utf8") <= 5 * 1024,
      `capped content should be under 5 KB after truncation marker; got ${capped.length}`,
    );
    assert.match(capped, /truncated for hook payload/);
  });

  it("setHooks(null) detaches the manager so no events fire", async () => {
    const hooks = new CapturingHooks();
    const exec = new ToolExecutor([makeTool()], { hooks: hooks as never });
    exec.setHooks(null);
    await exec.run(
      { id: "c8", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    assert.strictEqual(hooks.fired.length, 0);
  });

  it("no hooks attached at all → no firing, no errors", async () => {
    const exec = new ToolExecutor([makeTool()]);
    const res = await exec.run(
      { id: "c9", name: "echo", arguments: "{}" },
      allowAll,
      { cwd: "/tmp" },
    );
    assert.strictEqual(res.ok, true);
  });
});

// Unused now — silence lint
void beforeEach;
void afterEach;
void HooksManager;
void setSpawnHookImplForTesting;
