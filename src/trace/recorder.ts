/**
 * Append-only session trace recorder.
 *
 * `createRecorder({ enabled, sessionId, root })` returns a recorder that is
 * a no-op unless `enabled` is true. When enabled it appends one JSON line
 * per event to `<sessionTraceDir>/trace.jsonl` with `appendFileSync` and
 * stores large bodies in a content-addressed blob store (blobs.ts).
 *
 * Guarantees:
 *   - Never throws. The first disk error is logged once via
 *     `logger.warn("trace:write_failed")` and the recorder disables itself
 *     for the rest of the session.
 *   - Nothing is created on disk until the first event or blob, so a
 *     disabled recorder (or an enabled one that never emits) leaves no trace
 *     directory behind.
 *   - Every string that hits disk goes through `redactLight` first.
 *   - A session stops recording (with one warning) once it has written
 *     `RETENTION.traceMaxSessionBytes`.
 *   - Reopening a session that already has a trace.jsonl (resume,
 *     `--continue`, checkpoint restore) appends: `seq` continues from the
 *     number of lines already on disk.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import { logger } from "../util/logger.js";
import { getLogTurnId } from "../util/log-sink.js";
import { RETENTION } from "../storage-limits.js";
import { BlobStore, sha256Hex, type BlobStoreOptions } from "./blobs.js";
import { blobsDir, sessionTraceDir, traceFilePath } from "./paths.js";
import { redactDeep, redactLight } from "./redact.js";
import { TRACE_SCHEMA_VERSION, type PayloadFor, type TraceEvent, type TraceEventType } from "./types.js";

export interface TraceRecorder {
  readonly enabled: boolean;
  /** Session id this recorder writes under. */
  readonly sessionId: string;
  /** Absolute session trace directory, or null when disabled. */
  readonly dir: string | null;
  /**
   * Append one event. `turnId` defaults to the ambient turn id from the
   * structured logger (`getLogTurnId()`), or null when there is none.
   */
  emit<T extends TraceEventType>(type: T, payload: PayloadFor<T>, turnId?: string | null): void;
  /** Store `content` (redacted) in the blob store. Returns its sha, or null when disabled. */
  blob(content: string): string | null;
  /** Resolve once every pending write is on disk. Writes are synchronous, so this is immediate. */
  flush(): Promise<void>;
}

export interface CreateRecorderOptions extends BlobStoreOptions {
  enabled: boolean;
  sessionId: string;
  /** Trace root override; env `KIMIFLARE_TRACE_DIR` still wins (see paths.ts). */
  root?: string | null;
  /** Per-session byte cap; defaults to RETENTION.traceMaxSessionBytes. */
  maxSessionBytes?: number;
}

