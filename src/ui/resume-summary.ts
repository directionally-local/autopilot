/**
 * "Where you left off": what a saved conversation was doing when it stopped,
 * read straight from its messages, no model call. Shown when a conversation
 * that ended mid-task is reopened (`-c`, `autopilot resume`, `/resume`, a
 * renderer restart) and by `/status` at any time.
 *
 * Sources, all already in the saved history:
 *  - the request being worked on (the last real user message);
 *  - the task list (the last `tasks_set` call for that request);
 *  - files changed (`edit` / `write` calls that succeeded);
 *  - checks that ran (`bash` calls that look like tests, builds, linters or
 *    type checks), with pass/fail from the exit code and counts from the
 *    output;
 *  - tool calls that never finished: saved with a `(stopped)` result by the
 *    interrupt handler, or healed into one on load (repairDanglingToolCalls)
 *    after a crash or a closed terminal. They show as "interrupted".
 */

import type { ChatMessage } from "../agent/messages.js";
import { STOPPED_TOOL_RESULT } from "../agent/messages.js";
import { cutAtWord } from "../session-title.js";
import { CONTINUE_MARKER, formatWhen } from "./resume-replay.js";

export type CheckOutcome = "passed" | "failed" | "ran";

export interface CheckRun {
  command: string;
  outcome: CheckOutcome;
  /** e.g. "42 passed", "41 passed, 1 failed", "exit 1", "timed out". */
  detail?: string;
}

export interface LeftOffTask {
  title: string;
  status: "pending" | "in_progress" | "completed";
}

export interface WhereYouLeftOff {
  /** The request being worked on. */
  goal: string;
  /** Completed tasks from the task list. */
  done: string[];
  /** Files edited or written successfully, in first-touched order. */
  filesChanged: string[];
  /** Checks that finished, latest run of each command, oldest first. */
  checks: CheckRun[];
  /** The in-progress task(s) and calls that were cut off ("… — interrupted"). */
  inProgress: string[];
  /** Tasks not started yet. */
  pending: string[];
  /** Tool calls that never finished. */
  interrupted: number;
  /** The conversation stopped before the request was finished. */
  stoppedMidTask: boolean;
  /** The history has a task list for this request. */
  hasTaskList: boolean;
}

const CHECK_COMMAND =
  /\b(test|tests|vitest|jest|mocha|ava|pytest|tox|tsc|typecheck|type-check|types|lint|eslint|biome|ruff|mypy|pyright|flake8|clippy|build|check|vet|ci)\b/i;
/** Short follow-ups that don't restate the task: the goal is the request before them. */
const FOLLOW_UP = /^(continue|go on|keep going|carry on|resume|proceed|yes|y|ok|okay|go|do it|please continue)\b[\s.!]*$/i;

const MAX_CHECKS = 6;
const MAX_FILES = 6;
const GOAL_MAX_CHARS = 140;
const COMMAND_MAX_CHARS = 70;

