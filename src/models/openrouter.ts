/**
 * OpenRouter endpoint + request-header helpers shared by every caller that
 * talks to OpenRouter (chat completions, embeddings, the model catalog, the
 * generation-cost lookup, and key validation).
 *
 * `OPENROUTER_BASE_URL` overrides the API root. It exists for tests and local
 * mocks (and for OpenRouter-compatible proxies); normal users never set it.
 */

import { getUserAgent } from "../util/version.js";

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

export function openRouterBaseUrl(): string {
  const raw = process.env.OPENROUTER_BASE_URL?.trim();
  return (raw || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

export function openRouterUrl(path: string): string {
  return `${openRouterBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

/** OpenRouter's Decisions API is currently under `/api/alpha`, not `/api/v1`. */
export function openRouterAlphaUrl(path: string): string {
  const apiRoot = openRouterBaseUrl().replace(/\/v1\/?$/, "");
  return `${apiRoot}/alpha/${path.replace(/^\/+/, "")}`;
}

/**
 * Headers for an authenticated OpenRouter request. `HTTP-Referer`,
 * `X-OpenRouter-Title` and `X-OpenRouter-Categories` are OpenRouter's
 * app-attribution headers (https://openrouter.ai/docs/app-attribution):
 * optional, but they're how a project shows up in OpenRouter's public
 * rankings and category pages. `X-Title` is the older name for the title.
 */
/** App identity for attribution. The URL is OpenRouter's key for the app page. */
export const APP_URL = "https://directionallylocal.com";
export const APP_TITLE = "Autopilot";
/** Up to 2 per request: terminal coding agent, and agents that run in the background. */
export const APP_CATEGORIES = "cli-agent,cloud-agent";

export function openRouterHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": APP_URL,
    "X-OpenRouter-Title": APP_TITLE,
    "X-Title": APP_TITLE,
    "X-OpenRouter-Categories": APP_CATEGORIES,
    "User-Agent": getUserAgent(),
  };
}

/**
 * `fetch` that retries on network-level failures (thrown errors — DNS, TCP
 * connect timeouts, resets), not on HTTP error statuses. Node's connection
 * racing gives up on an address after ~250ms, so on slow or high-latency
 * links a first attempt fails intermittently with ETIMEDOUT; one retry
 * almost always connects. The chat client has its own, longer retry loop.
 */
export async function fetchWithNetworkRetry(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetchImpl(url, init);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw lastErr;
}

/** Shape of `GET /key` — only the fields we display. */
export interface OpenRouterKeyInfo {
  label?: string;
  /** Credit limit in USD, or null for unlimited. */
  limit?: number | null;
  /** Remaining credit in USD under `limit`, or null for unlimited. */
  limitRemaining?: number | null;
  /** USD spent on this key so far. */
  usage?: number;
  isFreeTier?: boolean;
}

export type KeyCheck =
  | { ok: true; info: OpenRouterKeyInfo }
  | { ok: false; reason: "invalid" | "network" | "http"; message: string };

/**
 * Validate an OpenRouter key against `GET /key`, which returns the key's
 * label, limit and usage without spending anything. Used by onboarding and
 * `/key set` so a typo is caught at paste time, not on the first prompt.
 */
export async function checkOpenRouterKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetchWithNetworkRetry(fetchImpl, openRouterUrl("key"), { headers: openRouterHeaders(apiKey) });
  } catch (e) {
    return { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid", message: "OpenRouter rejected this key." };
  }
  if (!res.ok) {
    return { ok: false, reason: "http", message: `OpenRouter returned HTTP ${res.status}.` };
  }
  try {
    const body = (await res.json()) as { data?: Record<string, unknown> };
    const d = body.data ?? {};
    return {
      ok: true,
      info: {
        label: typeof d.label === "string" ? d.label : undefined,
        limit: typeof d.limit === "number" ? d.limit : null,
        limitRemaining: typeof d.limit_remaining === "number" ? d.limit_remaining : null,
        usage: typeof d.usage === "number" ? d.usage : undefined,
        isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : undefined,
      },
    };
  } catch {
    return { ok: true, info: {} };
  }
}

/** Cheap shape check before any network call: OpenRouter keys start with `sk-or-`. */
export function looksLikeOpenRouterKey(key: string): boolean {
  return /^sk-or-[A-Za-z0-9_-]{8,}$/.test(key.trim());
}
