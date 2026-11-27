import type { ChatMessage } from "./messages.js";
import type { ProviderCompat } from "../providers/presets.js";
import { readEnv, type EnvLike } from "../util/env.js";
import { logger } from "../util/logger.js";

/** One gate per process: presets that need the synthesized fallback ignore the opt-in and warn only once. */
export function createReasoningStripGate() {
  let warned = false;
  return (
    compat: ProviderCompat,
    onWarning: (message: string) => void = (message) => logger.warn("agent:strip_reasoning_ignored", { message }),
    env: EnvLike = process.env,
  ): boolean => {
    const requested = readEnv("STRIP_REASONING", env) === "1";
    if (!requested) return false;
    if (compat.reasoningEcho.synthesizeFallback !== true) return true;
    if (!warned) {
      warned = true;
      onWarning("AUTOPILOT_STRIP_REASONING=1 is ignored: this provider requires reasoning_content on tool-call turns.");
    }
    return false;
  };
}

export interface StripReasoningOpts {
  /** Number of most-recent assistant messages to preserve reasoning on. Default 1. */
  keepLast?: number;
}

const DEFAULT_KEEP_LAST = 1;
const SUBSTANTIVE_TEXT_THRESHOLD = 200;

/**
 * Strip reasoning_content and narration text from historical assistant messages.
 *
 * Rules:
 * - Keep reasoning_content on the N most recent assistant messages (default N=1).
 * - On older assistant messages:
 *   - Delete reasoning_content key entirely.
 *   - If the message has both text content and tool_calls, replace text with "".
 *   - If the message has only text (no tool_calls), preserve it only when text
 *     length > SUBSTANTIVE_TEXT_THRESHOLD chars; otherwise replace with "".
 * - tool, system, and user messages are never modified.
 */
export function stripHistoricalReasoning(
  messages: ChatMessage[],
  opts: StripReasoningOpts = {},
): ChatMessage[] {
  const keepLast = opts.keepLast ?? DEFAULT_KEEP_LAST;

  // Identify indices of assistant messages so we know which are "recent".
  const assistantIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "assistant") {
      assistantIndices.push(i);
    }
  }

  // The last `keepLast` assistant messages are preserved; everything older is stripped.
  const preservedSet =
    keepLast === 0
      ? new Set<number>()
      : new Set(assistantIndices.slice(-keepLast));

  return messages.map((m, idx) => {
    if (m.role !== "assistant") return m;
    if (preservedSet.has(idx)) return m;

    const next: ChatMessage = { ...m };

    // Delete reasoning_content entirely.
    delete (next as unknown as Record<string, unknown>).reasoning_content;

    // Strip narration text when tool_calls are present.
    if (next.tool_calls && next.tool_calls.length > 0) {
      if (typeof next.content === "string") {
        next.content = "";
      } else if (Array.isArray(next.content)) {
        next.content = next.content.map((part) =>
          part.type === "text" ? { ...part, text: "" } : part,
        );
      }
      return next;
    }

    // No tool_calls — decide whether text is substantive.
    const textLen =
      typeof next.content === "string"
        ? next.content.length
        : Array.isArray(next.content)
          ? next.content
              .filter((p) => p.type === "text")
              .reduce((sum, p) => sum + p.text.length, 0)
          : 0;

    if (textLen <= SUBSTANTIVE_TEXT_THRESHOLD) {
      if (typeof next.content === "string") {
        next.content = "";
      } else if (Array.isArray(next.content)) {
        next.content = next.content.map((part) =>
          part.type === "text" ? { ...part, text: "" } : part,
        );
      }
    }

    return next;
  });
}
