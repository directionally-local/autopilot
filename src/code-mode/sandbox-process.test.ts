import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import {
  runInSandbox,
  secureSandboxUnavailableReason,
  sandboxHostPidForTesting,
  setSandboxHostTestHooks,
  queueSandboxRunTestHooks,
  resetSandboxCrashesForTesting,
  resetFallbackWarningFlag,
  codeModeCrashDisabledReason,
  disposeSandboxHost,
  disposeAllSandboxHosts,
  takeSandboxUnavailableWarning,
  sandboxHostEnv,
  CODE_MODE_CRASH_LIMIT,
  type SandboxOptions,
} from "./sandbox.js";
import { ToolExecutor } from "../tools/executor.js";
import type { PermissionRequest } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";

const unavailable = await secureSandboxUnavailableReason();
const SKIP = unavailable ? `isolated-vm is not available: ${unavailable}` : false;

/**
 * A real SIGSEGV/SIGABRT core-dumps, and on a desktop or server Linux with
 * apport that leaves an ~8 MB report in /var/crash on every test run. There
 * the crash tests use SIGKILL, which exercises the same parent path (child
 * exits by signal mid-run); set AUTOPILOT_TEST_NATIVE_CRASH=1 to force SIGSEGV.
 */
function corePipeHandler(): boolean {
  try {
    return readFileSync("/proc/sys/kernel/core_pattern", "utf8").startsWith("|");
  } catch {
    return false;
  }
}
const nativeCrash = process.env.AUTOPILOT_TEST_NATIVE_CRASH === "1" || !corePipeHandler();
const CRASH_HOOK = nativeCrash ? "segv" : "sigkill";
const CRASH_SIGNAL = nativeCrash ? "SIGSEGV" : "SIGKILL";

let sessionSeq = 0;
const newSession = () => `sandbox-process-test-${process.pid}-${++sessionSeq}`;

const echoTool: ToolSpec = {
  name: "echo",
  description: "Echo",
  parameters: { type: "object", properties: { text: { type: "string" } } },
  needsPermission: false,
  isReadOnly: true,
  run: async (args) => `echo:${(args as { text?: string }).text ?? ""}`,
};

