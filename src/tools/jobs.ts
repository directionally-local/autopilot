import type { ToolContext, ToolSpec } from "./registry.js";
import { JobManager, type JobRecord, type JobStatus } from "../jobs/manager.js";
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
interface WaitArgs { job_id: string; timeout_ms?: number; poll_interval_ms?: number }

/** How long job_wait blocks by default, and the hard ceiling. */
const DEFAULT_JOB_WAIT_MS = 10 * 60 * 1000;
const MAX_JOB_WAIT_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_JOB_WAIT_POLL_MS = 1000;
const MIN_JOB_WAIT_POLL_MS = 100;
const MAX_JOB_WAIT_POLL_MS = 60_000;
/** How often a long wait reports progress to the UI. The first line is sent
 *  immediately; later ones at most once a minute, so a long wait does not
 *  flood the transcript. */
const JOB_WAIT_PROGRESS_MS = 60_000;
/** Lines of each stream returned with the final status. */
const JOB_WAIT_TAIL_LINES = 100;

function isActiveJobStatus(status: JobStatus): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}

/** Resolve on timeout or abort, whichever comes first. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds >= 60 ? `${(seconds / 60).toFixed(1)}m` : `${seconds.toFixed(1)}s`;
}

/** The tail of a job's stdout and stderr, for a wait result. */
function jobOutputTail(jobs: JobManager, id: string): string {
  const parts: string[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    const log = jobs.logs(id, stream, { tail: JOB_WAIT_TAIL_LINES });
    if (!log.content.trim()) continue;
    parts.push(
      `--- ${stream} (last ${JOB_WAIT_TAIL_LINES} lines) ---\n${log.content.trimEnd()}` +
        (log.truncated ? `\n[… earlier ${stream} available via job_logs ${id}]` : ""),
    );
  }
  return parts.length > 0 ? parts.join("\n") : "(no output)";
}

function describeFinishedJob(record: JobRecord): string {
  const exit = record.exitCode === null ? "exit code unknown" : `exit ${record.exitCode}`;
  const duration = record.finishedAt !== null ? ` after ${formatDuration(record.finishedAt - record.createdAt)}` : "";
  return `Job ${record.id}: ${record.status} (${exit})${duration}`;
}

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
  description: "Start a shell command as a durable background job in its own POSIX process group. The command continues after this turn or Autopilot exits; wait for it with job_wait, inspect it with job_status/job_logs, and stop it with job_cancel. Output is kept in append-only files outside the workspace. An idempotency_key makes retried starts return the original job instead of launching a duplicate.",
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
    return `${renderRecord(record)}\n\nUse job_wait with job_id=${record.id} to block until it finishes (or times out) and get its exit code and output tail; job_status/job_logs only peek at it.`;
  },
};

export const jobStatusTool: ToolSpec<StatusArgs> = {
  name: "job_status",
  description: "Get the durable status of one background job, or list recent jobs in this working directory. This is a snapshot, not a wait: to block until a job finishes, call job_wait instead of polling job_status. Startup reconciliation uses wrapper exit files and PID plus process start-time checks; an ambiguous job is reported as unknown and never relaunched.",
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

export const jobWaitTool: ToolSpec<WaitArgs> = {
  name: "job_wait",
  description:
    "Block until a background job (from job_start, or a bash command that was moved to the background) finishes, or until timeout_ms passes. Returns the job's final status, exit code, and the tail of its stdout/stderr. Use this instead of repeated `sleep N` + job_status/ps polling: one job_wait call replaces a whole polling loop. Respects Esc (abort) and reports progress while it waits. The job keeps running if the wait times out or is aborted.",
  parameters: {
    type: "object",
    properties: {
      job_id: { type: "string", description: "Job ID to wait for." },
      timeout_ms: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_JOB_WAIT_MS,
        description: `Stop waiting after this long (default ${DEFAULT_JOB_WAIT_MS} = 10 minutes). The job keeps running.`,
      },
      poll_interval_ms: {
        type: "integer",
        minimum: MIN_JOB_WAIT_POLL_MS,
        maximum: MAX_JOB_WAIT_POLL_MS,
        description: `How often to check the job (default ${DEFAULT_JOB_WAIT_POLL_MS}).`,
      },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
  needsPermission: false,
  // A blocking wait must not run inside the synchronous, time-limited Code Mode
  // sandbox; expose it as a direct tool there instead.
  codeModeDirect: true,
  render: (args) => ({ title: `job_wait: ${String(args.job_id ?? "")}` }),
  async run(args, ctx) {
    const timeoutMs = args.timeout_ms ?? DEFAULT_JOB_WAIT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_JOB_WAIT_MS) {
      throw new Error(`timeout_ms must be an integer from 1000 through ${MAX_JOB_WAIT_MS}`);
    }
    const pollMs = args.poll_interval_ms ?? DEFAULT_JOB_WAIT_POLL_MS;
    if (!Number.isInteger(pollMs) || pollMs < MIN_JOB_WAIT_POLL_MS || pollMs > MAX_JOB_WAIT_POLL_MS) {
      throw new Error(`poll_interval_ms must be an integer from ${MIN_JOB_WAIT_POLL_MS} through ${MAX_JOB_WAIT_POLL_MS}`);
    }
    const jobs = new JobManager(ctx.jobsDbPath);
    try {
      let record = jobs.get(args.job_id);
      if (!record) return `Job not found: ${args.job_id}. job_status lists recent jobs.`;
      const startedAt = Date.now();
      if (!isActiveJobStatus(record.status)) {
        return `${describeFinishedJob(record)} — already finished, no wait needed.\n${jobOutputTail(jobs, record.id)}`;
      }
      ctx.onProgress?.(`Waiting for job ${record.id} (up to ${formatDuration(timeoutMs)})…`);
      let lastProgressAt = startedAt;
      while (true) {
        record = jobs.get(record.id) ?? record;
        if (!isActiveJobStatus(record.status)) break;
        if (ctx.signal?.aborted) {
          return (
            `(aborted — stopped waiting for job ${record.id} after ${formatDuration(Date.now() - startedAt)}; it is still ${record.status})\n` +
            jobOutputTail(jobs, record.id)
          );
        }
        const elapsed = Date.now() - startedAt;
        if (elapsed >= timeoutMs) {
          return (
            `Job ${record.id} is still ${record.status} after ${formatDuration(elapsed)} (timeout_ms=${timeoutMs}). It keeps running in the background.\n` +
            `${jobOutputTail(jobs, record.id)}\n\nCall job_wait again to keep waiting, or job_logs/job_status to inspect it.`
          );
        }
        await sleepUnlessAborted(Math.min(pollMs, timeoutMs - elapsed), ctx.signal);
        if (Date.now() - lastProgressAt >= JOB_WAIT_PROGRESS_MS) {
          lastProgressAt = Date.now();
          ctx.onProgress?.(`Still waiting for job ${record.id} (${formatDuration(Date.now() - startedAt)} elapsed, ${record.status})…`);
        }
      }
      return `${describeFinishedJob(record)}\n${jobOutputTail(jobs, record.id)}`;
    } finally {
      jobs.close();
    }
  },
};

/** The job_start row title, with a long script collapsed to its first line. */
export function formatJobStartTitle(command: string, maxWidth = 111): string {
  return `job_start: ${previewCommand(command, maxWidth - 11)}`;
}
