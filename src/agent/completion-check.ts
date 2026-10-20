import { activeOpenRouterKey } from "./llm-auth.js";
import { askJev, type AskJevOptions, type JevAnswer, type JevQuestion } from "./jev.js";
import { redactPrompt } from "../intent/subagent-policy.js";
import type { ChatMessage } from "./messages.js";

/**
 * "Did the agent actually finish?" — a yes/no check when a substantial turn
 * is about to end. Catches turns that stop after planning or announcing next
 * steps ("I'll now implement…") without doing the work, which otherwise
 * leaves the user typing "go on". Live checks: an announced-but-not-done turn
 * scored 0.03, a finished one 0.96.
 */

export interface CompletionCheckInput {
  /** The request that started the turn. */
  userRequest: string;
  /** The assistant's final message. */
  finalText: string;
  /** Tools executed during the turn, in order. */
  toolsUsed: string[];
}

/** Resolves to p(the request was fully handled), or null when unavailable. */
export type CompletionCheck = (input: CompletionCheckInput, signal: AbortSignal) => Promise<number | null>;

/** Below this, the loop asks the agent to continue (once per turn). */
export const INCOMPLETE_THRESHOLD = 0.2;
export const COMPLETION_CHECK_TIMEOUT_MS = 4_000;

export const CONTINUE_NUDGE =
  "You ended your turn before completing the user's request: you described a plan or next steps instead of doing them. " +
  "Continue now and carry out the remaining work with your tools, then report what you did. " +
  "If you are genuinely blocked or need a decision from the user, state exactly what you need instead.";

const WRITE_TOOLS = new Set(["write", "edit", "bash", "execute_code", "github_create_pr"]);

/** Only check turns that plausibly should have done work and didn't end by
 *  asking the user something (a question is a legitimate stop). */
export function shouldCheckCompletion(input: CompletionCheckInput, tier: "light" | "medium" | "heavy" | undefined): boolean {
  if (tier === "light") return false;
  const finalText = input.finalText.trim();
  if (!finalText || !input.userRequest.trim()) return false;
  if (/\?\s*$/.test(finalText)) return false;
  return true;
}

export function createJevCompletionCheck(
  apiKey: string,
  ask: (key: string, q: JevQuestion, o?: AskJevOptions) => Promise<JevAnswer> = askJev,
): CompletionCheck {
  return async (input, signal) => {
    const clip = (text: string, max: number) => redactPrompt(text.replace(/\s+/g, " ").trim()).slice(0, max);
    const used = input.toolsUsed.length
      ? `${input.toolsUsed.length} tool calls (${[...new Set(input.toolsUsed)].join(", ")}); ${input.toolsUsed.some((t) => WRITE_TOOLS.has(t)) ? "it ran commands or edited files" : "it only read or searched"}`
      : "no tool calls";
    const timeout = AbortSignal.timeout(COMPLETION_CHECK_TIMEOUT_MS);
    try {
      const answer = await ask(apiKey, {
        kind: "yes",
        prompt: [
          "Did the assistant end its turn legitimately — either by fully completing the user's request, or by clearly explaining a blocker or question that needs the user — as opposed to stopping early, only planning, or announcing next steps it has not done?",
          `User asked: ${clip(input.userRequest, 1_200)}`,
          `During the turn the assistant made ${used}.`,
          `Assistant's final message: ${clip(input.finalText, 1_500)}`,
        ].join("\n"),
      }, { signal: AbortSignal.any([timeout, signal]) });
      return answer.type === "noul" && typeof answer.noul === "number" ? answer.noul : null;
    } catch {
      return null;
    }
  };
}

/** Tool names executed since `turnUser` (the turn's request) in `messages`. */
export function toolsUsedSince(messages: ChatMessage[], turnUser: ChatMessage | undefined): string[] {
  const start = turnUser ? messages.indexOf(turnUser) : -1;
  return messages
    .slice(start + 1)
    .flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.function.name) : []));
}

/** The check for a session, or undefined when unavailable or turned off. */
export function completionCheckFromConfig(cfg: Parameters<typeof activeOpenRouterKey>[0] & { completionCheck?: boolean }): CompletionCheck | undefined {
  // Jev is OpenRouter's Decisions API: off whenever OpenRouter isn't the active provider.
  const apiKey = activeOpenRouterKey(cfg);
  if (cfg?.completionCheck === false || !apiKey) return undefined;
  return createJevCompletionCheck(apiKey);
}
