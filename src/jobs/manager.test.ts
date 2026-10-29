import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { JobManager } from "./manager.js";

const WAIT = new Int32Array(new SharedArrayBuffer(4));

type Fixture = { dir: string; dbPath: string; jobs: JobManager };

describe("JobManager", { concurrency: 1 }, () => {
  it("captures output and recovers completion from the wrapper exit file", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "printf 'hello\\n'; printf 'problem\\n' >&2");
    assert.ok(job.pid);
    assert.equal(job.pgid, job.pid);
    const completed = await waitForStatus(jobs, job.id, "completed");
    assert.equal(completed.exitCode, 0);
    assert.match(jobs.logs(job.id, "stdout").content, /hello/);
    assert.match(jobs.logs(job.id, "stderr").content, /problem/);
    assert.equal(jobs.logs(job.id, "stdout", { offset: 0 }).offset, 6);
  }));

  it("marks non-zero commands failed", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "printf 'bad\\n' >&2; exit 7");
    const result = await waitForStatus(jobs, job.id, "failed");
    assert.equal(result.exitCode, 7);
  }));

  it("enforces a durable timeout", async () => withFixture(async ({ dir, jobs }) => {
    const job = start(jobs, dir, "sleep 10", { timeoutMs: 1000 });
    const result = await waitForStatus(jobs, job.id, "timed_out", 6000);
    assert.equal(result.exitCode, 124);
  }));

  it("cancels the process group", async () => withFixture(({ dir, jobs }) => {
    const job = start(jobs, dir, "sleep 30 & wait");
    const result = jobs.cancel(job.id);
    assert.equal(result.status, "cancelled");
    assert.ok(result.finishedAt);
  }));

  it("escalates cancellation when a command ignores SIGTERM", async () => withFixture(({ dir, jobs }) => {
    const job = start(jobs, dir, "trap '' TERM; sleep 30");
    const result = jobs.cancel(job.id);
    assert.equal(result.status, "cancelled");
    assert.ok(job.pgid);
    const rows = execFileSync("ps", ["-axo", "pgid=,state="], { encoding: "utf8" });
    const states = rows.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match?.[1] === String(job.pgid) ? [match[2]!] : [];
    });
    assert.ok(states.every((state) => state.startsWith("Z")), `live processes remain in PGID ${job.pgid}: ${states.join(",")}`);
  }));

  it("reconciles a running process and its logs after reopening the database", async () => withFixture(async ({ dir, dbPath, jobs }) => {
    const job = start(jobs, dir, "echo ready; sleep 1; echo done");
    jobs.close();
    const restarted = new JobManager(dbPath);
    try {
      assert.equal(restarted.get(job.id)?.status, "running");
      const result = await waitForStatus(restarted, job.id, "completed");
      assert.match(restarted.logs(job.id, "stdout").content, /ready/);
      assert.match(restarted.logs(job.id, "stdout").content, /done/);
      assert.equal(result.status, "completed");
    } finally {
      restarted.close();
    }
  }));

  it("returns the existing record for a duplicate idempotency key", async () => withFixture(async ({ dir, jobs }) => {
    const first = start(jobs, dir, "echo once; sleep 1", { idempotencyKey: "stable-call" });
    const duplicate = start(jobs, dir, "echo should-not-run", { idempotencyKey: "stable-call" });
    assert.equal(duplicate.id, first.id);
    assert.equal(jobs.list({ cwd: dir }).length, 1);
    await waitForStatus(jobs, first.id, "completed");
  }));

  it("lists one session's jobs, not every session's", async () => withFixture(async ({ dir, jobs }) => {
    const other = join(dir, "other-project");
    execFileSync("mkdir", ["-p", other]);
    const mine = start(jobs, dir, "true", { sessionId: "session-a" });
    start(jobs, other, "true", { sessionId: "session-b" });
    const sameDirOtherSession = start(jobs, dir, "true", { sessionId: "session-b" });
    const legacyHere = start(jobs, dir, "true");
    start(jobs, other, "true");
    assert.equal(mine.sessionId, "session-a");
    assert.equal(legacyHere.sessionId, null);

    const shown = jobs.list({ session: { id: "session-a", cwd: dir }, limit: 100 }).map((job) => job.id);
    assert.deepEqual(shown.sort(), [mine.id, legacyHere.id].sort(), "its own jobs, and unrecorded ones from its directory");
    assert.ok(!shown.includes(sameDirOtherSession.id));
    assert.equal(jobs.list({ session: { id: "session-new", cwd: other }, limit: 100 }).filter((job) => job.sessionId !== null).length, 0);
    assert.equal(jobs.list({ limit: 100 }).length, 5, "without a session, everything, as before");
  }));

  it("adds the session column to a database from before it existed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-jobs-"));
    try {
      const dbPath = join(dir, "jobs.db");
      const old = new Database(dbPath);
      old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, status TEXT NOT NULL, pid INTEGER, pgid INTEGER,
        process_start_time TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, exit_code INTEGER, stdout_path TEXT NOT NULL, stderr_path TEXT NOT NULL,
        exit_path TEXT NOT NULL, pid_path TEXT NOT NULL, timeout_ms INTEGER, idempotency_key TEXT)`);
      old.prepare("INSERT INTO jobs (id, command, cwd, status, created_at, finished_at, exit_code, stdout_path, stderr_path, exit_path, pid_path) VALUES ('old', 'true', ?, 'completed', 1, 2, 0, 'o', 'e', 'x', 'p')").run(dir);
      old.close();
      const jobs = new JobManager(dbPath);
      try {
        assert.equal(jobs.get("old")?.sessionId, null);
        const job = start(jobs, dir, "true", { sessionId: "session-a" });
        assert.equal(jobs.get(job.id)?.sessionId, "session-a");
        assert.deepEqual(jobs.list({ session: { id: "session-a", cwd: dir } }).map((entry) => entry.id).sort(), [job.id, "old"].sort());
      } finally {
        jobs.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid timeouts", async () => withFixture(({ dir, jobs }) => {
    assert.throws(() => start(jobs, dir, "true", { timeoutMs: 1 }), /timeout_ms/);
  }));
});

function start(
  jobs: JobManager,
  dir: string,
  command: string,
  extra: Partial<Parameters<JobManager["start"]>[0]> = {},
) {
  return jobs.start({ command, cwd: dir, shell: "bash", shellArgs: ["-lc"], ...extra });
}

async function withFixture(run: (fixture: Fixture) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-jobs-"));
  const dbPath = join(dir, "state", "jobs.db");
  const jobs = new JobManager(dbPath);
  try {
    await run({ dir, dbPath, jobs });
  } finally {
    try { jobs.close(); } catch { /* already closed during restart test */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForStatus(
  jobs: JobManager,
  id: string,
  expected: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = jobs.get(id);
    if (result?.status === expected) return result;
    Atomics.wait(WAIT, 0, 0, 30);
  }
  assert.fail(`Job ${id} did not reach ${expected}; current status is ${jobs.get(id)?.status}`);
}
