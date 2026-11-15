import type { IntentResult } from "../intent/classify.js";

/** An explicit off binds every turn; otherwise preserve intent-tier selection. */
export function resolveTurnCodeMode(configured: boolean | undefined, tier: IntentResult["tier"]): boolean {
  return configured !== false && tier === "heavy";
}
