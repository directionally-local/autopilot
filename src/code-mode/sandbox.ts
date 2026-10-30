import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
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
  // This works when kimiflare is installed globally or in any project, regardless of cwd.
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

async function transpileOrStrip(code: string, cwd: string): Promise<{ js: string; warnings: string[] }> {
  // Node's built-in type stripper (22.13+): reliable, and no 23 MB
  // typescript dependency in the package. "transform" also handles enums.
  const builtin = (await import("node:module")) as { stripTypeScriptTypes?: (code: string, opts?: { mode?: "strip" | "transform" }) => string };
  if (typeof builtin.stripTypeScriptTypes === "function") {
    try {
      return { js: builtin.stripTypeScriptTypes(code, { mode: "transform" }), warnings: [] };
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
      const invoke = async (): Promise<ToolResult> => {
        const toolCallId = `code_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return opts.executor.run(
          { id: toolCallId, name: tool.name, arguments: JSON.stringify(args ?? {}) },
          opts.askPermission,
          opts.ctx,
        );
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
      return result.content;
    };
}

async function runWithIsolatedVm(opts: SandboxOptions): Promise<SandboxResult> {
  const ivm = await loadIsolatedVm();
  const isolate = new ivm.Isolate({ memoryLimit: opts.memoryLimitMB ?? 128 });
  const context = await isolate.createContext();
  const jail = context.global;
  await jail.set("global", jail.derefInto());

  const logs: string[] = [];
  const toolCalls: SandboxToolCall[] = [];

  // Set up console.log capture
  await context.evalClosure(
    `globalThis._log = function(...args) {
      $0.applySync(undefined, [args.map(String).join(" ")], { arguments: { copy: true } });
    };`,
    [(msg: string) => logs.push(msg)],
    { arguments: { reference: true } },
  );
  await context.eval(`var console = { log: function(...args) { _log(args.map(String).join(" ")); } };`);

  // Build API bindings for each tool
  const bridge = makeToolBridge(opts, toolCalls);

  for (const tool of opts.tools) {
    const call = bridge(tool);
    const host = async (argsJson: string): Promise<string> => call(JSON.parse(argsJson));

    // `arguments.reference` wraps the host function in a Reference. Passing a
    // pre-built `new ivm.Reference(fn)` here would wrap the Reference itself,
    // and `applySyncPromise` would then fail with "Reference is not a function".
    await context.evalClosure(
      `globalThis["_api_${tool.name}"] = function(argsJson) {
        return $0.applySyncPromise(undefined, [argsJson], { arguments: { copy: true } });
      };`,
      [host],
      { arguments: { reference: true } },
    );
  }

  // Build api object
  const apiMethods = opts.tools.map((t) => `  ${t.name}: function(input) { return _api_${t.name}(JSON.stringify(input ?? {})); }`).join(",\n");
  await context.eval(`var api = {\n${apiMethods}\n};`);

  // Compile TS to JS
  const { js: jsCode, warnings } = await transpileOrStrip(opts.code, opts.ctx.cwd);

  // Wrap in async IIFE to support top-level await
  const wrapped = `(async function() {\n${jsCode}\n})();`;

  try {
    const timeout = opts.timeoutMs ?? 30000;
    const script = await isolate.compileScript(wrapped);
    await script.run(context, { timeout, release: true });
    // Wait a tick for any pending promises to settle
    await new Promise((r) => setTimeout(r, 10));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: "", logs, error: message, toolCalls, warnings };
  } finally {
    isolate.dispose();
  }

  return { output: logs.join("\n"), logs, toolCalls, warnings };
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
 * Run model-written code in the isolated-vm sandbox. There is no fallback:
 * if the sandbox cannot run, the code does not run.
 */
export async function runInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  try {
    return await runWithIsolatedVm(opts);
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
