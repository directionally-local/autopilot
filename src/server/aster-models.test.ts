import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSelectableModel, modelsResponse, resetProviderCatalogCache, selectableModels, PROVIDER_CATALOG_CACHE_TTL_MS } from "./aster-models.js";
import { providerConfig, type AsterServerConfig } from "./aster-workspaces.js";

function config(overrides: Partial<AsterServerConfig>): AsterServerConfig {
  return { provider: providerConfig("openrouter"), models: [], modelCatalog: "catalog", workspaces: [], approvalTtlMs: 1000, ...overrides };
}

interface Call { url: string; authorization: string | undefined }

/** An OpenAI-compatible /models endpoint; `fail` answers 500 instead. */
function fakeFetch(calls: Call[], ids: string[], fail = false): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(input), authorization: headers.get("authorization") ?? undefined });
    if (fail) return new Response("upstream down", { status: 500 });
    return Response.json({ object: "list", data: ids.map((id) => ({ id, object: "model", created: 1_700_000_000, owned_by: "x" })) });
  }) as typeof fetch;
}

describe("Aster model catalog per provider", () => {
  beforeEach(() => resetProviderCatalogCache());

  it("offers a fixed list as is, for any provider", async () => {
    const deepseek = config({ provider: providerConfig("deepseek"), models: ["deepseek-flash"], modelCatalog: "fixed" });
    assert.deepEqual(await selectableModels(deepseek), [{ id: "deepseek-flash" }]);
    assert.equal(await isSelectableModel(deepseek, "deepseek-flash"), true);
    assert.equal(await isSelectableModel(deepseek, "deepseek-v4-pro"), false);
    assert.deepEqual(await modelsResponse(deepseek), {
      models: ["deepseek-flash"], catalog: [{ id: "deepseek-flash" }], provider: { id: "deepseek", name: "DeepSeek" }, defaultModel: "deepseek-flash",
    });
  });

  it("lists GET {baseUrl}/models with the server's own key, caches it, and validates models against it", async () => {
    const calls: Call[] = [];
    const deps = { fetch: fakeFetch(calls, ["deepseek-v4-pro", "deepseek-flash", "deepseek-embed"]), env: { DEEPSEEK_API_KEY: "server-key" } };
    const deepseek = config({ provider: providerConfig("deepseek") });

    const response = await modelsResponse(deepseek, deps);
    assert.deepEqual(response, {
      models: ["deepseek-v4-pro", "deepseek-flash"],
      catalog: [{ id: "deepseek-v4-pro", created: 1_700_000_000 }, { id: "deepseek-flash", created: 1_700_000_000 }],
      provider: { id: "deepseek", name: "DeepSeek" },
      defaultModel: "deepseek-v4-pro",
    });
    assert.deepEqual(calls, [{ url: "https://api.deepseek.com/models", authorization: "Bearer server-key" }]);

    assert.equal(await isSelectableModel(deepseek, "deepseek-flash", deps), true);
    assert.equal(await isSelectableModel(deepseek, "moonshotai/kimi-k2.6", deps), false);
    assert.equal(calls.length, 1, "the list is cached for a few minutes");

    let now = Date.now() + PROVIDER_CATALOG_CACHE_TTL_MS + 1;
    await selectableModels(deepseek, { ...deps, now: () => now });
    assert.equal(calls.length, 2, "refetched once the cache expires");
    now += 1;
    await selectableModels(deepseek, { ...deps, now: () => now });
    assert.equal(calls.length, 2);
  });

  it("falls back to the preset's default model when the provider's list is unavailable, keeping a stale list when it has one", async () => {
    const calls: Call[] = [];
    const openai = config({ provider: providerConfig("openai") });
    const failing = { fetch: fakeFetch(calls, [], true), env: { OPENAI_API_KEY: "k" } };
    assert.deepEqual(await selectableModels(openai, failing), [{ id: "gpt-6.1-sol" }]);
    assert.equal(await isSelectableModel(openai, "gpt-6.1-sol", failing), true);
    assert.equal((await modelsResponse(openai, failing)).defaultModel, "gpt-6.1-sol");
    assert.equal(calls[0]?.url, "https://api.openai.com/v1/models");

    // A list fetched earlier outlives a later outage.
    resetProviderCatalogCache();
    const good = { fetch: fakeFetch(calls, ["gpt-6-luna"]), env: { OPENAI_API_KEY: "k" } };
    assert.deepEqual((await selectableModels(openai, good)).map((m) => m.id), ["gpt-6-luna"]);
    const later = Date.now() + PROVIDER_CATALOG_CACHE_TTL_MS + 1;
    assert.deepEqual((await selectableModels(openai, { ...failing, now: () => later })).map((m) => m.id), ["gpt-6-luna"]);
  });

  it("lists a keyless provider without an Authorization header, and has nothing to fall back to when it has no default model", async () => {
    const calls: Call[] = [];
    const ollama = config({ provider: providerConfig("ollama", "http://gpu-box:11434/v1") });
    const models = await selectableModels(ollama, { fetch: fakeFetch(calls, ["qwen3:32b", "nomic-embed-text"]), env: {} });
    assert.deepEqual(models.map((m) => m.id), ["qwen3:32b"]);
    assert.deepEqual(calls, [{ url: "http://gpu-box:11434/v1/models", authorization: undefined }]);
    assert.deepEqual(await modelsResponse(ollama, { fetch: fakeFetch(calls, ["qwen3:32b"]), env: {} }), {
      models: ["qwen3:32b"], catalog: [{ id: "qwen3:32b", created: 1_700_000_000 }], provider: { id: "ollama", name: "Ollama" }, defaultModel: "qwen3:32b",
    });

    resetProviderCatalogCache();
    const down = await modelsResponse(ollama, { fetch: fakeFetch(calls, [], true), env: {} });
    assert.deepEqual(down.models, [], "the API answers 503 model_catalog_unavailable for this");
    assert.equal(down.defaultModel, "");
  });
});
