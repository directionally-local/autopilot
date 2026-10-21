// Model catalog formatting for the model picker.

import type { ModelPricing } from "../models/registry.js";

export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function dollar(n: number): string {
  // Catalog prices are per-token decimals scaled to per-Mtok; trim float noise.
  return `$${Number(n.toPrecision(4))}`;
}

/** "$0.95 / $4 / $0.16" (input / output / cached input, USD per Mtok), or "free". */
export function formatModelPrice(p: ModelPricing): string {
  if (p.inputPerMtok === 0 && p.outputPerMtok === 0) return "free";
  const head = `${dollar(p.inputPerMtok)} / ${dollar(p.outputPerMtok)}`;
  return p.cachedInputPerMtok !== undefined ? `${head} / ${dollar(p.cachedInputPerMtok)}` : head;
}
