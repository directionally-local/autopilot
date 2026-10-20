import { describe, it } from "node:test";
import assert from "node:assert";
import { detectEnvProviders, isProviderUsable, resolveActiveProvider, resolveProviderId } from "./resolve.js";
import { PROVIDER_IDS, PROVIDER_PRESETS } from "./presets.js";

describe("resolveProviderId", () => {
  it("keeps the pre-provider precedence for old configs: custom, then OpenRouter, then Requesty", () => {
    assert.strictEqual(resolveProviderId({ baseUrl: "https://gw/v1", openrouterApiKey: "k" }, {}), "custom");
    assert.strictEqual(resolveProviderId({ openrouterApiKey: "k", requestyApiKey: "r" }, {}), "openrouter");
    assert.strictEqual(resolveProviderId({ requestyApiKey: "r" }, {}), "requesty");
    assert.strictEqual(resolveProviderId({}, {}), "openrouter");
  });

  it("lets an explicit provider win over leftover credentials", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai", openrouterApiKey: "k", baseUrl: "https://gw/v1" }, {}), "openai");
  });

  it("lets a host app's KIMIFLARE_BASE_URL win over the config file, and AUTOPILOT_PROVIDER over both", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { KIMIFLARE_BASE_URL: "https://host/v1" }), "custom");
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { KIMIFLARE_BASE_URL: "https://host/v1", AUTOPILOT_PROVIDER: "deepseek" }), "deepseek");
  });

  it("ignores unknown provider names", () => {
    assert.strictEqual(resolveProviderId({ provider: "nope" as never, openrouterApiKey: "k" }, { AUTOPILOT_PROVIDER: "also-nope" }), "openrouter");
  });
});

describe("resolveActiveProvider", () => {
  it("reads a preset's key from its env var before the config file", () => {
    const p = resolveActiveProvider({ provider: "openai", providers: { openai: { apiKey: "file" } } }, { OPENAI_API_KEY: "env" });
    assert.strictEqual(p.apiKey, "env");
    assert.strictEqual(p.baseUrl, "https://api.openai.com/v1");
  });

  it("honours a base URL override (e.g. Ollama on another host)", () => {
    const p = resolveActiveProvider({ provider: "ollama", providers: { ollama: { baseUrl: "http://gpu-box:11434/v1" } } }, {});
    assert.strictEqual(p.baseUrl, "http://gpu-box:11434/v1");
    assert.ok(isProviderUsable(p), "Ollama needs no key");
  });

  it("is unusable when a provider that needs a key has none", () => {
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "deepseek" }, {})), false);
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "custom" }, {})), false);
  });
});

describe("presets", () => {
  it("are complete and self-consistent", () => {
    for (const id of PROVIDER_IDS) {
      const p = PROVIDER_PRESETS[id];
      assert.strictEqual(p.id, id);
      assert.ok(p.name);
      assert.ok(p.apiKeyEnv.length > 0, `${id} needs at least one key env var`);
      // Vertex and Bedrock build their URLs from project/location and region.
      if (!["openrouter", "requesty", "custom", "vertex", "bedrock"].includes(id)) assert.match(p.baseUrl ?? "", /^https?:\/\//, `${id} base URL`);
      // OpenRouter-only features stay off everywhere but OpenRouter.
      if (id !== "openrouter") assert.deepStrictEqual(p.capabilities, { costConfirmation: false, decisionsApi: false, hotcellGateway: false });
      // Defaults never borrow another provider's model ids.
      for (const m of [p.defaultModel, p.plumbingModel]) {
        if (m && id !== "openrouter") assert.ok(!m.startsWith("moonshotai/"), `${id} default ${m} looks like an OpenRouter id`);
      }
    }
  });
});

describe("detectEnvProviders", () => {
  it("lists providers whose key is in the environment", () => {
    assert.deepStrictEqual(detectEnvProviders({ OPENAI_API_KEY: "x", ZHIPU_API_KEY: "y" }), ["openai", "zai"]);
  });
});
