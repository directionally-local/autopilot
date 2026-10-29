import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, createWriteStream, readdirSync, statSync, unlinkSync } from "node:fs";
import type { WriteStream } from "node:fs";
import { readEnv } from "./env.js";

/**
 * File sink for structured logs (M5.1). Writes JSONL lines to
 * `~/.config/kimiflare/logs/<YYYY-MM-DD>.jsonl`, one file per day,
 * with a 7-day retention window pruned on startup.
 *
 * Design notes:
 *   - The file sink is independent of `KIMIFLARE_LOG_LEVEL`, which only
 *     gates stderr output. The file sink is **always on** unless
 *     disabled via `KIMIFLARE_LOG_SINK=off` — log files are
 *     observability infrastructure and should be written even when the
 *     TUI is silent. Disable for tests + the print/RPC modes that
 *     should not touch the user's disk.
 *   - We deliberately do NOT log LLM request/response bodies here.
 *     OpenRouter keeps them per generation (and KIMIFLARE_DUMP_LLM=1
 *     captures full payloads locally on demand); logging every body here
 *     would double disk usage for the loudest event type.
 *     Emit a thin event (`{event: "llm:call", model, request_id, …}`)
 *     and join on `request_id` if you need the body.
 */

const RETENTION_DAYS = 7;

function defaultLogDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "kimiflare", "logs");
}

let overrideDir: string | null = null;
let currentStream: WriteStream | null = null;
let currentDate: string | null = null; // YYYY-MM-DD this stream targets

/** Detect if we're running under Node's test runner so unit tests don't
 *  pollute the user's real `~/.config/kimiflare/logs/` directory. */
function isInNodeTestContext(): boolean {
  if (process.env.NODE_TEST_CONTEXT) return true;
  if (process.env.NODE_ENV === "test") return true;
  // `node --test` and `tsx --test` put "--test" in argv.
  if (process.argv.includes("--test")) return true;
  return false;
}

let sinkEnabled: boolean =
  readEnv("LOG_SINK") !== "off" && !isInNodeTestContext();

/** Resolve the directory new log files land in. Honors a test override. */
export function logDir(): string {
  return overrideDir ?? defaultLogDir();
}

/** Resolve the path of the log file for `date` (default today, UTC). */
export function logPathFor(date: Date = new Date()): string {
  return join(logDir(), `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** Override the log directory. Test-only escape hatch. */
export function setLogDirForTesting(dir: string | null): void {
  if (currentStream) {
    currentStream.end();
    currentStream = null;
    currentDate = null;
  }
  overrideDir = dir;
}

/** Disable the file sink entirely (e.g. for unit tests). */
export function setLogSinkEnabled(enabled: boolean): void {
  if (!enabled && currentStream) {
    currentStream.end();
    currentStream = null;
    currentDate = null;
  }
  sinkEnabled = enabled;
}

/** Test-only: wait for the current stream to flush + close before
 *  resolving. Use this in unit tests that want to readFileSync the log
 *  file after a write — `setLogSinkEnabled(false)` returns synchronously
 *  but the stream's actual flush is async. */
export async function flushAndCloseForTesting(): Promise<void> {
  if (!currentStream) return;
  const s = currentStream;
  currentStream = null;
  currentDate = null;
  await new Promise<void>((resolve) => {
    s.end(() => resolve());
  });
}

export function isLogSinkEnabled(): boolean {
  return sinkEnabled;
}

function ensureStream(now: Date): WriteStream | null {
  if (!sinkEnabled) return null;
  const dateKey = now.toISOString().slice(0, 10);
  if (currentStream && currentDate === dateKey) return currentStream;
  // Rotate on date change (UTC).
  if (currentStream) {
    currentStream.end();
    currentStream = null;
  }
  try {
    mkdirSync(logDir(), { recursive: true });
    currentStream = createWriteStream(logPathFor(now), { flags: "a" });
    currentDate = dateKey;
    // Swallow stream errors — disk-full, permission-denied, etc. must
    // never crash the agent loop.
    currentStream.on("error", () => {
      currentStream = null;
      currentDate = null;
    });
    return currentStream;
  } catch {
    return null;
  }
}

/**
 * Append a single log entry as one JSONL line. Best-effort and silent
 * on failure — the agent loop must not crash because the log file is
 * unwritable.
 */
export function writeLogLine(entry: object, now: Date = new Date()): void {
  const stream = ensureStream(now);
  if (!stream) return;
  try {
    stream.write(JSON.stringify(entry) + "\n");
  } catch {
    // ignore
  }
}

/**
 * Delete log files older than `retentionDays` days. Returns the number
 * of files removed. Called once at startup. Silent on errors.
 */
export function pruneOldLogs(retentionDays: number = RETENTION_DAYS): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(logDir());
  } catch {
    return 0;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(logDir(), name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        removed += 1;
      }
    } catch {
      // ignore individual entry failures
    }
  }
  return removed;
}

// ── Correlation context ──────────────────────────────────────────────────

let currentSessionId: string | null = null;
let currentTurnId: string | null = null;

/** Set the ambient session id stamped onto every log entry. Call once
 *  per session (or `null` to clear). */
export function setLogSessionId(id: string | null): void {
  currentSessionId = id;
}

/** Set the ambient turn id (typically a monotonic counter or a uuid).
 *  Cleared automatically by `setLogSessionId(null)`. */
export function setLogTurnId(id: string | null): void {
  currentTurnId = id;
}

export function getLogSessionId(): string | null {
  return currentSessionId;
}

export function getLogTurnId(): string | null {
  return currentTurnId;
}
