import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { activeOpenRouterKey, hasLlmAuth, llmAuthFromConfig } from "./llm-auth.js";

describe("llmAuthFromConfig", () => {
  // Provider keys in the developer's environment would otherwise win over the configs under test.
  const ENV = ["KIMIFLARE_BASE_URL", "KIMIFLARE_API_KEY", "AUTOPILOT_PROVIDER", "OPENROUTER_API_KEY", "KIMIFLARE_OPENROUTER_KEY", "REQUESTY_API_KEY", "DEEPSEEK_API_KEY", "OLLAMA_API_KEY"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("carries just the OpenRouter key for a normal config", () => {
    assert.deepStrictEqual(llmAuthFromConfig({ openrouterApiKey: "sk-or-a" }), { providerId: "openrouter", openrouterApiKey: "sk-or-a" });
  });

  it("resolves a custom endpoint from the config file, not only the env", () => {
    const auth = llmAuthFromConfig({ baseUrl: "https://broker.example/v1", apiKey: "host" });
    assert.deepStrictEqual(auth.customEndpoint, { baseUrl: "https://broker.example/v1", apiKey: "host" });
  });

  it("lets KIMIFLARE_BASE_URL win over the config file", () => {
    process.env.KIMIFLARE_BASE_URL = "https://env.example/v1";
    assert.strictEqual(llmAuthFromConfig({ baseUrl: "https://file.example/v1" }).customEndpoint?.baseUrl, "https://env.example/v1");
  });

  it("passes provider routing preferences through", () => {
    assert.deepStrictEqual(llmAuthFromConfig({ openrouterApiKey: "k", openrouterProvider: { ignore: ["X"] } }).openrouterRouting, { ignore: ["X"] });
  });

  it("defaults to OpenRouter with no credentials for a null config", () => {
    assert.deepStrictEqual(llmAuthFromConfig(null), { providerId: "openrouter" });
  });

  it("hands out only the active provider's credentials", () => {
    const auth = llmAuthFromConfig({
      provider: "deepseek",
      openrouterApiKey: "sk-or-must-not-leak",
      requestyApiKey: "rq-must-not-leak",
      providers: { deepseek: { apiKey: "sk-ds" } },
    });
    assert.deepStrictEqual(auth, {
      providerId: "deepseek",
      customEndpoint: { baseUrl: "https://api.deepseek.com", apiKey: "sk-ds", providerId: "deepseek" },
    });
    assert.strictEqual(activeOpenRouterKey({ provider: "deepseek", openrouterApiKey: "sk-or-x" }), undefined);
    assert.strictEqual(activeOpenRouterKey({ openrouterApiKey: "sk-or-x" }), "sk-or-x");
  });

  it("drops OpenRouter routing preferences for other providers", () => {
    const auth = llmAuthFromConfig({ provider: "ollama", openrouterProvider: { ignore: ["X"] } });
    assert.strictEqual(auth.openrouterRouting, undefined);
    assert.deepStrictEqual(auth.customEndpoint, { baseUrl: "http://127.0.0.1:11434/v1", providerId: "ollama" });
    assert.strictEqual(hasLlmAuth(auth), true, "local runtimes need no key");
  });
});

describe("hasLlmAuth", () => {
  it("needs a key or a custom endpoint", () => {
    assert.strictEqual(hasLlmAuth({}), false);
    assert.strictEqual(hasLlmAuth({ openrouterApiKey: "k" }), true);
    assert.strictEqual(hasLlmAuth({ customEndpoint: { baseUrl: "http://x" } }), true);
  });
});
