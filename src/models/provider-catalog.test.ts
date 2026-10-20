import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverOllamaModels,
  discoverOpenAiModels,
  ensureProviderCatalog,
  loadModelsDevProvider,
  mapModelsDevModel,
} from "./provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "./models-dev-snapshot.js";
import { featuredModels, getModel, getModelOrInfer, isFreeModel, listModels, registerProviderModels } from "./registry.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("mapModelsDevModel", () => {
  it("maps limits, pricing, capabilities, reasoning levels and the reasoning echo field", () => {
    const m = mapModelsDevModel({
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      release_date: "2026-10-17",
      attachment: true,
      reasoning: true,
      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      tool_call: true,
      temperature: true,
      interleaved: { field: "reasoning_content" },
      modalities: { input: ["text", "image"] },
      limit: { context: 1_000_000, output: 393_216 },
      cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.2 },
    });
    assert.strictEqual(m.contextWindow, 1_000_000);
    assert.strictEqual(m.maxOutputTokens, 393_216);
    assert.deepStrictEqual(m.pricing, { inputPerMtok: 0.15, cachedInputPerMtok: 0.003, outputPerMtok: 0.6, cacheWritePerMtok: 0.2 });
    assert.deepStrictEqual(m.supports, { tools: true, reasoning: true, streaming: true, vision: true });
    assert.deepStrictEqual(m.reasoningEfforts, ["low", "high", "max"]);
    assert.strictEqual(m.reasoningEchoField, "reasoning_content");
  });

  it("records models that reject temperature", () => {
    assert.strictEqual(mapModelsDevModel({ id: "gpt", tool_call: true, temperature: false }).supports.temperature, false);
  });
});

describe("models.dev snapshot", () => {
  it("covers every preset that uses models.dev, including its default models", () => {
    for (const p of Object.values(PROVIDER_PRESETS)) {
      if (p.catalog !== "models.dev") continue;
      const snap = MODELS_DEV_SNAPSHOT[p.modelsDevId!];
      assert.ok(snap, `${p.id}: no snapshot for ${p.modelsDevId}`);
      for (const m of [p.defaultModel, p.plumbingModel]) {
        if (m) assert.ok(snap.models[m], `${p.id}: default ${m} missing from models.dev`);
      }
    }
  });
});

describe("loadModelsDevProvider", () => {
  let home: string;
  const saved = process.env.XDG_CONFIG_HOME;
  before(async () => {
    home = await mkdtemp(join(tmpdir(), "models-dev-test-"));
    process.env.XDG_CONFIG_HOME = home;
  });
  after(async () => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    await rm(home, { recursive: true, force: true });
  });

  it("falls back to the bundled snapshot when models.dev is unreachable", async () => {
    const p = await loadModelsDevProvider("deepseek", { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
    assert.ok(p?.models["deepseek-flash"]);
  });

  it("keeps only providers with presets and caches them", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json({ deepseek: { id: "deepseek", models: { x: { id: "x", tool_call: true } } }, unrelated: { id: "unrelated", models: {} } });
    }) as typeof fetch;
    assert.ok((await loadModelsDevProvider("deepseek", { fetchImpl, ttlMs: 0 }))?.models.x);
    assert.ok((await loadModelsDevProvider("deepseek", { fetchImpl }))?.models.x, "served from cache");
    assert.strictEqual(calls, 1);
  });
});

describe("local discovery", () => {
  it("lists installed Ollama chat models with their context and capabilities", async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url === "http://127.0.0.1:11434/api/tags") {
        return json({ models: [{ name: "llama3.1:8b" }, { name: "nomic-embed-text" }, { name: "qwen3:32b" }] });
      }
      const model = JSON.parse(String(init?.body)).model as string;
      if (model === "nomic-embed-text") return json({ capabilities: ["embedding"] });
      if (model === "llama3.1:8b") return json({ capabilities: ["completion", "tools"], model_info: { "llama.context_length": 131072 } });
      return json({ capabilities: ["completion", "thinking"], model_info: { "qwen3.context_length": 40960 } });
    }) as unknown as typeof fetch;
    const models = await discoverOllamaModels("http://127.0.0.1:11434/v1", fetchImpl);
    assert.deepStrictEqual(models.map((m) => m.id), ["llama3.1:8b", "qwen3:32b"]);
    assert.strictEqual(models[0]!.contextWindow, 131072);
    assert.strictEqual(models[0]!.supports.tools, true);
    assert.strictEqual(models[1]!.supports.tools, false);
    assert.strictEqual(models[1]!.supports.reasoning, true);
  });

  it("lists models from an OpenAI-compatible /models, skipping embedders", async () => {
    let auth: string | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      assert.strictEqual(url, "http://127.0.0.1:1234/v1/models");
      return json({ data: [{ id: "qwen2.5-coder-32b" }, { id: "text-embedding-nomic" }] });
    }) as unknown as typeof fetch;
    const models = await discoverOpenAiModels("http://127.0.0.1:1234/v1/", "k", fetchImpl);
    assert.deepStrictEqual(models.map((m) => m.id), ["qwen2.5-coder-32b"]);
    assert.strictEqual(auth, "Bearer k");
  });
});

describe("registry with a provider catalog", () => {
  beforeEach(() => registerProviderModels("deepseek", []));
  after(() => registerProviderModels("openrouter", []));

  it("lists only the active provider's models and looks them up first", async () => {
    await ensureProviderCatalog("deepseek", {}, (async () => { throw new Error("offline"); }) as typeof fetch);
    const ids = listModels().map((m) => m.id);
    assert.ok(ids.includes("deepseek-v4-pro"));
    assert.ok(!ids.some((id) => id.includes("/")), "no OpenRouter ids in another provider's list");
    assert.strictEqual(getModel("deepseek-flash")?.contextWindow, 1_000_000);
    assert.strictEqual(getModelOrInfer("deepseek-flash").supports.reasoning, true, "reasoning effort isn't dropped");
    assert.ok(featuredModels().length > 0);
    assert.strictEqual(isFreeModel(getModelOrInfer("deepseek-flash")), false);
  });

  it("unknown models are not capped at a few thousand output tokens", () => {
    assert.strictEqual(getModelOrInfer("someone/unknown-model").maxOutputTokens, 16_384);
  });
});
