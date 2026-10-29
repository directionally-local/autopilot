/**
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`).
 *
 * We used better-sqlite3 before, which needs an install script to fetch its
 * native binary. npm 12 blocks dependency install scripts on `npm install -g`
 * by default, so the binary went missing and every database open threw. The
 * built-in module ships with every Node line in our `engines`.
 *
 * The wrapper keeps the small part of the better-sqlite3 surface we used, so
 * callers stay close to what they were:
 * - `pragma("name = value")` and `transaction(fn)` (with savepoints when nested);
 * - `undefined` bind parameters become NULL (node:sqlite rejects them), and
 *   empty blobs stay empty blobs on Node 22;
 * - rows come back as plain objects (node:sqlite gives null-prototype objects);
 * - foreign keys are off unless asked for, matching SQLite's own default
 *   (node:sqlite turns them on by default), and the busy timeout is 5s, as
 *   better-sqlite3's was (node:sqlite's is 0).
 *
 * The module is loaded lazily so Node 22's "SQLite is an experimental feature"
 * warning can be filtered out; Node 24 and later print nothing.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, StatementSync } from "node:sqlite";

type SqliteModule = typeof import("node:sqlite");

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, unknown>;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export type SqliteTransaction<A extends unknown[], R> = ((...args: A) => R) & {
  deferred: (...args: A) => R;
  immediate: (...args: A) => R;
  exclusive: (...args: A) => R;
};

export interface SqliteOpenOptions {
  /** Open read-only. */
  readOnly?: boolean;
  /** Enforce foreign keys (SQLite's default, and ours, is off). */
  foreignKeys?: boolean;
  /** Busy timeout in ms (better-sqlite3's default of 5000 is kept). */
  timeout?: number;
}

let sqliteModule: SqliteModule | undefined;

function isSqliteExperimentalWarning(warning: unknown, args: unknown[]): boolean {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  const first = args[0];
  const type =
    typeof first === "string"
      ? first
      : first && typeof first === "object" && "type" in first
        ? String((first as { type?: unknown }).type)
        : warning instanceof Error
          ? warning.name
          : "";
  return type === "ExperimentalWarning" && /SQLite/i.test(message);
}

/** Load `node:sqlite`, swallowing only its experimental warning. */
export function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: unknown, ...args: unknown[]) {
    if (isSqliteExperimentalWarning(warning, args)) return;
    return (original as (...a: unknown[]) => void).call(process, warning, ...args);
  } as typeof process.emitWarning;
  try {
    const require = createRequire(import.meta.url);
    sqliteModule = require("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return sqliteModule;
}

// A zero-length view over a non-empty buffer. Node 22's node:sqlite binds a
// view of a zero-byte ArrayBuffer (e.g. `Buffer.from(new Float32Array(0).buffer)`)
// as NULL instead of an empty blob, which trips NOT NULL columns.
const EMPTY_BLOB = new Uint8Array(new ArrayBuffer(1), 0, 0);

function normalizeParams(params: unknown[]): SqlValue[] {
  return params.map((p) => {
    // node:sqlite rejects undefined; better-sqlite3 bound it as NULL.
    if (p === undefined) return null;
    if (p instanceof Uint8Array && p.byteLength === 0) return EMPTY_BLOB;
    return p;
  }) as SqlValue[];
}

function plainRow(row: unknown): SqlRow | undefined {
  if (row === undefined || row === null) return undefined;
  return { ...(row as SqlRow) };
}

export class SqliteStatement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): SqliteRunResult {
    const result = this.stmt.run(...normalizeParams(params));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  /** One row as a plain object, or undefined. Cast to the row type you expect. */
  get(...params: unknown[]): unknown {
    return plainRow(this.stmt.get(...normalizeParams(params)));
  }

  /** All rows as plain objects. Cast to the row type you expect. */
  all(...params: unknown[]): unknown[] {
    return this.stmt.all(...normalizeParams(params)).map((row) => ({ ...(row as SqlRow) }));
  }
}

export class SqliteDatabase {
  readonly raw: DatabaseSync;
  /** The path the database was opened with. */
  readonly name: string;
  private savepointDepth = 0;

  constructor(path: string, opts: SqliteOpenOptions = {}) {
    const { DatabaseSync } = loadSqlite();
    this.name = path;
    this.raw = new DatabaseSync(path, {
      readOnly: opts.readOnly ?? false,
      enableForeignKeyConstraints: opts.foreignKeys ?? false,
      timeout: opts.timeout ?? 5000,
    });
  }

  get open(): boolean {
    return this.raw.isOpen;
  }

  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw.prepare(sql));
  }

  /**
   * Run a PRAGMA. `pragma("journal_mode = WAL")` sets; `pragma("user_version")`
   * reads. Returns the result rows, or the first column of the first row with
   * `{ simple: true }`.
   */
  pragma(source: string, opts: { simple?: boolean } = {}): unknown {
    const rows = this.prepare(`PRAGMA ${source}`).all() as SqlRow[];
    if (!opts.simple) return rows;
    const first = rows[0];
    return first ? Object.values(first)[0] : undefined;
  }

  /**
   * Wrap `fn` so each call runs in a transaction: BEGIN/COMMIT, ROLLBACK on
   * throw. A call made inside another transaction uses a savepoint instead.
   * Like better-sqlite3, the wrapper also has `.deferred`, `.immediate` and
   * `.exclusive` variants that pick the BEGIN mode.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): SqliteTransaction<A, R> {
    const run = (mode: string) => (...args: A): R => this.runInTransaction(mode, () => fn(...args));
    return Object.assign(run(""), {
      deferred: run(" DEFERRED"),
      immediate: run(" IMMEDIATE"),
      exclusive: run(" EXCLUSIVE"),
    });
  }

  private runInTransaction<R>(mode: string, fn: () => R): R {
    if (this.raw.isTransaction) {
      const name = `sp_${++this.savepointDepth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        this.raw.exec(`ROLLBACK TO ${name}`);
        this.raw.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        this.savepointDepth--;
      }
    }
    this.raw.exec(`BEGIN${mode}`);
    try {
      const result = fn();
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}
