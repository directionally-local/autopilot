import { execSync } from "node:child_process";
import { pickLlmAuth, type LlmAuth } from "./llm-auth.js";
import { runKimi } from "./client.js";
import type { ChatMessage } from "./messages.js";
import type { Mode } from "../mode.js";
import type { MemoryManager } from "../memory/manager.js";
import { distillSessionPlan } from "./distill.js";

export interface ContinuationSummaryOpts extends LlmAuth {
  messages: ChatMessage[];
  mode: Mode;
  model: string;
  memoryManager?: MemoryManager | null;
  memoryEnabled?: boolean;
  signal?: AbortSignal;
  /** Called with a progress delta (0–1) as the LLM streams its summary. */
  onProgress?: (delta: number) => void;
}

const HANDOFF_SYSTEM = `You are a session-continuation engine. Given evidence from a coding session, produce a dense handoff document so a new agent can pick up exactly where this one left off.

Output format (use these exact headings):
Goal: what the user originally asked for.
Completed: files modified, tests added, key decisions, commits made.
Remaining: what still needs to be done.
Current state: any open errors, incomplete refactors, or pending work.
Context: relevant file paths or architectural notes.

Rules:
- Be terse but complete. A new agent with zero prior context must be able to continue.
- Do not include chat-style pleasantries.
- Do not speculate beyond the evidence provided.
- Aim for ~300-600 tokens.`;

function extractFirstUserGoal(messages: ChatMessage[]): string {
  const texts: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
    text = text.trim();
    if (text.length > 5) {
      texts.push(text);
      if (texts.length >= 3) break;
    }
  }
  return texts.join("\n---\n");
}

function extractRecentAssistantMessages(messages: ChatMessage[], count = 3): string {
  const texts: string[] = [];
  for (let i = messages.length - 1; i >= 0 && texts.length < count; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("\n");
    }
    text = text.trim();
    if (text.length > 10) {
      texts.unshift(text);
    }
  }
  return texts.join("\n---\n");
}

function gatherGitEvidence(): string {
  const pieces: string[] = [];
  try {
    const branch = execSync("git branch --show-current", { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (branch) pieces.push(`Branch: ${branch}`);
  } catch {
    // ignore
  }
  try {
    const log = execSync("git log --oneline -5", { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (log) pieces.push(`Recent commits:\n${log}`);
  } catch {
    // ignore
  }
  try {
    const status = execSync("git status --short", { cwd: process.cwd(), encoding: "utf8" }).trim();
    if (status) pieces.push(`Working tree changes:\n${status}`);
  } catch {
    // ignore
  }
  return pieces.join("\n\n");
}

async function gatherMemoryEvidence(
  manager: MemoryManager,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<string> {
  if (!enabled) return "";
  try {
    const cwd = process.cwd();
    const results = await manager.recall({ text: cwd, repoPath: cwd, limit: 10 });
    const highSignal = results.filter((r) =>
      ["edit_event", "task", "instruction"].includes(r.memory.category),
    );
    if (highSignal.length === 0) return "";
    const synthesized = await manager.synthesizeRecalled(highSignal, signal);
    return synthesized ? `Recorded work log:\n${synthesized}` : "";
  } catch {
    return "";
  }
}

async function runKimiText(opts: LlmAuth & {
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  onProgress?: (delta: number) => void;
}): Promise<string> {
  const events = runKimi({
    ...pickLlmAuth(opts),
    model: opts.model,
    messages: opts.messages,
    temperature: 0.1,
    reasoningEffort: "low",
    signal: opts.signal,
  });
  let text = "";
  for await (const ev of events) {
    if (ev.type === "text") {
      text += ev.delta;
      opts.onProgress?.(Math.max(0, ev.delta.length));
    }
  }
  return text.trim();
}

/**
 * Generate a mode-aware continuation summary for `/fresh`.
 *
 * - `plan` mode: returns the distilled plan text (fast, no LLM call).
 * - `auto` / `edit`: gathers evidence and makes
 *   one lightweight LLM call to produce a handoff document.
 */
export async function generateContinuationSummary(
  opts: ContinuationSummaryOpts,
): Promise<string | null> {
  const { messages, mode } = opts;

  if (mode === "plan") {
    return distillSessionPlan(messages);
  }

  // For auto / edit, build a handoff document
  const goal = extractFirstUserGoal(messages);
  const recentAssistant = extractRecentAssistantMessages(messages);
  const gitEvidence = gatherGitEvidence();
  const memoryEvidence = opts.memoryManager
    ? await gatherMemoryEvidence(opts.memoryManager, opts.memoryEnabled ?? false, opts.signal)
    : "";

  const evidenceParts: string[] = [];
  if (goal) evidenceParts.push(`## Original goal(s)\n${goal}`);
  if (recentAssistant) evidenceParts.push(`## Recent assistant messages\n${recentAssistant}`);
  if (gitEvidence) evidenceParts.push(`## Git state\n${gitEvidence}`);
  if (memoryEvidence) evidenceParts.push(`## ${memoryEvidence}`);

  if (evidenceParts.length === 0) {
    return null;
  }

  const userPrompt = evidenceParts.join("\n\n");

  const summary = await runKimiText({
    ...pickLlmAuth(opts),
    model: opts.model,
    signal: opts.signal,
    onProgress: opts.onProgress,
    messages: [
      { role: "system", content: HANDOFF_SYSTEM },
      { role: "user", content: userPrompt },
    ],
  });

  return summary || null;
}
