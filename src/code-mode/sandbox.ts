import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../util/logger.js";
import { onShutdown } from "../util/exit.js";
import { observeSessionEnd } from "../hooks/session-lifecycle.js";
import type { HostToParent, ParentToHost, SandboxHostTestHook } from "./sandbox-protocol.js";
import type { ToolSpec, ToolContext } from "../tools/registry.js";
import type { ToolExecutor, PermissionAsker, ToolResult } from "../tools/executor.js";

export interface SandboxResult {
  /** console.log output joined by newlines */
  output: string;
  /** Individual log lines */
  logs: string[];
  /** Error message if execution failed */
  error?: string;
  /** Tool calls made during execution */
  toolCalls: SandboxToolCall[];
  /** Warnings emitted during transpilation or execution */
  warnings?: string[];
  /** The sandbox process crashed during this run (not a script error). */
  crashed?: boolean;
}

export interface SandboxToolCall {
  name: string;
  args: unknown;
  result: string;
  ok: boolean;
}

export interface SandboxOptions {
  code: string;
  tools: ToolSpec[];
  executor: ToolExecutor;
  askPermission: PermissionAsker;
  ctx: ToolContext;
  timeoutMs?: number;
  memoryLimitMB?: number;
  /**
   * The turn's per-file read cursor (#1080). Without it, `api.read({ path })`
   * always got the reducer's outline, so a model re-reading a large file
   * through Code Mode saw no progress and repeated the same script until the
   * loop guardrail blocked it.
   */
  readCursor?: SandboxReadCursor;
}

/** Shares the agent loop's whole-file read paging with calls made inside a script. */
export interface SandboxReadCursor {
  /** Page to serve for this read: 0 for the reducer's normal output, n > 0 for raw page n. */
  next(args: Record<string, unknown>): number;
  /** A successful edit/write of `path` starts its paging over. */
  invalidate(path: string): void;
}

