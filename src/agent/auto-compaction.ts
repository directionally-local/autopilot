/**
 * Automatic compaction, extracted from the TUI App: the mid-turn pass the
 * loop runs between iterations, and the post-turn pass (proactive, then
 * aggressive when the history is still huge). One implementation covers
 * both context modes — compiled context archives turns as artifacts; plain
 * context summarizes them with the LLM — so the three call sites can't
 * drift apart.
 *
 * Everything with a side effect (persistence, notices, hooks, memory,
 * the summarizer) comes in through `AutoCompactionDeps`, which keeps this
 * module host-agnostic and testable without rendering the app.
 */

import { compactMessagesViaArtifacts } from "./artifact-compaction.js";
import { elideStaleObservations } from "./elision.js";
import { HARD_COMPACTION_SHARE } from "./context-budget.js";
import type { ArtifactStore, SessionState } from "./session-state.js";
import type { ChatMessage } from "./messages.js";
import type { CompactResult } from "./llm-summarize.js";
import { injectRecalledMemoryOnce } from "../memory/recall-inject.js";
import { traceCompiledCompaction, traceLlmCompaction } from "../trace/compaction.js";
import type { TraceRecorder } from "../trace/recorder.js";

/** The slice of MemoryManager compaction needs. */
export interface CompactionMemory {
  recall(query: { text: string; repoPath: string; limit: number }): Promise<unknown[]>;
  synthesizeRecalled(results: unknown[]): Promise<string>;
}

export interface AutoCompactionDeps {
  /** Archive turns as artifacts (compiled context) instead of LLM summaries. */
  compiledContext: boolean;
  getState(): SessionState;
  setState(state: SessionState): void;
  store: ArtifactStore;
  /** LLM summarizer (plain context). */
  summarize(messages: ChatMessage[], opts: { keepLastTurns?: number; signal?: AbortSignal }): Promise<CompactResult>;
  /** Re-anchor durable memories after compaction. */
  memory?: CompactionMemory | null;
  cwd: string;
  /** Effective input budget for the active model. Enables budget-relative
   *  elision before summarization; omit to keep the old behavior. */
  budgetTokens?: number;
  /** Hard threshold; summarization runs only above this. Defaults to 0.85 × budget. */
  hardThresholdTokens?: number;
  trace?: TraceRecorder | null;
  turnId?: string | null;
  /** A notice for the user ("info" or a memory notice). */
  notify(kind: "info" | "memory", text: string): void;
  save(): Promise<void> | void;
  /** Best-effort PreCompact hook; never awaited. */
  firePreCompact?(signal?: AbortSignal): void;
}

export interface CompactionPass {
  messages: ChatMessage[];
  compacted: boolean;
}

/**
 * Compact once. `aggressive` keeps only the last turn (used when the
 * history is still far too large after the normal pass). Summarizer errors
 * propagate; the compiled path never throws.
 */
export async function compactConversation(
  messages: ChatMessage[],
  deps: AutoCompactionDeps,
  opts: { aggressive?: boolean; signal?: AbortSignal } = {},
): Promise<CompactionPass> {
  const keep = opts.aggressive ? { keepLastTurns: 1 } : {};
  const label = opts.aggressive ? "auto-compacted (aggressive)" : "auto-compacted";

  // Phase 1: elide stale tool output before paying for a summary. The
  // aggressive pass skips this — it is the last resort when elision was not
  // enough.
  let working = messages;
  if (!opts.aggressive && deps.budgetTokens) {
    const hard = deps.hardThresholdTokens ?? Math.floor(deps.budgetTokens * HARD_COMPACTION_SHARE);
    const elided = elideStaleObservations(working, {
      budgetTokens: deps.budgetTokens,
      targetTokens: hard,
    });
    if (elided.elidedCount > 0) {
      working = elided.messages;
      deps.notify(
        "info",
        `elided ${elided.elidedCount} stale tool output${elided.elidedCount === 1 ? "" : "s"}: ${elided.tokensBefore.toLocaleString()} → ${elided.tokensAfter.toLocaleString()} tokens`,
      );
      await deps.save();
      if (elided.tokensAfter < hard) return { messages: working, compacted: true };
    }
  }

  if (deps.compiledContext) {
    const result = compactMessagesViaArtifacts({ messages: working, state: deps.getState(), store: deps.store, ...keep });
    if (result.metrics.rawTurnsRemoved === 0) return { messages: result.newMessages, compacted: false };
    traceCompiledCompaction(deps.trace, result, deps.turnId ?? null);
    deps.setState(result.newState);
    const n = (v: number) => (opts.aggressive ? v.toLocaleString() : String(v));
    deps.notify(
      "info",
      `${label}: ${n(result.metrics.estimatedTokensBefore)} → ${n(result.metrics.estimatedTokensAfter)} tokens (${result.metrics.archivedArtifacts} artifacts)`,
    );
    await deps.save();
    return { messages: result.newMessages, compacted: true };
  }
  const result = await deps.summarize(working, { ...keep, ...(opts.signal ? { signal: opts.signal } : {}) });
  if (result.replacedCount === 0) return { messages: result.newMessages, compacted: false };
  traceLlmCompaction(deps.trace, working, result, deps.turnId ?? null);
  deps.notify("info", `${label}: ${result.replacedCount} messages summarized`);
  await deps.save();
  return { messages: result.newMessages, compacted: true };
}

