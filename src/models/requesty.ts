/**
 * Requesty endpoint + request-header helpers, the Requesty sibling of
 * openrouter.ts (chat completions, embeddings, the model catalog and key
 * validation).
 *
 * Requesty (https://requesty.ai) is an OpenAI-compatible LLM gateway. It is
 * used only when a Requesty key is configured and no OpenRouter key or custom
 * endpoint is, so it never changes what an existing setup talks to.
 *
 * `REQUESTY_BASE_URL` overrides the API root, e.g. the EU region
 * (https://router.eu.requesty.ai/v1). The same key works on every region.
 * Because the saved key is sent as a bearer to this URL, it must be https on
 * one of Requesty's regional hosts; anything else is rejected before a
 * request is made.
 */

import { getUserAgent } from "../util/version.js";
import { fetchWithNetworkRetry } from "./openrouter.js";

export const REQUESTY_DEFAULT_BASE_URL = "https://router.requesty.ai/v1";
export const REQUESTY_KEYS_URL = "https://app.requesty.ai/api-keys";

/** Requesty's regional API hosts (global, EU, US, AP). */
export const REQUESTY_HOSTS: readonly string[] = [
  "router.requesty.ai",
  "router.eu.requesty.ai",
  "router.us.requesty.ai",
  "router.ap.requesty.ai",
];

const INVALID_BASE_URL_MESSAGE =
  "REQUESTY_BASE_URL must be an https URL on a Requesty host " +
  `(${REQUESTY_HOSTS.join(", ")}), e.g. https://router.eu.requesty.ai/v1. ` +
  "Unset it to use the default.";

/**
 * The Requesty API root. Throws when REQUESTY_BASE_URL is set to anything
 * other than https on a Requesty host (no credentials, custom port, query or
 * fragment), so the key is never sent elsewhere.
 */
export function requestyBaseUrl(): string {
  const raw = process.env.REQUESTY_BASE_URL?.trim();
  if (!raw) return REQUESTY_DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(INVALID_BASE_URL_MESSAGE);
  }
  const trusted =
    url.protocol === "https:" &&
    REQUESTY_HOSTS.includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash;
  if (!trusted) throw new Error(INVALID_BASE_URL_MESSAGE);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function requestyUrl(path: string): string {
  return `${requestyBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

/** Headers for an authenticated Requesty request, with the same app attribution sent to OpenRouter. */
export function requestyHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://kimiflare.com",
    "X-Title": "autopilot",
    "User-Agent": getUserAgent(),
  };
}

export type RequestyKeyCheck =
  | { ok: true }
  | { ok: false; reason: "invalid" | "config" | "network" | "http"; message: string };

/**
 * Validate a Requesty key with an authenticated `GET /models` (200 for a
 * valid key, 401/403 for a bad one). Free: no tokens are spent.
 */
export async function checkRequestyKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RequestyKeyCheck> {
  let url: string;
  try {
    url = requestyUrl("models");
  } catch (e) {
    return { ok: false, reason: "config", message: e instanceof Error ? e.message : String(e) };
  }
  let res: Response;
  try {
    res = await fetchWithNetworkRetry(fetchImpl, url, { headers: requestyHeaders(apiKey) });
  } catch (e) {
    return { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid", message: "Requesty rejected this key." };
  }
  if (!res.ok) {
    return { ok: false, reason: "http", message: `Requesty returned HTTP ${res.status}.` };
  }
  return { ok: true };
}