function textOf(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

function isRealRequest(m: ChatMessage): boolean {
  if (m.role !== "user") return false;
  const text = textOf(m);
  return !!text && !text.startsWith("[Automatic notice");
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The command as a person would recognise it: first line, without a leading `cd … &&`. */
export function displayCommand(command: string): string {
  const first = command.trim().split("\n")[0] ?? "";
  const bare = first.replace(/^cd\s+\S+\s*&&\s*/, "").trim();
  return bare.length > COMMAND_MAX_CHARS ? `${bare.slice(0, COMMAND_MAX_CHARS - 1).trimEnd()}…` : bare;
}

export function isCheckCommand(command: string): boolean {
  return CHECK_COMMAND.test(command.split("\n")[0] ?? "");
}

function lastNumber(text: string, re: RegExp): number | undefined {
  let found: number | undefined;
  for (const m of text.matchAll(re)) found = Number(m[1]);
  return found;
}

/** Pass/fail and a short detail from a bash result (header `exit=N`, then output). */
export function checkOutcome(content: string): { outcome: CheckOutcome; detail?: string } {
  const head = content.trimStart();
  if (head.startsWith("(timed out")) return { outcome: "failed", detail: "timed out" };
  const exit = /^exit=(\d+|\?)/.exec(head);
  const passed = lastNumber(content, /(\d+) (?:passed|passing)\b/gi) ?? lastNumber(content, /^\s*[#ℹ]\s*pass (\d+)\s*$/gm);
  const failed = lastNumber(content, /(\d+) (?:failed|failing)\b/gi) ?? lastNumber(content, /^\s*[#ℹ]\s*fail (\d+)\s*$/gm);
  const counts = [passed !== undefined ? `${passed} passed` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
  if (exit && exit[1] !== "?") {
    const code = Number(exit[1]);
    if (code === 0) return { outcome: "passed", ...(counts ? { detail: counts } : {}) };
    return { outcome: "failed", detail: counts || `exit ${code}` };
  }
  if (failed) return { outcome: "failed", detail: counts };
  if (passed !== undefined) return { outcome: "passed", detail: counts };
  return { outcome: "ran" };
}

function isStopped(content: string): boolean {
  const c = content.trim();
  return c === STOPPED_TOOL_RESULT || c.startsWith("(aborted");
}

function isFailedResult(content: string): boolean {
  return /^(Error|Permission denied|Blocked)\b/.test(content.trim());
}

function callLabel(name: string, args: Record<string, unknown>): string {
  if (name === "bash" && typeof args.command === "string") return displayCommand(args.command);
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  return path ? `${name} ${path}` : name;
}

/**
 * What the conversation in `messages` was doing when it was saved. With
 * `running` (a turn is under way: `/status` mid-turn) calls without a result
 * yet are running, not interrupted.
 */
export function buildWhereYouLeftOff(messages: ChatMessage[], o: { running?: boolean } = {}): WhereYouLeftOff | null {
  // The request being worked on: the last real one, or the one before a
  // bare "continue" (which includes our own Continue prompt).
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (!isRealRequest(m)) continue;
    start = i;
    const text = textOf(m);
    if (!(FOLLOW_UP.test(text) || text.startsWith(CONTINUE_MARKER))) break;
  }
  if (start < 0) return null;
  const startText = textOf(messages[start]!);
  const goalText = startText.startsWith(CONTINUE_MARKER) ? startText.slice(CONTINUE_MARKER.length) : startText;
  const goal = cutAtWord(goalText.split("\n").find((l) => l.trim()) ?? goalText, GOAL_MAX_CHARS);

  const scope = messages.slice(start);
  const results = new Map<string, string>();
  for (const m of scope) if (m.role === "tool" && m.tool_call_id) results.set(m.tool_call_id, typeof m.content === "string" ? m.content : textOf(m));

  let tasks: LeftOffTask[] | null = null;
  const files: string[] = [];
  const checks = new Map<string, CheckRun>();
  const inProgressCalls: string[] = [];
  let interrupted = 0;

  for (const m of scope) {
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    for (const tc of m.tool_calls) {
      const name = tc.function?.name ?? "";
      const args = parseArgs(tc.function?.arguments);
      const result = results.get(tc.id);
      if (name === "tasks_set" && Array.isArray(args.tasks)) {
        tasks = (args.tasks as unknown[])
          .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
          .map((t) => ({
            title: typeof t.title === "string" ? t.title.trim() : "",
            status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
          }))
          .filter((t) => t.title) as LeftOffTask[];
        continue;
      }
      if (result === undefined && o.running) {
        inProgressCalls.push(`${callLabel(name, args)} — running`);
        continue;
      }
      if (result === undefined || isStopped(result)) {
        interrupted++;
        inProgressCalls.push(`${callLabel(name, args)} — interrupted`);
        continue;
      }
      if ((name === "edit" || name === "write") && typeof args.path === "string" && !isFailedResult(result)) {
        if (!files.includes(args.path)) files.push(args.path);
        continue;
      }
      if (name === "bash" && typeof args.command === "string" && isCheckCommand(args.command)) {
        const command = displayCommand(args.command);
        checks.delete(command); // keep the latest run, in run order
        checks.set(command, { command, ...checkOutcome(result) });
      }
    }
  }

  const last = [...messages].reverse().find((m) => m.role !== "system");
  const lastText = last ? textOf(last) : "";
  const unfinishedTasks = (tasks ?? []).some((t) => t.status !== "completed");
  const stoppedMidTask =
    !o.running && (
    !last ||
    last.role === "user" ||
    last.role === "tool" ||
    (last.role === "assistant" && (!!last.tool_calls?.length || lastText.startsWith("Stopped:"))) ||
    interrupted > 0 ||
    unfinishedTasks);

  const inProgress = [...(tasks ?? []).filter((t) => t.status === "in_progress").map((t) => t.title), ...inProgressCalls];
  if (stoppedMidTask && inProgress.length === 0 && last && last.role !== "assistant") {
    inProgress.push(last.role === "user" ? "the first reply to this request — interrupted" : "the next step after the last tool result — interrupted");
  }

  return {
    goal,
    done: (tasks ?? []).filter((t) => t.status === "completed").map((t) => t.title),
    filesChanged: files,
    checks: [...checks.values()].slice(-MAX_CHECKS),
    inProgress,
    pending: (tasks ?? []).filter((t) => t.status === "pending").map((t) => t.title),
    interrupted,
    stoppedMidTask,
    hasTaskList: tasks !== null,
  };
}

function checkLine(c: CheckRun): string {
  const mark = c.outcome === "passed" ? "✓" : c.outcome === "failed" ? "✗" : "·";
  return `  ${mark} ${c.command}${c.detail ? `  ${c.detail}` : ""}`;
}

function filesLine(files: string[]): string {
  const shown = files.slice(0, MAX_FILES).join(", ");
  return files.length > MAX_FILES ? `${shown} and ${files.length - MAX_FILES} more` : shown;
}

/**
 * The summary as text lines. `heading` is the first line; `updatedAt` adds
 * when it stopped.
 */
export function formatWhereYouLeftOff(
  s: WhereYouLeftOff,
  o: { heading?: string; updatedAt?: string; now?: number; timeZone?: string } = {},
): string {
  const when = o.updatedAt ? ` ${formatWhen(o.updatedAt, o.now, o.timeZone)}` : "";
  const heading =
    o.heading ?? (s.stoppedMidTask ? `Where you left off: stopped mid-task${when}` : `Where you left off: finished${when}`);
  const lines = [heading, `Goal: ${s.goal}`];
  const done = [...s.done.map((t) => `  ✓ ${t}`)];
  if (s.filesChanged.length > 0) done.push(`  ✓ Changed ${filesLine(s.filesChanged)}`);
  if (done.length > 0) lines.push("Done", ...done);
  if (s.checks.length > 0) lines.push("Checks", ...s.checks.map(checkLine));
  if (s.inProgress.length > 0) lines.push(s.stoppedMidTask ? "In progress when it stopped" : "In progress", ...s.inProgress.map((t) => `  ▸ ${t}`));
  if (s.pending.length > 0) lines.push("Still to do", ...s.pending.map((t) => `  · ${t}`));
  if (!s.hasTaskList && s.stoppedMidTask && s.pending.length === 0) lines.push("Still to do: not recorded (no task list for this request)");
  return lines.join("\n");
}

/**
 * The prompt "Continue" sends: the summary as context, and what to watch for
 * (interrupted commands didn't finish; files may have changed since).
 */
export function continuePrompt(s: WhereYouLeftOff): string {
  return [
    `${CONTINUE_MARKER} ${s.goal}`,
    "",
    "The previous run stopped before this request was finished (interrupted, closed, or the connection dropped). This is where it left off, from the saved conversation:",
    "",
    formatWhereYouLeftOff(s, { heading: "Summary" }),
    "",
    "Pick up from the step in progress. Anything marked interrupted did not finish: check its effect and run it again if it's still needed. Don't redo finished steps unless the files show they need it. Keep the task list up to date with tasks_set.",
  ].join("\n");
}
