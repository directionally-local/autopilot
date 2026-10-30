/**
 * OpenRouter model catalog: fetches the live model list from OpenRouter's public
 * `/models` endpoint and maps it into `ModelEntry` shape, instead of hand-maintaining
 * a hardcoded array. This is what lets a user pick from every model OpenRouter serves,
 * not a curated subset baked into this codebase.
 *
 * `GET https://openrouter.ai/api/v1/models` requires no authentication to list models
 * (auth is only needed for the chat-completions call itself). The response is cached
 * to disk (`~/.config/autopilot/openrouter-models.json`, same directory as config.json)
 * so a network blip or an offline session still has a model list to work with — the
 * stale cache is preferred over an empty list.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { registerOpenRouterModels, type ModelEntry } from "./registry.js";
import { fetchWithNetworkRetry, openRouterUrl } from "./openrouter.js";
import { configPath } from "../util/app-dirs.js";

/** Bump when the cached `ModelEntry` shape changes, so an old cache is refetched. */
const CACHE_VERSION = 4;

/** Default: refetch after 6 hours; always fall back to a stale cache on fetch failure. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Shape of one entry in OpenRouter's `/models` response — only the fields we use. */
export interface OpenRouterRawModel {
  id: string;
  name?: string;
  created?: number;
  benchmarks?: {
    artificial_analysis?: {
      coding_index?: number | null;
      agentic_index?: number | null;
      intelligence_index?: number | null;
    } | null;
  } | null;
  context_length?: number;
  top_provider?: { max_completion_tokens?: number | null } | null;
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  architecture?: { modality?: string; input_modalities?: string[] };
  supported_parameters?: string[];
}

interface OpenRouterModelsResponse {
  data: OpenRouterRawModel[];
}

function catalogCachePath(): string {
  return configPath("openrouter-models.json");
}

/** OpenRouter prices per-token as a decimal string (e.g. "0.0000008"); we store USD/Mtok. */
function perMtok(perToken: string | undefined): number {
  const n = Number(perToken);
  return Number.isFinite(n) ? n * 1_000_000 : 0;
}

/** Pure mapping, no I/O — kept separate so it's directly unit-testable. */
export function mapOpenRouterModel(raw: OpenRouterRawModel): ModelEntry {
  const supported = new Set(raw.supported_parameters ?? []);
  const aa = raw.benchmarks?.artificial_analysis;
  const quality = {
    ...(typeof aa?.coding_index === "number" ? { coding: aa.coding_index } : {}),
    ...(typeof aa?.agentic_index === "number" ? { agentic: aa.agentic_index } : {}),
    ...(typeof aa?.intelligence_index === "number" ? { intelligence: aa.intelligence_index } : {}),
  };
  return {
    id: raw.id,
    ...(raw.name ? { name: raw.name } : {}),
    ...(typeof raw.created === "number" ? { created: raw.created } : {}),
    ...(Object.keys(quality).length > 0 ? { quality } : {}),
    ...(raw.supported_parameters ? { parameters: [...raw.supported_parameters] } : {}),
    contextWindow: raw.context_length ?? 128_000,
    maxOutputTokens: raw.top_provider?.max_completion_tokens ?? 4_096,
    pricing: {
      inputPerMtok: perMtok(raw.pricing?.prompt),
      ...(raw.pricing?.input_cache_read ? { cachedInputPerMtok: perMtok(raw.pricing.input_cache_read) } : {}),
      outputPerMtok: perMtok(raw.pricing?.completion),
    },
    supports: {
      // OpenRouter's own catalog is the authority on whether a model accepts tool
      // calls; absence of "tools" here means the upstream provider doesn't support
      // function calling for this model, and we must not claim otherwise.
      tools: supported.has("tools"),
      reasoning: supported.has("reasoning") || supported.has("include_reasoning"),
      streaming: true,
      vision: (raw.architecture?.input_modalities ?? []).includes("image"),
      temperature: supported.has("temperature") ? true : undefined,
    },
  };
}

/** Fetch + map the full live catalog. Throws on network/HTTP failure — callers decide the fallback. */
export async function fetchOpenRouterCatalog(fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const res = await fetchWithNetworkRetry(fetchImpl, openRouterUrl("models"), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as OpenRouterModelsResponse;
  return (body.data ?? []).map(mapOpenRouterModel);
}

interface CacheFile {
  version?: number;
  fetchedAt: string;
  models: ModelEntry[];
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(catalogCachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    // Caches written by an older build carry a different ModelEntry shape.
    return parsed.version === CACHE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCache(models: ModelEntry[]): Promise<void> {
  const path = catalogCachePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const cache: CacheFile = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), models };
    await writeFile(path, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Best-effort — an unwritable config dir shouldn't block using the catalog this run.
  }
}

/**
 * Load the OpenRouter catalog for this run: refetch if the cache is missing or older
 * than `ttlMs`, otherwise reuse the cache without a network call. On a failed fetch,
 * fall back to whatever cache exists (even if stale) rather than return nothing.
 */
export async function loadOpenRouterCatalog(
  opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ModelEntry[]> {
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = await readCache();
  const isFresh = cached && Date.now() - Date.parse(cached.fetchedAt) < ttlMs;
  if (isFresh) return cached!.models;

  try {
    const models = await fetchOpenRouterCatalog(opts.fetchImpl ?? fetch);
    await writeCache(models);
    return models;
  } catch {
    // Network down, OpenRouter unreachable, etc. — a stale catalog beats an empty picker.
    return cached?.models ?? [];
  }
}

/**
 * Load the catalog (cache-first, see above) and register it with the model
 * registry, so `getModel()` / `listModels()` / the model picker see every
 * OpenRouter model. Called once at startup by every entry point (TUI, print
 * mode, RPC, serve). Never throws — with no network and no cache, the
 * registry keeps its seed list and the app still works.
 */
export async function ensureOpenRouterCatalog(
  opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  try {
    const models = await loadOpenRouterCatalog(opts);
    if (models.length > 0) registerOpenRouterModels(models);
    return models.length;
  } catch {
    return 0;
  }
}
