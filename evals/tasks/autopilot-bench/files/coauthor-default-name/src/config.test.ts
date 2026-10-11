import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateModelId } from "./agent/client.js";
import { getModelOrInfer } from "./models/registry.js";
import { loadConfig, hasLegacyCloudflareConfig, DEFAULT_MODEL } from "./config.js";

describe("validateModelId", () => {
  it("accepts OpenRouter model ids", () => {
    assert.doesNotThrow(() => validateModelId("moonshotai/kimi-k2.6"));
    assert.doesNotThrow(() => validateModelId("anthropic/claude-sonnet-4-6"));
    assert.doesNotThrow(() => validateModelId("deepseek/deepseek-r1:free"));
    assert.doesNotThrow(() => validateModelId("~moonshotai/kimi-latest"));
    assert.doesNotThrow(() => validateModelId("openrouter/auto"));
  });

  it("rejects Cloudflare-era and malformed ids", () => {
    assert.throws(() => validateModelId("@cf/moonshotai/kimi-k2.6"));
    assert.throws(() => validateModelId("bogus"));
    assert.throws(() => validateModelId(""));
    assert.throws(() => validateModelId("anthropic//"));
    assert.throws(() => validateModelId("has spaces/in-it"));
    assert.throws(() => validateModelId("../etc/passwd"));
  });
});

describe("model registry (via config)", () => {
  it("returns the seeded entry for the default model", () => {
    const m = getModelOrInfer(DEFAULT_MODEL);
    assert.equal(m.id, "moonshotai/kimi-k2.6");
    assert.equal(m.contextWindow, 262_144);
  });

  it("infers a conservative zero-priced entry for unknown models", () => {
    const m = getModelOrInfer("somevendor/future-model");
    assert.equal(m.pricing.inputPerMtok, 0); // zero rather than wrong
    assert.equal(m.contextWindow, 128_000);
  });
});

