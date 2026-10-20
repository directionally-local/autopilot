import { getUserAgent } from "../util/version.js";
import { openRouterHeaders, openRouterUrl } from "../models/openrouter.js";
import { requestyHeaders, requestyUrl } from "../models/requesty.js";
import { providerPresetOf, usesRequesty, type LlmAuth } from "../agent/llm-auth.js";
import { keyHeaders } from "../providers/presets.js";
import { resolveCustomEndpoint } from "../agent/custom-endpoint.js";

export interface EmbedOpts extends LlmAuth {
  model?: string;
  texts: string[];
}

/** OpenRouter's embedding model (the one Workers AI served, so vectors in
 *  existing memory databases stay comparable). Other providers' models are
 *  in src/providers/presets.ts. */
export const DEFAULT_EMBEDDING_MODEL = "baai/bge-base-en-v1.5";
/** Requesty does not serve bge-base-en-v1.5; its default is an OpenAI embedding model. */
export const REQUESTY_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** The provider has no embeddings API and no embedding model was configured. */
export class EmbeddingsUnavailableError extends Error {
  constructor(providerName: string) {
    super(
      `${providerName} has no embeddings API — vector recall is off. Set memoryEmbeddingModel, or embeddingProvider to a provider that has one.`,
    );
    this.name = "EmbeddingsUnavailableError";
  }
}

/**
 * The embedding model for `auth`'s provider: an explicit override, else the
 * provider preset's model. Null when the provider has none — callers then
 * store and search without vectors instead of failing.
 */
export function embeddingModelFor(auth: LlmAuth, override?: string): string | null {
  return override?.trim() || providerPresetOf(auth).embedding?.model || null;
}
const MAX_EMBED_CHARS = 2000; // ≈ the 512-token context of bge-base-en-v1.5

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) return text;
  return text.slice(0, MAX_EMBED_CHARS);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3
): Promise<Response> {
  let lastError: Error | undefined;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        // Rate limit or server error — retry with backoff
        const delay = 1000 * 2 ** i;
        await sleep(delay);
        continue;
      }
      const errText = await res.text().catch(() => "unknown error");
      throw new Error(`embeddings request failed (${res.status}): ${errText}`);
    } catch (e) {
      lastError = e as Error;
      if (i < retries - 1) {
        await sleep(1000 * 2 ** i);
      }
    }
  }
  throw lastError ?? new Error("embeddings request failed after retries");
}

/** Parse an OpenAI-shaped embeddings response (OpenRouter, custom endpoints). */
function parseOpenAiEmbeddingResponse(json: unknown): Float32Array[] {
  if (!json || typeof json !== "object") {
    throw new Error("embeddings response was not an object");
  }
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error("embeddings response contained no data array");
  }

  const indexed: { index: number; vector: Float32Array }[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const embedding = (item as Record<string, unknown>).embedding;
    const idx = (item as Record<string, unknown>).index;
    if (!Array.isArray(embedding)) continue;
    indexed.push({
      index: typeof idx === "number" ? idx : indexed.length,
      vector: new Float32Array(embedding as number[]),
    });
  }

  if (indexed.length === 0) {
    throw new Error("embeddings response contained no vectors");
  }

  indexed.sort((a, b) => a.index - b.index);
  return indexed.map((item) => {
    if (item.vector.length === 0) {
      throw new Error("embeddings response contained empty vector");
    }
    return item.vector;
  });
}

export async function fetchEmbeddings(opts: EmbedOpts): Promise<Float32Array[]> {
  const custom = opts.customEndpoint ?? resolveCustomEndpoint();
  const requesty = !custom && usesRequesty(opts);
  const model = embeddingModelFor(opts, opts.model);
  if (!model) throw new EmbeddingsUnavailableError(providerPresetOf(opts).name);
  const texts = opts.texts.map(truncateForEmbedding);

  if (texts.length === 0) {
    return [];
  }

  // Same routing rule as chat (see llm-auth.ts): a custom endpoint wins,
  // otherwise OpenRouter with the user's key, otherwise Requesty.
  let url: string;
  let headers: Record<string, string>;
  if (custom) {
    url = `${custom.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")}/embeddings`;
    headers = { "User-Agent": getUserAgent(), ...keyHeaders(custom.providerId, custom.apiKey) };
  } else if (requesty && opts.requestyApiKey) {
    url = requestyUrl("embeddings");
    headers = requestyHeaders(opts.requestyApiKey);
  } else {
    if (!opts.openrouterApiKey) throw new Error("embeddings: no OpenRouter API key configured");
    url = openRouterUrl("embeddings");
    headers = openRouterHeaders(opts.openrouterApiKey);
  }
  headers["Content-Type"] = "application/json";

  const res = await fetchWithRetry(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, input: texts }),
  });
  const json = (await res.json()) as unknown;
  return parseOpenAiEmbeddingResponse(json);
}

/**
 * Decode a vector stored as a SQLite BLOB. `new Float32Array(buffer)` would
 * treat every *byte* as an element (a 768-dim vector comes back with 3072
 * entries, which then never matches a query vector's length); reinterpret
 * the bytes instead. Copies first, since a Buffer's offset may not be
 * 4-byte aligned.
 */
export function vectorFromBlob(blob: Uint8Array): Float32Array {
  const bytes = Uint8Array.from(blob);
  return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    // Mismatched dimensions — skip this pair
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
