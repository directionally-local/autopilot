import Database from "better-sqlite3";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync, existsSync, statSync, closeSync, appendFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type JobStatus = "starting" | "running" | "cancelling" | "completed" | "failed" | "timed_out" | "cancelled" | "unknown";
export type JobStream = "stdout" | "stderr";

export interface JobRecord {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  pid: number | null;
  pgid: number | null;
  processStartTime: string | null;
  createdAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  stdoutPath: string;
  stderrPath: string;
  idempotencyKey: string | null;
  /** The Autopilot session that started it; null for jobs started before sessions were recorded. */
  sessionId: string | null;
}

export interface StartJobOptions {
  command: string;
  cwd: string;
  shell: string;
  shellArgs: string[];
  timeoutMs?: number;
  idempotencyKey?: string;
  sessionId?: string;
}

export interface JobLogResult {
  content: string;
  offset: number;
  size: number;
  truncated: boolean;
}

interface JobRow extends Record<string, unknown> {
  id: string;
  command: string;
  cwd: string;
  status: JobStatus;
  pid: number | null;
  pgid: number | null;
  process_start_time: string | null;
  created_at: number;
  finished_at: number | null;
  exit_code: number | null;
  stdout_path: string;
  stderr_path: string;
  exit_path: string;
  pid_path: string;
  timeout_ms: number | null;
  idempotency_key: string | null;
  session_id: string | null;
}

const MAX_LOG_BYTES = 64 * 1024;
const JOB_WRAPPER = String.raw`
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
const spec = JSON.parse(process.argv[1]);
process.title = 'autopilot-job-' + spec.id;
const tempExitPath = spec.exitPath + '.tmp';
let timedOut = false;
let child;
function writeExit(code, signal, timeout) {
  try {
    writeFileSync(tempExitPath, JSON.stringify({ code, signal, timedOut: timeout }) + '\n');
    renameSync(tempExitPath, spec.exitPath);
  } catch {}
}
writeFileSync(spec.pidPath, String(process.pid));
const stdoutFd = openSync(spec.stdoutPath, 'a', 0o600);
const stderrFd = openSync(spec.stderrPath, 'a', 0o600);
try {
  child = spawn(spec.shell, [...spec.shellArgs, spec.command], {
    cwd: spec.cwd,
    env: process.env,
    stdio: ['ignore', stdoutFd, stderrFd],
  });
} catch (error) {
  writeExit(127, null, false);
  closeSync(stdoutFd);
  closeSync(stderrFd);
  process.exit(0);
}
closeSync(stdoutFd);
closeSync(stderrFd);
let timeout;
if (spec.timeoutMs) {
  timeout = setTimeout(() => {
    timedOut = true;
    // Persist the reason before signalling the process group: this wrapper
    // belongs to that group and may itself receive the signal.
    writeExit(124, null, true);
    try { process.kill(-process.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    }, 1500);
  }, spec.timeoutMs);
  timeout.unref();
}
process.on('SIGTERM', () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch {}
  }
});
process.on('SIGINT', () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGINT'); } catch {}
  }
});
child.on('error', (error) => {
  if (!timedOut) writeExit(127, null, false);
  try { appendFileSync(spec.stderrPath, String(error) + '\n'); } catch {}
});
child.on('close', (code, signal) => {
  if (timeout) clearTimeout(timeout);
  if (timedOut) return;
  writeExit(code, signal, false);
  process.exit(0);
});
`;

/**
 * Durable, local process-group jobs. Each manager instance owns its SQLite
 * connection; create a fresh instance after a process restart to reconcile jobs.
 */
export class JobManager {
  private readonly db: Database.Database;
  private readonly jobsDir: string;

