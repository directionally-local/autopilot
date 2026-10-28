/**
 * Local session history: saved sessions (and their JSONL transcripts) plus
 * session traces. Autopilot never deletes these on its own; once they grow
 * past `HISTORY_HINT_BYTES`, startup shows a hint pointing at
 * `autopilot history` (see what's there) and `autopilot history prune`
 * (free the space).
 */

import { formatBytes } from "./agent/request-size.js";
import { sessionsDir } from "./sessions.js";
import { listFilesByMtime } from "./storage-limits.js";
import { dirSize, listTraceSessions } from "./trace/retention.js";
import { traceRoot } from "./trace/paths.js";

/** Total local history size at which startup mentions it. */
export const HISTORY_HINT_BYTES = 1024 * 1024 * 1024;

export interface LocalHistoryUsage {
  sessionsDir: string;
  sessionCount: number;
  sessionBytes: number;
  tracesDir: string;
  traceCount: number;
  traceBytes: number;
  totalBytes: number;
  /** Oldest last-write across sessions and traces, if any exist. */
  oldest: Date | null;
}

export async function localHistoryUsage(traceRootOverride?: string | null): Promise<LocalHistoryUsage> {
  const sDir = sessionsDir();
  const sessions = await listFilesByMtime(sDir, /\.json$/);
  let sessionBytes = 0;
  try {
    sessionBytes = await dirSize(sDir);
  } catch {
    /* no sessions yet */
  }
  const tDir = traceRoot(traceRootOverride);
  const traces = await listTraceSessions(traceRootOverride);
  const traceBytes = traces.reduce((sum, t) => sum + t.bytes, 0);
  const mtimes = [...sessions, ...traces].map((x) => x.mtime.getTime());
  return {
    sessionsDir: sDir,
    sessionCount: sessions.length,
    sessionBytes,
    tracesDir: tDir,
    traceCount: traces.length,
    traceBytes,
    totalBytes: sessionBytes + traceBytes,
    oldest: mtimes.length > 0 ? new Date(Math.min(...mtimes)) : null,
  };
}

/** The startup hint, or null while history is under the threshold. */
export function historyHint(usage: LocalHistoryUsage, threshold = HISTORY_HINT_BYTES): string | null {
  if (usage.totalBytes < threshold) return null;
  return (
    `Your local session history is ${formatBytes(usage.totalBytes)} ` +
    `(${usage.sessionCount} sessions, ${usage.traceCount} traces). Autopilot keeps it so you can analyze your usage: ` +
    "`autopilot history` shows where it lives. To free space, run `autopilot history prune --older-than <days>`."
  );
}

/** Multi-line summary for `autopilot history`. */
export function formatHistoryUsage(usage: LocalHistoryUsage): string {
  const lines = [
    `sessions  ${String(usage.sessionCount).padStart(5)}  ${formatBytes(usage.sessionBytes).padStart(9)}  ${usage.sessionsDir}`,
    `traces    ${String(usage.traceCount).padStart(5)}  ${formatBytes(usage.traceBytes).padStart(9)}  ${usage.tracesDir}`,
    `total            ${formatBytes(usage.totalBytes).padStart(9)}`,
  ];
  if (usage.oldest) lines.push(`oldest: ${usage.oldest.toISOString().slice(0, 10)}`);
  return lines.join("\n");
}
