import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "./manager.js";
import {
  drainFinishedHandoffs,
  renderHandoffCompletion,
  resetHandoffRegistry,
  trackedHandedOffJobs,
  trackHandedOffJob,
  untrackSession,
} from "./handoff.js";

const WAIT = new Int32Array(new SharedArrayBuffer(4));

function withJobs(run: (jobs: JobManager, dbPath: string, dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-"));
  const dbPath = join(dir, "state", "jobs.db");
  const jobs = new JobManager(dbPath);
  return (async () => {
    try {
      await run(jobs, dbPath, dir);
    } finally {
      jobs.close();
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

async function waitForStatus(jobs: JobManager, id: string, expected: string, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = jobs.get(id);
    if (result?.status === expected) return result;
    Atomics.wait(WAIT, 0, 0, 30);
  }
  assert.fail(`Job ${id} did not reach ${expected}; last status ${jobs.get(id)?.status}`);
}

describe("handoff registry", { concurrency: 1 }, () => {
  beforeEach(() => resetHandoffRegistry());

  it("tracks jobs per session and drains them once they finish", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const record = jobs.start({ command: "printf 'done-output\\n'; exit 0", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      trackHandedOffJob("s1", record.id);
      assert.deepEqual(trackedHandedOffJobs("s1"), [record.id]);

      // Not drained while still running (it may finish fast, so tolerate either).
      await waitForStatus(jobs, record.id, "completed");

      const drained = drainFinishedHandoffs("s1", dbPath);
      assert.equal(drained.length, 1);
      assert.equal(drained[0]!.id, record.id);
      assert.equal(drained[0]!.status, "completed");
      // Drained jobs are not delivered twice.
      assert.deepEqual(drainFinishedHandoffs("s1", dbPath), []);
      assert.deepEqual(trackedHandedOffJobs("s1"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("keeps still-running jobs tracked across drains", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const slow = jobs.start({ command: "sleep 5", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      const fast = jobs.start({ command: "exit 0", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      trackHandedOffJob("s1", slow.id);
      trackHandedOffJob("s1", fast.id);

      await waitForStatus(jobs, fast.id, "completed");
      const drained = drainFinishedHandoffs("s1", dbPath);
      assert.deepEqual(drained.map((r) => r.id), [fast.id]);
      assert.deepEqual(trackedHandedOffJobs("s1"), [slow.id]);

      jobs.cancel(slow.id);
      const afterCancel = drainFinishedHandoffs("s1", dbPath);
      assert.deepEqual(afterCancel.map((r) => r.id), [slow.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("scopes tracking to the session", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const a = jobs.start({ command: "exit 0", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      const b = jobs.start({ command: "exit 0", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      trackHandedOffJob("s1", a.id);
      trackHandedOffJob("s2", b.id);
      await waitForStatus(jobs, a.id, "completed");
      await waitForStatus(jobs, b.id, "completed");

      assert.deepEqual(drainFinishedHandoffs("s1", dbPath).map((r) => r.id), [a.id]);
      assert.deepEqual(drainFinishedHandoffs("s2", dbPath).map((r) => r.id), [b.id]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("untrackSession forgets jobs without draining them", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const record = jobs.start({ command: "sleep 5", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      trackHandedOffJob("s1", record.id);
      untrackSession("s1");
      assert.deepEqual(trackedHandedOffJobs("s1"), []);
      assert.deepEqual(drainFinishedHandoffs("s1", dbPath), []);
      jobs.cancel(record.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("drops jobs that vanished from the database", () => {
    trackHandedOffJob("s1", "no-such-job");
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-"));
    try {
      const dbPath = join(dir, "state", "jobs.db");
      assert.deepEqual(drainFinishedHandoffs("s1", dbPath), []);
      assert.deepEqual(trackedHandedOffJobs("s1"), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes extra env to the job", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const record = jobs.start({
        command: "printf 'marker=%s\\n' \"$HANDOFF_TEST_VAR\"",
        cwd: dir,
        shell: "bash",
        shellArgs: ["-lc"],
        env: { HANDOFF_TEST_VAR: "handoff-env-ok" },
      });
      await waitForStatus(jobs, record.id, "completed");
      assert.match(jobs.logs(record.id, "stdout").content, /marker=handoff-env-ok/);
      void dbPath;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

  it("renders a completion notice with status and a log tail", () => withJobs(async (jobs, dbPath) => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-handoff-cwd-"));
    try {
      const record = jobs.start({ command: "printf 'notice-body\\n'; exit 3", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      await waitForStatus(jobs, record.id, "failed");
      const notice = renderHandoffCompletion(jobs.get(record.id)!, dbPath);
      assert.match(notice, new RegExp(`Background job ${record.id} finished: failed`));
      assert.match(notice, /exit=3/);
      assert.match(notice, /notice-body/);
      assert.match(notice, /job_logs/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));
});