function opts(code: string, sessionId: string, extra: Partial<SandboxOptions> = {}): SandboxOptions {
  return {
    code,
    tools: [echoTool],
    executor: new ToolExecutor([echoTool]),
    askPermission: async () => "allow",
    ctx: { cwd: process.cwd(), sessionId },
    ...extra,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !alive(pid);
}

describe("Code Mode sandbox process", { skip: SKIP }, () => {
  before(() => setSandboxHostTestHooks(true));
  after(() => {
    setSandboxHostTestHooks(false);
    queueSandboxRunTestHooks();
    disposeAllSandboxHosts();
  });
  beforeEach(() => {
    resetSandboxCrashesForTesting();
    resetFallbackWarningFlag();
  });

  it("runs the script in a separate child process and returns the same result shape", async () => {
    const session = newSession();
    const result = await runInSandbox(opts(`const r: string = await api.echo({ text: "hi" }); console.log(r); console.log("two", 2)`, session));
    assert.equal(result.error, undefined);
    assert.equal(result.output, "echo:hi\ntwo 2");
    assert.deepEqual(result.logs, ["echo:hi", "two 2"]);
    assert.deepEqual(result.toolCalls, [{ name: "echo", args: { text: "hi" }, result: "echo:hi", ok: true }]);
    const pid = await sandboxHostPidForTesting(session);
    assert.ok(pid && pid !== process.pid, `sandbox pid ${pid} must differ from ${process.pid}`);
    // The host is long-lived for the session.
    await runInSandbox(opts(`console.log(1)`, session));
    assert.equal(await sandboxHostPidForTesting(session), pid);
    disposeSandboxHost(session);
    assert.ok(await waitDead(pid!), "disposed host process exits");
  });

  it("passes no secrets or parent environment to the child", async () => {
    const session = newSession();
    process.env.OPENROUTER_API_KEY = "sk-or-secret-for-test";
    process.env.AUTOPILOT_TEST_SECRET_TOKEN = "secret";
    try {
      queueSandboxRunTestHooks("env");
      const result = await runInSandbox(opts(`console.log("unused")`, session));
      const report = JSON.parse(result.logs[0] ?? "{}") as { pid: number; env: string[] };
      assert.notEqual(report.pid, process.pid);
      const allowed = new Set(["TMPDIR", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "AUTOPILOT_CODE_MODE_TEST_HOOKS"]);
      // Node may add a few of its own variables; nothing may come from the parent's env.
      for (const key of report.env) {
        assert.ok(allowed.has(key) || !(key in process.env), `child env leaked ${key}`);
      }
      assert.ok(!report.env.includes("OPENROUTER_API_KEY"));
      assert.ok(!report.env.includes("AUTOPILOT_TEST_SECRET_TOKEN"));
      assert.ok(!report.env.includes("HOME"));
      assert.ok(!report.env.includes("PATH"));
      assert.ok(!Object.keys(sandboxHostEnv()).includes("OPENROUTER_API_KEY"));
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.AUTOPILOT_TEST_SECRET_TOKEN;
      disposeSandboxHost(session);
    }
  });

  it("runs tool calls from inside the sandbox through the parent's permission check", async () => {
    const session = newSession();
    let ran = 0;
    const asked: PermissionRequest[] = [];
    const guarded: ToolSpec = {
      name: "guarded",
      description: "Needs permission",
      parameters: { type: "object", properties: {} },
      needsPermission: true,
      run: async () => {
        ran++;
        return "ran-in-parent";
      },
    };
    const parentPid = process.pid;
    const pidTool: ToolSpec = {
      name: "pid",
      description: "Report the pid the tool runs in",
      parameters: { type: "object", properties: {} },
      needsPermission: false,
      isReadOnly: true,
      run: async () => String(process.pid),
    };
    const executor = new ToolExecutor([guarded, pidTool]);
    const denied = await runInSandbox({
      ...opts(`console.log(await api.guarded({}))`, session),
      tools: [guarded, pidTool],
      executor,
      askPermission: async (req) => {
        asked.push(req);
        return "deny";
      },
    });
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.tool.name, "guarded");
    assert.equal(ran, 0, "a denied tool never runs");
    assert.equal(denied.toolCalls[0]?.ok, false);

    const allowed = await runInSandbox({
      ...opts(`console.log(await api.guarded({})); console.log(await api.pid({}))`, session),
      tools: [guarded, pidTool],
      executor,
      askPermission: async () => "allow",
    });
    assert.equal(ran, 1);
    assert.equal(allowed.output, `ran-in-parent\n${parentPid}`);
    disposeSandboxHost(session);
  });

  it("enforces the timeout inside the child and keeps the host usable", async () => {
    const session = newSession();
    const started = Date.now();
    const result = await runInSandbox(opts(`while (true) {}`, session, { timeoutMs: 200 }));
    assert.match(result.error ?? "", /timed out/i);
    assert.ok(Date.now() - started < 5000);
    const pid = await sandboxHostPidForTesting(session);
    const next = await runInSandbox(opts(`console.log("still here")`, session));
    assert.equal(next.output, "still here");
    assert.equal(await sandboxHostPidForTesting(session), pid);
    disposeSandboxHost(session);
  });

  it("enforces the memory limit", async () => {
    const session = newSession();
    const result = await runInSandbox(opts(`const a = []; while (true) a.push(new Array(1e5).fill(1));`, session, { memoryLimitMB: 16, timeoutMs: 20000 }));
    assert.ok(result.error, "the script fails");
    assert.ok(!result.crashed, "a memory-limit kill is a script error, not a crash");
    disposeSandboxHost(session);
  });

  it("an aborted turn kills the child's run", async () => {
    const session = newSession();
    await runInSandbox(opts(`console.log(1)`, session));
    const pid = await sandboxHostPidForTesting(session);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const started = Date.now();
    const result = await runInSandbox({ ...opts(`while (true) {}`, session, { timeoutMs: 30000 }), ctx: { cwd: process.cwd(), sessionId: session, signal: controller.signal } });
    assert.ok(Date.now() - started < 5000, "abort returns promptly");
    assert.match(result.error ?? "", /aborted/);
    assert.ok(!result.crashed, "an abort is not a crash");
    assert.ok(await waitDead(pid!), "the host running the aborted script is gone");
    assert.equal(codeModeCrashDisabledReason(session), null);
    const next = await runInSandbox(opts(`console.log("fresh")`, session));
    assert.equal(next.output, "fresh");
    const pre = new AbortController();
    pre.abort();
    const skipped = await runInSandbox({ ...opts(`console.log("never")`, session), ctx: { cwd: process.cwd(), sessionId: session, signal: pre.signal } });
    assert.match(skipped.error ?? "", /aborted/);
    disposeSandboxHost(session);
  });

  it(`a ${CRASH_SIGNAL} in the child fails only that call, warns once, and the next call gets a new host`, async () => {
    const session = newSession();
    await runInSandbox(opts(`console.log(1)`, session));
    const firstPid = await sandboxHostPidForTesting(session);
    queueSandboxRunTestHooks(CRASH_HOOK);
    const crashed = await runInSandbox(opts(`console.log("x")`, session));
    assert.equal(crashed.crashed, true);
    assert.equal(crashed.error, `The code sandbox crashed (${CRASH_SIGNAL}); run the steps as separate tool calls.`);
    assert.deepEqual(crashed.warnings, [`Code Mode's sandbox crashed (${CRASH_SIGNAL}). Only that execute_code call failed; Autopilot kept running.`]);
    assert.ok(!alive(firstPid!) || (await waitDead(firstPid!)));
    // The parent (this test process) is still running, and so is Code Mode.
    assert.equal(codeModeCrashDisabledReason(session), null);
    const after = await runInSandbox(opts(`console.log(await api.echo({ text: "back" }))`, session));
    assert.equal(after.output, "echo:back");
    assert.notEqual(await sandboxHostPidForTesting(session), firstPid);
    disposeSandboxHost(session);
  });

  it(`turns Code Mode off for the session after ${CODE_MODE_CRASH_LIMIT} crashes, with one notice`, async () => {
    const session = newSession();
    const other = newSession();
    queueSandboxRunTestHooks(nativeCrash ? "abort" : "sigkill", "exit1");
    const first = await runInSandbox(opts(`console.log(1)`, session));
    assert.equal(first.crashed, true);
    assert.match(first.error ?? "", nativeCrash ? /^The code sandbox crashed \(SIGABRT\)/ : /^The code sandbox crashed \(SIGKILL\)/);
    assert.equal(first.warnings?.length, 1);
    const second = await runInSandbox(opts(`console.log(1)`, session));
    assert.equal(second.error, "The code sandbox crashed (exit code 1); run the steps as separate tool calls.");
    assert.deepEqual(second.warnings, [
      "Code Mode is off for the rest of this session: the Code Mode sandbox crashed 2 times in this session. Tools are called directly instead.",
    ]);
    assert.equal(codeModeCrashDisabledReason(session), "the Code Mode sandbox crashed 2 times in this session");
    // Later calls do not run and add no notice; the loop's turn-start check stays silent too.
    const third = await runInSandbox(opts(`console.log("never")`, session));
    assert.match(third.error ?? "", /^Code Mode is off for the rest of this session/);
    assert.equal(third.warnings, undefined);
    assert.equal(await sandboxHostPidForTesting(session), null);
    assert.equal(takeSandboxUnavailableWarning(session, codeModeCrashDisabledReason(session)!), null);
    // Other sessions are unaffected.
    assert.equal(codeModeCrashDisabledReason(other), null);
    assert.equal((await runInSandbox(opts(`console.log("ok")`, other))).output, "ok");
    disposeSandboxHost(other);
  });

  it("leaves no child processes after cleanup", async () => {
    const sessions = [newSession(), newSession(), newSession()];
    const pids: number[] = [];
    for (const s of sessions) {
      await runInSandbox(opts(`console.log(1)`, s));
      pids.push((await sandboxHostPidForTesting(s))!);
    }
    assert.equal(new Set(pids).size, 3);
    disposeAllSandboxHosts();
    for (const pid of pids) assert.ok(await waitDead(pid), `host ${pid} exited`);
    for (const s of sessions) assert.equal(await sandboxHostPidForTesting(s), null);
  });
});
