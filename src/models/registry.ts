/**
 * Model registry: single source of truth for per-model capabilities and
 * pricing.
 *
 * Every model is served through OpenRouter (https://openrouter.ai) with the
 * user's own OpenRouter key — there is exactly one provider, so there is no
 * routing decision to make here. What the user *does* choose is the model,
 * and the list of models is not maintained by hand: the live OpenRouter
 * catalog (see openrouter-catalog.ts) is registered at startup via
 * `registerOpenRouterModels()`. The small SEED list below is only an offline
 * fallback, so a first run with no network and no cached catalog still has
 * accurate context windows/pricing for the default and plumbing models.
 *
 * Model ids are OpenRouter's own `vendor/model[:variant]` ids, e.g.
 * "moonshotai/kimi-k2.6" or "deepseek/deepseek-r1:free". Ids from the
 * Cloudflare era ("@cf/moonshotai/kimi-k2.6", …) are rewritten on config load
 * by `migrateLegacyModelId()`.
 */

export interface ModelPricing {
  /** USD per million uncached input tokens. */
  inputPerMtok: number;
  /** USD per million cached input tokens. Omit if the model does not bill cached input differently. */
  cachedInputPerMtok?: number;
  /** USD per million output tokens. */
  outputPerMtok: number;
  /** USD per million tokens written to the prompt cache (Anthropic-style explicit caching). */
  cacheWritePerMtok?: number;
}

export interface ModelCapabilities {
  tools: boolean;
  reasoning: boolean;
  streaming: boolean;
  /** Does this model support image/vision inputs? */
  vision?: boolean;
  /**
   * Does this model accept the `temperature` field in the request body?
   * Some reasoning models (e.g. Kimi K3, gpt-5 family) reject any
   * non-default value. Default: true.
   */
  temperature?: boolean;
}

/** Artificial Analysis scores OpenRouter publishes per model (0–100, higher is better). */
export interface ModelQuality {
  coding?: number;
  agentic?: number;
  intelligence?: number;
}

export interface ModelEntry {
  /** OpenRouter model id, e.g. "moonshotai/kimi-k2.6". */
  id: string;
  /** Human-readable name from the catalog, e.g. "MoonshotAI: Kimi K2.6". */
  name?: string;
  /** Release date, epoch seconds (from the catalog). */
  created?: number;
  /** Benchmark scores, when OpenRouter has them. Drives the "best & latest" list. */
  quality?: ModelQuality;
  /**
   * Request parameters the model's OpenRouter endpoints accept (the catalog's
   * `supported_parameters`). The client only sends parameters listed here —
   * required because every request sets `provider.require_parameters`, which
   * makes OpenRouter reject a request if no endpoint supports every parameter
   * sent. Undefined when unknown (seed entries, ids not in the catalog).
   */
  parameters?: string[];
  /**
   * Reasoning effort levels the model accepts (models.dev `reasoning_options`),
   * e.g. ["low","high","max"]. The client maps the user's /reasoning level onto
   * this list. Undefined: low/medium/high are assumed. Empty: the model takes
   * no reasoning_effort (thinking is a toggle, or always on).
   */
  reasoningEfforts?: string[];
  /** The model takes an explicit thinking token budget (Anthropic `budget_tokens`) rather than only an effort level. */
  reasoningBudget?: boolean;
  /** Field the API expects reasoning echoed back in on assistant history (e.g. "reasoning_content"). */
  reasoningEchoField?: string;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  supports: ModelCapabilities;
}

// Offline fallback only: accurate context/pricing for the default and
// plumbing models before (or without) the live catalog. Not a recommendation —
// the picker's featured list is ranked from live benchmark data (see
// featuredModels). Verified against https://openrouter.ai/api/v1/models on
// 2026-09-25; the live catalog replaces these numbers once it loads.
const SEED: ModelEntry[] = [
  {
    id: "moonshotai/kimi-k3",
    name: "MoonshotAI: Kimi K3",
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    pricing: { inputPerMtok: 0.8845, cachedInputPerMtok: 0.33, outputPerMtok: 10.5346 },
    // K3 fixes temperature=1.0 — sending any other value is a 400, so we omit it.
    supports: { tools: true, reasoning: true, streaming: true, vision: true, temperature: false },
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    name: "MoonshotAI: Kimi K2.7 Code",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.6562, cachedInputPerMtok: 0.18, outputPerMtok: 3.3 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
  {
    id: "moonshotai/kimi-k2.6",
    name: "MoonshotAI: Kimi K2.6",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.95, cachedInputPerMtok: 0.16, outputPerMtok: 4.0 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "MoonshotAI: Kimi K2.5",
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0.45, cachedInputPerMtok: 0.07, outputPerMtok: 2.25 },
    supports: { tools: true, reasoning: true, streaming: true, vision: true },
  },
];

