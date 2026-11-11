import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  capOutputTokens,
  contextLengthOf,
  fitOutputTokens,
  localContextLength,
  localProviderOf,
  resetLocalContextForTesting,
  servedContextLength,
  servedPromptLimit,
} from "./local-context.js";
import { getModelOrInfer, registerProviderModels } from "./registry.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("local server context length", () => {
  beforeEach(() => {
    resetLocalContextForTesting();
    registerProviderModels("vllm", []);
  });

  it("applies to vLLM, LM Studio, Ollama and custom endpoints only", () => {
    assert.equal(localProviderOf({ baseUrl: "http://x/v1", providerId: "vllm" }), "vllm");
    assert.equal(localProviderOf({ baseUrl: "http://x/v1", providerId: "lmstudio" }), "lmstudio");
    assert.equal(localProviderOf({ baseUrl: "http://x/v1", providerId: "ollama" }), "ollama");
    assert.equal(localProviderOf({ baseUrl: "http://x/v1" }), "custom");
    assert.equal(localProviderOf({ baseUrl: "http://x/v1", providerId: "openai" }), null);
    assert.equal(localProviderOf(null), null);
  });

  it("reads max_model_len and the common equivalents", () => {
    assert.equal(contextLengthOf({ id: "m", max_model_len: 32768 }), 32768);
    assert.equal(contextLengthOf({ id: "m", context_length: 8192 }), 8192);
    assert.equal(contextLengthOf({ id: "m", max_context_length: 131072 }), 131072);
    // LM Studio: the loaded context is what the server enforces.
    assert.equal(contextLengthOf({ id: "m", max_context_length: 131072, loaded_context_length: 4096 }), 4096);
    assert.equal(contextLengthOf({ id: "m" }), null);
    assert.equal(contextLengthOf({ id: "m", max_model_len: "32768" }), null);
    assert.equal(contextLengthOf(undefined), null);
  });

  it("asks GET /models once per provider, base URL and model", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return json({ object: "list", data: [{ id: "other", max_model_len: 1 }, { id: "qwen", max_model_len: 24000 }] });
    }) as typeof fetch;
    const endpoint = { baseUrl: "http://gpu:8000/v1/", providerId: "vllm" as const, apiKey: "k" };
    const [a, b] = await Promise.all([localContextLength(endpoint, "qwen", { fetchImpl }), localContextLength(endpoint, "qwen", { fetchImpl })]);
    assert.equal(a, 24000);
    assert.equal(b, 24000);
    assert.equal(await localContextLength(endpoint, "qwen", { fetchImpl }), 24000);
    assert.deepEqual(calls, ["http://gpu:8000/v1/models"]);
    assert.equal(servedContextLength("qwen"), 24000);
    // The registry follows, so compaction and the context meter use it.
    assert.equal(getModelOrInfer("qwen").contextWindow, 24000);
  });

  it("falls back to Ollama's /api/show model_info", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/v1/models")) return json({ data: [{ id: "llama3.1:8b", object: "model" }] });
      assert.deepEqual(JSON.parse(String(init?.body)), { model: "llama3.1:8b" });
      return json({ model_info: { "general.architecture": "llama", "llama.context_length": 131072 } });
    }) as typeof fetch;
    const ctx = await localContextLength({ baseUrl: "http://127.0.0.1:11434/v1", providerId: "ollama" }, "llama3.1:8b", { fetchImpl });
    assert.equal(ctx, 131072);
    assert.deepEqual(calls, ["GET http://127.0.0.1:11434/v1/models", "POST http://127.0.0.1:11434/api/show"]);
  });

  it("skips /api/show for servers that are not Ollama", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return json({ data: [{ id: "m" }] });
    }) as typeof fetch;
    assert.equal(await localContextLength({ baseUrl: "http://127.0.0.1:1234/v1", providerId: "lmstudio" }, "m", { fetchImpl }), null);
    assert.deepEqual(calls, ["http://127.0.0.1:1234/v1/models"]);
  });

  it("is silent on failure, and doesn't ask again", async () => {
    let calls = 0;
    const failing = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const endpoint = { baseUrl: "http://down:8000/v1", providerId: "vllm" as const };
    assert.equal(await localContextLength(endpoint, "m", { fetchImpl: failing }), null);
    assert.equal(await localContextLength(endpoint, "m", { fetchImpl: failing }), null);
    assert.equal(calls, 1);
    const http500 = (async () => json({ error: "boom" }, 500)) as typeof fetch;
    assert.equal(await localContextLength({ ...endpoint, baseUrl: "http://other:8000/v1" }, "m", { fetchImpl: http500 }), null);
    assert.equal(servedContextLength("m"), undefined);
  });

  it("never asks hosted providers", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json({ data: [] });
    }) as typeof fetch;
    assert.equal(await localContextLength({ baseUrl: "https://api.openai.com/v1", providerId: "openai" }, "gpt", { fetchImpl }), null);
    assert.equal(calls, 0);
  });

  it("caps the reply at half the context and below the model's own limit", () => {
    assert.equal(capOutputTokens(16384, 16384), 8192);
    assert.equal(capOutputTokens(16384, 131072), 16384);
    registerProviderModels("vllm", [
      { id: "small-out", contextWindow: 131072, maxOutputTokens: 4096, pricing: { inputPerMtok: 0, outputPerMtok: 0 }, supports: { tools: true, reasoning: false, streaming: true } },
    ]);
    assert.equal(capOutputTokens(16384, 131072, "small-out"), 4096);
  });

  it("lowers the reply to the room the prompt leaves, and refuses when too little is left", () => {
    // 24k context: half is 12k; a 12.8k prompt leaves ~10.5k.
    assert.equal(fitOutputTokens(16384, 24000, 1000), 12000);
    assert.equal(fitOutputTokens(16384, 24000, 12780), 24000 - 12780 - 750);
    assert.equal(fitOutputTokens(16384, 24000, servedPromptLimit(24000)), 3000);
    assert.equal(fitOutputTokens(16384, 24000, servedPromptLimit(24000) + 1), null);
    assert.equal(fitOutputTokens(16384, 8000, 12780), null);
  });
});
