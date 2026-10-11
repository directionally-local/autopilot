/**
 * Classify the user's next message as a signal about the previous turn:
 * a correction is a negative signal, a "go on" a weak positive one.
 * Regex only; an LLM judge is an export-time concern (plan §6).
 */

import type { NextMessageClassification } from "./types.js";

const CORRECTION = /^(no\b|nope\b|wrong\b|that's not\b|that is not\b|thats not\b|not what\b|undo\b|revert\b|stop\b|don't\b|dont\b)/i;
const CONTINUE = /^(go on\b|continue\b|yes\b|yep\b|yeah\b|ok\b|okay\b|do it\b|proceed\b|sure\b|sounds good\b|lgtm\b|looks good\b|next\b)/i;

export function classifyNextMessage(text: string): NextMessageClassification {
  const trimmed = text.trim();
  if (!trimmed) return "other";
  if (trimmed.startsWith("/")) return "other";
  if (CORRECTION.test(trimmed)) return "correction";
  if (CONTINUE.test(trimmed)) return "continue";
  if (trimmed.endsWith("?")) return "question";
  return "new_task";
}
