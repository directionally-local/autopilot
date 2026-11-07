import type { IntentResult } from "./classify.js";

/**
 * Intent-based model routing (config `modelRouting`, off by default): send
 * lighter turns to a faster/cheaper model while heavy turns keep `model`.
 *
 * Why it exists: local telemetry (docs/harness-trace-analysis-2026-11.md)
 * shows time-to-first-token is the dominant turn latency, and fast cheap
 * models answer qa/verify turns just as well. Routing light turns at a
 * low-TTFT model is the single highest-ROI model-side speedup on that data.
 *
 * The trade-off: cached prompt prefixes are per model, so a turn routed to a
 * different model re-prices the prompt at full rate. With the 150k-token
 * auto-compact cap a light qa turn is small, so the TTFT win usually pays
 * for the re-price — but verify it: watch `cacheHitRatio` per turn in
 * cost-debug.jsonl (each entry now carries `model` and `modelRouting`) and
 * back off if hits drop below ~95%.
 */
export interface ModelRoutingConfig {
  /** Model for light turns (quick questions, verifications, small lookups). */
  light?: string;
  /** Model for medium turns. Heavy turns always keep the session model. */
  medium?: string;
}

/**
 * The model a turn of this tier should run on, or undefined to keep
 * `currentModel` (routing off, no mapping for the tier, or a no-op).
 * Heavy turns are never rerouted: they are where model quality pays off.
 */
export function routedModelForTier(
  routing: ModelRoutingConfig | undefined,
  tier: IntentResult["tier"],
  currentModel: string,
): string | undefined {
  if (!routing) return undefined;
  const target = tier === "light" ? routing.light : tier === "medium" ? routing.medium : undefined;
  if (!target || target === currentModel) return undefined;
  return target;
}