const seedIndex = new Map<string, ModelEntry>(SEED.map((m) => [m.id, m]));
let userOverrides: Map<string, ModelEntry> = new Map();
/** Live OpenRouter catalog, populated by `registerOpenRouterModels()` (see openrouter-catalog.ts).
 *  Empty until that's called; registry.ts itself does no network I/O. */
let openRouterIndex: Map<string, ModelEntry> = new Map();
/** Live Requesty catalog, populated by `registerRequestyModels()` (see requesty-catalog.ts).
 *  Only loaded when Requesty is the configured gateway. */
let requestyIndex: Map<string, ModelEntry> = new Map();
/** Requesty managed policy ids, in catalog order: the picker's default list on Requesty. */
let requestyFeatured: string[] = [];
/**
 * The active provider's own catalog (models.dev or local discovery), for
 * every provider but OpenRouter and Requesty. When set, it is the picker's
 * whole list and the first place capabilities/pricing are looked up.
 */
let providerIndex: Map<string, ModelEntry> = new Map();
let providerCatalogId: string | null = null;

/** Register (or clear, with an empty list) the active provider's catalog (see provider-catalog.ts). */
export function registerProviderModels(providerId: string, entries: ModelEntry[]): void {
  providerIndex = new Map(entries.map((m) => [m.id, m]));
  providerCatalogId = entries.length > 0 ? providerId : null;
}

/** The provider whose catalog is registered, or null when OpenRouter/Requesty (or nothing) is. */
export function activeProviderCatalog(): string | null {
  return providerCatalogId;
}

/** Register or replace entries from a user-supplied config (e.g. ~/.kimiflare/models.json). */
export function registerUserModels(entries: ModelEntry[]): void {
  userOverrides = new Map(entries.map((m) => [m.id, m]));
}

/** Register or replace the live OpenRouter catalog (see `loadOpenRouterCatalog()`). */
export function registerOpenRouterModels(entries: ModelEntry[]): void {
  openRouterIndex = new Map(
    entries.map((m) => {
      // The catalog can't express "accepts temperature, but only the default
      // value" — keep the seed's hand-verified temperature=false (Kimi K3).
      const seed = seedIndex.get(m.id);
      if (seed?.supports.temperature === false) {
        return [m.id, { ...m, supports: { ...m.supports, temperature: false } }];
      }
      return [m.id, m];
    }),
  );
}

/** Register or replace the live Requesty catalog (see `loadRequestyCatalog()`).
 *  `featured` lists the managed policy ids shown before any search. */
export function registerRequestyModels(entries: ModelEntry[], featured: string[] = []): void {
  requestyIndex = new Map(entries.map((m) => [m.id, m]));
  requestyFeatured = featured.filter((id) => requestyIndex.has(id));
}

/** True once a live (or cached) OpenRouter catalog has been registered. */
export function hasOpenRouterCatalog(): boolean {
  return openRouterIndex.size > 0;
}

/** Look up a model by id. Returns undefined for unknown models. */
export function getModel(id: string): ModelEntry | undefined {
  return userOverrides.get(id) ?? providerIndex.get(id) ?? openRouterIndex.get(id) ?? requestyIndex.get(id) ?? seedIndex.get(id);
}

/** Look up a model, falling back to a generic entry for ids not in the catalog. */
export function getModelOrInfer(id: string): ModelEntry {
  const hit = getModel(id);
  if (hit) return hit;
  // Conservative defaults for unknown models — context kept small so the
  // harness errs on the side of compaction rather than wasted prompt tokens.
  // Output is not capped at a few thousand tokens: one unknown model must not
  // truncate every long answer (the request asks for 16k by default anyway).
  return {
    id,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: false, streaming: true },
  };
}

export function listModels(): ModelEntry[] {
  // Another provider's catalog is its whole list: OpenRouter's ids can't be served there.
  if (providerCatalogId) {
    const own = new Map(providerIndex);
    for (const [k, v] of userOverrides) own.set(k, v);
    return [...own.values()];
  }
  // The seed ids are OpenRouter ids; a Requesty-only catalog can't serve them.
  const requestyOnly = requestyIndex.size > 0 && openRouterIndex.size === 0;
  const out = new Map(requestyOnly ? [] : seedIndex);
  for (const [k, v] of openRouterIndex) out.set(k, v);
  for (const [k, v] of requestyIndex) out.set(k, v);
  for (const [k, v] of userOverrides) out.set(k, v);
  return [...out.values()];
}

/** Vendor segment of an OpenRouter id: "moonshotai/kimi-k2.6" → "moonshotai". */
export function vendorOf(id: string): string {
  const slash = id.indexOf("/");
  return slash < 0 ? id : id.slice(0, slash).replace(/^~/, "");
}

