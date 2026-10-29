/**
 * Discover and read local session traces for `autopilot insights`.
 *
 * Layout: `<root>/<session_id>/trace.jsonl` (see src/trace/paths.ts). A path
 * that is itself a session directory (contains `trace.jsonl`) is accepted too,
 * which makes `--traces <session>` convenient.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { TRACE_FILE_NAME, traceRoot } from "../trace/paths.js";
import type { TraceEvent } from "../trace/types.js";

export interface ScanOpts {
  /** Trace root or a single session directory. Defaults to the configured root. */
  root?: string;
  /** Only sessions whose trace file was modified at or after this time. */
  since?: Date;
  /** Keep at most this many of the most recent sessions. */
  limit?: number;
}

export interface ScannedSession {
  sessionId: string;
  path: string;
  mtimeMs: number;
  events: TraceEvent[];
}

async function readTraceFile(path: string): Promise<TraceEvent[]> {
  const raw = await readFile(path, "utf8");
  const events: TraceEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TraceEvent);
    } catch {
      // A truncated final line (crash) must not hide the rest of the session.
    }
  }
  return events;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function scanTraces(opts: ScanOpts = {}): Promise<ScannedSession[]> {
  const root = traceRoot(opts.root);

  // A single session directory.
  const direct = join(root, TRACE_FILE_NAME);
  if (await isFile(direct)) {
    const info = await stat(direct);
    if (opts.since && info.mtimeMs < opts.since.getTime()) return [];
    const events = await readTraceFile(direct);
    return events.length > 0 ? [{ sessionId: root.split(/[\\/]/).pop() ?? root, path: direct, mtimeMs: info.mtimeMs, events }] : [];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const sessions: ScannedSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, TRACE_FILE_NAME);
    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }
    if (opts.since && info.mtimeMs < opts.since.getTime()) continue;
    const events = await readTraceFile(path);
    if (events.length === 0) continue;
    sessions.push({ sessionId: entry.name, path, mtimeMs: info.mtimeMs, events });
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return opts.limit !== undefined && opts.limit > 0 ? sessions.slice(0, opts.limit) : sessions;
}
