/**
 * Layer 2: LLM fallback for ambiguous sessions.
 * Uses the cheapest available model. Results cached in usage.json.
 */

import type { TaskCategory, TaskCategorization } from "./types.js";
import { ALL_CATEGORIES } from "./types.js";

interface LlmClassifierDeps {
  runLlm: (prompt: string, model: string) => Promise<string>;
  /** Side-call model for the active provider (see plumbingModelOf). */
  model: string;
}

function redactSecrets(text: string): string {
  // Simple redaction: remove anything that looks like a token/key
  return text
    .replace(/\b(sk-[a-zA-Z0-9]{20,})\b/g, "[REDACTED]")
    .replace(/\b([a-zA-Z0-9_-]*(?:api[_-]?key|token|secret|password)[a-zA-Z0-9_-]*\s*[:=]\s*)[^\s&]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z0-9+/]{40,}=*)\b/g, "[REDACTED]");
}

export interface ClassifyWithLlmInput {
  firstUserMessage: string;
  toolCounts: Record<string, number>;
  filesTouched: string[];
  commandsRun: string[];
}

export async function classifyWithLlm(
  input: ClassifyWithLlmInput,
  deps: LlmClassifierDeps,
): Promise<TaskCategorization> {
  const model = deps.model;

  const toolSummary = Object.entries(input.toolCounts)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  const files = input.filesTouched.slice(0, 20).join(", ");
  const commands = input.commandsRun.slice(0, 10).join(", ");
  const firstMsg = redactSecrets(input.firstUserMessage.slice(0, 200));

  const prompt = `Classify this kimiflare session into one literal category.

First user message: ${firstMsg}
Tool calls: ${toolSummary}
Files touched: ${files}
Commands run: ${commands}

Categories: ${ALL_CATEGORIES.join(", ")}

Respond with JSON only: {"category": "...", "confidence": 0.0-1.0, "summary": "one-line description"}`;

  try {
    const raw = await deps.runLlm(prompt, model);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[0] : raw;
    const parsed = JSON.parse(jsonStr) as { category?: string; confidence?: number; summary?: string };

    const category = parsed.category as TaskCategory;
    const confidence = typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.7;
    const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;

    if (ALL_CATEGORIES.includes(category)) {
      return { category, confidence, classifiedBy: "llm", summary };
    }
  } catch {
    // Fall through to heuristic default
  }

  return { category: "other", confidence: 0.5, classifiedBy: "heuristic", summary: "LLM fallback failed" };
}