/**
 * Free on OpenRouter: the catalog lists a zero input and output price
 * (typically the `:free` variants). Ids missing from the catalog also carry
 * zero pricing (see `getModelOrInfer`), but that means "unknown", not free.
 */
export function isFreeModel(entry: ModelEntry): boolean {
  // "Free" is OpenRouter's notion; other catalogs' $0 means subscription
  // (coding plans) or local (Ollama), not a free tier.
  if (providerCatalogId) return false;
  const zero = entry.pricing.inputPerMtok === 0 && entry.pricing.outputPerMtok === 0;
  return zero && (entry.id.endsWith(":free") || getModel(entry.id) !== undefined);
}

/**
 * Rewrite a model id from the Cloudflare era to its OpenRouter equivalent.
 * Configs written before the OpenRouter switch persist Workers AI ids
 * (`@cf/moonshotai/kimi-k2.6`) and AI Gateway ids (`google-ai-studio/…`).
 * Anything already OpenRouter-shaped passes through unchanged.
 */
export function migrateLegacyModelId(id: string): string;
export function migrateLegacyModelId(id: string | undefined): string | undefined;
export function migrateLegacyModelId(id: string | undefined): string | undefined {
  if (!id) return id;
  const known = LEGACY_MODEL_IDS[id];
  if (known) return known;
  if (id.startsWith("@cf/")) {
    // "@cf/<vendor>/<model>" → "<vendor>/<model>"; Workers AI's zai-org is z-ai on OpenRouter.
    const rest = id.slice("@cf/".length);
    return rest.replace(/^zai-org\//, "z-ai/");
  }
  if (id.startsWith("workers-ai/")) return migrateLegacyModelId(id.slice("workers-ai/".length));
  if (id.startsWith("google-ai-studio/")) return `google/${id.slice("google-ai-studio/".length)}`;
  return id;
}

const LEGACY_MODEL_IDS: Record<string, string> = {
  "@cf/moonshotai/kimi-k2.7-code": "moonshotai/kimi-k2.7-code",
  "@cf/moonshotai/kimi-k2.6": "moonshotai/kimi-k2.6",
  "@cf/moonshotai/kimi-k2.5": "moonshotai/kimi-k2.5",
  "@cf/zai-org/glm-5.2": "z-ai/glm-5.2",
  "@cf/baai/bge-base-en-v1.5": "baai/bge-base-en-v1.5",
};

/** Variant / alias ids that duplicate a base model in listings. */
function isListingDuplicate(id: string): boolean {
  return id.startsWith("~") || /:(batch|free|nitro|floor|thinking|extended)$/.test(id);
}

/**
 * The "best & latest" models to show when nothing is searched: recent
 * (released within `maxAgeDays`), tool-capable models ranked by OpenRouter's
 * published Artificial Analysis agentic + coding scores — the two that matter
 * for a coding agent — with at most `perVendor` per vendor so no single lab
 * crowds the list. Entirely data-driven: it changes as OpenRouter's catalog
 * does, with no model names in code. Falls back to the seed list when the
 * catalog carries no benchmark data (offline, first run without network).
 */
export function featuredModels(
  models: ModelEntry[] = listModels(),
  opts: { limit?: number; perVendor?: number; maxAgeDays?: number; now?: number } = {},
): ModelEntry[] {
  const limit = opts.limit ?? 12;
  const perVendor = opts.perVendor ?? 2;
  const maxAgeSec = (opts.maxAgeDays ?? 365) * 86_400;
  const nowSec = (opts.now ?? Date.now()) / 1000;
  const score = (m: ModelEntry) => (m.quality?.agentic ?? 0) + (m.quality?.coding ?? 0);

  const ranked = models
    .filter(
      (m) =>
        m.supports.tools &&
        !isListingDuplicate(m.id) &&
        score(m) > 0 &&
        (m.created === undefined || nowSec - m.created <= maxAgeSec),
    )
    .sort((a, b) => score(b) - score(a) || (b.created ?? 0) - (a.created ?? 0));

  const out: ModelEntry[] = [];
  const perVendorCount = new Map<string, number>();
  for (const m of ranked) {
    const v = vendorOf(m.id);
    const n = perVendorCount.get(v) ?? 0;
    if (n >= perVendor) continue;
    perVendorCount.set(v, n + 1);
    out.push(m);
    if (out.length >= limit) break;
  }
  if (out.length > 0) return out;
  // Provider catalogs carry no benchmark scores: newest tool-capable models first.
  if (providerCatalogId) {
    return models
      .filter((m) => m.supports.tools)
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
      .slice(0, limit);
  }
  // Requesty publishes no benchmark scores: show its managed policies instead.
  if (requestyFeatured.length > 0) {
    const tools = models.filter((m) => m.supports.tools && requestyFeatured.includes(m.id));
    if (tools.length > 0) return tools.slice(0, limit);
  }
  return SEED.filter((s) => models.some((m) => m.id === s.id));
}
