import type { ChatMessage } from "./messages.js";
import type { Task } from "../tools/registry.js";

/**
 * The live plan, re-injected on every request (#950).
 *
 * `tasks_set` stays the write path, but the plan otherwise lives only in
 * history: compaction keeps at most a one-line digest, and a model that
 * forgets it re-plans or drifts. Appending a short reminder to each request
 * keeps the plan in front of the model without another tool call.
 *
 * The reminder is transient: it is appended to the request messages only,
 * never written into `opts.messages`, so it does not survive the turn and
 * does not disturb the cached prompt prefix.
 */
export function buildPlanReminder(tasks: Task[]): string | undefined {
  if (tasks.length === 0) return undefined;
  const lines = tasks.map((task) => {
    const mark = task.status === "completed" ? "[x]" : task.status === "in_progress" ? "[>]" : "[ ]";
    return `${mark} ${task.title}`;
  });
  return `<system-reminder>\nCurrent plan:\n${lines.join("\n")}\n</system-reminder>`;
}

/** Append the plan reminder as a transient system message at the end of the request. */
export function withPlanReminder(messages: ChatMessage[], reminder: string | undefined): ChatMessage[] {
  if (!reminder) return messages;
  return [...messages, { role: "system", content: reminder }];
}
