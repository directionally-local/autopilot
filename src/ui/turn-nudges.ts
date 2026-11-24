/**
 * Per-turn session nudges, extracted from App.processMessage: the occasional
 * /init tip, and — for auto/edit sessions — the context-fill handoff trigger.
 *
 * The trigger is the session's fill fraction of `effectiveInputBudget`
 * (src/agent/context-budget.ts): below 50% nothing, 50–80% a non-interrupting
 * ping, 80% and above the warning that ends the session at the natural break.
 * The old turn-count trigger (`freshAfterTurns`) is deprecated and no longer
 * decides anything here. A pure decision; App delivers the notice and runs the
 * handoff at the natural break.
 */

import type { Mode } from "../mode.js";
import { handoffTrigger, type HandoffShares, type HandoffTrigger } from "../agent/context-budget.js";
import { handoffPingNotice, handoffWarningNotice } from "../agent/handoff.js";

export { handoffPingNotice, handoffWarningNotice };

export const INIT_TIP_EVERY_TURNS = 15;
export const INIT_TIP = "Tip: Rerunning /init occasionally helps Autopilot stay accurate as your project evolves.";

export interface TurnNudgeInput {
  /** This turn's number in the session (1-based). */
  turn: number;
  /** The project has an AGENTS.md (or a legacy context file). */
  hasContextFile: boolean;
  /** The stale-context notice was already shown (it says the same thing, louder). */
  contextStale: boolean;
  mode: Mode;
  /** Estimated prompt tokens for the turn about to start. */
  estimatedTokens?: number;
  /** Effective input budget for the active model, in tokens. */
  budgetTokens?: number;
  /** The 50% ping was already delivered this session. */
  pingDelivered: boolean;
  /** The 80% warning was already delivered this session. */
  warningDelivered: boolean;
  /** Tunable threshold shares (defaults: 0.5 / 0.8). */
  shares?: HandoffShares;
}

export interface TurnNudges {
  initTip: boolean;
  /** The context-fill notice to deliver in-conversation: "ping" at 50%, "warning" at 80%. */
  fresh: "ping" | "warning" | null;
}

/** The fill fraction the nudge decision used (0 when no budget is known). */
export function turnFill(input: Pick<TurnNudgeInput, "estimatedTokens" | "budgetTokens">): number {
  const budget = input.budgetTokens ?? 0;
  if (budget <= 0 || input.estimatedTokens === undefined) return 0;
  return Math.max(0, input.estimatedTokens) / budget;
}

export function turnNudges(input: TurnNudgeInput): TurnNudges {
  const initTip = input.turn % INIT_TIP_EVERY_TURNS === 0 && input.hasContextFile && !input.contextStale;
  // The handoff is the auto/edit path; plan mode has its own plan handoff.
  if (input.mode !== "auto" && input.mode !== "edit") return { initTip, fresh: null };
  const trigger: HandoffTrigger = handoffTrigger(turnFill(input), input.shares);
  if (trigger === "none") return { initTip, fresh: null };
  // The warning supersedes a ping that was not delivered yet.
  if (trigger === "warning") return { initTip, fresh: input.warningDelivered ? null : "warning" };
  return { initTip, fresh: input.pingDelivered ? null : "ping" };
}
