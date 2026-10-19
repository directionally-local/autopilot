import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { lockKeyFor } from "./file-lock.js";

/**
 * Write `content` to `absPath` so that readers never observe a partial image,
 * then read it back and confirm the bytes on disk are what we meant to write.
 *
 * Strategy: write a sibling temp file and `rename` it over the target (atomic on
 * POSIX). The write goes to the symlink's target, not the link, so symlinked
 * sources keep working. When rename is not possible (e.g. no write permission on
 * the directory) fall back to an in-place write, still followed by verification.
 */
export async function writeFileVerified(absPath: string, content: string): Promise<void> {
  const target = await lockKeyFor(absPath);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    /* new file */
  }

  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  try {
    await writeFile(tmp, content, "utf8");
    // The umask applies to the temp file's creation mode; restore the
    // original permissions explicitly so an executable stays executable.
    if (mode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target);
  } catch {
    await unlink(tmp).catch(() => undefined);
    await writeFile(target, content, "utf8");
  }

  const onDisk = await readFile(target, "utf8");
  if (onDisk !== content) {
    throw new Error(`write verification failed for ${absPath}: file on disk does not match the intended content`);
  }
}
