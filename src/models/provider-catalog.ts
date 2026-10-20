/**
 * Model catalogs for providers other than OpenRouter and Requesty:
 *
 * - **models.dev** (https://models.dev/api.json) for hosted providers — the
 *   same open catalog opencode uses: per-provider model ids with tool-call,
 *   reasoning, limits, modalities and pricing. Cached on disk (6h TTL,
 *   trimmed to the providers Autopilot has presets for), with a bundled
 *   snapshot as the offline floor.
 * - **Live discovery** for local runtimes: Ollama's `/api/tags` +
 *   `/api/show`, and any OpenAI-compatible `/models` (LM Studio, custom
 *   gateways).
 *
 * The result is registered with the model registry as the active provider's
 * catalog, so the picker, capabilities, context window and pricing describe
 * the provider actually in use.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { registerProviderModels, type ModelEntry } from "./registry.js";
import { MODELS_DEV_SNAPSHOT } from "./models-dev-snapshot.js";
import { PROVIDER_PRESETS, type ProviderId } from "../providers/presets.js";
import { getUserAgent } from "../util/version.js";

export const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_VERSION = 1;
const TTL_MS = 6 * 60 * 60 * 1000;

/** One model in models.dev's api.json — only the fields we read. */
export interface ModelsDevModel {
  id: string;
  name?: string;
  release_date?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type: string; values?: string[]; min?: number; max?: number }>;
  tool_call?: boolean;
  temperature?: boolean;
  interleaved?: { field?: string } | boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  canonical_model_id?: string;
  status?: string;
}

export interface ModelsDevProvider {
  id: string;
  name?: string;
  models: Record<string, ModelsDevModel>;
}

/** Pure mapping into the registry's shape. */
export function mapModelsDevModel(m: ModelsDevModel): ModelEntry {
  // Options listed without an "effort" entry (e.g. only an on/off toggle)
  // mean the model takes no reasoning_effort: record that as an empty list.
  const efforts = m.reasoning_options ? (m.reasoning_options.find((o) => o.type === "effort")?.values ?? []) : undefined;
  const echo = typeof m.interleaved === "object" ? m.interleaved.field : undefined;
  const created = m.release_date ? Date.parse(m.release_date) / 1000 : NaN;
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    ...(Number.isFinite(created) ? { created } : {}),
    ...(efforts ? { reasoningEfforts: efforts } : {}),
    ...(m.reasoning_options?.some((o) => o.type === "budget_tokens") ? { reasoningBudget: true } : {}),
    ...(echo ? { reasoningEchoField: echo } : {}),
    contextWindow: m.limit?.context ?? 128_000,
    maxOutputTokens: m.limit?.output ?? 16_384,
    pricing: {
      inputPerMtok: m.cost?.input ?? 0,
      ...(m.cost?.cache_read !== undefined ? { cachedInputPerMtok: m.cost.cache_read } : {}),
      outputPerMtok: m.cost?.output ?? 0,
      ...(m.cost?.cache_write !== undefined ? { cacheWritePerMtok: m.cost.cache_write } : {}),
    },
    supports: {
      tools: m.tool_call === true,
      reasoning: m.reasoning === true,
      streaming: true,
      vision: m.attachment === true && (m.modalities?.input ?? []).includes("image"),
      ...(m.temperature === false ? { temperature: false } : {}),
    },
  };
}

export function mapModelsDevProvider(p: ModelsDevProvider): ModelEntry[] {
  return Object.values(p.models)
    .filter((m) => m.tool_call === true && m.status !== "deprecated")
    .map(mapModelsDevModel);
}

function cachePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "kimiflare", "models-dev.json");
}