/** Lightweight TypeScript-to-JavaScript type stripper for LLM-generated code. */
export function stripTypescript(code: string): string {
  let js = code;

  // Remove interface declarations
  js = js.replace(/interface\s+\w+\s*\{[\s\S]*?\n\}/g, "");

  // Remove type alias declarations
  js = js.replace(/type\s+\w+\s*=\s*[^;]+;/g, "");

  // Remove generic type parameters: foo<T>(...) -> foo(...)
  js = js.replace(/(\w+)<[^>]+>(\s*\()/g, "$1$2");

  // Remove variable type annotations: const x: string = ...
  js = js.replace(/(\b(?:const|let|var)\s+\w+)\s*:\s*[^=;]+/g, "$1");

  // Remove function parameter types: function foo(x: string, y: number)
  js = js.replace(/(\(|,\s*)(\w+)\s*:\s*[^,)=]+/g, "$1$2");

  // Remove function return types: function foo(): string {
  js = js.replace(/(\)[\s]*)\s*:\s*[^{]+(\s*\{)/g, "$1$2");

  // Remove async return type annotations: async function foo(): Promise<string>
  js = js.replace(/(\)[\s]*)\s*:\s*Promise<[^>]+>(\s*\{)/g, "$1$2");

  // Remove type assertions: expr as Type
  js = js.replace(/\s+as\s+\w+(?:\[\])?/g, "");

  // Remove non-null assertions: expr!
  js = js.replace(/(\w+)(\??)!/g, "$1$2");

  // Remove import type statements
  js = js.replace(/import\s+type\s+[^;]+;/g, "");

  // Remove declare statements
  js = js.replace(/declare\s+[^;]+;/g, "");

  // Clean up extra blank lines
  js = js.replace(/\n{3,}/g, "\n\n");

  return js.trim();
}

async function loadTypescript(cwd: string): Promise<typeof import("typescript") | null> {
  // First, try to resolve typescript relative to this module (kimiflare's own dependencies).
  // This works when autopilot is installed globally or in any project, regardless of cwd.
  try {
    const tsPath = await import.meta.resolve("typescript");
    return await import(tsPath);
  } catch {
    // Fall back to walking up from cwd
  }

  let dir = cwd;
  while (dir !== dirname(dir)) {
    try {
      const tsPath = join(dir, "node_modules", "typescript", "lib", "typescript.js");
      return await import(pathToFileURL(tsPath).href);
    } catch {
      // continue walking up
    }
    dir = dirname(dir);
  }
  return null;
}

type StripTypes = (code: string, opts?: { mode?: "strip" | "transform" }) => string;

/** Node's one-time "stripTypeScriptTypes is an experimental feature" warning, and nothing else. */
export function isStripTypesWarning(warning: unknown, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const first = args[0];
  const type =
    typeof first === "string"
      ? first
      : first && typeof first === "object" && "type" in first
        ? String((first as { type?: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : "";
  return type === "ExperimentalWarning" && /stripTypeScriptTypes/.test(message);
}

/**
 * Node's built-in type stripper, without the experimental warning its first call prints on
 * stderr (it would start `autopilot -p` output). Only that warning is dropped, and only during
 * the call; every other warning still goes out.
 */
export function stripTypesQuietly(strip: StripTypes, code: string): string {
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: unknown, ...args: unknown[]) {
    if (isStripTypesWarning(warning, args)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...args);
  } as typeof process.emitWarning;
  try {
    return strip(code, { mode: "transform" });
  } finally {
    process.emitWarning = original;
  }
}

async function transpileOrStrip(code: string, cwd: string): Promise<{ js: string; warnings: string[] }> {
  // Node's built-in type stripper (22.13+): reliable, and no 23 MB
  // typescript dependency in the package. "transform" also handles enums.
  const builtin = (await import("node:module")) as { stripTypeScriptTypes?: StripTypes };
  if (typeof builtin.stripTypeScriptTypes === "function") {
    try {
      return { js: stripTypesQuietly(builtin.stripTypeScriptTypes, code), warnings: [] };
    } catch {
      // unsupported syntax for the built-in: try typescript, then the regex fallback
    }
  }
  const ts = await loadTypescript(cwd);
  if (ts) {
    const result = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        isolatedModules: true,
      },
    });
    return { js: result.outputText, warnings: [] };
  }
  return {
    js: stripTypescript(code),
    warnings: ["Using the fallback TypeScript stripper: upgrade to Node 22.13+ (or install typescript) for reliable transpilation."],
  };
}

/**
 * isolated-vm is a CommonJS native module. Under Node ESM (and in the tsup
 * bundle) `import("isolated-vm")` exposes its exports only on `default`, so the
 * previous `const { Isolate } = await import(...)` was always `undefined` and
 * every session silently fell back to the old node:vm backend (since removed).
 */
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

interface IsolatedVmModule {
  Isolate: new (options: { memoryLimit: number }) => IsolatedVmInstance;
}

async function loadIsolatedVm(): Promise<IsolatedVmModule> {
  // Keep the specifier non-literal so TypeScript can typecheck builds where
  // this optional native dependency is not installed for the current runtime.
  const optionalModuleName: string = "isolated-vm";
  const mod = (await import(optionalModuleName)) as {
    Isolate?: IsolatedVmModule["Isolate"];
    default?: { Isolate?: IsolatedVmModule["Isolate"] };
  };
  const ivm = mod.default?.Isolate ? mod.default : mod;
  if (typeof ivm.Isolate !== "function") throw new Error("isolated-vm loaded but exposes no Isolate constructor");
  return { Isolate: ivm.Isolate };
}

/**
 * Tool calls from inside a script. Read-only (or explicitly concurrent) tools
 * may overlap, but mutating tools run one at a time in call order — the same
 * rule the standard agent loop applies to direct tool calls. Without this,
 * `Promise.all([api.edit(f, …), api.edit(f, …)])` on the old node:vm backend ran
 * both edits concurrently and lost one of them.
 */
function makeToolBridge(opts: SandboxOptions, toolCalls: SandboxToolCall[]) {
  let mutationTail: Promise<unknown> = Promise.resolve();
  return (tool: ToolSpec) =>
    async (args: unknown): Promise<string> => {
      const argsObj = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      const invoke = async (): Promise<ToolResult> => {
        const toolCallId = `code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const readRepeat = tool.name === "read" ? (opts.readCursor?.next(argsObj) ?? 0) : 0;
        const result = await opts.executor.run(
          { id: toolCallId, name: tool.name, arguments: JSON.stringify(args ?? {}) },
          opts.askPermission,
          opts.ctx,
          undefined,
          readRepeat > 0 ? { readRepeat } : undefined,
        );
        if (result.ok && (tool.name === "edit" || tool.name === "write") && typeof argsObj.path === "string") {
          opts.readCursor?.invalidate(argsObj.path);
        }
        return result;
      };
      let result: ToolResult;
      if (tool.isReadOnly === true || tool.concurrent === true) {
        result = await invoke();
      } else {
        const run = mutationTail.then(invoke, invoke);
        mutationTail = run.catch(() => undefined);
        result = await run;
      }
      toolCalls.push({ name: tool.name, args, result: result.content, ok: result.ok });
      if (!result.ok && tool.isReadOnly !== true) {
        throw new Error(result.content || `${tool.name} failed`);
      }
      return result.content;
    };
}

// ── Out-of-process sandbox ─────────────────────────────────────────────
//
// isolated-vm runs in a child process (sandbox-host.ts), one long-lived host
// per session, so a native crash inside it (SIGSEGV in ivm::RunRunner, V8
// lazy compile, …) fails one execute_code call instead of killing Autopilot.
// The child only runs the model's code: every api.* call comes back here over
// IPC and runs through the executor with the usual permission checks, the
// read cursor and the mutation ordering above. It gets a minimal environment
// (no API keys, tokens or other secrets).

/** Crashes in one session after which Code Mode is off for the rest of it. */
export const CODE_MODE_CRASH_LIMIT = 2;
/** A host with no run for this long is stopped (the next call starts a new one). */
const HOST_IDLE_MS = 10 * 60_000;
/** Parent-side safety net past the isolate's own timeout while no tool call is pending. */
const WATCHDOG_GRACE_MS = 5_000;

const CRASH_REASON_PREFIX = "the Code Mode sandbox crashed";

interface ReadyInfo {
  pid: number;
  node: string;
  isolatedVm: string | null;
}

type RunEnd =
  | { kind: "done"; error?: string }
  | { kind: "crash"; code: number | null; signal: NodeJS.Signals | null; info: ReadyInfo | null }
  | { kind: "stopped"; error: string };

interface ActiveRun {
  logs: string[];
  onTool(msg: Extract<HostToParent, { type: "tool" }>): void;
  end(result: RunEnd): void;
}

class SandboxHost {
  readonly child: ChildProcess;
  readonly ready: Promise<ReadyInfo>;
  info: ReadyInfo | null = null;
  readonly runs = new Map<number, ActiveRun>();
  /** Set when this side stopped the child (abort, watchdog, idle, cleanup): its exit is not a crash. */
  private stopReason: string | null = null;
  private exited = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly key: string) {
    const { script, execArgv } = resolveHostScript();
    this.child = fork(script, [], {
      env: sandboxHostEnv(),
      execArgv,
      // No inherited stdout/stderr: a native crash report must not land in the TUI.
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    this.ready = new Promise<ReadyInfo>((resolve, reject) => {
      this.child.on("message", (raw) => {
        const msg = raw as HostToParent;
        if (msg.type === "ready") {
          this.info = { pid: msg.pid, node: msg.node, isolatedVm: msg.isolatedVm };
          resolve(this.info);
          return;
        }
        const run = this.runs.get(msg.runId);
        if (!run) return;
        if (msg.type === "log") run.logs.push(msg.line);
        else if (msg.type === "tool") run.onTool(msg);
        else if (msg.type === "done") run.end(msg.error === undefined ? { kind: "done" } : { kind: "done", error: msg.error });
      });
      this.child.on("error", (err) => {
        // Spawn failure (or a failed send): nothing more is expected from this child.
        reject(err);
        this.child.kill("SIGKILL");
        this.onExit(null, null, err.message);
      });
      this.child.on("exit", (code, signal) => {
        reject(new Error(`sandbox host exited before it was ready (${signal ?? `code ${code}`})`));
        this.onExit(code, signal);
      });
    });
    this.ready.catch(() => undefined);
    this.unref();
  }

  get alive(): boolean {
    return !this.exited && this.stopReason === null;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    this.clearIdle();
    if (hosts.get(this.key) === this) hosts.delete(this.key);
    const runs = [...this.runs.values()];
    this.runs.clear();
    for (const run of runs) {
      if (this.stopReason !== null) run.end({ kind: "stopped", error: this.stopReason });
      else if (spawnError !== undefined) run.end({ kind: "stopped", error: `The Code Mode sandbox could not start: ${spawnError}. Call the tools directly instead.` });
      else run.end({ kind: "crash", code, signal, info: this.info });
    }
  }

  send(msg: ParentToHost): void {
    if (!this.alive || !this.child.connected) return;
    try {
      this.child.send(msg);
    } catch {
      // The channel closed under us; the exit handler ends the runs.
    }
  }

  /** Stop the child on purpose (abort, watchdog, idle, session end): runs end with `reason`, not as a crash. */
  stop(reason: string): void {
    if (this.exited) return;
    this.stopReason ??= reason;
    if (hosts.get(this.key) === this) hosts.delete(this.key);
    this.child.kill("SIGKILL");
  }

  register(runId: number, run: ActiveRun): void {
    this.clearIdle();
    this.runs.set(runId, run);
    this.ref();
  }

  unregister(runId: number): void {
    this.runs.delete(runId);
    if (this.runs.size > 0 || !this.alive) return;
    this.unref();
    this.idleTimer = setTimeout(() => this.stop("idle"), HOST_IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  // While idle the host must not keep Autopilot's event loop alive.
  private ref(): void {
    this.child.ref();
    this.child.channel?.ref();
  }

  private unref(): void {
    this.child.unref();
    this.child.channel?.unref();
  }
}

const hosts = new Map<string, SandboxHost>();
let nextRunId = 0;
let cleanupRegistered = false;
let testHooksEnabled = false;
const queuedTestHooks: SandboxHostTestHook[] = [];

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // Normal exit and gracefulExit (SIGTERM/SIGHUP, crashes) end here. If the
  // parent dies without running this, the host sees its IPC channel close
  // and exits on its own.
  process.once("exit", () => disposeAllSandboxHosts());
  onShutdown("code-mode-sandbox", () => disposeAllSandboxHosts());
  observeSessionEnd((sessionId) => disposeSandboxHost(sessionId));
}

function hostFor(key: string): SandboxHost {
  const existing = hosts.get(key);
  if (existing?.alive) return existing;
  registerCleanup();
  const host = new SandboxHost(key);
  hosts.set(key, host);
  return host;
}

/** Stop a session's sandbox host, if it has one (session end, /clear). */
export function disposeSandboxHost(sessionId: string | undefined): void {
  hosts.get(sessionId ?? NO_SESSION_KEY)?.stop("The Code Mode sandbox was shut down.");
}

/** Stop every sandbox host (process exit). */
export function disposeAllSandboxHosts(): void {
  for (const host of [...hosts.values()]) host.stop("The Code Mode sandbox was shut down.");
}

/** @internal The pid of a session's live sandbox host, for tests. */
export async function sandboxHostPidForTesting(sessionId: string | undefined): Promise<number | null> {
  const host = hosts.get(sessionId ?? NO_SESSION_KEY);
  if (!host?.alive) return null;
  return (await host.ready).pid;
}

/** @internal Enable the host's fault-injection hooks (child env flag) for hosts started from now on. */
export function setSandboxHostTestHooks(enabled: boolean): void {
  testHooksEnabled = enabled;
}

/** @internal Make the next runs trigger these test hooks in the host, one per run (needs setSandboxHostTestHooks). */
export function queueSandboxRunTestHooks(...hooks: SandboxHostTestHook[]): void {
  queuedTestHooks.length = 0;
  queuedTestHooks.push(...hooks);
}

/**
 * The host's environment: nothing from Autopilot's own (no API keys, tokens,
 * NODE_OPTIONS). Only what Node itself needs on each platform.
 */
export function sandboxHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keep = process.platform === "win32" ? ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"] : ["TMPDIR"];
  for (const name of keep) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (testHooksEnabled) env.AUTOPILOT_CODE_MODE_TEST_HOOKS = "1";
  return env;
}

/**
 * The host script next to this module: dist/sandbox-host.js in the package
 * (also reached from dist/sdk/), or the TypeScript source in a checkout,
 * which Node runs with its built-in type stripping.
 */
function resolveHostScript(): { script: string; execArgv: string[] } {
  const execArgv = ["--disable-warning=ExperimentalWarning"];
  for (const rel of ["./sandbox-host.js", "../sandbox-host.js", "./sandbox-host.ts"]) {
    const path = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(path)) return { script: path, execArgv };
  }
  throw new Error("the Code Mode sandbox host script is missing from this installation");
}

// ── Crash accounting ───────────────────────────────────────────────────

const crashCounts = new Map<string, number>();
const crashWarningShownSessions = new Set<string>();

/** @internal Reset crash counts and their warnings, for tests. */
export function resetSandboxCrashesForTesting(): void {
  crashCounts.clear();
  crashWarningShownSessions.clear();
}

/** Why Code Mode is off for this session after repeated sandbox crashes, or null. */
export function codeModeCrashDisabledReason(sessionId: string | undefined): string | null {
  const crashes = crashCounts.get(sessionId ?? NO_SESSION_KEY) ?? 0;
  return crashes >= CODE_MODE_CRASH_LIMIT ? `${CRASH_REASON_PREFIX} ${crashes} times in this session` : null;
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ?? `exit code ${code ?? "unknown"}`;
}

/** Count a crash; returns the user-facing warnings it produces (at most one each). */
function recordCrash(sessionId: string | undefined, end: Extract<RunEnd, { kind: "crash" }>): string[] {
  const key = sessionId ?? NO_SESSION_KEY;
  const crashes = (crashCounts.get(key) ?? 0) + 1;
  crashCounts.set(key, crashes);
  const how = describeExit(end.code, end.signal);
  // No code, output or environment: only what identifies the crash.
  logger.warn("code_mode:sandbox_crash", {
    sessionId,
    signal: end.signal,
    exitCode: end.code,
    crashes,
    node: end.info?.node ?? process.version,
    isolatedVm: end.info?.isolatedVm ?? null,
    platform: process.platform,
    arch: process.arch,
  });
  const warnings: string[] = [];
  if (!crashWarningShownSessions.has(key)) {
    crashWarningShownSessions.add(key);
    warnings.push(`Code Mode's sandbox crashed (${how}). Only that execute_code call failed; Autopilot kept running.`);
  }
  const disabled = codeModeCrashDisabledReason(sessionId);
  if (disabled) {
    const notice = takeSandboxUnavailableWarning(sessionId, disabled);
    if (notice) warnings.push(notice);
  }
  return warnings;
}

const ABORTED_ERROR = "The run was interrupted: the turn was aborted.";

async function runInChildSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const signal = opts.ctx.signal;
  if (signal?.aborted) return { output: "", logs: [], error: ABORTED_ERROR, toolCalls: [] };

  // Transpile here: the child gets plain JavaScript and needs no TypeScript.
  const { js, warnings } = await transpileOrStrip(opts.code, opts.ctx.cwd);
  const toolCalls: SandboxToolCall[] = [];
  const timeoutMs = opts.timeoutMs ?? 30000;
  const host = hostFor(opts.ctx.sessionId ?? NO_SESSION_KEY);
  const runId = ++nextRunId;
  const bridge = makeToolBridge(opts, toolCalls);
  const toolsByName = new Map(opts.tools.map((tool) => [tool.name, tool]));
  const testHook = queuedTestHooks.shift();

  return await new Promise<SandboxResult>((resolve) => {
    const logs: string[] = [];
    let pendingTools = 0;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    // The isolate enforces the timeout itself; this only catches a host that
    // stops responding while no api.* call is outstanding.
    const armWatchdog = () => {
      if (watchdog || settled) return;
      watchdog = setTimeout(() => host.stop("Script execution timed out."), timeoutMs + WATCHDOG_GRACE_MS);
    };
    const disarmWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };
    const onAbort = () => host.stop(ABORTED_ERROR);

    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      disarmWatchdog();
      signal?.removeEventListener("abort", onAbort);
      host.unregister(runId);
      resolve(result);
    };

    host.register(runId, {
      logs,
      onTool: (msg) => {
        pendingTools++;
        disarmWatchdog();
        const tool = toolsByName.get(msg.name);
        void (async () => {
          let reply: ParentToHost;
          try {
            if (!tool) throw new Error(`unknown tool: ${msg.name}`);
            const content = await bridge(tool)(JSON.parse(msg.argsJson) as unknown);
            reply = { type: "toolResult", runId, callId: msg.callId, content };
          } catch (err) {
            reply = { type: "toolResult", runId, callId: msg.callId, error: err instanceof Error ? err.message : String(err) };
          }
          pendingTools--;
          if (settled) return;
          host.send(reply);
          if (pendingTools === 0) armWatchdog();
        })();
      },
      end: (end) => {
        if (end.kind === "done") {
          finish(end.error === undefined
            ? { output: logs.join("\n"), logs, toolCalls, warnings }
            : { output: "", logs, error: end.error, toolCalls, warnings });
        } else if (end.kind === "stopped") {
          finish({ output: "", logs, error: end.error, toolCalls, warnings });
        } else {
          const crashWarnings = recordCrash(opts.ctx.sessionId, end);
          finish({
            output: "",
            logs,
            error: `The code sandbox crashed (${describeExit(end.code, end.signal)}); run the steps as separate tool calls.`,
            toolCalls,
            warnings: [...warnings, ...crashWarnings],
            crashed: true,
          });
        }
      },
    });
    signal?.addEventListener("abort", onAbort, { once: true });

    host.ready.then(
      () => {
        if (settled) return;
        host.send({
          type: "run",
          runId,
          code: js,
          toolNames: opts.tools.map((tool) => tool.name),
          timeoutMs,
          memoryLimitMB: opts.memoryLimitMB ?? 128,
          ...(testHook ? { testHook } : {}),
        });
        armWatchdog();
      },
      () => undefined, // the exit/error handler ends the run
    );
  });
}