describe("loadConfig", () => {
  // loadConfig reads env + the config file; isolate both so a developer's
  // real ~/.config/kimiflare/config.json can't leak into assertions.
  const ENV_KEYS = [
    "OPENROUTER_API_KEY",
    "KIMIFLARE_OPENROUTER_KEY",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
    "KIMI_MODEL",
    "KIMIFLARE_BASE_URL",
    "KIMIFLARE_API_KEY",
    "KIMIFLARE_WORKER_BACKEND",
    "KIMIFLARE_SUBAGENT_POLICY",
    "XDG_CONFIG_HOME",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let configHome: string;
  const configFile = () => join(configHome, "kimiflare", "config.json");

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    configHome = await mkdtemp(join(tmpdir(), "kimiflare-config-test-"));
  });

  beforeEach(async () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.XDG_CONFIG_HOME = configHome;
    await rm(configFile(), { force: true });
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(configHome, { recursive: true, force: true });
  });

  async function writeConfigFile(contents: Record<string, unknown>): Promise<void> {
    await mkdir(join(configHome, "kimiflare"), { recursive: true });
    await writeFile(configFile(), JSON.stringify(contents), "utf8");
  }

  async function readConfigFile(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(configFile(), "utf8")) as Record<string, unknown>;
  }

  it("returns null with no key and no custom endpoint", async () => {
    assert.strictEqual(await loadConfig(), null);
  });

  it("returns null when the file only has Cloudflare credentials (upgrading user → onboarding)", async () => {
    await writeConfigFile({ accountId: "acct", apiToken: "cf-token", model: "@cf/moonshotai/kimi-k2.6" });
    assert.strictEqual(await loadConfig(), null);
  });

  it("resolves from OPENROUTER_API_KEY with the default model", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg.openrouterApiKey, "sk-or-env");
    assert.strictEqual(cfg.model, DEFAULT_MODEL);
    assert.strictEqual(cfg.coauthorName, "autopilot");
    assert.strictEqual(cfg.coauthorEmail, "kimiflare@proton.me");
  });

  it("keeps remote workers as the compatibility default and supports explicit Hotcell opt-in", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.strictEqual((await loadConfig())?.workerBackend, "remote");
    process.env.KIMIFLARE_WORKER_BACKEND = "hotcell";
    assert.strictEqual((await loadConfig())?.workerBackend, "hotcell");
    delete process.env.KIMIFLARE_WORKER_BACKEND;
    await writeConfigFile({ openrouterApiKey: "sk-or-file", workerBackend: "hotcell" });
    assert.strictEqual((await loadConfig())?.workerBackend, "hotcell");
    process.env.KIMIFLARE_WORKER_BACKEND = "remote";
    assert.strictEqual((await loadConfig())?.workerBackend, "remote");
  });

  it("defaults subagent routing to suggest and supports persisted and env policy choices", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.equal((await loadConfig())?.subagentPolicy, "suggest");
    await writeConfigFile({ openrouterApiKey: "sk-or-file", subagentPolicy: "off" });
    assert.equal((await loadConfig())?.subagentPolicy, "off");
    process.env.KIMIFLARE_SUBAGENT_POLICY = "auto";
    assert.equal((await loadConfig())?.subagentPolicy, "auto");
    process.env.KIMIFLARE_SUBAGENT_POLICY = "invalid";
    assert.equal((await loadConfig())?.subagentPolicy, "off");
  });

  it("resolves from KIMIFLARE_OPENROUTER_KEY", async () => {
    process.env.KIMIFLARE_OPENROUTER_KEY = "sk-or-alt";
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-alt");
  });

  it("env key wins over the persisted key", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file" });
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.strictEqual((await loadConfig())?.openrouterApiKey, "sk-or-env");
  });

  it("resolves a persisted openrouterApiKey and model", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file", model: "anthropic/claude-sonnet-4-6" });
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-file");
    assert.strictEqual(cfg?.model, "anthropic/claude-sonnet-4-6");
  });

  it("KIMI_MODEL overrides the persisted model", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file", model: "anthropic/claude-sonnet-4-6" });
    process.env.KIMI_MODEL = "moonshotai/kimi-k3";
    assert.strictEqual((await loadConfig())?.model, "moonshotai/kimi-k3");
  });

  it("falls back to a key stored under legacy providerKeys.openrouter", async () => {
    await writeConfigFile({ providerKeys: { openrouter: "sk-or-legacy" } });
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-legacy");
    // …and the rewrite moves it to the new field.
    const onDisk = await readConfigFile();
    assert.strictEqual(onDisk.openrouterApiKey, "sk-or-legacy");
    assert.strictEqual(onDisk.providerKeys, undefined);
  });

  it("migrates a Cloudflare-era config: model ids rewritten, retired fields dropped, other settings kept", async () => {
    await writeConfigFile({
      openrouterApiKey: "sk-or-file",
      accountId: "acct",
      apiToken: "cf-token",
      cloudflareOAuth: { expiresAt: 1, scopes: [], clientId: "x" },
      aiGatewayId: "gw",
      aiGatewayMetadata: { team: "cli" },
      unifiedBilling: true,
      providerKeyAliases: { anthropic: "alias" },
      secretsStoreId: "store",
      cloudMode: false,
      model: "@cf/moonshotai/kimi-k2.6",
      plumbingModel: "@cf/moonshotai/kimi-k2.5",
      memoryEmbeddingModel: "@cf/baai/bge-base-en-v1.5",
      theme: "everforest-light",
      mcpServers: { fs: { type: "local", command: ["fs-mcp"] } },
    });
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(cfg.plumbingModel, "moonshotai/kimi-k2.5");
    assert.strictEqual(cfg.memoryEmbeddingModel, "baai/bge-base-en-v1.5");
    assert.strictEqual(cfg.theme, "everforest-light");
    // Commute still deploys with these.
    assert.strictEqual(cfg.accountId, "acct");
    assert.strictEqual(cfg.apiToken, "cf-token");

    const onDisk = await readConfigFile();
    for (const k of [
      "cloudflareOAuth",
      "aiGatewayId",
      "aiGatewayMetadata",
      "unifiedBilling",
      "providerKeyAliases",
      "secretsStoreId",
      "cloudMode",
    ]) {
      assert.strictEqual(onDisk[k], undefined, `${k} should be removed from disk`);
    }
    assert.strictEqual(onDisk.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(onDisk.plumbingModel, "moonshotai/kimi-k2.5");
    assert.strictEqual(onDisk.theme, "everforest-light");
    assert.deepStrictEqual(onDisk.mcpServers, { fs: { type: "local", command: ["fs-mcp"] } });
    assert.strictEqual(onDisk.accountId, "acct");
    assert.strictEqual(onDisk.apiToken, "cf-token");
    assert.strictEqual(onDisk.openrouterApiKey, "sk-or-file");
  });

  it("never writes an env-provided key into the file during migration", async () => {
    await writeConfigFile({ aiGatewayId: "gw", model: "@cf/moonshotai/kimi-k2.6", theme: "t" });
    process.env.OPENROUTER_API_KEY = "sk-or-env-secret";
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-env-secret");
    const onDisk = await readConfigFile();
    assert.strictEqual(onDisk.openrouterApiKey, undefined);
    assert.strictEqual(onDisk.aiGatewayId, undefined);
    assert.strictEqual(onDisk.model, "moonshotai/kimi-k2.6");
  });

  it("leaves an already-clean file untouched", async () => {
    const clean = { openrouterApiKey: "sk-or-file", model: "moonshotai/kimi-k3", theme: "t" };
    await writeConfigFile(clean);
    await loadConfig();
    assert.deepStrictEqual(await readConfigFile(), clean);
  });

  it("keeps settings-only fields (lspEnabled, remoteWorkerUrl, githubRepo, openrouterProvider)", async () => {
    await writeConfigFile({
      openrouterApiKey: "sk-or-file",
      lspEnabled: true,
      remoteWorkerUrl: "https://commute.example.com",
      githubRepo: "owner/repo",
      openrouterProvider: { ignore: ["SomeProvider"] },
    });
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg.lspEnabled, true);
    assert.strictEqual(cfg.remoteWorkerUrl, "https://commute.example.com");
    assert.strictEqual(cfg.githubRepo, "owner/repo");
    assert.deepStrictEqual(cfg.openrouterProvider, { ignore: ["SomeProvider"] });
  });

  it("omits undefined fields from the resolved config", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.ok(!("baseUrl" in cfg));
    assert.ok(!("accountId" in cfg));
  });

  describe("custom OpenAI-compatible endpoint", () => {
    it("resolves with ONLY KIMIFLARE_BASE_URL + KIMIFLARE_API_KEY (no OpenRouter key)", async () => {
      process.env.KIMIFLARE_BASE_URL = "https://aig.example.com/v1";
      process.env.KIMIFLARE_API_KEY = "broker-key";
      const cfg = await loadConfig();
      assert.ok(cfg, "expected a usable config without an OpenRouter key");
      assert.strictEqual(cfg.baseUrl, "https://aig.example.com/v1");
      assert.strictEqual(cfg.apiKey, "broker-key");
      assert.strictEqual(cfg.openrouterApiKey, undefined);
    });

    it("resolves a persisted baseUrl/apiKey", async () => {
      await writeConfigFile({ baseUrl: "https://cfg.example.com/v1", apiKey: "cfg-key", model: "my-alias" });
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.strictEqual(cfg.baseUrl, "https://cfg.example.com/v1");
      assert.strictEqual(cfg.apiKey, "cfg-key");
      assert.strictEqual(cfg.model, "my-alias");
    });

    it("env vars win over persisted baseUrl/apiKey", async () => {
      await writeConfigFile({ baseUrl: "https://cfg.example.com/v1", apiKey: "cfg-key" });
      process.env.KIMIFLARE_BASE_URL = "https://env.example.com/v1";
      process.env.KIMIFLARE_API_KEY = "env-key";
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.baseUrl, "https://env.example.com/v1");
      assert.strictEqual(cfg?.apiKey, "env-key");
    });

    it("carries Cloudflare env credentials alongside (Commute only)", async () => {
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
      process.env.CLOUDFLARE_API_TOKEN = "cf-token";
      process.env.KIMIFLARE_BASE_URL = "https://aig.example.com/v1";
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.accountId, "acct");
      assert.strictEqual(cfg?.apiToken, "cf-token");
    });
  });

  describe("hasLegacyCloudflareConfig", () => {
    it("is false with no file", async () => {
      assert.strictEqual(await hasLegacyCloudflareConfig(), false);
    });

    it("is true for a Cloudflare-era file without an OpenRouter key", async () => {
      await writeConfigFile({ accountId: "acct", apiToken: "cf-token" });
      assert.strictEqual(await hasLegacyCloudflareConfig(), true);
      await writeConfigFile({ aiGatewayId: "gw" });
      assert.strictEqual(await hasLegacyCloudflareConfig(), true);
      await writeConfigFile({ cloudflareOAuth: { expiresAt: 1 } });
      assert.strictEqual(await hasLegacyCloudflareConfig(), true);
    });

    it("is false once an OpenRouter key is saved, or for an unrelated file", async () => {
      await writeConfigFile({ apiToken: "cf-token", openrouterApiKey: "sk-or-x" });
      assert.strictEqual(await hasLegacyCloudflareConfig(), false);
      await writeConfigFile({ theme: "t" });
      assert.strictEqual(await hasLegacyCloudflareConfig(), false);
    });
  });
});
