import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { discoverAzureDeployments } from "../models/provider-catalog.js";
import { registerProviderModels } from "../models/registry.js";
import { runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { fetchEmbeddings } from "../memory/embeddings.js";
import { isProviderUsable, resolveActiveProvider } from "./resolve.js";

describe("Azure OpenAI", () => {
  const originalFetch = globalThis.fetch;
  const ENV = ["AZURE_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_RESOURCE_NAME", "AUTOPILOT_PROVIDER"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];

  before(() => {
    for (const k of ENV) delete process.env[k];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.endsWith("/embeddings")) return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] }), { status: 200 });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("builds the v1 endpoint from the resource name and needs both resource and key", () => {
    const p = resolveActiveProvider({ provider: "azure", providers: { azure: { apiKey: "k" } } }, { AZURE_RESOURCE_NAME: "contoso" });
    assert.strictEqual(p.baseUrl, "https://contoso.openai.azure.com/openai/v1");
    assert.ok(isProviderUsable(p));
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "azure", providers: { azure: { apiKey: "k" } } }, {})), false);
  });

  it("lists deployments as models, priced and described by their underlying model", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://models.dev")) throw new Error("offline");
      assert.strictEqual(url, "https://contoso.openai.azure.com/openai/deployments?api-version=2022-12-01");
      assert.strictEqual(new Headers(init?.headers).get("api-key"), "az-key");
      return new Response(JSON.stringify({ data: [
        { id: "prod-gpt", model: "gpt-6.1-sol", status: "succeeded" },
        { id: "embedder", model: "text-embedding-3-small", status: "succeeded" },
        { id: "custom-ft", model: "my-finetune", status: "succeeded" },
        { id: "creating", model: "gpt-6.1-sol", status: "running" },
      ] }), { status: 200 });
    }) as unknown as typeof fetch;
    const models = await discoverAzureDeployments("https://contoso.openai.azure.com/openai/v1", "az-key", fetchImpl);
    assert.deepStrictEqual(models.map((m) => m.id), ["prod-gpt", "custom-ft"]);
    assert.strictEqual(models[0]!.name, "prod-gpt (gpt-6.1-sol)");
    assert.strictEqual(models[0]!.pricing.inputPerMtok, 2, "priced as gpt-6.1-sol");
    assert.strictEqual(models[0]!.supports.reasoning, true);
  });

  it("sends deployment names over Responses with the api-key header, and uses it for embeddings", async () => {
    const auth = llmAuthFromConfig({ provider: "azure", providers: { azure: { apiKey: "az-key", baseUrl: "https://contoso.openai.azure.com/openai/v1" } } });
    seen.length = 0;
    for await (const _ of runKimi({ ...auth, model: "prod-gpt", messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    await fetchEmbeddings({ ...auth, model: "embedder", texts: ["x"] });
    assert.strictEqual(seen[0]!.url, "https://contoso.openai.azure.com/openai/v1/responses");
    assert.strictEqual(seen[0]!.body.model, "prod-gpt");
    assert.strictEqual(seen[1]!.url, "https://contoso.openai.azure.com/openai/v1/embeddings");
    for (const s of seen) {
      assert.strictEqual(s.headers.get("api-key"), "az-key");
      assert.strictEqual(s.headers.get("authorization"), null);
    }
  });
});
