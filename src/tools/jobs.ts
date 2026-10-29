import type { ToolContext, ToolSpec } from "./registry.js";
import { JobManager } from "../jobs/manager.js";
import { getShellCommand } from "./bash.js";
import { previewCommand } from "../util/command-preview.js";

interface StartArgs {
  command: string;
  timeout_ms?: number;
  idempotency_key?: string;
}
interface StatusArgs { job_id?: string; limit?: number }
interface LogsArgs { job_id: string; stream?: "stdout" | "stderr"; offset?: number; tail?: number }
interface CancelArgs { job_id: string }

function withJobs<T>(ctx: ToolContext, run: (jobs: JobManager) => T): T {
  const jobs = new JobManager(ctx.jobsDbPath);
  try {
    return run(jobs);
  } finally {
    jobs.close();
  }
}

function renderRecord(record: ReturnType<JobManager["list"]>[number]): string {
  return [
    `Job ${record.id}: ${record.status}`,
    `Command: ${record.command}`,
    `Working directory: ${record.cwd}`,
    `Started: ${new Date(record.createdAt).toISOString()}`,
    `PID/PGID: ${record.pid ?? "unknown"}/${record.pgid ?? "unknown"}`,
    record.exitCode === null ? "Exit code: not available" : `Exit code: ${record.exitCode}`,
    `Logs: stdout=${record.stdoutPath} stderr=${record.stderrPath}`,
  ].join("\n");
}

export const jobStartTool: ToolSpec<StartArgs> = {
  name: "job_start",
  description: "Start a shell command as a durable background job in its own POSIX process group. The command continues after this turn or Autopilot exits; inspect it with job_status/job_logs and stop it with job_cancel. Output is kept in append-only files outside the workspace. An idempotency_key makes retried starts return the original job instead of launching a duplicate.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run in the current project directory." },
      timeout_ms: { type: "integer", minimum: 1000, maximum: 604800000, description: "Optional wall-clock timeout in milliseconds (max 7 days)." },
      idempotency_key: { type: "string", minLength: 1, maxLength: 128, description: "Optional stable key for retry-safe starts; unique within the working directory." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({ title: formatJobStartTitle(String(args.command ?? "")) }),
  async run(args, ctx) {
    const shell = getShellCommand(ctx.shell);
    const record = withJobs(ctx, (jobs) => jobs.start({
      command: args.command,
      cwd: ctx.cwd,
      shell: shell.shell,
      shellArgs: shell.args,
      timeoutMs: args.timeout_ms,
      idempotencyKey: args.idempotency_key,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    }));
    return `${renderRecord(record)}\n\nUse job_status with job_id=${record.id} to check progress.`;
  },
};

export const jobStatusTool: ToolSpec<StatusArgs> = {
  name: "job_status",
  description: "Get the durable status of one background job, or list recent jobs in this working directory. Startup reconciliation uses wrapper exit files and PID plus process start-time checks; an ambiguous job is reported as unknown and never relaunched.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job ID. Omit to list recent jobs." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Maximum recent jobs when job_id is omitted (default 20)." },
    },
    additionalProperties: false,
  },
  needsPermission: false,
  isReadOnly: true,
  async run(args, ctx) {
    return withJobs(ctx, (jobs) => {
      if (args.job_id) {
        const record = jobs.get(args.job_id);
        return record ? renderRecord(record) : `Job not found: ${args.job_id}`;
      }
      const records = jobs.list({ cwd: ctx.cwd, limit: args.limit });
      return records.length ? records.map(renderRecord).join("\n\n") : "No managed jobs found for this working directory.";
    });
  },
};

export const jobLogsTool: ToolSpec<LogsArgs> = {
  name: "job_logs",
  description: "Read a background job's append-only stdout or stderr log. By default returns the last 100 lines; provide offset (byte position) to continue reading from a previous response. Each response is capped at 64 KiB.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      stream: { type: "string", enum: ["stdout", "stderr"], description: "Log stream (default stdout)." },
      offset: { type: "integer", minimum: 0, description: "Byte offset for incremental reads; when set, tail is ignored." },
      tail: { type: "integer", minimum: 1, maximum: 1000, description: "Number of trailing lines (default 100)." },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
  needsPermission: false,
  isReadOnly: true,
  async run(args, ctx) {
    return withJobs(ctx, (jobs) => {
      const result = jobs.logs(args.job_id, args.stream ?? "stdout", { offset: args.offset, tail: args.tail });
      const header = `${args.stream ?? "stdout"} log: bytes ${args.offset ?? Math.max(0, result.size - Buffer.byteLength(result.content))}-${result.offset} of ${result.size}${result.truncated ? " (more available)" : ""}`;
      return `${header}\n${result.content}`;
    });
  },
};

export const jobCancelTool: ToolSpec<CancelArgs> = {
  name: "job_cancel",
  description: "Cancel a running background job by sending SIGTERM, then SIGKILL if needed, to its entire process group. Completed jobs are left unchanged.",
  parameters: {
    type: "object",
    properties: { job_id: { type: "string" } },
    required: ["job_id"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({ title: `job_cancel: ${String(args.job_id ?? "")}` }),
  async run(args, ctx) {
    return withJobs(ctx, (jobs) => renderRecord(jobs.cancel(args.job_id)));
  },
};

/** The job_start row title, with a long script collapsed to its first line. */
export function formatJobStartTitle(command: string, maxWidth = 111): string {
  return `job_start: ${previewCommand(command, maxWidth - 11)}`;
}
