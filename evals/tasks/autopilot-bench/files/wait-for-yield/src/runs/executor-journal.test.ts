import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../jobs/manager.js";
import { RunStore } from "./store.js";
import { ToolExecutor } from "../tools/executor.js";
import { waitForTool } from "../tools/wait-for.js";
import type { ToolSpec } from "../tools/registry.js";

const allow = async () => "allow" as const;

describe("run tool-boundary journal", () => {
  it("writes an intent before execution and a result afterward", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-journal-"));
    const dbPath = join(dir, "runs.db");
    const store = new RunStore(dbPath);
    try {
      const run = store.createRun({ task: "Test a journaled tool", cwd: dir });
      store.transition(run.id, "running");
      const tool: ToolSpec = {
        name: "fake_action",
        description: "test action",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: false,
        run: async () => "private tool output",
      };
      const executor = new ToolExecutor([tool]);
      const result = await executor.run(
        { id: "call-1", name: tool.name, arguments: '{"secret":"private input"}' },
        allow,
        { cwd: dir, runId: run.id, runsDbPath: dbPath },
      );

      assert.equal(result.ok, true);
      const events = store.listEvents(run.id);
      assert.deepEqual(events.map((event) => event.type), ["state", "state", "tool_intent", "tool_result"]);
      assert.equal(events[2]!.toolCallId, "call-1");
      assert.equal(events[3]!.metadata.ok, true);
      assert.equal(JSON.stringify(events).includes("private input"), false);
      assert.equal(JSON.stringify(events).includes("private tool output"), false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("schedules a supervisor re-check when waiting on an active managed job", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-job-wait-"));
    const runsDbPath = join(dir, "runs.db");
    const jobsDbPath = join(dir, "jobs.db");
    const store = new RunStore(runsDbPath);
    const jobs = new JobManager(jobsDbPath);
    try {
      const run = store.createRun({ task: "Wait for the command", cwd: dir });
      store.transition(run.id, "running");
      const job = jobs.start({ command: "sleep 30", cwd: dir, shell: "bash", shellArgs: ["-lc"] });
      const executor = new ToolExecutor([waitForTool]);
      const result = await executor.run(
        { id: "call-job-wait", name: "wait_for", arguments: JSON.stringify({ job_id: job.id, poll_interval_ms: 1000 }) },
        allow,
        { cwd: dir, runId: run.id, runsDbPath, jobsDbPath },
      );

      assert.equal(result.waitRequest?.condition, "job");
      assert.equal(result.waitRequest?.jobId, job.id);
      const timer = store.getTimer(result.waitRequest!.timerId);
      assert.equal(timer?.condition, "job");
      assert.equal(timer?.jobId, job.id);
      assert.equal(store.getRun(run.id)?.status, "waiting");
    } finally {
      const record = jobs.get(jobs.list({ cwd: dir })[0]?.id ?? "");
      if (record && ["starting", "running"].includes(record.status)) jobs.cancel(record.id);
      jobs.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a failure result when an executed tool throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-journal-"));
    const dbPath = join(dir, "runs.db");
    const store = new RunStore(dbPath);
    try {
      const run = store.createRun({ task: "Test a failing tool", cwd: dir });
      store.transition(run.id, "running");
      const tool: ToolSpec = {
        name: "fake_failure",
        description: "test failure",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: false,
        run: async () => { throw new Error("expected tool failure"); },
      };
      const executor = new ToolExecutor([tool]);
      const result = await executor.run(
        { id: "call-fail", name: tool.name, arguments: "{}" },
        allow,
        { cwd: dir, runId: run.id, runsDbPath: dbPath },
      );

      assert.equal(result.ok, false);
      const events = store.listEvents(run.id);
      assert.equal(events.at(-1)?.type, "tool_result");
      assert.equal(events.at(-1)?.metadata.ok, false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists wait_for and yields the run before another model turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autopilot-run-wait-"));
    const dbPath = join(dir, "runs.db");
    const store = new RunStore(dbPath);
    try {
      const run = store.createRun({ task: "Wait without polling", cwd: dir });
      store.transition(run.id, "running");
      const executor = new ToolExecutor([waitForTool]);
      const result = await executor.run(
        { id: "call-wait", name: "wait_for", arguments: '{"duration_ms":1000}' },
        allow,
        { cwd: dir, runId: run.id, runsDbPath: dbPath },
      );

      assert.equal(result.ok, true);
      assert.equal(result.waitRequest?.runId, run.id);
      assert.ok(result.waitRequest?.timerId);
      assert.equal(store.getRun(run.id)?.status, "waiting");
      assert.equal(store.getTimer(result.waitRequest!.timerId)?.status, "scheduled");
      assert.deepEqual(store.listEvents(run.id).map((event) => event.type), [
        "state", "state", "tool_intent", "tool_result", "state",
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
