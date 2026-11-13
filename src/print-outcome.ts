/**
 * Did a print-mode run finish? (exit code 45)
 *
 * A run is unfinished when, after the turn returned normally:
 *  - any tool call was denied (a permission rule, a hook, the guardrails or
 *    the headless policy; ToolResult.denied);
 *  - the model offered plan options for someone to pick (present_plan_options);
 *  - a limit stopped the turn before it finished (the loop's turn end reason
 *    is not "complete");
 *  - or the final reply asks the user something. The heuristic is
 *    deliberately narrow: the reply's last non-empty line, outside a code
 *    block and ignoring trailing markdown emphasis, quotes and closing
 *    brackets, ends with a question mark. A reply that ends with a statement
 *    ("Let me know if you need anything else.") counts as finished.
 *
 * Budget (42), loop (43), blocked prompt (44) and API errors (1) keep their
 * own codes and are decided before this.
 */

import type { ChatMessage } from "./agent/messages.js";
import type { TurnEndReason } from "./trace/types.js";

export const UNFINISHED_EXIT_CODE = 45;

export type UnfinishedReason = "denied_tool_calls" | "asks_user" | "plan_options" | "stopped_early";

export interface UnfinishedRun {
  code: typeof UNFINISHED_EXIT_CODE;
  reasons: UnfinishedReason[];
  /** One line for stderr. */
  message: string;
  /** Names of the denied tool calls, in order. */
  denied: string[];
  /** The question the final reply ended with. */
  question?: string;
  /** The loop's turn end reason, when it wasn't "complete". */
  turnEnd?: TurnEndReason;
}

/** The text of an assistant message (string or text parts). */
export function assistantText(msg: ChatMessage | null | undefined): string {
  if (!msg || msg.role !== "assistant" || msg.content === null) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** The final reply's closing question, or null when it doesn't end with one. */
export function closingQuestion(text: string): string | null {
  const lines = text.split("\n");
  let inFence = false;
  let last: string | null = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      last = null;
      continue;
    }
    if (!inFence && line.trim()) last = line.trim();
  }
  if (inFence || last === null) return null;
  const stripped = last.replace(/[\s*_`'"’”)\]]+$/u, "");
  return stripped.endsWith("?") ? last : null;
}

export function unfinishedRun(facts: {
  denied: string[];
  finalText: string;
  planOptions: boolean;
  turnEnd: TurnEndReason | null;
}): UnfinishedRun | null {
  const reasons: UnfinishedReason[] = [];
  const parts: string[] = [];
  if (facts.denied.length > 0) {
    reasons.push("denied_tool_calls");
    const names = [...new Set(facts.denied)].join(", ");
    parts.push(`${facts.denied.length} tool call${facts.denied.length === 1 ? " was" : "s were"} denied (${names})`);
  }
  if (facts.planOptions) {
    reasons.push("plan_options");
    parts.push("the model offered plan options for someone to choose");
  }
  const turnEnd = facts.turnEnd && facts.turnEnd !== "complete" ? facts.turnEnd : undefined;
  if (turnEnd) {
    reasons.push("stopped_early");
    parts.push(`the turn stopped before finishing (${turnEnd})`);
  }
  const question = closingQuestion(facts.finalText);
  if (question) {
    reasons.push("asks_user");
    parts.push("the final reply asks a question");
  }
  if (reasons.length === 0) return null;
  return {
    code: UNFINISHED_EXIT_CODE,
    reasons,
    message: `run did not finish: ${parts.join("; ")} — exiting with code ${UNFINISHED_EXIT_CODE}`,
    denied: facts.denied,
    ...(question ? { question } : {}),
    ...(turnEnd ? { turnEnd } : {}),
  };
}
