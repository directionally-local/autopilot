/**
 * Helpers for recording `compaction` events from the three compaction
 * paths (compiled-context archiving, LLM summarization, request preflight).
 */

import type { ChatMessage } from "../agent/messages.js";
import { estimatePromptTokens } from "../agent/artifact-compaction.js";
import type { TraceRecorder } from "./recorder.js";

interface ArtifactCompactionLike {
  metrics: {
    estimatedTokensBefore: number;
    estimatedTokensAfter: number;
    rawTurnsRemoved: number;
    archivedArtifacts: number;
  };
}

interface SummaryCompactionLike {
  newMessages: ChatMessage[];
  replacedCount: number;
  summary?: string;
}

/** Record a compiled-context compaction (no-op when nothing was removed). */
export function traceCompiledCompaction(
  trace: TraceRecorder | null | undefined,
  result: ArtifactCompactionLike,
  turnId: string | null = null,
): void {
  if (!trace?.enabled || result.metrics.rawTurnsRemoved === 0) return;
  trace.emit(
    "compaction",
    {
      method: "compiled",
      tokens_before: result.metrics.estimatedTokensBefore,
      tokens_after: result.metrics.estimatedTokensAfter,
      turns_removed: result.metrics.rawTurnsRemoved,
      artifacts_archived: result.metrics.archivedArtifacts,
    },
    turnId,
  );
}

/** Record an LLM-summary compaction (no-op when nothing was replaced). */
export function traceLlmCompaction(
  trace: TraceRecorder | null | undefined,
  before: ChatMessage[],
  result: SummaryCompactionLike,
  turnId: string | null = null,
): void {
  if (!trace?.enabled || result.replacedCount === 0) return;
  trace.emit(
    "compaction",
    {
      method: "llm",
      tokens_before: estimatePromptTokens(before),
      tokens_after: estimatePromptTokens(result.newMessages),
      turns_removed: result.replacedCount,
      ...(result.summary ? { summary_blob: trace.blob(result.summary) ?? "" } : {}),
    },
    turnId,
  );
}
