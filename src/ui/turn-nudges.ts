/**
 * Per-turn session nudges, extracted from App.processMessage: the occasional
 * /init tip, and — for long auto/edit sessions — either a /fresh suggestion
 * or, when auto-fresh is on, starting fresh automatically. A pure decision;
 * App shows the notices and runs the fresh start.
 */

import type { Mode } from "../mode.js";

export const INIT_TIP_EVERY_TURNS = 15;
export const INIT_TIP = "Tip: Rerunning /init occasionally helps autopilot (formerly kimiflare) stay accurate as your project evolves.";

export interface TurnNudgeInput {
  /** This turn's number in the session (1-based). */
  turn: number;
  /** The project has an AGENTS.md (or a legacy context file). */
  hasContextFile: boolean;
  /** The stale-context notice was already shown (it says the same thing, louder). */
  contextStale: boolean;
  mode: Mode;
  /** 0 disables the long-session check. */
  freshAfterTurns: number;
  /** The long-session suggestion was already made this session. */
  freshSuggested: boolean;
  autoFreshEnabled: boolean;
}

export interface TurnNudges {
  initTip: boolean;
  /** "auto": start fresh now; "suggest": tell the user; null: nothing. */
  fresh: "auto" | "suggest" | null;
}

export function turnNudges(input: TurnNudgeInput): TurnNudges {
  const initTip = input.turn % INIT_TIP_EVERY_TURNS === 0 && input.hasContextFile && !input.contextStale;
  const longSession =
    input.freshAfterTurns > 0 &&
    input.turn >= input.freshAfterTurns &&
    (input.mode === "auto" || input.mode === "edit") &&
    !input.freshSuggested;
  return { initTip, fresh: longSession ? (input.autoFreshEnabled ? "auto" : "suggest") : null };
}

export function freshSuggestion(turns: number): string {
  return `Session has run for ${turns} turns. The model may slow down with accumulated context. Run /fresh to continue with a summarized state, or /compact to compress history.`;
}