class NoopRecorder implements TraceRecorder {
  readonly enabled = false;
  readonly dir = null;
  constructor(readonly sessionId: string) {}
  emit(): void {
    /* disabled */
  }
  blob(): null {
    return null;
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/** A recorder that drops everything. Safe to share. */
export function createNoopRecorder(sessionId = ""): TraceRecorder {
  return new NoopRecorder(sessionId);
}

/** Mint a turn id. Hosts pass it to `runAgentTurn` so every event of a turn shares it. */
export function makeTurnId(): string {
  return randomUUID();
}

export interface MemoryTraceRecorder extends TraceRecorder {
  readonly events: TraceEvent[];
  readonly blobs: Map<string, string>;
  /** Content of a blob by sha, or undefined. */
  blobText(sha: string | null | undefined): string | undefined;
  /** Events of one type, payloads typed. */
  ofType<T extends TraceEventType>(type: T): Array<TraceEvent<T>>;
}

class InMemoryRecorder implements MemoryTraceRecorder {
  readonly enabled = true;
  readonly dir = null;
  readonly events: TraceEvent[] = [];
  readonly blobs = new Map<string, string>();
  private seq = 0;
  constructor(readonly sessionId: string) {}
  emit<T extends TraceEventType>(type: T, payload: PayloadFor<T>, turnId?: string | null): void {
    this.events.push({
      v: TRACE_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      seq: this.seq++,
      session_id: this.sessionId,
      turn_id: turnId === undefined ? getLogTurnId() : turnId,
      type,
      payload: redactDeep(payload),
    } as TraceEvent<T>);
  }
  blob(content: string): string {
    const redacted = redactLight(content);
    const sha = sha256Hex(redacted);
    if (!this.blobs.has(sha)) this.blobs.set(sha, redacted);
    return sha;
  }
  blobText(sha: string | null | undefined): string | undefined {
    return sha ? this.blobs.get(sha) : undefined;
  }
  ofType<T extends TraceEventType>(type: T): Array<TraceEvent<T>> {
    return this.events.filter((e): e is TraceEvent<T> => e.type === type);
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

/** An enabled recorder that keeps everything in memory. For tests and in-process consumers. */
export function createMemoryRecorder(sessionId = "memory"): MemoryTraceRecorder {
  return new InMemoryRecorder(sessionId);
}

class FileTraceRecorder implements TraceRecorder {
  enabled = true;
  readonly dir: string;
  private readonly file: string;
  private readonly blobs: BlobStore;
  private readonly maxSessionBytes: number;
  private seq = 0;
  private bytesWritten = 0;
  private dirReady = false;

  constructor(
    readonly sessionId: string,
    dir: string,
    opts: { maxBlobBytes?: number; maxSessionBytes?: number },
  ) {
    this.dir = dir;
    this.file = traceFilePath(dir);
    this.blobs = new BlobStore(blobsDir(dir), { maxBlobBytes: opts.maxBlobBytes });
    this.maxSessionBytes = opts.maxSessionBytes ?? RETENTION.traceMaxSessionBytes;
  }

  emit<T extends TraceEventType>(type: T, payload: PayloadFor<T>, turnId?: string | null): void {
    if (!this.enabled) return;
    try {
      const event: TraceEvent<T> = {
        v: TRACE_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        seq: this.seq,
        session_id: this.sessionId,
        turn_id: turnId === undefined ? getLogTurnId() : turnId,
        type,
        payload: redactDeep(payload),
      } as TraceEvent<T>;
      if (!this.dirReady) {
        mkdirSync(this.dir, { recursive: true });
        this.dirReady = true;
        this.resumeSeq();
        event.seq = this.seq;
      }
      const line = JSON.stringify(event) + "\n";
      if (!this.ensureBudget(Buffer.byteLength(line, "utf8"))) return;
      appendFileSync(this.file, line, "utf8");
      this.seq++;
    } catch (err) {
      this.fail(err);
    }
  }

  blob(content: string): string | null {
    if (!this.enabled) return null;
    try {
      const result = this.blobs.put(redactLight(content));
      // A blob that crosses the cap is already on disk: return its sha so the
      // event referencing it stays consistent; nothing further is recorded.
      if (result.written > 0) this.ensureBudget(result.written);
      return result.sha256;
    } catch (err) {
      this.fail(err);
      return null;
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  /** Continue `seq` after the lines already in an existing trace file. */
  private resumeSeq(): void {
    if (!existsSync(this.file)) return;
    const existing = readFileSync(this.file, "utf8");
    let lines = 0;
    for (let i = 0; i < existing.length; i++) if (existing.charCodeAt(i) === 10) lines++;
    this.seq = lines;
    this.bytesWritten += Buffer.byteLength(existing, "utf8");
  }

  /** Account for `bytes`; returns false (and disables) once the session cap is exceeded. */
  private ensureBudget(bytes: number): boolean {
    this.bytesWritten += bytes;
    if (this.bytesWritten > this.maxSessionBytes) {
      this.enabled = false;
      logger.warn("trace:session_cap", {
        session_id: this.sessionId,
        dir: this.dir,
        max_bytes: this.maxSessionBytes,
      });
      return false;
    }
    return true;
  }

  private fail(err: unknown): void {
    this.enabled = false;
    logger.warn("trace:write_failed", {
      session_id: this.sessionId,
      dir: this.dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build the recorder for a session. Disabled recorders cost nothing and
 * touch nothing on disk.
 */
export function createRecorder(opts: CreateRecorderOptions): TraceRecorder {
  if (!opts.enabled) return new NoopRecorder(opts.sessionId);
  const dir = sessionTraceDir(opts.sessionId, opts.root);
  return new FileTraceRecorder(opts.sessionId, dir, {
    maxBlobBytes: opts.maxBlobBytes,
    maxSessionBytes: opts.maxSessionBytes,
  });
}
