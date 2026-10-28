/**
 * Trace housekeeping: list session trace directories and, on request,
 * delete the ones older than a cutoff. Nothing here runs automatically.
 *
 * Age is by last write to the session's trace.jsonl (falling back to
 * the directory mtime), so an active session counts as new.
 */

import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { TRACE_FILE_NAME, traceRoot } from "./paths.js";

export interface TraceSessionInfo {
  sessionId: string;
  path: string;
  /** Last activity (trace.jsonl mtime, else directory mtime). */
  mtime: Date;
  bytes: number;
}

export interface PruneTracesOptions {
  /** Trace root; defaults to `traceRoot()`. */
  root?: string | null;
  /** Delete sessions whose last write is older than this many days. */
  olderThanDays: number;
  now?: number;
}

export interface PruneTracesResult {
  removed: string[];
  keptBytes: number;
}

export async function dirSize(path: string): Promise<number> {
  let total = 0;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const p = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else if (entry.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

/** List session trace directories under `root`, newest first. */
export async function listTraceSessions(root?: string | null): Promise<TraceSessionInfo[]> {
  const base = traceRoot(root);
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return [];
  }
  const sessions: TraceSessionInfo[] = [];
  for (const name of names) {
    const path = join(base, name);
    try {
      const s = await stat(path);
      if (!s.isDirectory()) continue;
      let mtime = s.mtime;
      try {
        mtime = (await stat(join(path, TRACE_FILE_NAME))).mtime;
      } catch {
        /* no trace file yet; use the directory mtime */
      }
      sessions.push({ sessionId: name, path, mtime, bytes: await dirSize(path) });
    } catch {
      /* skip unreadable entries */
    }
  }
  sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return sessions;
}

/**
 * Delete session trace directories not written to in `olderThanDays`. Only
 * runs when the user asks (`autopilot history prune`). Never throws.
 */
export async function pruneTraces(opts: PruneTracesOptions): Promise<PruneTracesResult> {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.olderThanDays * 24 * 60 * 60 * 1000;

  const removed: string[] = [];
  let sessions: TraceSessionInfo[];
  try {
    sessions = await listTraceSessions(opts.root);
  } catch {
    return { removed, keptBytes: 0 };
  }

  let keptBytes = 0;
  for (const s of sessions) {
    if (s.mtime.getTime() >= cutoff) {
      keptBytes += s.bytes;
      continue;
    }
    try {
      await rm(s.path, { recursive: true, force: true });
      removed.push(s.sessionId);
    } catch {
      keptBytes += s.bytes;
    }
  }

  return { removed, keptBytes };
}