/** Recall durable memories into `messages` (mutated) after a compaction. Non-fatal. */
export async function recallAfterCompaction(messages: ChatMessage[], deps: AutoCompactionDeps, signal?: AbortSignal): Promise<boolean> {
  const memory = deps.memory;
  if (!memory || signal?.aborted) return false;
  try {
    const results = await memory.recall({ text: deps.getState().task || deps.cwd, repoPath: deps.cwd, limit: 5 });
    if (results.length === 0 || signal?.aborted) return false;
    const text = await memory.synthesizeRecalled(results);
    if (!injectRecalledMemoryOnce(messages, text)) return false;
    deps.notify("memory", `recalled ${results.length} memor${results.length === 1 ? "y" : "ies"} after compaction`);
    await deps.save();
    return true;
  } catch {
    return false;
  }
}

/**
 * Between loop iterations, once over the threshold: fire PreCompact, compact,
 * and re-anchor memories. Failures leave the messages unchanged — the
 * request preflight is the backstop.
 */
export async function compactMidTurn(messages: ChatMessage[], deps: AutoCompactionDeps, signal: AbortSignal): Promise<ChatMessage[]> {
  if (signal.aborted) return messages;
  deps.firePreCompact?.(signal);
  try {
    const pass = await compactConversation(messages, deps, { signal });
    if (pass.compacted) await recallAfterCompaction(pass.messages, deps, signal);
    return pass.messages;
  } catch {
    return messages;
  }
}

export interface PostTurnCompactionInput {
  getMessages(): ChatMessage[];
  setMessages(messages: ChatMessage[]): void;
  /** The proactive threshold was crossed (shouldCompact with the model's budget). */
  overThreshold: boolean;
  estimateTokens(messages: ChatMessage[]): number;
  /** Above this, compact aggressively (keep only the last turn). */
  aggressiveTokenThreshold: number;
  signal: AbortSignal;
}

/**
 * After a turn: the proactive pass when over the threshold, then — if the
 * history is still above the aggressive threshold — an aggressive pass.
 * Returns the token estimate after the aggressive pass (the host decides on
 * auto-fresh), or null when the history never got that large.
 */
export async function compactAfterTurn(input: PostTurnCompactionInput, deps: AutoCompactionDeps): Promise<number | null> {
  const run = async (aggressive: boolean): Promise<boolean> => {
    try {
      const pass = await compactConversation(input.getMessages(), deps, { aggressive, signal: input.signal });
      if (pass.compacted) input.setMessages(pass.messages);
      return pass.compacted;
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        deps.notify("info", `${aggressive ? "aggressive auto-compact" : "auto-compact"} failed: ${(err as Error).message ?? String(err)}`);
      }
      return false;
    }
  };

  if (input.overThreshold) {
    deps.firePreCompact?.();
    if (await run(false)) await recallAfterCompaction(input.getMessages(), deps);
  }
  if (input.estimateTokens(input.getMessages()) > input.aggressiveTokenThreshold) {
    await run(true);
    return input.estimateTokens(input.getMessages());
  }
  return null;
}
