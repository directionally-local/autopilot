/**
 * Context handoff: the fresh-first ordering at context exhaustion.
 *
 * The session's own model writes the handoff in its own turn, at the natural
 * break, in the five headings `/fresh` already uses. `generateContinuationSummary`
 * stays as the fallback when in-turn authoring is unavailable; compaction runs
 * only when both fail. The new session records the old session's id
 * (`continuedFrom`) and the handoff cites it.
 *
 * This module is host-agnostic: every side effect (checkpoint, summarizer,
 * compaction, starting the new session, notices) comes in through
 * `HandoffDeps`, so the ordering is testable without rendering the app.
 */

import type { ChatMessage } from "./messages.js";
import type { Mode } from "../mode.js";
import { HANDOFF_HEADINGS } from "./continuation-summary.js";

/** The five headings `/fresh`'s summarizer asks for, in order. Imported from
 *  the summarizer rather than restated: one source of truth for the format. */
export { HANDOFF_HEADINGS };

/** True when `text` carries all five handoff headings. */
export function hasHandoffHeadings(text: string): boolean {
  return HANDOFF_HEADINGS.every((heading) => new RegExp(`^\\s*${heading}`, "m").test(text));
}

/** The line that links a handoff to the session it continues. */
export function sessionCitation(oldSessionId: string): string {
  return `Continued from session: ${oldSessionId}`;
}

/** The summary with the session citation as its first line (idempotent). An
 *  empty id cites nothing: a citation to no session is worse than none. */
export function withSessionCitation(summary: string, oldSessionId: string): string {
  if (!oldSessionId) return summary;
  const citation = sessionCitation(oldSessionId);
  if (summary.includes(citation)) return summary;
  return `${citation}\n\n${summary}`;
}

/** The in-conversation ping: informational, never interrupts the iteration. */
export function handoffPingNotice(fill: number): string {
  return `Context is at ${Math.round(fill * 100)}% of the input budget. Finish the current iteration, then write the handoff checkpoint (Goal / Completed / Remaining / Current state / Context) at the natural break.`;
}

/** The in-conversation warning: finish the iteration and transition at the break. */
export function handoffWarningNotice(fill: number): string {
  return `Context is at ${Math.round(fill * 100)}% of the input budget. Finish the current iteration, stop starting new large tasks, and write the final handoff checkpoint at the end of this turn; a new session will continue from it.`;
}

/** The directive delivered in the model's own turn: the notice plus the shape. */
export function handoffDirective(trigger: "ping" | "warning", fill: number, oldSessionId: string): string {
  const notice = trigger === "ping" ? handoffPingNotice(fill) : handoffWarningNotice(fill);
  return [
    `[context handoff] ${notice}`,
    "Write the handoff as normal output with these exact headings: Goal, Completed, Remaining, Current state, Context.",
    `Start it with the line "${sessionCitation(oldSessionId)}".`,
  ].join("\n");
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * The handoff the model authored in its own turn: the most recent assistant
 * message in the current turn (back to the last user message) that carries the
 * five headings. Null when the turn ended without one.
 */
export function inTurnHandoffFrom(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") break;
    if (message?.role !== "assistant") continue;
    const text = textOf(message.content).trim();
    if (text && hasHandoffHeadings(text)) return text;
  }
  return null;
}

export interface HandoffTurnPlan {
  trigger: "ping" | "warning";
  fill: number;
  /** Delivered in-conversation at the turn start; never interrupts the iteration. */
  notice: string;
  /** The checkpoint is written when the iteration ends naturally. */
  checkpointAtBreak: true;
  /** Start a new session at the natural break (warning + auto-fresh on). */
  transitionAtBreak: boolean;
}

/**
 * What a context-fill trigger asks for. Pure: the notice is delivered at the
 * turn start, and the checkpoint/transition happen only when the iteration
 * ends naturally (the host runs `runHandoff` in its post-turn block).
 */
export function planHandoffTurn(input: {
  trigger: "ping" | "warning";
  fill: number;
  /** The user's explicit opt-out (`autoFreshEnabled: false`). Unset means the
   *  handoff is the default at the warning — the maintainer's pointer. */
  autoFreshEnabled?: boolean;
  mode: Mode;
  oldSessionId: string;
}): HandoffTurnPlan {
  const transitionAtBreak =
    input.trigger === "warning" &&
    input.autoFreshEnabled !== false &&
    (input.mode === "auto" || input.mode === "edit");
  return {
    trigger: input.trigger,
    fill: input.fill,
    notice: handoffDirective(input.trigger, input.fill, input.oldSessionId),
    checkpointAtBreak: true,
    transitionAtBreak,
  };
}

export interface HandoffDeps {
  oldSessionId: string;
  /** From `planHandoffTurn`: transition at the break, or checkpoint only. */
  transition: boolean;
  /** The handoff the model authored in its own turn, if any. */
  inTurnSummary?: string | null;
  /** Preserve the old session whole (checkpoint) before anything else. */
  checkpoint: () => Promise<void>;
  /** The fallback summarizer (`generateContinuationSummary`). */
  fallbackSummary: () => Promise<string | null>;
  /** Compaction, run only when the handoff fails. */
  compact: () => Promise<void>;
  /** Start the new session from the cited summary; returns its id. */
  startFresh: (summary: string) => string | Promise<string>;
  notify: (kind: "info" | "error", text: string) => void;
}

export type HandoffOutcome =
  | { kind: "checkpoint" }
  | { kind: "handoff"; source: "in-turn" | "fallback"; summary: string; oldSessionId: string; newSessionId: string }
  | { kind: "compaction"; reason: string };

/**
 * Run at the natural break: checkpoint the old session, then — when the plan
 * says to transition — use the in-turn handoff, else the fallback summary,
 * else compaction. Compaction never runs while a handoff is in progress or
 * has succeeded for the same exhaustion event.
 */
export async function runHandoff(deps: HandoffDeps): Promise<HandoffOutcome> {
  // The old session is preserved whole before anything else: the handoff is
  // the fast path, not the only copy.
  await deps.checkpoint();
  if (!deps.transition) return { kind: "checkpoint" };

  let summary: string | null = null;
  let source: "in-turn" | "fallback" = "in-turn";
  const inTurn = deps.inTurnSummary?.trim();
  if (inTurn && hasHandoffHeadings(inTurn)) {
    summary = inTurn;
  } else {
    source = "fallback";
    try {
      summary = (await deps.fallbackSummary())?.trim() || null;
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      deps.notify("error", `Handoff failed: ${reason}. Falling back to compaction.`);
      await deps.compact();
      return { kind: "compaction", reason };
    }
  }
  if (!summary) {
    deps.notify("error", "Handoff failed: no summary was produced. Falling back to compaction.");
    await deps.compact();
    return { kind: "compaction", reason: "no summary" };
  }

  const cited = withSessionCitation(summary, deps.oldSessionId);
  const newSessionId = await deps.startFresh(cited);
  deps.notify("info", `Handoff complete: session ${newSessionId} continues from ${deps.oldSessionId}.`);
  return { kind: "handoff", source, summary: cited, oldSessionId: deps.oldSessionId, newSessionId };
}
