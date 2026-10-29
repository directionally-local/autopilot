import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, relative } from "node:path";
import type { LspManager } from "../lsp/manager.js";
import type { Diagnostic } from "../lsp/protocol.js";
import { diagnosticSeverityName } from "../lsp/protocol.js";

/** How long to wait for a language server to publish diagnostics after a change. */
const DEFAULT_LSP_WAIT_MS = 250;
const LSP_POLL_MS = 50;
/** Keep the appended block small: it rides along with every edit/write result. */
const DEFAULT_MAX_CHARS = 2_000;
const DEFAULT_MAX_ITEMS = 20;
const CHECK_TIMEOUT_MS = 3_000;

export interface PostEditDiagnosticsOptions {
  /** The host's language server manager, when it runs one. */
  lsp?: LspManager | null;
  /** Include warnings as well as errors. Default: errors only. */
  includeWarnings?: boolean;
  /** Working directory used to shorten the displayed path. */
  cwd?: string;
  maxChars?: number;
  maxItems?: number;
  lspWaitMs?: number;
  signal?: AbortSignal;
}

/**
 * Collect a compact diagnostics block for a file that was just edited or
 * written. Uses the language server when one is running for the file; otherwise
 * falls back to a fast, dependency-free syntax check. Returns undefined when
 * there is nothing worth reporting, so callers can append unconditionally.
 */
export async function collectPostEditDiagnostics(
  absPath: string,
  opts: PostEditDiagnosticsOptions = {},
): Promise<string | undefined> {
  const resolved = opts.lsp?.resolveClientForPath(absPath);
  if (resolved) {
    const diagnostics = await waitForDiagnostics(resolved.client, absPath, opts);
    const filtered = diagnostics.filter(
      (d) => d.severity === 1 || (opts.includeWarnings === true && d.severity === 2),
    );
    if (filtered.length === 0) return undefined;
    return formatBlock(absPath, filtered.map(formatDiagnostic), opts);
  }
  return syntaxCheck(absPath, opts);
}

async function waitForDiagnostics(
  client: { getDiagnostics(path: string): Diagnostic[] },
  absPath: string,
  opts: PostEditDiagnosticsOptions,
): Promise<Diagnostic[]> {
  const deadline = Date.now() + (opts.lspWaitMs ?? DEFAULT_LSP_WAIT_MS);
  // Give the server one publish cycle first: reading immediately would return
  // the diagnostics cached for the pre-edit document.
  await delay(LSP_POLL_MS);
  for (;;) {
    const diagnostics = client.getDiagnostics(absPath);
    if (diagnostics.length > 0 || Date.now() >= deadline || opts.signal?.aborted) return diagnostics;
    await delay(LSP_POLL_MS);
  }
}

function formatDiagnostic(d: Diagnostic): string {
  const severity = diagnosticSeverityName(d.severity);
  const code = d.code !== undefined ? ` [${d.code}]` : "";
  const source = d.source ? ` (${d.source})` : "";
  return `${severity}${code}${source} — line ${d.range.start.line + 1}: ${d.message}`;
}

function formatBlock(absPath: string, lines: string[], opts: PostEditDiagnosticsOptions): string {
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;
  const shown = lines.slice(0, maxItems);
  const omitted = lines.length - shown.length;
  if (omitted > 0) shown.push(`… ${omitted} more`);
  const display = opts.cwd ? relative(opts.cwd, absPath) || absPath : absPath;
  const body = shown.join("\n");
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const capped = body.length > maxChars ? `${body.slice(0, maxChars)}\n… truncated` : body;
  return `<diagnostics path="${display}">\n${capped}\n</diagnostics>`;
}

/** Fast syntax check for languages we can validate without extra dependencies. */
async function syntaxCheck(absPath: string, opts: PostEditDiagnosticsOptions): Promise<string | undefined> {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".json") {
    try {
      JSON.parse(await readFile(absPath, "utf8"));
      return undefined;
    } catch (e) {
      return formatBlock(absPath, [`error — ${(e as Error).message}`], opts);
    }
  }

  const check = checkCommandFor(ext);
  if (!check) return undefined;
  const result = await runCheck(check.command, [...check.args, absPath], opts.cwd, opts.signal);
  const stderr = result.stderr.trim();
  // A missing checker (ENOENT) is not a problem with the edited file.
  if (result.code === 0 || result.code === null || !stderr) return undefined;
  return formatBlock(absPath, stderr.split("\n").map((line) => `error — ${line}`), opts);
}

function checkCommandFor(ext: string): { command: string; args: string[] } | undefined {
  switch (ext) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return { command: process.execPath, args: ["--check"] };
    case ".py":
    case ".pyi":
      return { command: "python3", args: ["-m", "py_compile"] };
    case ".sh":
    case ".bash":
      return { command: "bash", args: ["-n"] };
    default:
      // TypeScript/TSX have no dependency-free checker; the LSP covers them.
      return undefined;
  }
}

function runCheck(
  command: string,
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_TIMEOUT_MS);
    timer.unref();
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Not unref'd: the debounce must keep the loop alive until it resolves.
    setTimeout(resolve, ms);
  });
}
