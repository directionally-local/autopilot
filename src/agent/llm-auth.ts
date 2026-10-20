/**
 * The one place that turns config into model-call credentials.
 *
 * Every `runKimi` / `fetchEmbeddings` call site spreads `llmAuthFromConfig(cfg)`
 * into its options instead of picking individual credential fields, so the
 * main loop, side-calls (summaries, memory, decomposition, …), embeddings,
 * print/emit/serve/SDK entry points all authenticate the same way — and all
 * of them follow the active provider (src/providers/resolve.ts). Only the
 * active provider's credentials are returned: with provider "openai", the
 * OpenRouter key is never handed to a call site even when it is configured.
 */

import type { OpenRouterProviderPrefs } from "./client.js";
import type { CustomEndpoint } from "./custom-endpoint.js";
import { getPreset, type ProviderId, type ProviderPreset } from "../providers/presets.js";
import { resolveActiveProvider, type ProviderConfigFields } from "../providers/resolve.js";

export interface LlmAuth {
  /** The active provider. Absent only on hand-built auth objects (tests); treated as inferred from the keys. */
  providerId?: ProviderId;
  /** The user's OpenRouter key; set only when OpenRouter is the active provider. */
  openrouterApiKey?: string;
  /** The user's Requesty key; set only when Requesty is the active provider. */
  requestyApiKey?: string;
  /** OpenAI-compatible endpoint for every other provider (presets and host-app gateways). */
  customEndpoint?: CustomEndpoint;
  /** Extra OpenRouter routing preferences (config: openrouterProvider). OpenRouter only. */
  openrouterRouting?: OpenRouterProviderPrefs;
}

type AuthConfigFields = ProviderConfigFields & { openrouterProvider?: OpenRouterProviderPrefs };

export function llmAuthFromConfig(cfg: Partial<AuthConfigFields> | null | undefined): LlmAuth {
  const active = resolveActiveProvider(cfg ?? null);
  switch (active.id) {
    case "openrouter":
      return {
        providerId: "openrouter",
        ...(active.apiKey ? { openrouterApiKey: active.apiKey } : {}),
        ...(cfg?.openrouterProvider ? { openrouterRouting: cfg.openrouterProvider } : {}),
      };
    case "requesty":
      return { providerId: "requesty", ...(active.apiKey ? { requestyApiKey: active.apiKey } : {}) };
    default:
      if (!active.baseUrl) return { providerId: active.id };
      return {
        providerId: active.id,
        customEndpoint: {
          baseUrl: active.baseUrl,
          ...(active.apiKey ? { apiKey: active.apiKey } : {}),
          ...(active.id !== "custom" ? { providerId: active.id } : {}),
        },
      };
  }
}

/** The provider an auth object routes to (custom endpoint, then OpenRouter, then Requesty when untagged). */
export function providerIdOf(auth: LlmAuth): ProviderId {
  if (auth.providerId) return auth.providerId;
  if (auth.customEndpoint) return auth.customEndpoint.providerId ?? "custom";
  if (auth.openrouterApiKey) return "openrouter";
  if (auth.requestyApiKey) return "requesty";
  return "openrouter";
}

export function providerPresetOf(auth: LlmAuth): ProviderPreset {
  return getPreset(providerIdOf(auth));
}

/** True when model calls can be made at all (a key, or an endpoint that needs none). */
export function hasLlmAuth(auth: LlmAuth): boolean {
  if (auth.customEndpoint) return !!auth.customEndpoint.apiKey || !providerPresetOf(auth).keyRequired;
  return !!auth.openrouterApiKey || !!auth.requestyApiKey;
}

/** True when model calls go to Requesty. */
export function usesRequesty(auth: LlmAuth): boolean {
  return providerIdOf(auth) === "requesty" && !!auth.requestyApiKey;
}

/** True when OpenRouter is the active provider (and OpenRouter-only features may run). */
export function usesOpenRouter(auth: LlmAuth): boolean {
  return providerIdOf(auth) === "openrouter" && !!auth.openrouterApiKey;
}

/** Just the auth fields of a larger options object, for forwarding to runKimi / fetchEmbeddings. */
export function pickLlmAuth(o: LlmAuth): LlmAuth {
  return {
    ...(o.providerId ? { providerId: o.providerId } : {}),
    ...(o.openrouterApiKey ? { openrouterApiKey: o.openrouterApiKey } : {}),
    ...(o.requestyApiKey ? { requestyApiKey: o.requestyApiKey } : {}),
    ...(o.customEndpoint ? { customEndpoint: o.customEndpoint } : {}),
    ...(o.openrouterRouting ? { openrouterRouting: o.openrouterRouting } : {}),
  };
}

/**
 * The OpenRouter key, but only while OpenRouter is the active provider. Use
 * this — never `cfg.openrouterApiKey` — for OpenRouter-only features (Jev,
 * cost confirmation, `cost --verify`, Hotcell subagents), so they switch off
 * with the provider instead of quietly calling OpenRouter.
 */
export function activeOpenRouterKey(cfg: Partial<AuthConfigFields> | null | undefined): string | undefined {
  const auth = llmAuthFromConfig(cfg);
  return usesOpenRouter(auth) ? auth.openrouterApiKey : undefined;
}
