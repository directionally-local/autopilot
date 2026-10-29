import type { ChatMessage } from "./messages.js";
import { getModelOrInfer } from "../models/registry.js";
import { compactMessagesViaArtifacts, estimatePromptTokens } from "./artifact-compaction.js";
import {
  ArtifactStore,
  deserializeArtifactStore,
  emptySessionState,
  serializeArtifactStore,
  type SerializedArtifact,
  type SessionState,
} from "./session-state.js";

/** Default completion budget when the caller doesn't pin one. The API counts
 *  `input + max_completion_tokens` against the context window. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 16_384;

/** Headroom for estimator drift: prompt tokens are estimated from characters,
 *  which under-counts code- and JSON-heavy content. */
export const BUDGET_SAFETY_MARGIN_TOKENS = 8_192;

/** Legacy absolute cap. Kept for callers that still import it; budget-relative
 *  thresholds no longer apply it unless a host opts in via `absoluteCapTokens`. */
export const PROACTIVE_COMPACTION_CAP_TOKENS = 80_000;

/** Soft threshold: elide stale tool output at this share of the input budget. */
export const SOFT_COMPACTION_SHARE = 0.6;

/** Hard threshold: summarize only when the history is still above this share. */
export const HARD_COMPACTION_SHARE = 0.85;

/** Recent turns to keep raw, tried in order until the history fits. */
const KEEP_TURNS_LADDER = [4, 2, 1] as const;

/** Largest prompt the model accepts: context window minus the completion
 *  budget and a safety margin. Shared by request preflight and compaction. */
export function effectiveInputBudget(model: string, maxCompletionTokens?: number): number {
  const contextWindow = getModelOrInfer(model).contextWindow;
  const completion = maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS;
  return Math.max(1, contextWindow - completion - BUDGET_SAFETY_MARGIN_TOKENS);
}

export interface CompactionThresholdOpts {
  maxCompletionTokens?: number;
  /** Optional absolute token cap (cost control). Off by default. */
  absoluteCapTokens?: number;
}

/** Estimated-token level at which hosts elide stale tool output. */
export function softCompactionThreshold(model: string, opts: CompactionThresholdOpts = {}): number {
  const budget = effectiveInputBudget(model, opts.maxCompletionTokens);
  const soft = Math.floor(budget * SOFT_COMPACTION_SHARE);
  return opts.absoluteCapTokens ? Math.min(soft, opts.absoluteCapTokens) : soft;
}

/** Estimated-token level above which hosts summarize instead of only eliding. */
export function hardCompactionThreshold(model: string, opts: CompactionThresholdOpts = {}): number {
  const budget = effectiveInputBudget(model, opts.maxCompletionTokens);
  const hard = Math.floor(budget * HARD_COMPACTION_SHARE);
  return opts.absoluteCapTokens ? Math.min(hard, opts.absoluteCapTokens) : hard;
}

/** @deprecated Use {@link softCompactionThreshold}. Budget-relative since #947. */
export function proactiveCompactionThreshold(model: string, maxCompletionTokens?: number): number {
  return softCompactionThreshold(model, { maxCompletionTokens });
}

/** The prompt cannot fit even after compacting everything but the active turn. */
export class ContextBudgetError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly budgetTokens: number,
    readonly contextWindow: number,
  ) {
    super(
      `kimiflare: context window exceeded (~${estimatedTokens.toLocaleString()} tokens needed, ` +
        `${budgetTokens.toLocaleString()} available of ${contextWindow.toLocaleString()}). ` +
        `Older turns were already compacted; the current turn alone is too large. ` +
        `Run /clear to start fresh, pick a model with a larger context window, or reduce the size of the request (e.g. fewer or smaller attachments).`,
    );
    this.name = "ContextBudgetError";
  }
}

/** Where compaction reads and writes durable state. Hosts persist it with
 *  their session so archived turns stay recoverable. */
export interface CompactionTarget {
  getState(): SessionState;
  setState(state: SessionState): void;
  getStore(): ArtifactStore;
  /** Called after state/store changed so the host can mirror it for saving. */
  onChange?(): void;
}

export interface CompactionOutcome {
  messages: ChatMessage[];
  tokensBefore: number;
  tokensAfter: number;
  turnsRemoved: number;
  artifactsArchived: number;
}

/**
 * Compact older complete turns into session state + archived artifacts until
 * `messages` fits `budgetTokens`. Keeps system messages, the active (last)
 * turn, and valid assistant/tool pairing (whole turns are moved or kept).
 * Tries progressively smaller working sets; bounded, never loops. Returns null
 * when no turn could be removed.
 */
export function compactToFit(messages: ChatMessage[], budgetTokens: number, target: CompactionTarget): CompactionOutcome | null {
  const tokensBefore = estimatePromptTokens(messages);
  for (const keepLastTurns of KEEP_TURNS_LADDER) {
    // Dry run against a scratch store so a too-weak attempt leaves no trace.
    const scratch = new ArtifactStore();
    const attempt = compactMessagesViaArtifacts({ messages, state: target.getState(), store: scratch, keepLastTurns });
    if (attempt.metrics.rawTurnsRemoved === 0) continue;
    const isLast = keepLastTurns === KEEP_TURNS_LADDER[KEEP_TURNS_LADDER.length - 1];
    if (attempt.metrics.estimatedTokensAfter > budgetTokens && !isLast) continue;

    const store = target.getStore();
    for (const artifact of scratch.list()) store.add(artifact);
    target.setState(attempt.newState);
    target.onChange?.();
    return {
      messages: attempt.newMessages,
      tokensBefore,
      tokensAfter: attempt.metrics.estimatedTokensAfter,
      turnsRemoved: attempt.metrics.rawTurnsRemoved,
      artifactsArchived: attempt.metrics.archivedArtifacts,
    };
  }
  return null;
}

/** Compaction target backed by a persisted session file: state and archived
 *  artifacts are written onto the object, so any later save persists them. */
export function sessionFileCompactionTarget(file: {
  sessionState?: SessionState;
  artifactStore?: SerializedArtifact[];
}): CompactionTarget {
  let store: ArtifactStore | null = null;
  return {
    getState: () => file.sessionState ?? emptySessionState(),
    setState: (state) => {
      file.sessionState = state;
    },
    getStore: () => (store ??= file.artifactStore ? deserializeArtifactStore(file.artifactStore) : new ArtifactStore()),
    onChange: () => {
      if (store) file.artifactStore = serializeArtifactStore(store);
    },
  };
}
