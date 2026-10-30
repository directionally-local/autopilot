/**
 * Requesty model catalog, the Requesty sibling of openrouter-catalog.ts.
 *
 * Two public endpoints, both returning the same model shape:
 *  - `GET /models/managed`: Requesty's curated managed policies (short ids such
 *    as "claude-sonnet-4-5" or "kimi-k2.6" that route across several upstream
 *    providers). Listed first and used as the picker's default list.
 *  - `GET /models`: the full `vendor/model` catalog.
 *
 * Neither needs a key. The merged list is cached to disk
 * (`~/.config/autopilot/requesty-models.json`) and a stale cache is preferred
 * over an empty list when the network is down.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { registerRequestyModels, type ModelEntry } from "./registry.js";
import { fetchWithNetworkRetry } from "./openrouter.js";
import { requestyUrl } from "./requesty.js";
import { configPath } from "../util/app-dirs.js";

/** Bump when the cached shape changes, so an old cache is refetched. */
const CACHE_VERSION = 2;

/** Default: refetch after 6 hours; always fall back to a stale cache on fetch failure. */
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/** Shape of one entry in Requesty's `/models` and `/models/managed` responses (fields we use). */
export interface RequestyRawModel {
  id: string;
  api?: string;
  created?: number;
  context_window?: number;
  max_output_tokens?: number;
  /** USD per token. */
  input_price?: number;
  output_price?: number;
  cached_price?: number;
  supports_tool_calling?: boolean;
  supports_reasoning?: boolean;
  supports_vision?: boolean;
}

interface RequestyModelsResponse {
  data?: RequestyRawModel[];
}

export interface RequestyCatalog {
  models: ModelEntry[];
  /** Managed policy ids (without the "@eu" duplicates), for the picker's default list. */
  featured: string[];
}

function catalogCachePath(): string {
  return configPath("requesty-models.json");
}

/**
 * Catalog ids end up in the terminal (model picker, status line), so an id
 * with a control character (C0, DEL or C1, which covers ANSI/OSC escape
 * sequences) is never registered, whether it comes from the API or the cache.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeModelId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && !CONTROL_CHARS.test(id);
}

/** Requesty prices per token as a number; we store USD/Mtok. */
function perMtok(perToken: number | undefined): number {
  return typeof perToken === "number" && Number.isFinite(perToken) ? perToken * 1_000_000 : 0;
}

/** Pure mapping, no I/O. */
export function mapRequestyModel(raw: RequestyRawModel): ModelEntry {
  return {
    id: raw.id,
    ...(typeof raw.created === "number" ? { created: raw.created } : {}),
    contextWindow: raw.context_window ?? 128_000,
    maxOutputTokens: raw.max_output_tokens ?? 4_096,
    pricing: {
      inputPerMtok: perMtok(raw.input_price),
      ...(typeof raw.cached_price === "number" ? { cachedInputPerMtok: perMtok(raw.cached_price) } : {}),
      outputPerMtok: perMtok(raw.output_price),
    },
    supports: {
      tools: raw.supports_tool_calling === true,
      reasoning: raw.supports_reasoning === true,
      streaming: true,
      vision: raw.supports_vision === true,
    },
  };
}

async function fetchModels(fetchImpl: typeof fetch, path: string): Promise<RequestyRawModel[]> {
  const res = await fetchWithNetworkRetry(fetchImpl, requestyUrl(path), {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Requesty /${path} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as RequestyModelsResponse;
  return (body.data ?? []).filter((m) => isSafeModelId(m?.id) && (!m.api || m.api === "chat"));
}

/**
 * Fetch + map the managed policies and the full catalog, managed first. Either
 * list may fail on its own; throws only when both do.
 */
export async function fetchRequestyCatalog(fetchImpl: typeof fetch = fetch): Promise<RequestyCatalog> {
  const [managed, full] = await Promise.allSettled([
    fetchModels(fetchImpl, "models/managed"),
    fetchModels(fetchImpl, "models"),
  ]);
  if (managed.status === "rejected" && full.status === "rejected") throw managed.reason;
  const managedModels = managed.status === "fulfilled" ? managed.value : [];
  const fullModels = full.status === "fulfilled" ? full.value : [];
  const byId = new Map<string, ModelEntry>();
  for (const raw of [...managedModels, ...fullModels]) {
    if (!byId.has(raw.id)) byId.set(raw.id, mapRequestyModel(raw));
  }
  return {
    models: [...byId.values()],
    featured: managedModels.map((m) => m.id).filter((id) => !id.endsWith("@eu")),
  };
}

interface CacheFile extends RequestyCatalog {
  version?: number;
  fetchedAt: string;
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const raw = await readFile(catalogCachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION) return null;
    return {
      ...parsed,
      models: (parsed.models ?? []).filter((m) => isSafeModelId(m?.id)),
      featured: (parsed.featured ?? []).filter(isSafeModelId),
    };
  } catch {
    return null;
  }
}

async function writeCache(catalog: RequestyCatalog): Promise<void> {
  const path = catalogCachePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const cache: CacheFile = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), ...catalog };
    await writeFile(path, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Best-effort, like the OpenRouter catalog cache.
  }
}

/**
 * Load the Requesty catalog for this run: reuse a fresh cache, otherwise
 * refetch; on a failed fetch fall back to whatever cache exists.
 */
export async function loadRequestyCatalog(
  opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<RequestyCatalog> {
  const ttlMs = opts.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const cached = await readCache();
  const isFresh = cached && Date.now() - Date.parse(cached.fetchedAt) < ttlMs;
  if (isFresh) return { models: cached!.models, featured: cached!.featured ?? [] };

  try {
    const catalog = await fetchRequestyCatalog(opts.fetchImpl ?? fetch);
    await writeCache(catalog);
    return catalog;
  } catch {
    return { models: cached?.models ?? [], featured: cached?.featured ?? [] };
  }
}

/**
 * Load the catalog (cache-first) and register it with the model registry.
 * Called at startup instead of `ensureOpenRouterCatalog()` when Requesty is
 * the configured gateway. Never throws.
 */
export async function ensureRequestyCatalog(
  opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  try {
    const catalog = await loadRequestyCatalog(opts);
    if (catalog.models.length > 0) registerRequestyModels(catalog.models, catalog.featured);
    return catalog.models.length;
  } catch {
    return 0;
  }
}
