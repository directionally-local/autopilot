/**
 * Report Autopilot's state to herdr (#1103), the terminal multiplexer for
 * coding agents: `working` while a turn runs, `blocked` while waiting on the
 * person (a permission prompt, a plan choice), `idle` when ready for input,
 * and a release when Autopilot exits. Each state report carries the command
 * that reopens this session, so herdr can restore the pane after a restart.
 *
 * Protocol: https://github.com/herdrdev/herdr — docs "Add Herdr support to
 * your agent" and "Socket API › Agent state reporting". The socket takes
 * newline-delimited JSON (`pane.report_agent`, `pane.report_metadata`,
 * `pane.release_agent`); without a socket the same calls go through
 * `$HERDR_BIN_PATH pane report-agent|report-metadata|release-agent`.
 *
 * Outside herdr `getHerdrReporter()` is null and nothing here runs. Inside,
 * reports are fire-and-forget: one in flight at a time, only the latest
 * pending state is sent, each call is bounded by a short timeout, and a
 * failure is logged once and otherwise ignored.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { logger } from "./logger.js";
import { onShutdown } from "./exit.js";

export type HerdrState = "idle" | "working" | "blocked";

/** Stable integration id (must not start with `herdr:`) and the name herdr shows. */
export const HERDR_SOURCE = "autopilot";
export const HERDR_AGENT = "autopilot";
/** Per-call budget; herdr answers locally in a few ms. */
export const HERDR_TIMEOUT_MS = 500;

export interface HerdrEnv {
  paneId: string;
  socketPath?: string;
  binPath?: string;
}

/** The herdr pane this process runs in, or null outside herdr. */
export function detectHerdr(env: NodeJS.ProcessEnv = process.env): HerdrEnv | null {
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) return null;
  // herdr sets HERDR_ENV=1 in its panes; an explicit other value opts out.
  if (env.HERDR_ENV !== undefined && env.HERDR_ENV !== "1") return null;
  const socketPath = env.HERDR_SOCKET_PATH?.trim() || undefined;
  const binPath = env.HERDR_BIN_PATH?.trim() || undefined;
  if (!socketPath && !binPath) return null;
  return { paneId, socketPath, binPath };
}

/** One herdr API call: a socket method name and its params (pane_id included). */
export type HerdrSend = (method: string, params: Record<string, unknown>) => Promise<void>;

/** Send one request over herdr's socket and wait (briefly) for its reply. */
export function socketSend(socketPath: string, timeoutMs = HERDR_TIMEOUT_MS): HerdrSend {
  const endpoint = process.platform === "win32" && !socketPath.startsWith("\\\\") ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  let n = 0;
  return (method, params) =>
    new Promise<void>((resolve, reject) => {
      const id = `${HERDR_SOURCE}:${process.pid}:${++n}`;
      let buf = "";
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        client.destroy();
        if (err) reject(err);
        else resolve();
      };
      const client = createConnection(endpoint, () => {
        client.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      client.setTimeout(timeoutMs, () => done(new Error(`herdr socket timed out after ${timeoutMs}ms`)));
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        try {
          const reply = JSON.parse(buf.slice(0, nl)) as { error?: { code?: string; message?: string } };
          if (reply.error) done(new Error(`herdr ${method}: ${reply.error.code ?? ""} ${reply.error.message ?? ""}`.trim()));
          else done();
        } catch {
          done();
        }
      });
      client.on("error", (err) => done(err));
      client.on("close", () => done());
    });
}

