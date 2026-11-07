import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Write a file so readers never see a partial result: write a sibling temp
 * file, then rename it over the target. rename() is atomic on the same
 * filesystem, so a concurrent reader gets either the old or the new contents.
 */
export async function writeFileAtomic(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    // `mode` applies to the temp file at creation, so the target never exists
    // with wider permissions, even for a moment.
    await writeFile(tmp, data, mode === undefined ? "utf8" : { encoding: "utf8", mode });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const LOCK_STALE_MS = 15_000;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 25;

/**
 * Cross-process mutex backed by an exclusive mkdir. Several autopilot
 * sessions share usage.json, and an in-process promise chain alone let them
 * interleave writes. A lock left behind by a crashed process is broken after
 * LOCK_STALE_MS. If the lock can't be taken within LOCK_WAIT_MS we run `fn`
 * anyway: losing a usage update is better than stalling the agent.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      await mkdir(lockPath);
      held = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") break;
      const age = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (held) await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Salvage a JSON document that has trailing garbage, which is what an
 * interleaved non-atomic write leaves behind. Tries successively shorter
 * prefixes ending at a closing brace and returns the first that parses.
 */
export function recoverJsonPrefix(raw: string): unknown | undefined {
  for (let i = raw.lastIndexOf("}"); i > 0; i = raw.lastIndexOf("}", i - 1)) {
    try {
      return JSON.parse(raw.slice(0, i + 1));
    } catch {
      /* keep shortening */
    }
  }
  return undefined;
}
