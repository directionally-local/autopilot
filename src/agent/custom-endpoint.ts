/**
 * Custom OpenAI-compatible endpoint routing.
 *
 * When `KIMIFLARE_BASE_URL` is set (or `baseUrl` in config), every model call
 * — chat and embeddings — is sent to `<baseUrl>/chat/completions` (or
 * `/embeddings`) with `Authorization: Bearer <KIMIFLARE_API_KEY>` instead of
 * OpenRouter, and no OpenRouter key is needed.
 *
 * This is how a host application (e.g. an agents platform running kimiflare
 * inside a container) points the CLI at its own gateway/broker instead of
 * handing the process a raw provider key. The broker terminates the bearer it
 * issued and forwards upstream with credentials that never enter this process.
 *
 * Precedence (per field): env var > config field. Model ids pass through to
 * the body unchanged — no OpenRouter id-shape validation.
 */

import type { ProviderId } from "../providers/presets.js";
import { readEnv } from "../util/env.js";

export interface CustomEndpoint {
  /** OpenAI-compatible base URL. `/chat/completions` is appended unless the URL already ends with it. */
  baseUrl: string;
  /** Bearer sent as `Authorization` to `baseUrl`. Omitted entirely when unset (unauthenticated local gateways). */
  apiKey?: string;
  /** The provider preset this endpoint belongs to (its quirks, defaults and name). Unset means a host-app gateway. */
  providerId?: ProviderId;
}

/** Config fields a custom endpoint can be persisted under (see `KimiConfig`). */
export interface CustomEndpointConfigFields {
  baseUrl?: string;
  apiKey?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the custom endpoint, if one is configured. Env vars win over
 * config fields, field by field (same rule `loadConfig()` applies to every
 * other setting). Returns null when no base URL is configured anywhere —
 * an API key on its own does not activate custom routing.
 */
export function resolveCustomEndpoint(
  config?: CustomEndpointConfigFields | null,
): CustomEndpoint | null {
  const baseUrl = nonEmpty(readEnv("BASE_URL")) ?? nonEmpty(config?.baseUrl);
  if (!baseUrl) return null;
  const apiKey = nonEmpty(readEnv("API_KEY")) ?? nonEmpty(config?.apiKey);
  return { baseUrl, ...(apiKey ? { apiKey } : {}) };
}

/**
 * Build the chat-completions URL for a custom base. Lenient about how the
 * base was written: trailing slashes are trimmed, and a base that already
 * ends in `/chat/completions` is used as-is.
 */
export function customChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}
