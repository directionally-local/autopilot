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
 * every session silently fell back to node:vm.
 */
async function loadIsolatedVm(): Promise<typeof import("isolated-vm")> {
  const mod = (await import("isolated-vm")) as typeof import("isolated-vm") & { default?: typeof import("isolated-vm") };
  const ivm = mod.default?.Isolate ? mod.default : mod;
  if (typeof ivm.Isolate !== "function") throw new Error("isolated-vm loaded but exposes no Isolate constructor");
  return ivm;
}

/**
 * Tool calls from inside a script. Read-only (or explicitly concurrent) tools
 * may overlap, but mutating tools run one at a time in call order — the same
 * rule the standard agent loop applies to direct tool calls. Without this,
 * `Promise.all([api.edit(f, …), api.edit(f, …)])` on the node:vm backend ran
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

async function runWithNodeVm(opts: SandboxOptions): Promise<SandboxResult> {
  const { runInNewContext } = await import("node:vm");

  const logs: string[] = [];
  const toolCalls: SandboxToolCall[] = [];

  const sandbox: Record<string, unknown> = {
    console: {
      log: (...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      },
    },
    api: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    Infinity,
    NaN,
    undefined,
  };

  // Build API bindings
  const bridge = makeToolBridge(opts, toolCalls);
  for (const tool of opts.tools) {
    const call = bridge(tool);
    (sandbox.api as Record<string, unknown>)[tool.name] = (input?: unknown): Promise<string> => call(input ?? {});
  }

  const { js: jsCode, warnings } = await transpileOrStrip(opts.code, opts.ctx.cwd);
  const wrapped = `"use strict";\n(async function() {\n${jsCode}\n})();`;

  try {
    const timeout = opts.timeoutMs ?? 30000;
    await runInNewContext(wrapped, sandbox, { timeout, displayErrors: true });
    // Wait a tick for pending promises
    await new Promise((r) => setTimeout(r, 10));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { output: "", logs, error: message, toolCalls, warnings };
  }

  return { output: logs.join("\n"), logs, toolCalls, warnings };
}

const fallbackWarningShownSessions = new Set<string>();
const NO_SESSION_KEY = "__no_session__";

/** @internal Reset the fallback warning state for testing. */
export function resetFallbackWarningFlag(): void {
  fallbackWarningShownSessions.clear();
}

export function buildFallbackWarning(errMessage: string): string {
  let reason: string;
  let fix: string;

  if (errMessage.includes("Cannot find module") || errMessage.includes("isolated-vm")) {
    reason = "The optional dependency `isolated-vm` is not installed.";
    fix = "Run `npm install isolated-vm` in your project (or `npm install -g isolated-vm` if KimiFlare is installed globally).";
  } else if (errMessage.includes("bindings") || errMessage.includes(".node")) {
    reason = "The `isolated-vm` native bindings are incompatible with this Node version or architecture.";
    fix = "Try `npm rebuild isolated-vm`, or switch to Node 22 LTS if you're on Apple Silicon.";
  } else {
    reason = "The secure sandbox (`isolated-vm`) could not be loaded.";
    fix = "Ensure build tools are installed, then run `npm install isolated-vm`.";
  }

  return `Code Mode is using the built-in Node.js sandbox. Tool execution works normally, but without memory limits or full process isolation. ${reason} ${fix}`;
}

export async function runInSandbox(opts: SandboxOptions): Promise<SandboxResult> {
  try {
    return await runWithIsolatedVm(opts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const result = await runWithNodeVm(opts);

    // Emit the fallback warning once per session — new sessions in the same
    // process (common when embedded via SDK) still see it.
    const sessionKey = opts.ctx.sessionId ?? NO_SESSION_KEY;
    if (!fallbackWarningShownSessions.has(sessionKey)) {
      fallbackWarningShownSessions.add(sessionKey);
      const warning = buildFallbackWarning(message);
      return { ...result, warnings: [warning, ...(result.warnings ?? [])] };
    }

    return result;
  }
}
