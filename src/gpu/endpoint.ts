/**
 * "Use your own GPUs" off this machine: a vLLM (or other OpenAI-compatible) server the person
 * already runs, or one `dl model up` set up on another server of theirs. The address is
 * checked with GET <base>/models before anything is saved.
 */

export type EndpointError = "unreachable" | "unauthorized" | "http" | "not_openai" | "no_models";

export type EndpointCheck = { ok: true; baseUrl: string; models: string[] } | { ok: false; error: EndpointError; message: string };

export const ENDPOINT_TIMEOUT_MS = 5_000;

/**
 * What was typed, as an OpenAI-compatible base URL: http:// when no scheme was given, /v1 when
 * no path was, and no trailing slash or /models. Undefined when it isn't a URL.
 */
export function normalizeBaseUrl(input: string): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!url.hostname) return undefined;
  let path = url.pathname.replace(/\/+$/, "").replace(/\/models$/, "");
  if (!path) path = "/v1";
  return `${url.protocol}//${url.host}${path}`;
}

/** A server's address and port as the base URL dl model up serves on. Undefined when either is unusable. */
export function serverBaseUrl(address: string, port: string): string | undefined {
  const host = address.trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  const p = port.trim() || "8000";
  if (!host || /\s/.test(host)) return undefined;
  if (!/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535) return undefined;
  // A bare IPv6 address needs brackets in a URL.
  const bracketed = host.includes(":") && !host.startsWith("[") && (host.match(/:/g) ?? []).length > 1 ? `[${host}]` : host.replace(/:\d+$/, "");
  return normalizeBaseUrl(`http://${bracketed}:${p}/v1`);
}

/** GET <base>/models: reachable, accepted, OpenAI-shaped, with at least one model. */
export async function checkModelsEndpoint(baseUrl: string, key?: string, fetchImpl: typeof fetch = fetch): Promise<EndpointCheck> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/models`, {
      headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(ENDPOINT_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e instanceof Error ? (e.name === "TimeoutError" ? "no answer in 5 s" : e.message) : String(e);
    return { ok: false, error: "unreachable", message: `Couldn't reach ${baseUrl} (${why}).` };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: "unauthorized", message: `${baseUrl} needs an API key, or rejected this one.` };
  if (!res.ok) return { ok: false, error: "http", message: `${baseUrl}/models returned HTTP ${res.status}.` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, error: "not_openai", message: `${baseUrl}/models didn't answer with JSON. Is this an OpenAI-compatible server?` };
  }
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return { ok: false, error: "not_openai", message: `${baseUrl}/models has no model list. Is this an OpenAI-compatible server?` };
  const models = data.map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === "string" && id.length > 0);
  if (models.length === 0) return { ok: false, error: "no_models", message: `${baseUrl} is up but serves no models yet.` };
  return { ok: true, baseUrl, models };
}