const unavailableWarningShownSessions = new Set<string>();
const NO_SESSION_KEY = "__no_session__";

/** @internal Reset the once-per-session warning state for testing. */
export function resetFallbackWarningFlag(): void {
  unavailableWarningShownSessions.clear();
}

let secureSandboxProbe: Promise<string | null> | null = null;

/**
 * Null when the isolated-vm sandbox loads; otherwise why it did not.
 * Probed once per process. Code Mode needs it: Node's built-in `vm` is not
 * a security boundary (`Promise.constructor("return process")()` reaches the
 * host process from inside it), so without isolated-vm Code Mode is turned
 * off and tools are called directly instead.
 */
export function secureSandboxUnavailableReason(): Promise<string | null> {
  secureSandboxProbe ??= loadIsolatedVm().then(
    () => null,
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  return secureSandboxProbe;
}

/** @internal Force the probe result in tests (undefined re-probes). */
export function setSecureSandboxProbeForTesting(reason: string | null | undefined): void {
  secureSandboxProbe = reason === undefined ? null : Promise.resolve(reason);
}

export function buildFallbackWarning(errMessage: string): string {
  if (errMessage.startsWith(CRASH_REASON_PREFIX)) {
    return `Code Mode is off for the rest of this session: ${errMessage}. Tools are called directly instead.`;
  }
  let reason: string;
  let fix: string;

  if (errMessage.includes("No native build was found")) {
    // node-gyp-build: the package is installed but has neither a prebuilt
    // binary for this Node/platform nor one its install script built —
    // npm 11+/12 block dependency install scripts unless allowed.
    reason = "The optional dependency `isolated-vm` has no prebuilt binary for this Node version and platform, and its install script did not run (npm blocks dependency install scripts unless allowed).";
    fix = "Allow its install script and reinstall: `npm config set allow-scripts=isolated-vm`, then `npm install -g autopilot-ai` (or use Node 22 or 24, which have prebuilt binaries).";
  } else if (errMessage.includes("Cannot find module") || errMessage.includes("isolated-vm")) {
    reason = "The optional dependency `isolated-vm` is not installed.";
    fix = "Run `npm install isolated-vm` in your project (or `npm install -g isolated-vm` if Autopilot is installed globally).";
  } else if (errMessage.includes("bindings") || errMessage.includes(".node")) {
    reason = "The `isolated-vm` native bindings are incompatible with this Node version or architecture.";
    fix = "Try `npm rebuild isolated-vm`, or switch to Node 22 LTS if you're on Apple Silicon.";
  } else {
    reason = "The secure sandbox (`isolated-vm`) could not be loaded.";
    fix = "Ensure build tools are installed, then run `npm install isolated-vm`.";
  }

  return `Code Mode is off: it needs the isolated-vm sandbox, and Node's built-in vm cannot contain model-written code. Tools are called directly instead. ${reason} ${fix}`;
}

/** The Code Mode unavailable warning, once per session (null after the first). */
export function takeSandboxUnavailableWarning(sessionId: string | undefined, errMessage: string): string | null {
  const key = sessionId ?? NO_SESSION_KEY;
  if (unavailableWarningShownSessions.has(key)) return null;
  unavailableWarningShownSessions.add(key);
  return buildFallbackWarning(errMessage);
}

/**
 * Run model-written code in the isolated-vm sandbox, in a child process. There
 * is no fallback: if the sandbox cannot run, the code does not run.
 */
export async function runInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  const disabled = codeModeCrashDisabledReason(opts.ctx.sessionId);
  if (disabled) {
    return {
      output: "",
      logs: [],
      error: `Code Mode is off for the rest of this session (${disabled}). Call the tools directly instead.`,
      toolCalls: [],
    };
  }
  // Without isolated-vm (e.g. no prebuilt binary for this Node), don't start a sandbox
  // process just to have it fail on the import: say the sandbox can't run, as before.
  const unavailable = await secureSandboxUnavailableReason();
  if (unavailable) {
    return {
      output: "",
      logs: [],
      error: `The Code Mode sandbox could not run this code: ${unavailable}. Call the tools directly instead.`,
      toolCalls: [],
    };
  }
  try {
    return await runInChildSandbox(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: "",
      logs: [],
      error: `The Code Mode sandbox could not run this code: ${message}. Call the tools directly instead.`,
      toolCalls: [],
    };
  }
}
