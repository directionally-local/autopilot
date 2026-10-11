/**
 * Content-addressed blob store for one session's trace.
 *
 * `put(content)` writes `<dir>/<sha256>` once per distinct content and
 * returns the sha. Content longer than `maxBlobBytes` is cut at the cap and
 * suffixed with `\n[truncated: N bytes total]`; the sha is of the bytes
 * actually stored, so a file always hashes to its own name.
 *
 * The store throws on disk errors; the recorder catches, warns once and
 * disables itself (see recorder.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Default per-blob cap: 2 MB. */
export const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;

export interface BlobPutResult {
  sha256: string;
  /** Byte length of the original content, before any truncation. */
  bytes: number;
  truncated: boolean;
  /** Byte length written to disk (0 when the blob already existed). */
  written: number;
}

export interface BlobStoreOptions {
  maxBlobBytes?: number;
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Cut `content` so its UTF-8 encoding fits in `maxBytes`, never splitting a code point. */
export function truncateUtf8(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return content;
  let end = maxBytes;
  // Back up over continuation bytes (10xxxxxx) so we don't cut a code point.
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8");
}

export class BlobStore {
  private readonly seen = new Set<string>();
  private dirReady = false;
  readonly maxBlobBytes: number;

  constructor(
    readonly dir: string,
    opts: BlobStoreOptions = {},
  ) {
    this.maxBlobBytes = opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  }

  put(content: string): BlobPutResult {
    const bytes = Buffer.byteLength(content, "utf8");
    let stored = content;
    let truncated = false;
    if (bytes > this.maxBlobBytes) {
      stored = `${truncateUtf8(content, this.maxBlobBytes)}\n[truncated: ${bytes} bytes total]`;
      truncated = true;
    }
    const sha256 = sha256Hex(stored);
    if (this.seen.has(sha256)) return { sha256, bytes, truncated, written: 0 };

    if (!this.dirReady) {
      mkdirSync(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const path = join(this.dir, sha256);
    let written = 0;
    if (!existsSync(path)) {
      writeFileSync(path, stored, "utf8");
      written = Buffer.byteLength(stored, "utf8");
    }
    this.seen.add(sha256);
    return { sha256, bytes, truncated, written };
  }

  has(sha256: string): boolean {
    return this.seen.has(sha256) || existsSync(join(this.dir, sha256));
  }

  pathFor(sha256: string): string {
    return join(this.dir, sha256);
  }
}
