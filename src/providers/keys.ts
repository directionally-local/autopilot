/**
 * Provider key management shared by onboarding, `/provider`, `/key`,
 * `/logout` and `autopilot auth <provider>`: validating a key against the
 * provider, and writing keys and the provider choice into config.json
 * without disturbing other settings.
 */

import { readFile } from "node:fs/promises";
import { configPath, patchPersistedConfig, type KimiConfig } from "../config.js";
import { checkOpenRouterKey, looksLikeOpenRouterKey } from "../models/openrouter.js";
import { checkRequestyKey } from "../models/requesty.js";
import { getPreset, PROVIDER_IDS, type ProviderId } from "./presets.js";
import { resolveActiveProvider, resolveProviderKey, type ProviderSettings } from "./resolve.js";

export type ProviderKeyCheck =
  | { ok: true; detail?: string }
  | { ok: false; reason: "invalid" | "network" | "http" | "format"; message: string };

/** Cheap shape check before any network call. */
export function looksLikeProviderKey(id: ProviderId, key: string): boolean {
  if (id === "openrouter") return looksLikeOpenRouterKey(key);
  return key.length >= 8 && !/\s/.test(key);
}

/**
 * Validate a key (or, for keyless local runtimes, reachability) without
 * spending tokens: OpenRouter's GET /key, otherwise an authenticated
 * GET <baseUrl>/models.
 */
export async function checkProviderKey(
  id: ProviderId,
  key: string | undefined,
  baseUrl?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderKeyCheck> {
  const preset = getPreset(id);
  if (key && !looksLikeProviderKey(id, key)) {
    return { ok: false, reason: "format", message: id === "openrouter" ? "OpenRouter keys start with sk-or-." : "That doesn't look like an API key." };
  }
  if (id === "openrouter") {
    if (!key) return { ok: false, reason: "invalid", message: "An OpenRouter key is required." };
    const res = await checkOpenRouterKey(key, fetchImpl);
    if (!res.ok) return { ok: false, reason: res.reason, message: res.message };
    const credit = typeof res.info.limitRemaining === "number" ? ` · $${res.info.limitRemaining.toFixed(2)} credit left` : "";
    return { ok: true, detail: `${res.info.label ? `(${res.info.label})` : ""}${credit}`.trim() || undefined };
  }
  if (id === "requesty") {
    if (!key) return { ok: false, reason: "invalid", message: "A Requesty key is required." };
    const res = await checkRequestyKey(key, fetchImpl);
    return res.ok ? { ok: true } : { ok: false, reason: res.reason === "config" ? "http" : res.reason, message: res.message };
  }
  const base = (baseUrl ?? preset.baseUrl)?.replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "http", message: "No base URL configured." };
  if (!key && preset.keyRequired) return { ok: false, reason: "invalid", message: `A ${preset.name} API key is required.` };
  let res: Response;
  try {
    res = await fetchImpl(`${base}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: "network",
      message: preset.keyRequired ? `Couldn't reach ${preset.name}: ${msg}` : `Couldn't reach ${preset.name} at ${base} — is it running? (${msg})`,
    };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid", message: `${preset.name} rejected this key.` };
  if (!res.ok) return { ok: false, reason: "http", message: `${preset.name} returned HTTP ${res.status}.` };
  return { ok: true };
}

async function persistedProviders(): Promise<Partial<Record<ProviderId, ProviderSettings>>> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as Partial<KimiConfig>;
    return raw.providers ?? {};
  } catch {
    return {};
  }
}

/** The config patch that stores `key` where provider `id` reads it from. */
export async function keyPatch(id: ProviderId, key: string | undefined): Promise<Partial<KimiConfig>> {
  if (id === "openrouter") return { openrouterApiKey: key };
  if (id === "requesty") return { requestyApiKey: key };
  if (id === "custom") return { apiKey: key };
  const providers = await persistedProviders();
  const next: ProviderSettings = { ...providers[id] };
  if (key) next.apiKey = key;
  else delete next.apiKey;
  return { providers: { ...providers, [id]: next } };
}

/** Save a provider's key (and optional base URL) to config.json. */
export async function saveProviderKey(id: ProviderId, key: string | undefined, baseUrl?: string): Promise<string> {
  const patch = await keyPatch(id, key);
  if (baseUrl) {
    if (id === "custom") patch.baseUrl = baseUrl;
    else if (id !== "openrouter" && id !== "requesty") {
      const providers = patch.providers ?? (await persistedProviders());
      patch.providers = { ...providers, [id]: { ...providers[id], baseUrl } };
    }
  }
  return patchPersistedConfig(patch);
}

/**
 * Make `to` the active provider. The outgoing provider's model is kept under
 * providers.<from>.model so switching back restores it; the incoming one's
 * last model (or its preset default) becomes the top-level model.
 */
export async function switchProvider(cfg: KimiConfig | null, to: ProviderId, model?: string): Promise<string> {
  const providers = await persistedProviders();
  const from = cfg ? resolveActiveProvider(cfg).id : undefined;
  if (from && cfg?.model) providers[from] = { ...providers[from], model: cfg.model };
  const nextModel = model ?? providers[to]?.model ?? getPreset(to).defaultModel;
  if (nextModel) providers[to] = { ...providers[to], model: nextModel };
  return patchPersistedConfig({ provider: to, providers, model: nextModel });
}

export interface ProviderStatusRow {
  id: ProviderId;
  name: string;
  active: boolean;
  /** "env" (key in the environment), "config", "not needed" (local runtimes), or null (no key). */
  key: "env" | "config" | "not needed" | null;
}

/** One row per provider for `/provider` and `autopilot auth status`. */
export function providerStatus(cfg: KimiConfig | null, env: NodeJS.ProcessEnv = process.env): ProviderStatusRow[] {
  const active = resolveActiveProvider(cfg, env).id;
  return PROVIDER_IDS.map((id) => {
    const preset = getPreset(id);
    const fromEnv = preset.apiKeyEnv.some((n) => env[n]?.trim());
    const key = resolveProviderKey(id, cfg, env);
    return {
      id,
      name: preset.name,
      active: id === active,
      key: fromEnv ? "env" : key ? "config" : preset.keyRequired || id === "custom" ? null : "not needed",
    };
  });
}
