import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../jobs/manager.js";
import type { ToolContext } from "./registry.js";
import { jobStartTool, jobWaitTool, jobCancelTool } from "./jobs.js";

const ACTIVE_JOB_STATUSES = new Set(["starting", "running", "cancelling"]);

async function startJob(ctx: ToolContext, command: string): Promise<string> {
  const output = String(await jobStartTool.run({ command }, ctx));
  const id = /Job ([0-9a-f-]{36}):/.exec(output)?.[1];
  assert.ok(id, output);
  return id!;
}

async function waitUntilFinished(jobs: JobManager, id: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = jobs.get(id);
    if (record && !ACTIVE_JOB_STATUSES.has(record.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${id} did not finish`);
}

describe("job_start", () => {
  it("records the session that started the job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-tool-"));
    const jobsDbPath = join(dir, "jobs.db");
    try {
      const ctx = { cwd: dir, jobsDbPath, sessionId: "session-a" } as unknown as ToolContext;
      const output = await jobStartTool.run({ command: "true" }, ctx);
      const id = /Job ([0-9a-f-]{36}):/.exec(String(output))?.[1];
      assert.ok(id, String(output));
      const jobs = new JobManager(jobsDbPath);
      try {
        assert.equal(jobs.get(id!)?.sessionId, "session-a");
      } finally {
        jobs.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("job_wait", () => {
  it("returns immediately for a job that already finished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-wait-"));
    const jobsDbPath = join(dir, "jobs.db");
    try {
      const ctx = { cwd: dir, jobsDbPath } as unknown as ToolContext;
      const id = await startJob(ctx, "printf 'hello\\n'");
      const jobs = new JobManager(jobsDbPath);
      try {
        await waitUntilFinished(jobs, id);
      } finally {
        jobs.close();
      }
      const output = String(await jobWaitTool.run({ job_id: id }, ctx));
      assert.match(output, /completed/);
      assert.match(output, /exit 0/);
      assert.match(output, /hello/);
      assert.match(output, /already finished/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out without killing the job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-wait-"));
    const jobsDbPath = join(dir, "jobs.db");
    try {
      const ctx = { cwd: dir, jobsDbPath } as unknown as ToolContext;
      const id = await startJob(ctx, "sleep 30");
      const startedAt = Date.now();
      const output = String(await jobWaitTool.run({ job_id: id, timeout_ms: 1000, poll_interval_ms: 100 }, ctx));
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 900, `waited only ${elapsed}ms`);
      assert.ok(elapsed < 10_000, `waited too long: ${elapsed}ms`);
      assert.match(output, /still running/);
      assert.match(output, /timeout_ms=1000/);
      const jobs = new JobManager(jobsDbPath);
      try {
        assert.equal(jobs.get(id)?.status, "running");
      } finally {
        jobs.close();
      }
      await jobCancelTool.run({ job_id: id }, ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops waiting when the turn is aborted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-wait-"));
    const jobsDbPath = join(dir, "jobs.db");
    try {
      const controller = new AbortController();
      const ctx = { cwd: dir, jobsDbPath, signal: controller.signal } as unknown as ToolContext;
      const id = await startJob(ctx, "sleep 30");
      setTimeout(() => controller.abort(), 150);
      const startedAt = Date.now();
      const output = String(await jobWaitTool.run({ job_id: id, timeout_ms: 60_000, poll_interval_ms: 100 }, ctx));
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed < 10_000, `abort took ${elapsed}ms`);
      assert.match(output, /aborted/);
      assert.match(output, /still running/);
      await jobCancelTool.run({ job_id: id }, ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports progress while it waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-wait-"));
    const jobsDbPath = join(dir, "jobs.db");
    try {
      const progress: string[] = [];
      const ctx = { cwd: dir, jobsDbPath, onProgress: (message: string) => progress.push(message) } as unknown as ToolContext;
      const id = await startJob(ctx, "sleep 30");
      await jobWaitTool.run({ job_id: id, timeout_ms: 1000, poll_interval_ms: 100 }, ctx);
      assert.ok(progress.some((message) => message.includes(`Waiting for job ${id}`)), progress.join("\n"));
      await jobCancelTool.run({ job_id: id }, ctx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an unknown job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-job-wait-"));
    try {
      const ctx = { cwd: dir, jobsDbPath: join(dir, "jobs.db") } as unknown as ToolContext;
      const output = String(await jobWaitTool.run({ job_id: "missing" }, ctx));
      assert.match(output, /Job not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
