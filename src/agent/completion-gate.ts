/**
 * Completion gate: a last, deterministic check before the agent's final
 * answer. Two states mean the work is not actually done:
 *
 * - a background job this session started (a bash command that outlived its
 *   foreground budget, or `job_start`) is still running, so its result is not
 *   in yet;
 * - the last test command the turn ran failed, so verification is not green.
 *
 * The loop nudges the model once per turn when either holds: wait for the job
 * or re-run/fix the tests, or say plainly in the final answer that it is still
 * outstanding. This is not a verification system — it only stops a plain
 * "done" from hiding a known-pending result.
 */

import { existsSync } from "node:fs";
import { JobManager, defaultJobDbPath, type JobStatus } from "../jobs/manager.js";
import { trackedHandedOffJobs } from "../jobs/handoff.js";
import { classifyVerification } from "../trace/verification.js";
import { previewCommand } from "../util/command-preview.js";

const ACTIVE_STATUSES = new Set<JobStatus>(["starting", "running", "cancelling"]);

/** Start of a command segment, optionally preceded by env assignments and a
 *  runner shim (same shape as the verification classifier). */
const TEST_SEGMENT = String.raw`(?:^|[;&|(]\s*|&&\s*|\|\|\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:npx\s+|pnpm\s+exec\s+|pnpm\s+dlx\s+|yarn\s+|bunx\s+|bun\s+run\s+|(?:\.\/)?node_modules\/\.bin\/)?(?:npm\s+run\s+test[\w:.-]*|pnpm\s+(?:run\s+)?test[\w:.-]*|yarn\s+(?:run\s+)?test[\w:.-]*|bun\s+(?:run\s+)?test[\w:.-]*|make\s+test[\w:.-]*|(?:python[0-9.]*\s+-m\s+)?pytest|go\s+test|cargo\s+test|vitest|jest|tsx\s+--test|node\s+--test)(?=\s|$)`;

const TEST_WITH_SCRIPT_RE = new RegExp(TEST_SEGMENT);

/**
 * True when a bash command runs tests. Includes scoped runs such as
 * `npm run test:file -- src/x.test.ts`, which the verification classifier
 * deliberately treats as neither test nor build.
 */
export function isTestCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (classifyVerification(trimmed) === "test") return true;
  return TEST_WITH_SCRIPT_RE.test(trimmed);
}

export interface TestRun {
  command: string;
  exitCode: number;
}

export interface CompletionGateNoticeInput {
  /** Jobs this session started that are still running. */
  runningJobs: Array<{ id: string; command: string }>;
  /** The most recent test command run in the turn, when there was one. */
  lastTest?: TestRun;
}

/** What the turn knows about its verification state for the final answer. */
export interface CompletionGateState {
  /** The latest test command run in this turn, if any. */
  lastTest?: TestRun;
}

/** Record a bash result in the gate state when the command was a test run.
 *  A later passing run replaces an earlier failure, and vice versa. */
export function recordBashResult(
  state: CompletionGateState,
  command: string | undefined,
  meta: { exitCode?: number | null; timedOut?: boolean } | undefined,
): void {
  if (!command || !isTestCommand(command)) return;
  // A timed-out test did not pass. A command handed off to a background job
  // has no exit code yet; the running-job check covers it instead.
  const exitCode = typeof meta?.exitCode === "number"
    ? meta.exitCode
    : meta?.timedOut
      ? 124
      : undefined;
  if (exitCode === undefined) return;
  state.lastTest = { command, exitCode };
}

/**
 * Running jobs this session started. With a session id, jobs are looked up by
 * session (and cwd, for rows from before sessions were recorded); without
 * one, only handed-off jobs the in-memory registry still tracks are reported.
 */
export function runningSessionJobs(
  sessionId: string | undefined,
  cwd: string,
  jobsDbPath?: string,
): Array<{ id: string; command: string }> {
  const tracked = new Set(trackedHandedOffJobs(sessionId));
  if (!sessionId && tracked.size === 0) return [];
  // No jobs database yet means this session cannot have started a job; don't
  // create one just to check.
  const dbPath = jobsDbPath ?? defaultJobDbPath();
  if (!existsSync(dbPath)) return [];
  let jobs: JobManager | undefined;
  try {
    jobs = new JobManager(dbPath);
    const records = jobs.list(
      sessionId ? { session: { id: sessionId, cwd }, limit: 100 } : { cwd, limit: 100 },
    );
    return records
      .filter((record) => ACTIVE_STATUSES.has(record.status) && (sessionId !== undefined || tracked.has(record.id)))
      .map((record) => ({ id: record.id, command: record.command }));
  } catch {
    return [];
  } finally {
    jobs?.close();
  }
}

/** The nudge, or null when there is nothing outstanding. */
export function completionGateNotice(input: CompletionGateNoticeInput): string | null {
  const parts: string[] = [];
  const { runningJobs, lastTest } = input;
  if (runningJobs.length > 0) {
    const list = runningJobs
      .map((job) => `${job.id} (\`${previewCommand(job.command, 80)}\`)`)
      .join(", ");
    parts.push(
      runningJobs.length === 1
        ? `Background job ${list}, which you started this session, is still running — its result is not in yet.`
        : `Background jobs ${list}, which you started this session, are still running — their results are not in yet.`,
    );
  }
  if (lastTest && lastTest.exitCode !== 0) {
    parts.push(`Your last test command failed with exit ${lastTest.exitCode}: \`${previewCommand(lastTest.command, 160)}\`.`);
  }
  if (parts.length === 0) return null;
  return [
    "<system-reminder>",
    "Completion gate — before you give your final answer:",
    ...parts.map((part) => `- ${part}`),
    "Either resolve this first (wait for the job with job_status/job_logs; fix the failure and re-run tests, preferably the project's full test command) or say plainly in your final answer that it is still outstanding and why. Do not claim the work is complete or verified while this is true.",
    "</system-reminder>",
  ].join("\n");
}
