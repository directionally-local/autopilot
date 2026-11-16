/**
 * Code Mode sandbox host: a small child process that runs model-written code
 * in isolated-vm, forked by src/code-mode/sandbox.ts.
 *
 * isolated-vm is a native module; a crash inside it (SIGSEGV in
 * ivm::RunRunner, V8 lazy compile, …) used to take the whole TUI down with it.
 * Here it only takes this process down, and the parent fails that one
 * execute_code call.
 *
 * This process has no capabilities of its own beyond what isolated-vm code
 * had before: every api.* call is sent to the parent as a "tool" message and
 * the parent runs it through the normal executor and permission checks. The
 * parent starts it with a minimal environment (no API keys or secrets).
 *
 * Keep this file self-contained (Node built-ins and isolated-vm only, and
 * type-only imports): it is bundled on its own as dist/sandbox-host.js and run
 * straight from source (Node type stripping) in development and tests.
 */
import { createRequire } from "node:module";
import type { HostToParent, ParentToHost } from "./sandbox-protocol.js";

interface IsolatedVmContext {
  global: { set(name: string, value: unknown): Promise<void>; derefInto(): unknown };
  evalClosure(code: string, references: unknown[], options: { arguments: { copy?: boolean; reference?: boolean } }): Promise<unknown>;
  eval(code: string): Promise<unknown>;
}

interface IsolatedVmInstance {
  createContext(): Promise<IsolatedVmContext>;
  compileScript(source: string): Promise<{
    run(context: IsolatedVmContext, options: { timeout: number; release: boolean }): Promise<unknown>;
  }>;
  dispose(): void;
}

type IsolateCtor = new (options: { memoryLimit: number }) => IsolatedVmInstance;

const send = (msg: HostToParent): void => {
  if (process.connected) process.send?.(msg);
};

const require = createRequire(import.meta.url);

function isolatedVmVersion(): string | null {
  try {
    return (require("isolated-vm/package.json") as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

let isolateCtor: Promise<IsolateCtor> | null = null;
function loadIsolate(): Promise<IsolateCtor> {
  isolateCtor ??= (async () => {
    // Resolved from this package's own node_modules (the script lives in dist/).
    const name: string = "isolated-vm";
    const mod = (await import(name)) as { Isolate?: IsolateCtor; default?: { Isolate?: IsolateCtor } };
    const Isolate = mod.default?.Isolate ?? mod.Isolate;
    if (typeof Isolate !== "function") throw new Error("isolated-vm loaded but exposes no Isolate constructor");
    return Isolate;
  })();
  return isolateCtor;
}

/** Pending api.* calls waiting for the parent, keyed by run then call id. */
const pending = new Map<number, Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>>();
let nextCallId = 0;

function runTestHook(hook: string, runId: number): boolean {
  if (process.env.AUTOPILOT_CODE_MODE_TEST_HOOKS !== "1") return false;
  switch (hook) {
    case "segv":
      process.kill(process.pid, "SIGSEGV");
      return true;
    case "abort":
      process.abort();
      return true;
    case "sigkill":
      process.kill(process.pid, "SIGKILL");
      return true;
    case "exit1":
      process.exit(1);
      return true;
    case "env":
      send({ type: "log", runId, line: JSON.stringify({ pid: process.pid, env: Object.keys(process.env).sort() }) });
      send({ type: "done", runId });
      return true;
    default:
      return false;
  }
}

async function run(msg: Extract<ParentToHost, { type: "run" }>): Promise<void> {
  const { runId } = msg;
  if (msg.testHook && runTestHook(msg.testHook, runId)) return;
  let isolate: IsolatedVmInstance | null = null;
  const calls = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
  pending.set(runId, calls);
  try {
    const Isolate = await loadIsolate();
    isolate = new Isolate({ memoryLimit: msg.memoryLimitMB });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    // console.log capture: each line goes to the parent as it is logged, so
    // output printed before a crash is not lost.
    await context.evalClosure(
      `globalThis._log = function(...args) {
        $0.applySync(undefined, [args.map(String).join(" ")], { arguments: { copy: true } });
      };`,
      [(line: string) => send({ type: "log", runId, line })],
      { arguments: { reference: true } },
    );
    await context.eval(`var console = { log: function(...args) { _log(args.map(String).join(" ")); } };`);

    for (const name of msg.toolNames) {
      const host = (argsJson: string): Promise<string> =>
        new Promise<string>((resolve, reject) => {
          const callId = ++nextCallId;
          calls.set(callId, { resolve, reject });
          send({ type: "tool", runId, callId, name, argsJson });
        });
      // `arguments.reference` wraps the host function in a Reference (see the
      // note in sandbox.ts history: a pre-built Reference would be wrapped twice).
      await context.evalClosure(
        `globalThis[${JSON.stringify(`_api_${name}`)}] = function(argsJson) {
          return $0.applySyncPromise(undefined, [argsJson], { arguments: { copy: true } });
        };`,
        [host],
        { arguments: { reference: true } },
      );
    }
    const apiMethods = msg.toolNames
      .map((n) => `  ${JSON.stringify(n)}: function(input) { return globalThis[${JSON.stringify(`_api_${n}`)}](JSON.stringify(input ?? {})); }`)
      .join(",\n");
    await context.eval(`var api = {\n${apiMethods}\n};`);

    // Wrap in an async IIFE to support top-level await.
    const wrapped = `(async function() {\n${msg.code}\n})();`;
    const script = await isolate.compileScript(wrapped);
    await script.run(context, { timeout: msg.timeoutMs, release: true });
    // Wait a tick for any pending promises to settle.
    await new Promise((r) => setTimeout(r, 10));
    send({ type: "done", runId });
  } catch (err) {
    send({ type: "done", runId, error: err instanceof Error ? err.message : String(err) });
  } finally {
    pending.delete(runId);
    for (const call of calls.values()) call.reject(new Error("run finished"));
    try {
      isolate?.dispose();
    } catch {
      // already disposed (e.g. after a memory-limit kill)
    }
  }
}

process.on("message", (raw) => {
  const msg = raw as ParentToHost;
  if (msg.type === "run") {
    void run(msg);
  } else if (msg.type === "toolResult") {
    const call = pending.get(msg.runId)?.get(msg.callId);
    if (!call) return;
    pending.get(msg.runId)?.delete(msg.callId);
    if (msg.error !== undefined) call.reject(new Error(msg.error));
    else call.resolve(msg.content ?? "");
  }
});

// The parent owns this process: when its IPC channel closes (parent exited,
// crashed or was killed) there is nothing left to do.
process.on("disconnect", () => process.exit(0));
// Ctrl+C in a terminal signals the whole foreground process group; the parent
// decides what an interrupt means and stops this process itself.
process.on("SIGINT", () => {});

send({ type: "ready", pid: process.pid, node: process.version, isolatedVm: isolatedVmVersion() });
