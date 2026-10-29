import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../jobs/manager.js";
import type { ToolContext } from "./registry.js";
import { jobStartTool } from "./jobs.js";

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