/** The CLI argv for a socket call (`herdr pane report-agent …`). */
export function cliArgs(method: string, params: Record<string, unknown>): string[] {
  const pane = String(params.pane_id);
  const common = ["--source", String(params.source)];
  const seq = params.seq === undefined ? [] : ["--seq", String(params.seq)];
  switch (method) {
    case "pane.report_agent": {
      const args = ["pane", "report-agent", pane, ...common, "--agent", String(params.agent), "--state", String(params.state), ...seq];
      if (typeof params.message === "string") args.push("--message", params.message);
      if (typeof params.agent_session_id === "string") args.push("--agent-session-id", params.agent_session_id);
      if (Array.isArray(params.resume_argv)) args.push("--", ...params.resume_argv.map(String));
      return args;
    }
    case "pane.report_metadata": {
      const args = ["pane", "report-metadata", pane, ...common, ...seq];
      for (const [k, v] of Object.entries((params.tokens ?? {}) as Record<string, string | null>)) {
        if (v === null) args.push("--clear-token", k);
        else args.push("--token", `${k}=${v}`);
      }
      return args;
    }
    case "pane.release_agent":
      return ["pane", "release-agent", pane, ...common, "--agent", String(params.agent), ...seq];
    default:
      throw new Error(`unsupported herdr method ${method}`);
  }
}

