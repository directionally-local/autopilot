/**
 * Context length of a model served by a local runtime (vLLM, LM Studio,
 * Ollama, or a custom OpenAI-compatible endpoint), read from the server.
 *
 * Those servers reject a request whose prompt plus `max_tokens` exceeds the
 * context they were started with (vLLM: `--max-model-len`), and their
 * `/models` listing is the only place that number lives. On first use per
 * provider + base URL + model we ask once (short timeout) and cache the
 * answer, a failure included, for the life of the process:
 *
 *  - GET {baseUrl}/models, the model's entry: vLLM `max_model_len`, LM Studio
 *    `loaded_context_length` / `max_context_length`, or `context_length`.
 *  - Ollama's OpenAI-compatible listing has none: POST {root}/api/show and
 *    read `model_info["<arch>.context_length"]`.
 *
 * Anything that fails leaves the request as it was.
 */

import type { CustomEndpoint } from "../agent/custom-endpoint.js";
import { getModel, noteServedContextWindow } from "./registry.js";
import { keyHeaders, type ProviderId } from "../providers/presets.js";

/** Providers whose context length is whatever the server was started with. */
const LOCAL_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>(["vllm", "lmstudio", "ollama", "custom"]);

/** How long the one lookup may take before the request goes ahead without it. */
export const LOCAL_CONTEXT_TIMEOUT_MS = 2_000;

/** Fields servers use for a model's context length, most specific first. */
const CONTEXT_FIELDS = ["loaded_context_length", "max_model_len", "context_length", "max_context_length"] as const;

const lookups = new Map<string, Promise<number | null>>();
/** Context lengths servers reported, by model id (read synchronously by the context budget). */
const served = new Map<string, number>();

/** The local provider an endpoint belongs to, or null for hosted providers. */
export function localProviderOf(endpoint: CustomEndpoint | null | undefined): ProviderId | null {
  if (!endpoint) return null;
  const id = endpoint.providerId ?? "custom";
  return LOCAL_PROVIDERS.has(id) ? id : null;
}

/** A context length from one `/models` entry, or null when it names none. */
export function contextLengthOf(entry: unknown): number | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;
  for (const field of CONTEXT_FIELDS) {
    const v = e[field];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return null;
}

function isOllama(providerId: ProviderId, baseUrl: string): boolean {
  if (providerId === "ollama") return true;
  try {
    return new URL(baseUrl).port === "11434";
  } catch {
    return false;
  }
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchContextLength(
  providerId: ProviderId,
  endpoint: CustomEndpoint,
  model: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number | null> {
  const base = endpoint.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  const headers = { Accept: "application/json", ...keyHeaders(providerId, endpoint.apiKey) };
  try {
    const body = (await readJson(await fetchImpl(`${base}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) }))) as {
      data?: unknown[];
    } | null;
    const entry = body?.data?.find((m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === model);
    const ctx = contextLengthOf(entry);
    if (ctx) return ctx;
  } catch {
    // Unreachable or not OpenAI-compatible: fall through.
  }
  if (!isOllama(providerId, base)) return null;
  try {
    const show = (await readJson(
      await fetchImpl(`${base.replace(/\/v1$/, "")}/api/show`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        signal: AbortSignal.timeout(timeoutMs),
      }),
    )) as { model_info?: Record<string, unknown> } | null;
    for (const [k, v] of Object.entries(show?.model_info ?? {})) {
      if (k.endsWith(".context_length") && typeof v === "number" && v > 0) return Math.floor(v);
    }
  } catch {
    // Older Ollama, or not Ollama after all.
  }
  return null;
}

/**
 * The served context length of `model` on a local endpoint, or null when the
 * endpoint is hosted or the server doesn't say. One lookup per provider, base
 * URL and model; concurrent callers share it.
 */
export function localContextLength(
  endpoint: CustomEndpoint | null | undefined,
  model: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<number | null> {
  const providerId = localProviderOf(endpoint);
  if (!endpoint || !providerId || !model) return Promise.resolve(null);
  const key = `${providerId}\u0000${endpoint.baseUrl}\u0000${model}`;
  let pending = lookups.get(key);
  if (!pending) {
    pending = fetchContextLength(providerId, endpoint, model, opts.fetchImpl ?? fetch, opts.timeoutMs ?? LOCAL_CONTEXT_TIMEOUT_MS)
      .catch(() => null)
      .then((ctx) => {
        if (ctx) {
          served.set(model, ctx);
          noteServedContextWindow(model, ctx);
        }
        return ctx;
      });
    lookups.set(key, pending);
  }
  return pending;
}

/** The context length a local server reported for `model`, once looked up. */
export function servedContextLength(model: string): number | undefined {
  return served.get(model);
}

/**
 * Max output tokens for a request to a server with context `contextLength`:
 * at most half of it (a long reply must not leave no room for the prompt),
 * and never above the model's own output limit when the catalog knows one.
 */
export function capOutputTokens(requested: number, contextLength: number, model?: string): number {
  const own = model ? getModel(model)?.maxOutputTokens : undefined;
  return Math.max(1, Math.min(requested, Math.floor(contextLength / 2), own && own > 0 ? own : Infinity));
}

/** Room for the reply below which a request isn't worth sending. */
export function minReplyTokens(contextLength: number): number {
  return Math.min(4_096, Math.floor(contextLength / 8));
}

/** Headroom for the prompt estimate's drift (it is from characters, not a tokenizer). */
function driftTokens(contextLength: number): number {
  return Math.min(1_024, Math.floor(contextLength / 32));
}

/** The largest estimated prompt a server with this context still takes, with room for a reply. */
export function servedPromptLimit(contextLength: number): number {
  return Math.max(1, contextLength - minReplyTokens(contextLength) - driftTokens(contextLength));
}

/**
 * `max_tokens` for a prompt of about `promptTokens` on a server with context
 * `contextLength`: the capped value (above), lowered to the room the prompt
 * leaves. Null when that room is under {@link minReplyTokens}: the request
 * would be rejected, or leave no room to answer, so it isn't sent.
 */
export function fitOutputTokens(requested: number, contextLength: number, promptTokens: number, model?: string): number | null {
  if (promptTokens > servedPromptLimit(contextLength)) return null;
  const room = contextLength - promptTokens - driftTokens(contextLength);
  return Math.max(1, Math.min(capOutputTokens(requested, contextLength, model), room));
}

/** What to change on the server to get a longer context, by provider. */
function raiseHint(providerId: ProviderId | null): string {
  switch (providerId) {
    case "vllm":
      return "raise --max-model-len on the server";
    case "lmstudio":
      return "load the model with a longer context length in LM Studio";
    case "ollama":
      return "raise the context length on the server (OLLAMA_CONTEXT_LENGTH or num_ctx)";
    default:
      return "raise the context length on the server (vLLM: --max-model-len)";
  }
}

/** The fail-fast message when a prompt cannot fit a local server's context. */
export function localContextMessage(o: {
  promptTokens: number;
  contextLength: number;
  model: string;
  providerId: ProviderId | null;
  providerName: string;
}): string {
  const n = (v: number) => v.toLocaleString("en-US");
  return (
    `This prompt is about ${n(o.promptTokens)} tokens, but ${o.model} on ${o.providerName} has a context of ` +
    `${n(o.contextLength)} tokens, which leaves too little room for a reply. ` +
    `Compact with /compact, start a new session, or ${raiseHint(o.providerId)}.`
  );
}

/** Test-only. */
export function resetLocalContextForTesting(): void {
  lookups.clear();
  served.clear();
}