interface CacheFile {
  version: number;
  fetchedAt: string;
  providers: Record<string, ModelsDevProvider>;
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    return parsed.version === CACHE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

/** The models.dev providers Autopilot has presets for. */
function wantedProviders(): string[] {
  return [...new Set(Object.values(PROVIDER_PRESETS).flatMap((p) => (p.modelsDevId ? [p.modelsDevId] : [])))];
}

/** Fetch models.dev and keep only the providers we have presets for. Throws on failure. */
export async function fetchModelsDev(fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<Record<string, ModelsDevProvider>> {
  const res = await fetchImpl(MODELS_DEV_URL, { headers: { Accept: "application/json", "User-Agent": getUserAgent() }, signal });
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  const all = (await res.json()) as Record<string, ModelsDevProvider>;
  const out: Record<string, ModelsDevProvider> = {};
  for (const id of wantedProviders()) if (all[id]) out[id] = all[id]!;
  return out;
}

/**
 * The models.dev entry for one provider: fresh cache, else a refetch, else
 * a stale cache, else the bundled snapshot.
 */
export async function loadModelsDevProvider(
  modelsDevId: string,
  opts: { fetchImpl?: typeof fetch; ttlMs?: number } = {},
): Promise<ModelsDevProvider | undefined> {
  const cached = await readCache();
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < (opts.ttlMs ?? TTL_MS);
  if (fresh && cached.providers[modelsDevId]) return cached.providers[modelsDevId];
  try {
    const providers = await fetchModelsDev(opts.fetchImpl ?? fetch, AbortSignal.timeout(15_000));
    try {
      await mkdir(dirname(cachePath()), { recursive: true });
      const file: CacheFile = { version: CACHE_VERSION, fetchedAt: new Date().toISOString(), providers };
      await writeFile(cachePath(), JSON.stringify(file), "utf8");
    } catch {
      // Best-effort cache.
    }
    if (providers[modelsDevId]) return providers[modelsDevId];
  } catch {
    // Offline or models.dev down: fall through to what we have.
  }
  return cached?.providers[modelsDevId] ?? MODELS_DEV_SNAPSHOT[modelsDevId];
}

// ── Local runtimes ─────────────────────────────────────────────────────

interface OllamaTag {
  name: string;
  modified_at?: string;
}

/** Ollama's native API lives at the server root, not under the OpenAI-compatible /v1. */
function ollamaRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Installed Ollama models that can chat. `/api/show` reports capabilities
 * ("completion", "tools", "vision", "thinking") and the context length.
 */
export async function discoverOllamaModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const root = ollamaRoot(baseUrl);
  const tags = (await (await fetchImpl(`${root}/api/tags`, { signal: AbortSignal.timeout(3_000) })).json()) as { models?: OllamaTag[] };
  const out: ModelEntry[] = [];
  for (const tag of tags.models ?? []) {
    let caps: string[] = [];
    let context = 0;
    try {
      const show = (await (
        await fetchImpl(`${root}/api/show`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: tag.name }),
          signal: AbortSignal.timeout(3_000),
        })
      ).json()) as { capabilities?: string[]; model_info?: Record<string, unknown> };
      caps = show.capabilities ?? [];
      for (const [k, v] of Object.entries(show.model_info ?? {})) {
        if (k.endsWith(".context_length") && typeof v === "number") context = v;
      }
    } catch {
      // Older Ollama without /api/show details: list the model with defaults.
    }
    if (caps.length > 0 && !caps.includes("completion")) continue; // embedding-only models
    const created = tag.modified_at ? Date.parse(tag.modified_at) / 1000 : NaN;
    out.push({
      id: tag.name,
      ...(Number.isFinite(created) ? { created } : {}),
      contextWindow: context || 32_768,
      maxOutputTokens: 16_384,
      pricing: { inputPerMtok: 0, outputPerMtok: 0 },
      supports: {
        // Without capability info we can't tell; let the user try.
        tools: caps.length === 0 || caps.includes("tools"),
        reasoning: caps.includes("thinking"),
        streaming: true,
        vision: caps.includes("vision"),
      },
    });
  }
  return out;
}

/** Models from an OpenAI-compatible `GET /models` (LM Studio, custom gateways). Ids only; capabilities unknown. */
export async function discoverOpenAiModels(baseUrl: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`GET /models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string; created?: number }> };
  return (body.data ?? [])
    .filter((m) => typeof m.id === "string" && !/embed/i.test(m.id))
    .map((m) => ({
      id: m.id,
      ...(typeof m.created === "number" ? { created: m.created } : {}),
      contextWindow: 32_768,
      maxOutputTokens: 16_384,
      pricing: { inputPerMtok: 0, outputPerMtok: 0 },
      supports: { tools: true, reasoning: false, streaming: true },
    }));
}

/**
 * Load and register the catalog for a non-OpenRouter, non-Requesty
 * provider. Never throws: with nothing available the registry keeps its
 * defaults and unknown models are inferred.
 */
export async function ensureProviderCatalog(
  id: ProviderId,
  endpoint: { baseUrl?: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const preset = PROVIDER_PRESETS[id];
  let models: ModelEntry[] = [];
  try {
    if (preset.catalog === "models.dev" && preset.modelsDevId) {
      const p = await loadModelsDevProvider(preset.modelsDevId, { fetchImpl });
      models = p ? mapModelsDevProvider(p) : [];
    } else if (preset.catalog === "copilot" && endpoint.baseUrl && endpoint.apiKey) {
      const { loadCopilotModels } = await import("../providers/copilot.js");
      models = await loadCopilotModels(endpoint.baseUrl, endpoint.apiKey, fetchImpl);
    } else if (preset.catalog === "ollama" && endpoint.baseUrl) {
      models = await discoverOllamaModels(endpoint.baseUrl, fetchImpl);
    } else if ((preset.catalog === "openai-models" || preset.catalog === "none") && endpoint.baseUrl) {
      models = await discoverOpenAiModels(endpoint.baseUrl, endpoint.apiKey, fetchImpl);
    }
  } catch {
    models = [];
  }
  registerProviderModels(id, models);
  return models.length;
}
