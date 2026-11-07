import { JobManager, type JobRecord } from "./manager.js";
import { previewCommand } from "../util/command-preview.js";

/**
 * Foreground bash commands that outlived their foreground budget and were
 * handed off to a durable managed job (#1101). Tracked in memory per session;
 * the agent loop drains finished ones at tool boundaries and delivers their
 * outcome like background-subagent results, so the model never has to poll
 * `job_status` in a tight loop.
 *
 * In-memory on purpose: the registry only drives the completion *notice*. The
 * job itself is durable in the jobs database, so a restart loses the notice,
 * never the process or its logs.
 */
const tracked = new Map<string, Set<string>>();

const ACTIVE_STATUSES = new Set(["starting", "running", "cancelling"]);

export function trackHandedOffJob(sessionId: string | undefined, jobId: string): void {
  const key = sessionId ?? "";
  let set = tracked.get(key);
  if (!set) {
    set = new Set();
    tracked.set(key, set);
  }
  set.add(jobId);
}

/** Forget every handed-off job for a session (session end, tests). */
export function untrackSession(sessionId: string | undefined): void {
  tracked.delete(sessionId ?? "");
}

/** Test hook: clear the whole registry. */
export function resetHandoffRegistry(): void {
  tracked.clear();
}

/** Handed-off job ids currently tracked for a session (tests, diagnostics). */
export function trackedHandedOffJobs(sessionId: string | undefined): string[] {
  return [...(tracked.get(sessionId ?? "") ?? [])];
}

/**
 * Return the tracked jobs for `sessionId` that have finished since the last
 * drain, removing them from the registry. Still-running jobs stay tracked.
 */
export function drainFinishedHandoffs(sessionId: string | undefined, jobsDbPath?: string): JobRecord[] {
  const set = tracked.get(sessionId ?? "");
  if (!set || set.size === 0) return [];
  const jobs = new JobManager(jobsDbPath);
  try {
    const finished: JobRecord[] = [];
    for (const id of set) {
      const record = jobs.get(id);
      // A missing row means the jobs database was reset; stop tracking it.
      if (!record || !ACTIVE_STATUSES.has(record.status)) {
        set.delete(id);
        if (record) finished.push(record);
      }
    }
    if (set.size === 0) tracked.delete(sessionId ?? "");
    return finished;
  } finally {
    jobs.close();
  }
}

const NOTICE_LOG_TAIL_LINES = 20;

/**
 * Render the completion notice injected into the conversation when a
 * handed-off job finishes. Includes a log tail so the model usually does not
 * need a follow-up `job_logs` call.
 */
export function renderHandoffCompletion(record: JobRecord, jobsDbPath?: string): string {
  const status = `Background job ${record.id} finished: ${record.status}` +
    (record.exitCode === null ? "" : ` (exit=${record.exitCode})`) +
    ` — \`${previewCommand(record.command, 100)}\``;
  const jobs = new JobManager(jobsDbPath);
  try {
    const parts = [status];
    for (const stream of ["stdout", "stderr"] as const) {
      const log = jobs.logs(record.id, stream, { tail: NOTICE_LOG_TAIL_LINES });
      if (log.content.trim()) {
        const suffix = log.truncated ? " (last lines shown; job_logs has the rest)" : "";
        parts.push(`--- ${stream}${suffix} ---\n${log.content.trimEnd()}`);
      }
    }
    parts.push(`Use job_logs with job_id=${record.id} for the full output.`);
    return parts.join("\n");
  } finally {
    jobs.close();
  }
}