  constructor(dbPath = defaultJobDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.jobsDir = join(dirname(dbPath), "jobs");
    mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        pid INTEGER,
        pgid INTEGER,
        process_start_time TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        exit_code INTEGER,
        stdout_path TEXT NOT NULL,
        stderr_path TEXT NOT NULL,
        exit_path TEXT NOT NULL,
        pid_path TEXT NOT NULL,
        timeout_ms INTEGER,
        idempotency_key TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
        ON jobs(cwd, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
    `);
    // Databases from before jobs recorded their session gain the column in place.
    const columns = this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "session_id")) this.db.exec("ALTER TABLE jobs ADD COLUMN session_id TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(session_id, created_at)");
    this.reconcile();
  }

  close(): void {
    this.db.close();
  }

  start(options: StartJobOptions): JobRecord {
    if (process.platform === "win32") {
      throw new Error("Managed jobs currently require macOS or Linux (POSIX process groups).");
    }
    const command = options.command.trim();
    if (!command) throw new Error("command must not be empty");
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 7 * 24 * 60 * 60 * 1000)) {
      throw new Error("timeout_ms must be an integer from 1000 through 604800000");
    }
    if (options.idempotencyKey !== undefined && (!options.idempotencyKey.trim() || options.idempotencyKey.length > 128)) {
      throw new Error("idempotency_key must contain 1–128 characters");
    }

    this.reconcile();
    if (options.idempotencyKey) {
      const existing = this.db.prepare("SELECT * FROM jobs WHERE cwd = ? AND idempotency_key = ?").get(options.cwd, options.idempotencyKey) as JobRow | undefined;
      if (existing) return toJobRecord(existing);
    }

    const id = randomUUID();
    const jobDir = join(this.jobsDir, id);
    mkdirSync(jobDir, { recursive: true, mode: 0o700 });
    const paths = {
      stdoutPath: join(jobDir, "stdout.log"),
      stderrPath: join(jobDir, "stderr.log"),
      exitPath: join(jobDir, "exit.json"),
      pidPath: join(jobDir, "pid"),
    };
    const now = Date.now();
    try {
      this.db.prepare(`INSERT INTO jobs
        (id, command, cwd, status, created_at, stdout_path, stderr_path, exit_path, pid_path, timeout_ms, idempotency_key, session_id)
        VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, command, options.cwd, now, paths.stdoutPath, paths.stderrPath, paths.exitPath, paths.pidPath, options.timeoutMs ?? null, options.idempotencyKey ?? null, options.sessionId ?? null);
    } catch (error) {
      if (options.idempotencyKey && (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        rmSync(jobDir, { recursive: true, force: true });
        const existing = this.db.prepare("SELECT * FROM jobs WHERE cwd = ? AND idempotency_key = ?").get(options.cwd, options.idempotencyKey) as JobRow | undefined;
        if (existing) return toJobRecord(existing);
      }
      throw error;
    }

    const spec = JSON.stringify({
      command,
      cwd: options.cwd,
      id,
      shell: options.shell,
      shellArgs: options.shellArgs,
      timeoutMs: options.timeoutMs ?? null,
      ...paths,
    });
    const child = spawn(process.execPath, ["--input-type=module", "-e", JOB_WRAPPER, spec], {
      cwd: options.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    if (!child.pid) {
      this.db.prepare("UPDATE jobs SET status = 'failed', finished_at = ?, exit_code = 127 WHERE id = ?").run(Date.now(), id);
      throw new Error("Unable to start detached job process");
    }
    child.unref();
    const startTime = waitForProcessStartTime(child.pid, id, paths.exitPath);
    this.db.prepare("UPDATE jobs SET status = 'running', pid = ?, pgid = ?, process_start_time = ? WHERE id = ?")
      .run(child.pid, child.pid, startTime, id);
    return this.getRecord(id)!;
  }

  get(id: string): JobRecord | undefined {
    this.reconcile();
    return this.getRecord(id);
  }

  /**
   * Recent jobs, newest first. `session` narrows them to one Autopilot session's jobs, plus
   * jobs from before sessions were recorded that ran in that session's directory.
   */
  list(options: { cwd?: string; session?: { id: string; cwd: string }; limit?: number } = {}): JobRecord[] {
    this.reconcile();
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)));
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.cwd) {
      where.push("cwd = ?");
      params.push(options.cwd);
    }
    if (options.session) {
      where.push("(session_id = ? OR (session_id IS NULL AND cwd = ?))");
      params.push(options.session.id, options.session.cwd);
    }
    const rows = this.db.prepare(`SELECT * FROM jobs ${where.length ? `WHERE ${where.join(" AND ")} ` : ""}ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as JobRow[];
    return rows.map(toJobRecord);
  }

  logs(id: string, stream: JobStream, options: { offset?: number; tail?: number } = {}): JobLogResult {
    const row = this.getRow(id);
    if (!row) throw new Error(`Job not found: ${id}`);
    const path = stream === "stdout" ? row.stdout_path : row.stderr_path;
    if (!existsSync(path)) return { content: "", offset: 0, size: 0, truncated: false };
    const size = statSync(path).size;
    if (options.offset !== undefined) {
      const offset = Math.max(0, Math.min(size, Math.trunc(options.offset)));
      const length = Math.min(MAX_LOG_BYTES, size - offset);
      const fd = openSync(path, "r");
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      closeSync(fd);
      return { content: buffer.subarray(0, bytesRead).toString("utf8"), offset: offset + bytesRead, size, truncated: offset + bytesRead < size };
    }
    const tailLines = Math.max(1, Math.min(1000, Math.trunc(options.tail ?? 100)));
    const start = Math.max(0, size - MAX_LOG_BYTES);
    const fd = openSync(path, "r");
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    closeSync(fd);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/(?<=\n)/);
    const content = lines.slice(-tailLines).join("");
    const byteLength = Buffer.byteLength(content, "utf8");
    return { content, offset: size, size, truncated: start > 0 || byteLength < size };
  }

  cancel(id: string): JobRecord {
    this.reconcile();
    const row = this.getRow(id);
    if (!row) throw new Error(`Job not found: ${id}`);
    if (row.status !== "running" && row.status !== "starting") return toJobRecord(row);
    this.db.prepare("UPDATE jobs SET status = 'cancelling' WHERE id = ?").run(id);
    const pgid = row.pgid ?? row.pid;
    if (pgid) {
      try { process.kill(-pgid, "SIGTERM"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      const until = Date.now() + 1500;
      while (Date.now() < until && isProcessGroupAlive(pgid)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      // The wrapper may have exited while descendants remain in the same
      // group, so check the group itself rather than only the wrapper PID.
      if (isProcessGroupAlive(pgid)) {
        try { process.kill(-pgid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      this.reconcile();
      const updated = this.getRow(id);
      if (!updated || updated.status !== "cancelling" && updated.status !== "running" && updated.status !== "starting") break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ? AND status IN ('cancelling', 'running', 'starting')").run(Date.now(), id);
    this.reconcile();
    return this.getRecord(id)!;
  }

  private getRecord(id: string): JobRecord | undefined {
    const row = this.getRow(id);
    return row ? toJobRecord(row) : undefined;
  }

  private getRow(id: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  }

  /** Recover completion from wrapper files; never relaunch a missing process. */
  private reconcile(): void {
    const rows = this.db.prepare("SELECT * FROM jobs WHERE status IN ('starting', 'running', 'cancelling', 'unknown')").all() as JobRow[];
    for (const row of rows) {
      if (existsSync(row.exit_path)) {
        try {
          const result = JSON.parse(readFileSync(row.exit_path, "utf8")) as { code: number | null; signal: string | null; timedOut?: boolean };
          const status: JobStatus = result.timedOut ? "timed_out" : row.status === "cancelling" ? "cancelled" : result.code === 0 ? "completed" : "failed";
          this.db.prepare("UPDATE jobs SET status = ?, exit_code = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?")
            .run(status, result.code, Date.now(), row.id);
          continue;
        } catch {
          // A partial/corrupt marker is not proof of completion. Check process identity below.
        }
      }
      let pid = row.pid;
      if (!pid && existsSync(row.pid_path)) {
        const parsed = Number(readFileSync(row.pid_path, "utf8").trim());
        if (Number.isInteger(parsed) && parsed > 0) pid = parsed;
      }
      if (pid && row.process_start_time) {
        const observed = readProcessStartTime(pid);
        if (observed && observed === row.process_start_time && !isZombie(pid)) {
          this.db.prepare("UPDATE jobs SET status = ?, pid = ?, pgid = COALESCE(pgid, ?) WHERE id = ?")
            .run(row.status === "cancelling" ? "cancelling" : "running", pid, pid, row.id);
          continue;
        }
      }
      if (row.status === "cancelling") {
        this.db.prepare("UPDATE jobs SET status = 'cancelled', finished_at = COALESCE(finished_at, ?) WHERE id = ?")
          .run(Date.now(), row.id);
        continue;
      }
      this.db.prepare("UPDATE jobs SET status = 'unknown', finished_at = COALESCE(finished_at, ?) WHERE id = ?")
        .run(Date.now(), row.id);
    }
  }
}

function defaultJobDbPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.AUTOPILOT_JOBS_DB || join(root, "autopilot", "jobs.db");
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    const rows = execFileSync("ps", ["-axo", "pgid=,state="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return rows.split("\n").some((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match?.[1] === String(pgid) && !match[2]!.startsWith("Z");
    });
  } catch {
    // Fail conservatively: let kill report an unexpected permission error.
    return true;
  }
}

function waitForProcessStartTime(pid: number, jobId: string, exitPath: string): string | null {
  const deadline = Date.now() + 1000;
  let previous: string | null = null;
  const title = `autopilot-job-${jobId}`;
  while (Date.now() < deadline) {
    if (existsSync(exitPath)) break;
    const current = readProcessStartTime(pid);
    const hasUniqueTitle = process.platform !== "darwin" || current?.includes(title) === true;
    if (current && current === previous && hasUniqueTitle && !isZombie(pid)) return current;
    previous = current;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return previous;
}

function readProcessStartTime(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fieldsAfterCommand = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
      // /proc stat starts this suffix at field 3; starttime is field 22.
      return fieldsAfterCommand[19] ? `linux:${fieldsAfterCommand[19]}` : null;
    } catch {
      return null;
    }
  }
  try {
    // On macOS the wrapper sets a unique process title before its PID is saved.
    return execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function isZombie(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return state.startsWith("Z");
  } catch {
    return true;
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    command: row.command,
    cwd: row.cwd,
    status: row.status,
    pid: row.pid,
    pgid: row.pgid,
    processStartTime: row.process_start_time,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    stdoutPath: row.stdout_path,
    stderrPath: row.stderr_path,
    idempotencyKey: row.idempotency_key,
    sessionId: row.session_id ?? null,
  };
}
