/**
 * Narrator — tier-aware wording for the status line.
 *
 * The tone adapts to intent tier: light (casual), medium (focused), heavy
 * (deliberate).
 */

export type IntentTier = "light" | "medium" | "heavy";
export type TurnPhase = "generating" | "executing" | "waiting";

// ── Status phases ────────────────────────────────────────────────────────────

export function humanizePhase(phase: TurnPhase, tier?: IntentTier): string {
  switch (phase) {
    case "generating":
      return pick(tier, {
        light: "thinking",
        medium: "thinking",
        heavy: "reasoning",
      });
    case "executing":
      return pick(tier, {
        light: "running",
        medium: "working",
        heavy: "executing",
      });
    case "waiting":
      return pick(tier, {
        light: "ready",
        medium: "ready",
        heavy: "waiting",
      });
  }
}

function pick<T>(tier: IntentTier | undefined, choices: Record<IntentTier, T>): T {
  return choices[tier ?? "medium"];
}
