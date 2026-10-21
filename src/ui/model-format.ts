// Model catalog formatting and search for the model picker.

import type { ModelEntry, ModelPricing } from "../models/registry.js";
import { fuzzyFilter } from "../util/fuzzy.js";

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

/**
 * Fuzzy search over id + display name, best matches first (the shared
 * fuzzyFilter). Equally good matches come newest-first, and `:batch`
 * variants — a duplicate of almost every model, meant for offline batch
 * jobs — are left out (still selectable with `/model <id>`).
 */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const candidates = models
    .filter((m) => !m.id.endsWith(":batch"))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  return fuzzyFilter(candidates, query, (m) => `${m.id} ${m.name ?? ""}`);
}
