import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

/** Shared retention policy for all on-disk kimiflare data. */
export const RETENTION = {
  /** Session files older than this (days) are pruned. */
  sessionMaxAgeDays: 30,
  /** Max number of session files to keep. */
  sessionMaxCount: 100,
  /** Usage log day entries older than this (days) are pruned. */
  usageDayMaxAgeDays: 90,
  /** Usage log session entries older than this (days) are pruned. */
  usageSessionMaxAgeDays: 30,
  /** Max number of session entries in usage log. */
  usageSessionMaxCount: 200,
  /** Max size of cost-debug JSONL before rotation (bytes). */
  costDebugMaxBytes: 5 * 1024 * 1024,
  /** Number of rotated cost-debug files to keep. */
  costDebugRotations: 2,
  /** Memories older than this (days) are pruned. */
  memoryMaxAgeDays: 90,
  /** Max memories per repo. */
  memoryMaxEntries: 1000,
  /** Session trace directories older than this (days) are pruned. */
  traceMaxAgeDays: 90,
  /** Max total size of all session traces (bytes). Oldest sessions go first. */
  traceMaxTotalBytes: 2 * 1024 * 1024 * 1024,
  /** Max size of a single session trace (bytes); recording stops at the cap. */
  traceMaxSessionBytes: 200 * 1024 * 1024,
} as const;

/** Return files sorted by mtime descending (newest first). */
export async function listFilesByMtime(dir: string, pattern = /.*/): Promise<{ path: string; mtime: Date }[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files: { path: string; mtime: Date }[] = [];
  for (const name of entries) {
    if (!pattern.test(name)) continue;
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.isFile()) files.push({ path: p, mtime: s.mtime });
    } catch {
      /* skip */
    }
  }
  files.sort((a, b) => (b.mtime < a.mtime ? -1 : 1));
  return files;
}

/** Delete files older than maxAgeDays, then enforce maxCount by deleting oldest. */
export async function pruneFiles(
  files: { path: string; mtime: Date }[],
  maxAgeDays: number,
  maxCount: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
  let removed = 0;
  for (const f of files) {
    if (f.mtime < cutoff) {
      try {
        await unlink(f.path);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  const remaining = files.filter((f) => {
    // We don't re-stat; approximate by mtime from original list
    return f.mtime >= cutoff;
  });
  if (remaining.length > maxCount) {
    const toDelete = remaining.slice(maxCount);
    for (const f of toDelete) {
      try {
        await unlink(f.path);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

/** Rotate a JSONL file when it exceeds maxBytes. Keeps N backups. */
export async function rotateJsonl(path: string, maxBytes: number, rotations: number): Promise<void> {
  const { rename } = await import("node:fs/promises");
  let s;
  try {
    s = await stat(path);
  } catch {
    return;
  }
  if (s.size <= maxBytes) return;
  // Shift backups: .2 -> .3, .1 -> .2, etc.
  for (let i = rotations - 1; i >= 1; i--) {
    const src = i === 1 ? path : `${path}.${i - 1}`;
    const dst = `${path}.${i}`;
    try {
      await rename(src, dst);
    } catch {
      /* ignore if src doesn't exist */
    }
  }
}
