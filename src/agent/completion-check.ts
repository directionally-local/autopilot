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

/** Deterministic nudge: a PR opened this turn is not done until its CI has
 *  been verified. Fires when the agent created a PR but never checked CI, when
 *  the last check run was still pending (CI takes minutes) and the agent
 *  stopped anyway, or when it pushed a fix after the last check. Returns the
 *  nudge text, or null when there is nothing left to verify. */
export function prCiNudge(messages: ChatMessage[], turnUser: ChatMessage | undefined): string | null {
  const start = turnUser ? messages.indexOf(turnUser) : -1;
  const turn = messages.slice(start + 1);
  const created: string[] = [];
  let lastChecks: string | null = null;
  let pushedSinceCheck = false;

  for (const m of turn) {
    if (m.role === "assistant") {
      for (const call of m.tool_calls ?? []) {
        if (call.function.name === "bash" && /\bgit\s+push\b/.test(call.function.arguments ?? "")) {
          if (lastChecks !== null) pushedSinceCheck = true;
        }
      }
      continue;
    }
    if (m.role !== "tool") continue;
    const text = typeof m.content === "string" ? m.content : "";
    if (m.name === "github_create_pr") {
      const match = text.match(/Created PR #(\d+)/);
      if (match) created.push(`#${match[1]}`);
    } else if (m.name === "github_pr_checks") {
      lastChecks = text;
      pushedSinceCheck = false;
    }
  }

  if (created.length === 0) return null;
  const prs = created.join(", ");
  const waitHint =
    "Call github_pr_checks with wait_seconds: 300 to wait for the checks, fix any failure, push, and re-check. " +
    "Mark the PR ready with github_update_pr (draft: false) only once every check is green.";

  if (lastChecks === null) {
    return `You opened ${prs} but never checked its CI. ${waitHint}`;
  }
  if (pushedSinceCheck) {
    return `You pushed a fix to ${prs} after the last CI check, so its current state is unknown. ${waitHint}`;
  }
  const pending = /CI: [^\n]*?\b([1-9]\d*) pending/.exec(lastChecks);
  if (pending) {
    return `CI for ${prs} was still running when you stopped (${pending[1]} pending). ${waitHint}`;
  }
  if (/CI: no checks reported/.test(lastChecks)) {
    return `No CI checks had reported for ${prs} when you stopped. Call github_pr_checks again with wait_seconds: 300 to wait for them; if the repository has no CI, mark the PR ready with github_update_pr (draft: false).`;
  }
  return null;
}

/** The check for a session, or undefined when unavailable or turned off. */
export function completionCheckFromConfig(cfg: Parameters<typeof activeOpenRouterKey>[0] & { completionCheck?: boolean }): CompletionCheck | undefined {
  // Jev is OpenRouter's Decisions API: off whenever OpenRouter isn't the active provider.
  const apiKey = activeOpenRouterKey(cfg);
  if (cfg?.completionCheck === false || !apiKey) return undefined;
  return createJevCompletionCheck(apiKey);
}
