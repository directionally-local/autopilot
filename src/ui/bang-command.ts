import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { logger } from "../util/logger.js";

/**
 * `! <command>` in the TUI prompt: run a shell command in the user's real
 * terminal (so logins, password prompts, and interactive programs work) and
 * capture its output for the transcript and the model.
 *
 * Under Camouflage the renderer first suspends itself to lend the terminal
 * (TerminalHandoff below); when it can't, the command runs with its output
 * captured instead. While the command owns the terminal we swallow our own
 * writes to stdout/stderr, detach our stdin listeners and leave raw mode. The
 * child writes straight to the TTY fds, so it is unaffected. Everything is
 * restored when it exits. Output is captured through `script(1)`, which gives
 * the child a real pty; without it (Windows, missing binary) the command
 * still runs interactively but its output isn't captured.
 */

let handedOff = false;

/** True while a `!` command owns the terminal (the app ignores SIGINT then). */
/**
 * A renderer that owns the terminal (Camouflage) and can lend it out.
 * `suspend` resolves false when it can't (Windows, older renderers); the
 * command then runs with its output captured instead of drawn.
 */
export interface TerminalHandoff {
  suspend(): Promise<boolean>;
  resume(): void;
}
let terminalHandoff: TerminalHandoff | null = null;

export function registerTerminalHandoff(h: TerminalHandoff | null): void {
  terminalHandoff = h;
}

/** Run without a terminal: output piped and captured, no prompts. */
function runCaptured(inv: Invocation, cwd: string): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(inv.file, inv.args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: inv.env ?? process.env });
    let output = "";
    child.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
    child.once("error", (e) => resolve({ code: 127, signal: null, output: `failed to start: ${e.message}` }));
    child.once("exit", (code, signal) => resolve({ code, signal, output }));
  });
}

export function isTerminalHandedOff(): boolean {
  return handedOff;
}

/** Returns the command after a leading `!` ("" for a bare `!`), or null if the input isn't a `!` command. */
export function parseBangCommand(input: string): string | null {
  const t = input.trimStart();
  if (!t.startsWith("!")) return null;
  return t.slice(1).trim();
}

export interface BangResult {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Cleaned output, or null when it couldn't be captured. */
  output: string | null;
}

