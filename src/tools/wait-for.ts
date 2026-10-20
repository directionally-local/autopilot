import type { ToolOutput, ToolSpec } from "./registry.js";
import { JobManager } from "../jobs/manager.js";
import { RunStore } from "../runs/store.js";
import { workerRegistry } from "./worker-registry.js";
import { finishedReport } from "./workers.js";

interface WaitArgs {
  worker_id?: string;
  job_id?: string;
  duration_ms?: number;
  until?: string;
  poll_interval_ms?: number;
}

const MAX_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_JOB_POLL_MS = 10_000;

export const waitForTool: ToolSpec<WaitArgs> = {
  name: "wait_for",
  description: [
    "Wait without polling the model: for a background subagent (worker_id; returns its findings), or — inside an unattended run — for a managed job to finish, a duration to elapse, or an absolute ISO-8601 time.",
    "The current turn ends immediately; a durable timer is saved for the supervisor to wake the run later. Requires an active runId.",
    "For job waits, the supervisor should re-check the job at each wake and reschedule while it remains active.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      worker_id: { type: "string", description: "Background subagent to wait for (worker id or #number); returns its findings. Works in any session." },
      job_id: { type: "string", description: "Managed job ID to wait for." },
      duration_ms: { type: "integer", minimum: 1000, maximum: MAX_WAIT_MS, description: "Wait this long, up to seven days." },
      until: { type: "string", format: "date-time", description: "Absolute ISO-8601 time to resume." },
      poll_interval_ms: { type: "integer", minimum: 1000, maximum: 300000, description: "For job waits, how long until the next supervisor check (default 10000)." },
    },
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: args.worker_id ? `wait_for subagent ${args.worker_id}` : args.job_id ? `wait_for job ${args.job_id}` : "wait_for timer" }),
  async run(args, ctx): Promise<string | ToolOutput> {
    // Background subagents live in this process: wait for one directly (no durable timer needed).
    if (args.worker_id) {
      if (!workerRegistry.find(args.worker_id)) return `No background subagent ${args.worker_id}; worker_status lists them.`;
      return finishedReport(await workerRegistry.waitFor(args.worker_id, ctx.signal));
    }
    if (!ctx.runId) {
      return "wait_for is available only inside a durable unattended run; no wait was scheduled.";
    }
    const hasJob = typeof args.job_id === "string" && args.job_id.length > 0;
    const hasDuration = args.duration_ms !== undefined;
    const hasUntil = args.until !== undefined;
    if (Number(hasJob) + Number(hasDuration) + Number(hasUntil) !== 1) {
      throw new Error("Provide exactly one of job_id, duration_ms, or until.");
    }

    const now = Date.now();
    let condition: "job" | "time";
    let jobId: string | undefined;
    let wakeAt: number;
    let intervalMs = DEFAULT_JOB_POLL_MS;
    if (hasJob) {
      jobId = args.job_id;
      const jobs = new JobManager(ctx.jobsDbPath);
      let record;
      try { record = jobs.get(jobId!); } finally { jobs.close(); }
      if (!record) throw new Error(`Managed job not found: ${jobId}`);
      if (!["starting", "running", "cancelling"].includes(record.status)) {
        return `Job ${jobId} is already ${record.status}; use job_status to inspect its result. No wait was scheduled.`;
      }
      const interval = args.poll_interval_ms ?? DEFAULT_JOB_POLL_MS;
      if (!Number.isInteger(interval) || interval < 1000 || interval > 300000) {
        throw new Error("poll_interval_ms must be an integer from 1000 through 300000");
      }
      intervalMs = interval;
      condition = "job";
      wakeAt = now + intervalMs;
    } else if (hasDuration) {
      const duration = args.duration_ms!;
      if (!Number.isInteger(duration) || duration < 1000 || duration > MAX_WAIT_MS) {
        throw new Error(`duration_ms must be an integer from 1000 through ${MAX_WAIT_MS}`);
      }
      condition = "time";
      wakeAt = now + duration;
    } else {
      const parsed = Date.parse(args.until!);
      if (!Number.isFinite(parsed) || parsed <= now || parsed - now > MAX_WAIT_MS) {
        throw new Error("until must be a future ISO-8601 time within the next seven days");
      }
      condition = "time";
      wakeAt = parsed;
    }

    const runs = new RunStore(ctx.runsDbPath);
    try {
      const timer = runs.scheduleTimer({ runId: ctx.runId, condition, jobId, wakeAt, intervalMs });
      const content = condition === "job"
        ? `Yielding run ${ctx.runId} until the supervisor re-checks job ${jobId} at ${new Date(wakeAt).toISOString()}. Timer ${timer.id}.`
        : `Yielding run ${ctx.runId} until ${new Date(wakeAt).toISOString()}. Timer ${timer.id}.`;
      const bytes = Buffer.byteLength(content, "utf8");
      return {
        content,
        rawBytes: bytes,
        reducedBytes: bytes,
        waitRequest: {
          runId: ctx.runId,
          timerId: timer.id,
          condition,
          ...(jobId ? { jobId } : {}),
          wakeAt,
        },
      };
    } finally {
      runs.close();
    }
  },
};
