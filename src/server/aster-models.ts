/**
 * The models an Aster conversation may use, for the configured provider.
 *
 * A fixed `models` list in aster.json is offered as is. With `"models": "catalog"` the
 * list is live: OpenRouter's catalog (tool-calling models only; the cell agent needs tools)
 * for OpenRouter, and `GET {baseUrl}/models` in the OpenAI-compatible shape for every
 * other provider, authenticated with the server's own key from `provider.apiKeyEnv` (or
 * unauthenticated for keyless local runtimes). That list is cached for a few minutes and
 * falls back to the preset's default model when the call fails, so a provider outage
 * never empties the picker.
 */

import { loadOpenRouterCatalog } from "../models/openrouter-catalog.js";
import { discoverOpenAiModels } from "../models/provider-catalog.js";
import type { AsterProviderConfig, AsterServerConfig } from "./aster-workspaces.js";

export interface AsterModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  inputPerMtok?: number;
  outputPerMtok?: number;
  created?: number;
  reasoning?: boolean;
  vision?: boolean;
}

/** What GET /api/v1/models returns. `models` and `catalog` predate `provider`/`defaultModel`. */
export interface AsterModelsResponse {
  models: string[];
  catalog: AsterModelInfo[];
  provider: { id: string; name: string };
  defaultModel: string;
}

export interface AsterModelCatalogDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  cacheTtlMs?: number;
}

export const PROVIDER_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  models: AsterModelInfo[];
}

const cache = new Map<string, CacheEntry>();

/** Drop cached provider catalogs (tests). */
export function resetProviderCatalogCache(): void {
  cache.clear();
}

export async function selectableModels(config: AsterServerConfig, deps: AsterModelCatalogDeps = {}): Promise<AsterModelInfo[]> {
  if (config.modelCatalog === "fixed") return config.models.map((id) => ({ id }));
  if (config.provider.id === "openrouter") return openRouterModels();
  return providerModels(config.provider, deps);
}

export async function isSelectableModel(config: AsterServerConfig, model: string, deps: AsterModelCatalogDeps = {}): Promise<boolean> {
  if (!model.trim() || model.length > 200) return false;
  if (config.modelCatalog === "fixed") return config.models.includes(model);
  return (await selectableModels(config, deps)).some((entry) => entry.id === model);
}

/** The /models response body; `models` empty means the catalog is unavailable right now. */
export async function modelsResponse(config: AsterServerConfig, deps: AsterModelCatalogDeps = {}): Promise<AsterModelsResponse> {
  const catalog = await selectableModels(config, deps);
  const models = catalog.map((model) => model.id);
  const preferred = config.provider.defaultModel;
  const defaultModel = preferred && models.includes(preferred) ? preferred : models[0] ?? preferred ?? "";
  return { models, catalog, provider: { id: config.provider.id, name: config.provider.name }, defaultModel };
}

async function openRouterModels(): Promise<AsterModelInfo[]> {
  const catalog = await loadOpenRouterCatalog();
  return catalog
    .filter((model) => model.supports.tools)
    .map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      contextWindow: model.contextWindow,
      inputPerMtok: model.pricing.inputPerMtok,
      outputPerMtok: model.pricing.outputPerMtok,
      ...(model.created !== undefined ? { created: model.created } : {}),
      reasoning: model.supports.reasoning,
      vision: model.supports.vision === true,
    }));
}

async function providerModels(provider: AsterProviderConfig, deps: AsterModelCatalogDeps): Promise<AsterModelInfo[]> {
  const now = deps.now ?? Date.now;
  const ttl = deps.cacheTtlMs ?? PROVIDER_CATALOG_CACHE_TTL_MS;
  const key = `${provider.id} ${provider.baseUrl ?? ""}`;
  const cached = cache.get(key);
  if (cached && now() - cached.fetchedAt < ttl) return cached.models;

  const fallback = provider.defaultModel ? [{ id: provider.defaultModel }] : [];
  if (!provider.baseUrl) return fallback;
  const apiKey = (deps.env ?? process.env)[provider.apiKeyEnv]?.trim() || undefined;
  try {
    const discovered = await discoverOpenAiModels(provider.baseUrl, apiKey, deps.fetch ?? fetch);
    const models: AsterModelInfo[] = discovered.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.created !== undefined ? { created: model.created } : {}),
    }));
    if (models.length === 0) return fallback;
    cache.set(key, { fetchedAt: now(), models });
    return models;
  } catch {
    // A stale list beats the one-model fallback; the next call past the TTL retries.
    return cached?.models ?? fallback;
  }
}