interface Invocation {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/** Build the `script(1)` invocation that runs `command` in a pty and logs to `logPath`. */
export function scriptInvocation(
  command: string,
  shell: string,
  logPath: string,
  plat: NodeJS.Platform = platform(),
): Invocation | null {
  if (plat === "darwin" || plat === "freebsd" || plat === "openbsd" || plat === "netbsd") {
    // BSD: script [-q] file command ...
    return { file: "script", args: ["-q", logPath, shell, "-c", command] };
  }
  if (plat === "linux") {
    // util-linux: script -q -e -c "command" file  (runs $SHELL -c; -e returns the child's exit code)
    return { file: "script", args: ["-q", "-e", "-c", command, logPath], env: { ...process.env, SHELL: shell } };
  }
  return null;
}

/** Strip terminal control sequences from a pty transcript so it reads like plain output. */
export function cleanTerminalOutput(raw: string): string {
  const text = raw
    // OSC (titles, hyperlinks) … BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // CSI sequences (colors, cursor movement, erase)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Other two-char escapes
    .replace(/\x1b[@-Z\\-_]/g, "")
    // util-linux header/footer when -q isn't honored
    .replace(/^Script (?:started|done) on .*$/gm, "");
  const lines = text.split(/\r?\n/).map((line) => {
    // A bare \r returns to column 0 (progress bars): keep the last overwrite.
    const segs = line.split("\r");
    let out = segs[segs.length - 1] ?? "";
    if (!out && segs.length > 1) out = segs.filter(Boolean).pop() ?? "";
    // Apply backspaces, then drop remaining control characters (^D etc.).
    while (/[^\x08]\x08/.test(out)) out = out.replace(/[^\x08]\x08/, "");
    return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const MAX_CONTEXT_CHARS = 16_000;

/** Keep the head and tail of long output. */
export function truncateMiddle(text: string, max = MAX_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n[… ${text.length - max} chars omitted …]\n\n${text.slice(-half)}`;
}

/** The context message the model sees after the user runs a `!` command. */
export function formatBangContext(r: BangResult): string {
  const status = r.signal ? `killed by ${r.signal}` : `exit code ${r.exitCode ?? "?"}`;
  const body =
    r.output === null
      ? "(output was shown in the user's terminal but could not be captured)"
      : r.output
        ? truncateMiddle(r.output)
        : "(no output)";
  return (
    "[The user ran this shell command themselves with `!` in the autopilot prompt. " +
    "This is context for you, not a new request.]\n" +
    `$ ${r.command}\n(${status})\n${body}`
  );
}

type Write = typeof process.stdout.write;

/**
 * Stop Node from reading the TTY so keystrokes reach the child. Removing the
 * 'readable' listener isn't enough: the libuv handle keeps reading (and
 * buffering) until the stream's highWaterMark fills. Node restarts the read
 * by itself (`Socket#_read` → `readStart`) the next time a consumer reads.
 */
export function stopReading(stdin: NodeJS.ReadStream): void {
  stdin.pause();
  const stream = stdin as unknown as {
    _handle?: { reading?: boolean; readStop?: () => number };
    _readableState?: { reading?: boolean };
  };
  try {
    if (stream._handle?.reading && stream._handle.readStop) {
      stream._handle.readStop();
      stream._handle.reading = false;
      // Keep Node's Readable state in sync with the stopped libuv handle.
      // Otherwise reattaching Ink's `readable` listener leaves `reading` true,
      // suppressing _read() forever and making the prompt appear frozen.
      if (stream._readableState) stream._readableState.reading = false;
    }
  } catch {
    // best-effort: worst case the parent competes for a few keystrokes
  }
}

function swallow(): Write {
  return ((_chunk: unknown, encOrCb?: unknown, cb?: unknown) => {
    const done = typeof encOrCb === "function" ? encOrCb : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as Write;
}

function spawnInherit(inv: Invocation, cwd: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(inv.file, inv.args, { cwd, stdio: "inherit", env: inv.env ?? process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

export async function runBangCommand(command: string, cwd: string): Promise<BangResult> {
  const isWindows = platform() === "win32";
  const shell = isWindows ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/sh";
  const direct: Invocation = isWindows
    ? { file: shell, args: ["/c", command] }
    : { file: shell, args: ["-c", command] };

  // Under Camouflage the renderer holds the terminal (raw mode, reading
  // keys); borrow it, or capture the output when it can't be lent.
  if (terminalHandoff && !(await terminalHandoff.suspend())) {
    const r = await runCaptured(direct, cwd);
    return { command, exitCode: r.code, signal: r.signal, output: cleanTerminalOutput(r.output) };
  }

  const stdin = process.stdin;
  const stdout = process.stdout;
  const stderr = process.stderr;
  const origOut = stdout.write;
  const origErr = stderr.write;
  const readable = stdin.listeners("readable") as Array<(...a: unknown[]) => void>;
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;

  const logDir = isWindows ? null : await mkdtemp(join(tmpdir(), "autopilot-bang-"));
  const logPath = logDir ? join(logDir, "out.log") : null;
  const viaScript = logPath ? scriptInvocation(command, shell, logPath) : null;

  // ── Hand the terminal to the child ──
  origOut.call(stdout, `\n$ ${command}\n`);
  stdout.write = swallow();
  stderr.write = swallow();
  for (const l of readable) stdin.removeListener("readable", l);
  if (stdin.isTTY) stdin.setRawMode(false);
  stopReading(stdin);
  handedOff = true;

  let result: { code: number | null; signal: NodeJS.Signals | null };
  let captured = false;
  let spawnError: string | null = null;
  try {
    if (viaScript) {
      try {
        result = await spawnInherit(viaScript, cwd);
        captured = true;
      } catch (e) {
        logger.warn("bang:script_unavailable", { error: (e as Error).message });
        result = await spawnInherit(direct, cwd);
      }
    } else {
      result = await spawnInherit(direct, cwd);
    }
  } catch (e) {
    result = { code: 127, signal: null };
    spawnError = (e as Error).message;
    logger.warn("bang:spawn_failed", { error: spawnError });
  } finally {
    // ── Take the terminal back ──
    handedOff = false;
    stdout.write = origOut;
    stderr.write = origErr;
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    for (const l of readable) stdin.addListener("readable", l);
    origOut.call(stdout, "\n");
    terminalHandoff?.resume();
  }

  let output: string | null = spawnError ? `failed to start: ${spawnError}` : null;
  if (captured && logPath) {
    output = cleanTerminalOutput(await readFile(logPath, "utf8").catch(() => ""));
  }
  if (logDir) await rm(logDir, { recursive: true, force: true }).catch(() => {});
  return { command, exitCode: result.code, signal: result.signal, output };
}
