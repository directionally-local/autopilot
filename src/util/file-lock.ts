import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/**
 * In-process, per-path async mutex for tools that read-modify-write files.
 *
 * Two concurrent `edit` calls against the same file (e.g. `Promise.all` inside
 * an `execute_code` block) would otherwise both read the same base image and
 * the last `writeFile` would silently drop the other's change. Serializing per
 * resolved path makes each call see the previous call's result.
 */
const tails = new Map<string, Promise<unknown>>();

/** Lock key for a path: its realpath when it exists (so symlinks share a key). */
export async function lockKeyFor(absPath: string): Promise<string> {
  const absolute = resolve(absPath);
  try {
    return await realpath(absolute);
  } catch {
    // Canonicalize through the nearest existing parent so a missing path
    // below a symlink gets the same key before and after it is created.
    const suffix: string[] = [];
    let cursor = absolute;
    while (true) {
      const parent = dirname(cursor);
      suffix.unshift(basename(cursor));
      try {
        return join(await realpath(parent), ...suffix);
      } catch {
        if (parent === cursor) return absolute;
        cursor = parent;
      }
    }
  }
}

export async function withFileLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKeyFor(absPath);
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** @internal Number of paths currently holding or waiting on a lock. */
export function pendingLockCount(): number {
  return tails.size;
}
