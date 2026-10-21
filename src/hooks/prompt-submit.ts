/**
 * The start of a user prompt, the same in every host (TUI, print, emit,
 * serve, SDK/RPC): SessionStart (once per session), then the veto-able
 * UserPromptSubmit hook. Observers such as Agent Beacon see the order
 * SessionStart → UserPromptSubmit → tool events → Stop, always with the
 * session id, so hosts must have the id before they call this.
 */

import type { HooksManager } from "./manager.js";
import type { IntentTier } from "./types.js";
import { noteSessionStart } from "./session-lifecycle.js";
import { classifyIntent } from "../intent/classify.js";
import { providerPresetOf, type LlmAuth } from "../agent/llm-auth.js";

export interface PromptSubmitInfo {
  hooks?: HooksManager;
  sessionId: string;
  cwd: string;
  /** The prompt as the user wrote it (after custom-command expansion). */
  prompt: string;
  /** Intent tier; classified from `prompt` when omitted. */
  tier?: IntentTier;
  /** The session already has history (SessionStart `source: "resume"`). */
  resumed: boolean;
  model: string;
  /** For SessionStart's `provider`. */
  auth?: LlmAuth;
}

/** Exit code of print / emit mode when a UserPromptSubmit hook blocks the
 *  prompt (next to 42, budget exhausted, and 43, agent loop). */
export const PROMPT_BLOCKED_EXIT_CODE = 44;

export type PromptSubmitResult = { blocked: false } | { blocked: true; reason: string };

/** Default text when a hook blocks a prompt without saying why. */
export const PROMPT_BLOCKED_DEFAULT_REASON = "UserPromptSubmit hook blocked the prompt";

/** Thrown by non-interactive hosts (SDK, RPC) when a UserPromptSubmit hook blocks the prompt. */
export class PromptBlockedError extends Error {
  readonly reason: string;
  readonly code = "prompt_blocked";
  constructor(reason: string) {
    super(`prompt blocked by a UserPromptSubmit hook: ${reason}`);
    this.name = "PromptBlockedError";
    this.reason = reason;
  }
}

/**
 * Fire SessionStart (if this session hasn't started in this process) and
 * UserPromptSubmit. A block (exit 2, a deny/block decision, or a failing
 * `failClosed` hook) comes back as `{ blocked: true, reason }`; the host
 * then drops the prompt without calling the model.
 */
export async function submitUserPrompt(info: PromptSubmitInfo): Promise<PromptSubmitResult> {
  let provider: string | undefined;
  try {
    provider = info.auth ? providerPresetOf(info.auth).id : undefined;
  } catch {
    provider = undefined;
  }
  await noteSessionStart({
    ...(info.hooks ? { hooks: info.hooks } : {}),
    sessionId: info.sessionId,
    cwd: info.cwd,
    resumed: info.resumed,
    model: info.model,
    ...(provider ? { provider } : {}),
  });
  if (!info.hooks?.hasEnabledHooks("UserPromptSubmit")) return { blocked: false };
  const outcome = await info.hooks.fire(
    "UserPromptSubmit",
    {
      event: "UserPromptSubmit",
      session_id: info.sessionId,
      cwd: info.cwd,
      prompt: info.prompt,
      tier: info.tier ?? classifyIntent(info.prompt).tier,
    },
    null,
  );
  if (!outcome.vetoed) return { blocked: false };
  return { blocked: true, reason: outcome.vetoReason || PROMPT_BLOCKED_DEFAULT_REASON };
}