/** Run `$HERDR_BIN_PATH pane …` with a timeout. */
export function cliSend(binPath: string, timeoutMs = HERDR_TIMEOUT_MS): HerdrSend {
  return (method, params) =>
    new Promise<void>((resolve, reject) => {
      execFile(binPath, cliArgs(method, params), { timeout: timeoutMs, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
}

/** Socket when it exists, otherwise the CLI. */
export function defaultSend(env: HerdrEnv): HerdrSend {
  if (env.socketPath && (process.platform === "win32" || existsSync(env.socketPath))) return socketSend(env.socketPath);
  if (env.binPath) return cliSend(env.binPath);
  return socketSend(env.socketPath!);
}

/**
 * The command herdr runs to bring this session back after a restart: a plain
 * command name, no apostrophes or control characters (herdr rejects those).
 */
export function resumeArgv(sessionId: string | null | undefined): string[] {
  if (sessionId && /^[\w.:-]{1,200}$/.test(sessionId)) return ["autopilot", "--session", sessionId];
  return ["autopilot", "--continue"];
}

/** First line of a task, trimmed to herdr's 80-character token limit. */
export function summaryToken(task: string): string {
  const line = task.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const clean = line.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

export interface HerdrReportOpts {
  /** Why the agent is blocked (shown by herdr). */
  message?: string;
  /** Current session id; picks the resume command. */
  sessionId?: string | null;
}

interface Job {
  method: string;
  params: Record<string, unknown>;
}

export interface HerdrReporterOptions {
  env: HerdrEnv;
  send?: HerdrSend;
  /** Clock for `seq` (ms); herdr wants it to rise across restarts too. */
  now?: () => number;
}

export class HerdrReporter {
  readonly env: HerdrEnv;
  private readonly send: HerdrSend;
  private readonly now: () => number;
  private seq = 0;
  /** Latest pending job per lane ("state", "meta", "release"); older ones are dropped. */
  private readonly pending = new Map<string, Job>();
  private running: Promise<void> | null = null;
  private last: string | null = null;
  private lastSummary: string | null = null;
  private released = false;
  private warned = false;

  constructor(opts: HerdrReporterOptions) {
    this.env = opts.env;
    this.send = opts.send ?? defaultSend(opts.env);
    this.now = opts.now ?? Date.now;
  }

  /** Report a state; repeated identical reports are skipped. */
  report(state: HerdrState, opts: HerdrReportOpts = {}): void {
    if (this.released) return;
    const resume = resumeArgv(opts.sessionId);
    const key = JSON.stringify([state, opts.message ?? null, resume]);
    if (key === this.last) return;
    this.last = key;
    const params: Record<string, unknown> = { state };
    if (opts.message) params.message = opts.message.slice(0, 200);
    if (resume[1] === "--session") params.agent_session_id = opts.sessionId;
    params.resume_argv = resume;
    this.enqueue("state", { method: "pane.report_agent", params });
  }

  /** Show `summary` (the current task) in herdr's sidebar; empty clears it. */
  setSummary(task: string): void {
    if (this.released) return;
    const value = summaryToken(task);
    if (value === (this.lastSummary ?? "")) return;
    this.lastSummary = value;
    this.enqueue("meta", { method: "pane.report_metadata", params: { tokens: { summary: value || null } } });
  }

  /** Give the pane back to herdr. Resolves once sent (or timed out). */
  release(): Promise<void> {
    if (this.released) return this.idle();
    this.released = true;
    this.pending.clear();
    if (this.lastSummary) this.enqueue("meta", { method: "pane.report_metadata", params: { tokens: { summary: null } } });
    this.enqueue("release", { method: "pane.release_agent", params: {} });
    return this.idle();
  }

  /** Resolves when nothing is in flight or pending. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  private nextSeq(): number {
    // Microsecond-scale clock so a later process always outranks this one.
    this.seq = Math.max(this.seq + 1, Math.floor(this.now() * 1000));
    return this.seq;
  }

  private enqueue(lane: string, job: Job): void {
    this.pending.delete(lane);
    this.pending.set(lane, job);
    if (!this.running) this.running = this.drain().finally(() => (this.running = null));
  }

  private async drain(): Promise<void> {
    for (;;) {
      const next = this.pending.entries().next();
      if (next.done) return;
      const [lane, job] = next.value;
      this.pending.delete(lane);
      const params: Record<string, unknown> = { pane_id: this.env.paneId, source: HERDR_SOURCE };
      if (job.method !== "pane.report_metadata") params.agent = HERDR_AGENT;
      Object.assign(params, job.params, { seq: this.nextSeq() });
      try {
        await this.send(job.method, params);
      } catch (err) {
        if (!this.warned) {
          this.warned = true;
          logger.warn("herdr.report_failed", { method: job.method, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
}

let singleton: HerdrReporter | null | undefined;
/** Set on the reporting process (and so inherited by its children). */
export const HERDR_OWNER_ENV = "AUTOPILOT_HERDR_PANE";
const OWNER_VAR = HERDR_OWNER_ENV;

/**
 * The process-wide reporter, or null outside herdr. The first call inside
 * herdr registers the release with the shutdown tasks.
 */
export function getHerdrReporter(): HerdrReporter | null {
  if (singleton !== undefined) return singleton;
  const env = detectHerdr();
  // An Autopilot started from this one (e.g. `autopilot -p` in a bash tool
  // call) inherits the pane; only the outermost one reports for it.
  const nested = env !== null && process.env[OWNER_VAR] === env.paneId;
  singleton = env && !nested ? new HerdrReporter({ env }) : null;
  if (singleton) {
    process.env[OWNER_VAR] = singleton.env.paneId;
    const reporter = singleton;
    onShutdown("herdr-release", () => reporter.release());
  }
  return singleton;
}

/** Test-only: forget the singleton. */
export function resetHerdrForTesting(): void {
  singleton = undefined;
}

export interface HerdrTuiSnapshot {
  turnRunning: boolean;
  sessionId: string | null | undefined;
  /** Tool waiting for permission, if any. */
  permissionTool: string | null;
  /** A choice is waiting on the person (plan options, plan-complete picker). */
  awaitingChoice: boolean;
  /** Text of the current task, read only when a turn starts. */
  currentTask: () => string | undefined;
}

/** The state the TUI is in, as herdr sees it. */
export function tuiState(s: Pick<HerdrTuiSnapshot, "turnRunning" | "permissionTool" | "awaitingChoice">): { state: HerdrState; message?: string } {
  if (s.permissionTool) return { state: "blocked", message: `Waiting for permission: ${s.permissionTool}` };
  if (s.awaitingChoice) return { state: "blocked", message: "Waiting for a choice" };
  return { state: s.turnRunning ? "working" : "idle" };
}

/** Called on every TUI render; reports only when something changed. */
export function syncHerdrFromTui(s: HerdrTuiSnapshot, reporter: HerdrReporter | null = getHerdrReporter()): void {
  if (!reporter) return;
  const { state, message } = tuiState(s);
  if (state === "working") {
    const task = s.currentTask();
    if (task !== undefined) reporter.setSummary(task);
  }
  reporter.report(state, { message, sessionId: s.sessionId });
}
