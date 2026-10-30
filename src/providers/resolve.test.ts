import { describe, it } from "node:test";
import assert from "node:assert";
import { detectEnvProviders, isProviderUsable, resolveActiveProvider, resolveProviderId } from "./resolve.js";
import { PROVIDER_IDS, PROVIDER_PRESETS } from "./presets.js";

describe("AUTOPILOT_* env names (#911)", () => {
  it("AUTOPILOT_BASE_URL + AUTOPILOT_API_KEY select the custom endpoint, winning over the KIMIFLARE_* names", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { AUTOPILOT_BASE_URL: "https://new/v1" }), "custom");
    const p = resolveActiveProvider(null, {
      AUTOPILOT_BASE_URL: "https://new/v1",
      KIMIFLARE_BASE_URL: "https://old/v1",
      AUTOPILOT_API_KEY: "new-key",
      KIMIFLARE_API_KEY: "old-key",
    });
    assert.strictEqual(p.id, "custom");
    assert.strictEqual(p.baseUrl, "https://new/v1");
    assert.strictEqual(p.apiKey, "new-key");
  });

  it("still honours the KIMIFLARE_* names alone", () => {
    const p = resolveActiveProvider(null, { KIMIFLARE_BASE_URL: "https://old/v1", KIMIFLARE_API_KEY: "old-key" });
    assert.strictEqual(p.baseUrl, "https://old/v1");
    assert.strictEqual(p.apiKey, "old-key");
  });

  it("AUTOPILOT_OPENROUTER_KEY is an OpenRouter key", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_OPENROUTER_KEY: "sk-or-new" }).apiKey, "sk-or-new");
  });
});

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

  it("routes a preset through AUTOPILOT_BASE_URL when AUTOPILOT_PROVIDER names it (a gateway in front of the provider)", () => {
    const env = { AUTOPILOT_PROVIDER: "deepseek", AUTOPILOT_BASE_URL: "http://gw:4752/deepseek", DEEPSEEK_API_KEY: "egress-token" };
    const p = resolveActiveProvider({ provider: "openai", providers: { deepseek: { baseUrl: "https://api.deepseek.com" } } }, env);
    assert.strictEqual(p.id, "deepseek");
    assert.strictEqual(p.baseUrl, "http://gw:4752/deepseek", "the env URL wins over config and the preset");
    assert.strictEqual(p.apiKey, "egress-token");
    assert.ok(isProviderUsable(p));
    // The legacy spelling works too; a keyless preset needs no key behind the gateway.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", KIMIFLARE_BASE_URL: "http://gw:4752/ollama/v1" }).baseUrl, "http://gw:4752/ollama/v1");
    assert.ok(isProviderUsable(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", AUTOPILOT_BASE_URL: "http://gw:4752/ollama/v1" })));
    // Without AUTOPILOT_PROVIDER the URL still means a custom endpoint, and without the URL the preset's own base holds.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://gw:4752/deepseek" }).id, "custom");
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "deepseek" }).baseUrl, "https://api.deepseek.com");
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
