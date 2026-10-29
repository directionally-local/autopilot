/**
 * Stale-observation elision (Phase 1 of
 * docs/plans/harness-lessons-from-arxiv-2609-20804.md).
 *
 * Before paying for an LLM summary, replace bulky tool outputs in the middle
 * of the history with a short stub. The stub keeps the reducer's artifact id
 * so `expand_artifact` still works. The system prefix and a recent window of
 * turns stay verbatim, so the model keeps the task and its latest context.
 */
import type { ChatMessage } from "./messages.js";
import {
  estimateMessageTokens,
  estimatePromptTokens,
  groupIntoTurns,
} from "./artifact-compaction.js";
import { HARD_COMPACTION_SHARE, SOFT_COMPACTION_SHARE } from "./context-budget.js";

/** Tool outputs shorter than this are cheap enough to keep verbatim. */
export const ELISION_MIN_CHARS = 2_000;

/** Share of the input budget kept verbatim at the tail of the history. */
export const ELISION_RECENT_SHARE = 0.3;

/** Always keep at least this many recent turns verbatim. */
export const ELISION_MIN_RECENT_TURNS = 2;

/** The reducer footer that carries the artifact id. */
const ARTIFACT_FOOTER = /\[output reduced — full raw stored as artifact ([^\]\s]+)\]/;

export interface ElisionOpts {
  /** Effective input budget for the active model. */
  budgetTokens: number;
  /** Elide only at or above this level. Defaults to 0.6 × budget. */
  softThresholdTokens?: number;
  /** Stop eliding once the history is at or below this level. Defaults to 0.85 × budget. */
  targetTokens?: number;
  /** Minimum recent turns kept verbatim. Defaults to 2. */
  minRecentTurns?: number;
  /** Share of the budget kept verbatim at the tail. Defaults to 0.3. */
  recentShare?: number;
  /** Tool outputs shorter than this are left alone. Defaults to 2000 chars. */
  minChars?: number;
}

export interface ElisionResult {
  messages: ChatMessage[];
  elidedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

function unchanged(messages: ChatMessage[], tokensBefore: number): ElisionResult {
  return { messages, elidedCount: 0, tokensBefore, tokensAfter: tokensBefore };
}

function stubFor(content: string): string {
  const lines = content.split("\n").length;
  const artifactId = content.match(ARTIFACT_FOOTER)?.[1];
  const artifact = artifactId ? `; full raw stored as artifact ${artifactId}` : "";
  return `[tool output elided: ${lines} lines / ${content.length} chars; re-run the tool if needed${artifact}]`;
}

/**
 * Elide bulky tool outputs in the middle of the history, oldest first, until
 * the prompt fits `targetTokens` or the middle region is exhausted. Returns
 * the input unchanged when it is below the soft threshold or has no middle.
 */
export function elideStaleObservations(messages: ChatMessage[], opts: ElisionOpts): ElisionResult {
  const tokensBefore = estimatePromptTokens(messages);
  const soft = opts.softThresholdTokens ?? Math.floor(opts.budgetTokens * SOFT_COMPACTION_SHARE);
  if (tokensBefore < soft) return unchanged(messages, tokensBefore);

  const { prefix, turns } = groupIntoTurns(messages);
  if (turns.length === 0) return unchanged(messages, tokensBefore);

  const minRecent = Math.max(1, opts.minRecentTurns ?? ELISION_MIN_RECENT_TURNS);
  const recentShare = opts.recentShare ?? ELISION_RECENT_SHARE;
  const recentBudget = Math.floor(opts.budgetTokens * recentShare);

  // Keep at least `minRecent` turns, then extend the verbatim tail until it
  // covers the recent share of the budget (or the whole history).
  let keep = Math.min(minRecent, turns.length);
  let keptTokens = turns
    .slice(turns.length - keep)
    .reduce((sum, turn) => sum + estimatePromptTokens(turn.messages), 0);
  while (keep < turns.length && keptTokens < recentBudget) {
    keep++;
    keptTokens += estimatePromptTokens(turns[turns.length - keep]!.messages);
  }
  keep = Math.max(1, Math.min(keep, turns.length));

  const middle = turns.slice(0, turns.length - keep);
  if (middle.length === 0) return unchanged(messages, tokensBefore);

  const target = opts.targetTokens ?? Math.floor(opts.budgetTokens * HARD_COMPACTION_SHARE);
  const minChars = opts.minChars ?? ELISION_MIN_CHARS;

  const newMiddle = middle.map((turn) => ({ ...turn, messages: [...turn.messages] }));
  let running = tokensBefore;
  let elidedCount = 0;

  outer: for (const turn of newMiddle) {
    for (let i = 0; i < turn.messages.length; i++) {
      if (running <= target) break outer;
      const message = turn.messages[i]!;
      if (message.role !== "tool") continue;
      const content = typeof message.content === "string" ? message.content : "";
      if (content.length < minChars) continue;

      const stub: ChatMessage = { ...message, content: stubFor(content) };
      running -= estimateMessageTokens(message) - estimateMessageTokens(stub);
      turn.messages[i] = stub;
      elidedCount++;
    }
  }

  if (elidedCount === 0) return unchanged(messages, tokensBefore);

  const newMessages: ChatMessage[] = [
    ...prefix,
    ...newMiddle.flatMap((turn) => turn.messages),
    ...turns.slice(turns.length - keep).flatMap((turn) => turn.messages),
  ];
  return {
    messages: newMessages,
    elidedCount,
    tokensBefore,
    tokensAfter: estimatePromptTokens(newMessages),
  };
}
