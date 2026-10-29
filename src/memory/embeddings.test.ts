import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { fetchEmbeddings, cosineSimilarity, embeddingModelFor, EmbeddingsUnavailableError, vectorFromBlob, DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";

function assertClose(actual: Float32Array, expected: number[], epsilon = 1e-6): void {
  assert.strictEqual(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.ok(
      Math.abs(actual[i]! - expected[i]!) < epsilon,
      `expected ${actual[i]} to be close to ${expected[i]} at index ${i}`,
    );
  }
}

describe("fetchEmbeddings", () => {
  const originalFetch = globalThis.fetch;
  const savedBase = process.env.KIMIFLARE_BASE_URL;
  let lastRequest: Request | null = null;
  let responseBody: unknown = { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };

  beforeEach(() => {
    delete process.env.KIMIFLARE_BASE_URL;
    lastRequest = null;
    responseBody = { data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      lastRequest = new Request(input, init);
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedBase === undefined) delete process.env.KIMIFLARE_BASE_URL;
    else process.env.KIMIFLARE_BASE_URL = savedBase;
  });

  it("posts to OpenRouter /embeddings with the key and the same bge model Workers AI served", async () => {
    const vectors = await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: ["hello world"] });
    assert.strictEqual(DEFAULT_EMBEDDING_MODEL, "baai/bge-base-en-v1.5");
    assert.strictEqual(lastRequest!.url, "https://openrouter.ai/api/v1/embeddings");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer sk-or-test");
    assert.deepStrictEqual(await lastRequest!.clone().json(), { model: "baai/bge-base-en-v1.5", input: ["hello world"] });
    assertClose(vectors[0]!, [0.1, 0.2, 0.3]);
  });

  it("batches texts and orders vectors by index, not arrival", async () => {
    responseBody = {
      data: [
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
    };
    const vectors = await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: ["a", "b"] });
    assertClose(vectors[0]!, [0.1, 0.2, 0.3]);
    assertClose(vectors[1]!, [0.4, 0.5, 0.6]);
  });

  it("uses a custom endpoint's /embeddings with the configured model", async () => {
    await fetchEmbeddings({
      customEndpoint: { baseUrl: "https://broker.example/v1/", apiKey: "host-key" },
      model: "bge-small",
      texts: ["x"],
    });
    assert.strictEqual(lastRequest!.url, "https://broker.example/v1/embeddings");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer host-key");
    assert.strictEqual((await lastRequest!.clone().json()).model, "bge-small");
  });

  it("never sends OpenRouter's bge model to a custom endpoint: without a model, embeddings are unavailable", async () => {
    await assert.rejects(
      fetchEmbeddings({ customEndpoint: { baseUrl: "https://broker.example/v1" }, texts: ["x"] }),
      EmbeddingsUnavailableError,
    );
    assert.strictEqual(lastRequest, null);
  });

  it("uses the active preset's embedding model", async () => {
    await fetchEmbeddings({
      providerId: "openai",
      customEndpoint: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-oa", providerId: "openai" },
      texts: ["x"],
    });
    assert.strictEqual(lastRequest!.url, "https://api.openai.com/v1/embeddings");
    assert.strictEqual((await lastRequest!.clone().json()).model, "text-embedding-3-small");
  });

  it("reports providers without an embeddings API instead of calling them", async () => {
    const deepseek = { providerId: "deepseek" as const, customEndpoint: { baseUrl: "https://api.deepseek.com", apiKey: "k", providerId: "deepseek" as const } };
    assert.strictEqual(embeddingModelFor(deepseek), null);
    assert.strictEqual(embeddingModelFor(deepseek, "my-embedder"), "my-embedder");
    await assert.rejects(fetchEmbeddings({ ...deepseek, texts: ["x"] }), /DeepSeek has no embeddings API/);
    assert.strictEqual(lastRequest, null);
  });

  it("throws without an OpenRouter key or custom endpoint", async () => {
    await assert.rejects(fetchEmbeddings({ texts: ["x"] }), /no OpenRouter API key/);
  });

  it("returns an empty array for empty input without calling the API", async () => {
    assert.deepStrictEqual(await fetchEmbeddings({ openrouterApiKey: "k", texts: [] }), []);
    assert.strictEqual(lastRequest, null);
  });

  it("throws when the response contains no vectors", async () => {
    responseBody = { data: [] };
    await assert.rejects(fetchEmbeddings({ openrouterApiKey: "k", texts: ["x"] }), /no vectors/);
  });

  it("truncates inputs to the embedding model's context window", async () => {
    const long = "x".repeat(5000);
    await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: [long] });
    const body = (await lastRequest!.clone().json()) as { input: string[] };
    // bge-base-en-v1.5 has a 512-token context; 2.5 chars/token with 10% headroom.
    assert.ok(body.input[0]!.length <= 1152, `input was ${body.input[0]!.length} chars`);
    assert.ok(body.input[0]!.length > 0);
  });

  it("retries with a smaller budget when the model rejects the input as too long", async () => {
    const long = "x".repeat(5000);
    const lengths: number[] = [];
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = (await req.clone().json()) as { input: string[] };
      lengths.push(body.input[0]!.length);
      calls++;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "You passed 513 input tokens and requested 0 output tokens. However, the model's context length is only 512 tokens, resulting in a maximum input length of 512 tokens. Please reduce the length of the input prompt.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const vectors = await fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: [long] });
    assert.strictEqual(calls, 2);
    assert.ok(lengths[1]! < lengths[0]!, `expected a smaller retry, got ${lengths.join(" then ")}`);
    assertClose(vectors[0]!, [0.1, 0.2, 0.3]);
  });

  it("does not retry a non-context 400", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "invalid model" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await assert.rejects(fetchEmbeddings({ openrouterApiKey: "sk-or-test", texts: ["x"] }), /invalid model/);
    assert.strictEqual(calls, 1);
  });
});

describe("vectorFromBlob", () => {
  it("round-trips a stored vector (bytes are reinterpreted, not widened)", () => {
    const v = new Float32Array([0.5, -1.25, 3]);
    const blob = Buffer.from(v.buffer);
    assert.deepStrictEqual(Array.from(vectorFromBlob(blob)), [0.5, -1.25, 3]);
    assert.strictEqual(cosineSimilarity(v, vectorFromBlob(blob)), 1);
  });

  it("handles a Buffer at an unaligned offset", () => {
    const v = new Float32Array([1, 2]);
    const padded = Buffer.concat([Buffer.from([9]), Buffer.from(v.buffer)]).subarray(1);
    assert.deepStrictEqual(Array.from(vectorFromBlob(padded)), [1, 2]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    assert.strictEqual(cosineSimilarity(a, a), 1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });

  it("returns 0 for mismatched dimensions", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    assert.strictEqual(cosineSimilarity(a, b), 0);
  });
});
