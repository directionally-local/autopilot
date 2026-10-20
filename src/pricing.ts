/**
 * Per-token pricing for the local cost estimate, looked up from the model
 * registry (the active provider's catalog: OpenRouter's live catalog,
 * models.dev, …). Unknown models return zero cost — usage is still tracked,
 * but the dollar figure is suppressed rather than silently wrong. On
 * OpenRouter the estimate is replaced by the billed cost it reports (see
 * usage-tracker.ts); other providers don't report per-request cost, so there
 * the estimate is the final figure.
 */

import { getModel, type ModelPricing } from "./models/registry.js";

/** Legacy K2.6 constants — kept as exports for back-compat with anything
 *  importing them directly. New code should look up via the registry. */
export const PRICE_IN_PER_M = 0.95;
export const PRICE_IN_CACHED_PER_M = 0.16;
export const PRICE_OUT_PER_M = 4.0;

export interface CostBreakdown {
  uncachedIn: number;
  cachedIn: number;
  /** Prompt tokens written to the cache (billed at the cache-write rate where one exists). */
  cacheWrite: number;
  out: number;
  total: number;
}

const ZERO_PRICING: ModelPricing = { inputPerMtok: 0, outputPerMtok: 0 };

export function calculateCost(
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  model?: string,
  /** Prompt tokens written to the prompt cache (Anthropic-style explicit caching). */
  cacheWriteTokens = 0,
): CostBreakdown {
  const pricing = model ? (getModel(model)?.pricing ?? ZERO_PRICING) : {
    inputPerMtok: PRICE_IN_PER_M,
    cachedInputPerMtok: PRICE_IN_CACHED_PER_M,
    outputPerMtok: PRICE_OUT_PER_M,
  };
  // Cache writes are part of the prompt; bill them at the write rate instead
  // of the plain input rate when the model has one.
  const cacheWrite = pricing.cacheWritePerMtok !== undefined ? Math.min(cacheWriteTokens, Math.max(0, promptTokens - cachedTokens)) : 0;
  const uncachedIn = Math.max(0, promptTokens - cachedTokens - cacheWrite);
  const cachedIn = cachedTokens;
  const out = completionTokens;
  const cachedRate = pricing.cachedInputPerMtok ?? pricing.inputPerMtok;
  const total =
    (uncachedIn * pricing.inputPerMtok) / 1_000_000 +
    (cachedIn * cachedRate) / 1_000_000 +
    (cacheWrite * (pricing.cacheWritePerMtok ?? pricing.inputPerMtok)) / 1_000_000 +
    (out * pricing.outputPerMtok) / 1_000_000;
  return { uncachedIn, cachedIn, cacheWrite, out, total };
}
