import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { classifyHttpHost, detectEnvProviders, isProviderUsable, providerDestinationLabel, resetPrivateHttpWarnings, resolveActiveProvider, resolveProviderId, setPrivateHttpWarningHandler } from "./resolve.js";
import { PROVIDER_IDS, PROVIDER_PRESETS } from "./presets.js";
import { logger } from "../util/logger.js";

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

  it("honours a loopback base URL override (e.g. Ollama on this machine)", () => {
    const p = resolveActiveProvider({ provider: "ollama", providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } }, {});
    assert.strictEqual(p.baseUrl, "http://localhost:11434/v1");
    assert.ok(isProviderUsable(p), "Ollama needs no key");
  });

  it("refuses a cleartext base URL to a LAN host (the documented trade-off)", () => {
    assert.throws(
      () => resolveActiveProvider({ provider: "ollama", providers: { ollama: { baseUrl: "http://gpu-box:11434/v1" } } }, {}),
      /base URL must use https \(got http:\/\/gpu-box:11434\)/,
    );
  });

  it("routes a preset through AUTOPILOT_BASE_URL when AUTOPILOT_PROVIDER names it (a gateway in front of the provider)", () => {
    const env = { AUTOPILOT_PROVIDER: "deepseek", AUTOPILOT_BASE_URL: "https://gw:4752/deepseek", DEEPSEEK_API_KEY: "egress-token" };
    const p = resolveActiveProvider({ provider: "openai", providers: { deepseek: { baseUrl: "https://api.deepseek.com" } } }, env);
    assert.strictEqual(p.id, "deepseek");
    assert.strictEqual(p.baseUrl, "https://gw:4752/deepseek", "the env URL wins over config and the preset");
    assert.strictEqual(p.apiKey, "egress-token");
    assert.ok(isProviderUsable(p));
    // The legacy spelling works too; a keyless preset needs no key behind the gateway.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", KIMIFLARE_BASE_URL: "https://gw:4752/ollama/v1" }).baseUrl, "https://gw:4752/ollama/v1");
    assert.ok(isProviderUsable(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", AUTOPILOT_BASE_URL: "https://gw:4752/ollama/v1" })));
    // Without AUTOPILOT_PROVIDER the URL still means a custom endpoint, and without the URL the preset's own base holds.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://gw:4752/deepseek" }).id, "custom");
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "deepseek" }).baseUrl, "https://api.deepseek.com");
  });

  it("is unusable when a provider that needs a key has none", () => {
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "deepseek" }, {})), false);
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "custom" }, {})), false);
  });
});

describe("base URL scheme guard (T3-F2 re-scope)", () => {
  it("accepts https and loopback http", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://api.example.com/v1", AUTOPILOT_API_KEY: "k" }).baseUrl, "https://api.example.com/v1");
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
      assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: "k" }).baseUrl, url);
    }
  });

  it("refuses http to a non-loopback host and names it", () => {
    assert.throws(
      () => resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://example.com/v1", AUTOPILOT_API_KEY: "k" }),
      /base URL must use https \(got http:\/\/example\.com\)/,
    );
  });

  it("does not allowlist hosts: any https host is accepted", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://any-host.example/v1", AUTOPILOT_API_KEY: "k" }).baseUrl, "https://any-host.example/v1");
  });

  it("does not treat a 127.* DNS name as loopback (T1-01)", () => {
    for (const url of ["http://127.0.0.1.evil.com/v1", "http://127.1.evil.com/v1"]) {
      assert.throws(
        () => resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: "k" }),
        /base URL must use https/,
        url,
      );
    }
  });

  it("labels the destination host, or <preset> when the module owns the URL", () => {
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://api.example.com/v1", AUTOPILOT_API_KEY: "k" })), "api.example.com");
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://localhost:11434/v1", AUTOPILOT_API_KEY: "k" })), "localhost");
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_OPENROUTER_KEY: "sk-or" })), "<preset>");
  });
});

describe("base URL scheme guard (v2.0.0: private ranges and key-travel warning)", () => {
  const resolve = (url: string, key = "k") => resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: key });

  it("classifies hosts without treating lookalike DNS names as addresses", () => {
    assert.strictEqual(classifyHttpHost("127.0.0.1"), "loopback");
    assert.strictEqual(classifyHttpHost("192.168.1.5"), "private");
    assert.strictEqual(classifyHttpHost("ollama-box.local"), "private");
    assert.strictEqual(classifyHttpHost("127.0.0.1.evil.com"), "public");
    assert.strictEqual(classifyHttpHost("notlocal.example"), "public");
    assert.strictEqual(classifyHttpHost("example.com"), "public");
  });

  it("accepts http to each private range", () => {
    for (const url of ["http://192.168.1.5/v1", "http://10.0.0.7/v1", "http://172.16.0.9/v1", "http://100.64.1.2/v1"]) {
      assert.strictEqual(resolve(url).baseUrl, url, url);
    }
  });

  it("accepts exactly within the CIDR ranges and refuses the edges", () => {
    const accepted = ["http://172.16.255.255/v1", "http://172.31.255.255/v1", "http://100.64.0.0/v1", "http://100.127.255.255/v1", "http://192.168.255.255/v1", "http://10.255.255.255/v1"];
    for (const url of accepted) assert.strictEqual(resolve(url).baseUrl, url, url);
    const refused = ["http://172.15.0.1/v1", "http://172.32.0.1/v1", "http://100.128.0.1/v1", "http://192.169.0.1/v1", "http://11.0.0.1/v1"];
    for (const url of refused) assert.throws(() => resolve(url), /base URL must use https/, url);
  });

  it("accepts .local names, case-insensitively", () => {
    for (const url of ["http://ollama-box.local:11434/v1", "http://NAS.LOCAL/v1"]) {
      assert.strictEqual(resolve(url).baseUrl, url, url);
    }
  });

  it("still refuses a dotless bare hostname (the ruling names .local only)", () => {
    assert.throws(() => resolve("http://gpu-box:11434/v1"), /base URL must use https \(got http:\/\/gpu-box:11434\)/);
  });

  it("warns once per host on the user-visible channel when a key travels, and stays silent without one", () => {
    resetPrivateHttpWarnings();
    const warnings: string[] = [];
    setPrivateHttpWarningHandler((m) => warnings.push(m));
    const spy = mock.method(logger, "warn");
    try {
      resolve("http://192.168.1.5/v1");
      resolve("http://192.168.1.5/v1");
      assert.strictEqual(warnings.length, 1, "warned once for the host");
      assert.match(warnings[0]!, /192\.168\.1\.5/);
      assert.strictEqual(spy.mock.calls.filter((c) => c.arguments[0] === "provider:http_key_travel").length, 1, "the logger record is secondary");
      resetPrivateHttpWarnings();
      warnings.length = 0;
      spy.mock.resetCalls();
      resolve("http://10.0.0.7/v1", "");
      assert.strictEqual(warnings.length, 0, "keyless stays silent");
      assert.strictEqual(spy.mock.calls.filter((c) => c.arguments[0] === "provider:http_key_travel").length, 0);
    } finally {
      spy.mock.restore();
      setPrivateHttpWarningHandler(undefined);
    }
  });

  it("labels a private host", () => {
    assert.strictEqual(providerDestinationLabel(resolve("http://192.168.1.5/v1")), "192.168.1.5");
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
