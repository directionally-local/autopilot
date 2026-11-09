import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateModelId } from "./agent/client.js";
import { DEFAULT_AUTO_COMPACT_CAP_TOKENS } from "./agent/context-budget.js";
import { getModelOrInfer } from "./models/registry.js";
import {
  loadConfig,
  hasLegacyCloudflareConfig,
  tuiMemoryEnabled,
  DEFAULT_MODEL,
  DEFAULT_PLUMBING_MODEL,
  REQUESTY_DEFAULT_MODEL,
  REQUESTY_PLUMBING_MODEL,
  plumbingModelOf,
  saveConfig,
  patchPersistedConfig,
  configPath,
  takeFreeDefaultLunaNotice,
  DL_FREE_OLD_DEFAULT_MODEL,
  FREE_DEFAULT_LUNA_NOTICE,
} from "./config.js";

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
    "KIMIFLARE_SUBAGENT_POLICY",
    "REQUESTY_API_KEY",
    "KIMIFLARE_TRACE",
    "KIMIFLARE_TRACE_DIR",
    "XDG_CONFIG_HOME",
    "AUTOPILOT_PROVIDER",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "KIMIFLARE_PLUMBING_MODEL",
    "KIMIFLARE_SHELL",
    "KIMIFLARE_WORKER_BUDGET_USD",
    "KIMIFLARE_WORKER_BUDGET_MAX_USD",
    // #911: the AUTOPILOT_* spellings of the same settings
    "AUTOPILOT_OPENROUTER_KEY",
    "AUTOPILOT_BASE_URL",
    "AUTOPILOT_API_KEY",
    "AUTOPILOT_SUBAGENT_POLICY",
    "AUTOPILOT_TRACE",
    "AUTOPILOT_TRACE_DIR",
    "AUTOPILOT_PLUMBING_MODEL",
    "AUTOPILOT_SHELL",
    "KIMIFLARE_MEMORY_ENABLED",
    "AUTOPILOT_MEMORY_ENABLED",
    // #1073: memory extraction policy
    "AUTOPILOT_MEMORY_EXTRACTION",
    "KIMIFLARE_MEMORY_EXTRACTION",
    "AUTOPILOT_AUTO_COMPACT_CAP_TOKENS",
    "KIMIFLARE_AUTO_COMPACT_CAP_TOKENS",
    "AUTOPILOT_DL_FREE_TOKEN",
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
    // Notices queued by an earlier test (state.json) must not leak into the next.
    await takeFreeDefaultLunaNotice();
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

  it("leaves memoryEnabled unset by default; the TUI turns memory on (#1077)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.memoryEnabled, undefined, "unconfigured memory stays unset, not false");
    assert.strictEqual(tuiMemoryEnabled(cfg), true, "the TUI defaults memory on");
    assert.strictEqual(tuiMemoryEnabled(null), true);
    assert.strictEqual(tuiMemoryEnabled({ memoryEnabled: false }), false, "/memory off stays off");
    assert.strictEqual(tuiMemoryEnabled({ memoryEnabled: true }), true);
  });

  it("keeps SDK/print/remote opt-in: an explicit false or env wins (#1077)", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await writeConfigFile({ memoryEnabled: false });
    assert.strictEqual((await loadConfig())?.memoryEnabled, false);

    await writeConfigFile({});
    process.env.AUTOPILOT_MEMORY_ENABLED = "0";
    assert.strictEqual((await loadConfig())?.memoryEnabled, false, "env off wins over the default");

    delete process.env.AUTOPILOT_MEMORY_ENABLED;
    process.env.AUTOPILOT_MEMORY_ENABLED = "1";
    assert.strictEqual((await loadConfig())?.memoryEnabled, true, "env on is an explicit opt-in");
  });

  it("caps compaction thresholds at 150k by default; env/file override, 0 opts out", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    assert.strictEqual((await loadConfig())?.autoCompactCapTokens, DEFAULT_AUTO_COMPACT_CAP_TOKENS);

    await writeConfigFile({ autoCompactCapTokens: 250_000 });
    assert.strictEqual((await loadConfig())?.autoCompactCapTokens, 250_000, "persisted value wins");

    process.env.AUTOPILOT_AUTO_COMPACT_CAP_TOKENS = "90000";
    assert.strictEqual((await loadConfig())?.autoCompactCapTokens, 90_000, "env wins over the file");
    delete process.env.AUTOPILOT_AUTO_COMPACT_CAP_TOKENS;

    await writeConfigFile({ autoCompactCapTokens: 0 });
    assert.strictEqual((await loadConfig())?.autoCompactCapTokens, 0, "0 opts out of the cap");
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
    assert.strictEqual(cfg.coauthorName, "Autopilot");
    assert.strictEqual(cfg.coauthorEmail, "autopilot@directionallylocal.com");
  });

  it("credits dl in commits when dl started it; AUTOPILOT_COAUTHOR=0 still turns the trailer off", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    const prev = { by: process.env.AUTOPILOT_LAUNCHED_BY, co: process.env.AUTOPILOT_COAUTHOR };
    try {
      process.env.AUTOPILOT_LAUNCHED_BY = "dl";
      const cfg = await loadConfig();
      assert.deepStrictEqual([cfg?.coauthor, cfg?.coauthorName, cfg?.coauthorEmail], [true, "dl", "dl@directionallylocal.com"]);
      process.env.AUTOPILOT_COAUTHOR = "0";
      assert.strictEqual((await loadConfig())?.coauthor, false);
      delete process.env.AUTOPILOT_COAUTHOR;
      await writeConfigFile({ openrouterApiKey: "sk-or-file", coauthor: false });
      assert.strictEqual((await loadConfig())?.coauthor, false, "config.json's switch is kept");
    } finally {
      if (prev.by === undefined) delete process.env.AUTOPILOT_LAUNCHED_BY;
      else process.env.AUTOPILOT_LAUNCHED_BY = prev.by;
      if (prev.co === undefined) delete process.env.AUTOPILOT_COAUTHOR;
      else process.env.AUTOPILOT_COAUTHOR = prev.co;
    }
  });

  describe("memoryExtraction policy (#1073)", () => {
    it("defaults to session", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.strictEqual(cfg.memoryExtraction, "session");
    });

    it("honors a persisted policy", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", memoryExtraction: "deterministic" });
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.strictEqual(cfg.memoryExtraction, "deterministic");
    });

    it("lets AUTOPILOT_MEMORY_EXTRACTION override the file", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", memoryExtraction: "deterministic" });
      process.env.AUTOPILOT_MEMORY_EXTRACTION = "aggressive";
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.strictEqual(cfg.memoryExtraction, "aggressive");
    });

    it("falls back to session for an unknown policy", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      process.env.AUTOPILOT_MEMORY_EXTRACTION = "loud";
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.strictEqual(cfg.memoryExtraction, "session");
    });
  });

  it("serializes concurrent patches so none is lost", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file" });
    // Fire the three `/settings … off` writes at once, as the TUI does.
    await Promise.all([
      patchPersistedConfig({ prFooter: false }),
      patchPersistedConfig({ inviteTip: false }),
      patchPersistedConfig({ starTip: false }),
    ]);
    const onDisk = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
    assert.strictEqual(onDisk.prFooter, false);
    assert.strictEqual(onDisk.inviteTip, false);
    assert.strictEqual(onDisk.starTip, false);
    assert.strictEqual(onDisk.openrouterApiKey, "sk-or-file", "unrelated fields are kept");
  });

  it("loads an old config that still names a UI engine, and drops it on save", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file", uiEngine: "ink" });
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.equal("uiEngine" in cfg, false);
    await saveConfig(cfg);
    assert.equal("uiEngine" in (await readConfigFile()), false);
  });

  it("loads an old config that still names a theme, and drops it on save", async () => {
    await writeConfigFile({ openrouterApiKey: "sk-or-file", theme: "nord" });
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.equal("theme" in cfg, false);
    await saveConfig(cfg);
    assert.equal("theme" in (await readConfigFile()), false);
  });

  it("ignores and removes legacy worker spend-cap settings", async () => {
    process.env.KIMIFLARE_WORKER_BUDGET_USD = "0.01";
    process.env.KIMIFLARE_WORKER_BUDGET_MAX_USD = "0.02";
    await writeConfigFile({
      openrouterApiKey: "sk-or-file",
      workerBudgetUsd: 0.01,
      workerBudgetMaxUsd: 0.02,
      workerMaxParallel: 2,
      workerTimeoutMs: 1234,
    });

    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.equal("workerBudgetUsd" in cfg, false);
    assert.equal("workerBudgetMaxUsd" in cfg, false);
    assert.equal(cfg.workerMaxParallel, 2);
    assert.equal(cfg.workerTimeoutMs, 1234);

    const onDisk = await readConfigFile();
    assert.equal(onDisk.workerBudgetUsd, undefined);
    assert.equal(onDisk.workerBudgetMaxUsd, undefined);
    assert.equal(onDisk.workerMaxParallel, 2);
  });

  it("defaults subagent routing to auto, migrates the old implicit default, and preserves explicit choices", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    assert.equal((await loadConfig())?.subagentPolicy, "auto");

    await writeConfigFile({ openrouterApiKey: "sk-or-file", subagentPolicy: "suggest" });
    assert.equal((await loadConfig())?.subagentPolicy, "auto");
    await writeConfigFile({ openrouterApiKey: "sk-or-file", subagentPolicy: "suggest", subagentPolicyExplicit: true });
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
      shell: "/bin/bash",
      mcpServers: { fs: { type: "local", command: ["fs-mcp"] } },
    });
    const cfg = await loadConfig();
    assert.ok(cfg);
    assert.strictEqual(cfg.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(cfg.plumbingModel, "moonshotai/kimi-k2.5");
    assert.strictEqual(cfg.memoryEmbeddingModel, "baai/bge-base-en-v1.5");
    assert.strictEqual(cfg.shell, "/bin/bash");
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
    assert.strictEqual(onDisk.shell, "/bin/bash");
    assert.deepStrictEqual(onDisk.mcpServers, { fs: { type: "local", command: ["fs-mcp"] } });
    assert.strictEqual(onDisk.accountId, "acct");
    assert.strictEqual(onDisk.apiToken, "cf-token");
    assert.strictEqual(onDisk.openrouterApiKey, "sk-or-file");
  });

  it("never writes an env-provided key into the file during migration", async () => {
    await writeConfigFile({ aiGatewayId: "gw", model: "@cf/moonshotai/kimi-k2.6", shell: "t" });
    process.env.OPENROUTER_API_KEY = "sk-or-env-secret";
    const cfg = await loadConfig();
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-env-secret");
    const onDisk = await readConfigFile();
    assert.strictEqual(onDisk.openrouterApiKey, undefined);
    assert.strictEqual(onDisk.aiGatewayId, undefined);
    assert.strictEqual(onDisk.model, "moonshotai/kimi-k2.6");
  });

  it("leaves an already-clean file untouched", async () => {
    const clean = { openrouterApiKey: "sk-or-file", model: "moonshotai/kimi-k3", shell: "t" };
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

  describe("trace", () => {
    it("is absent by default", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      const cfg = await loadConfig();
      assert.ok(cfg);
      assert.ok(!("trace" in cfg));
    });

    it("KIMIFLARE_TRACE=1 enables tracing; KIMIFLARE_TRACE_DIR sets the root", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      process.env.KIMIFLARE_TRACE = "1";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: true });
      process.env.KIMIFLARE_TRACE_DIR = "/tmp/traces";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: true, root: "/tmp/traces" });
    });

    it("AUTOPILOT_TRACE / AUTOPILOT_TRACE_DIR work and win over the KIMIFLARE_* names (#911)", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      process.env.AUTOPILOT_TRACE = "1";
      process.env.AUTOPILOT_TRACE_DIR = "/tmp/new-traces";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: true, root: "/tmp/new-traces" });
      process.env.KIMIFLARE_TRACE = "1";
      process.env.AUTOPILOT_TRACE = "0";
      process.env.KIMIFLARE_TRACE_DIR = "/tmp/old-traces";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: false, root: "/tmp/new-traces" });
    });

    it("reads the persisted block and lets the env override it", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", trace: { enabled: true, root: "/persisted" } });
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: true, root: "/persisted" });
      process.env.KIMIFLARE_TRACE = "0";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: false, root: "/persisted" });
      process.env.KIMIFLARE_TRACE_DIR = "/env";
      assert.deepStrictEqual((await loadConfig())?.trace, { enabled: false, root: "/env" });
    });
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

    it("resolves with AUTOPILOT_BASE_URL + AUTOPILOT_API_KEY, which win over the KIMIFLARE_* names (#911)", async () => {
      process.env.AUTOPILOT_BASE_URL = "https://new.example.com/v1";
      process.env.AUTOPILOT_API_KEY = "new-key";
      let cfg = await loadConfig();
      assert.strictEqual(cfg?.baseUrl, "https://new.example.com/v1");
      assert.strictEqual(cfg?.apiKey, "new-key");
      process.env.KIMIFLARE_BASE_URL = "https://old.example.com/v1";
      process.env.KIMIFLARE_API_KEY = "old-key";
      cfg = await loadConfig();
      assert.strictEqual(cfg?.baseUrl, "https://new.example.com/v1");
      assert.strictEqual(cfg?.apiKey, "new-key");
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

  describe("Requesty (opt-in)", () => {
    it("resolves with ONLY REQUESTY_API_KEY and uses Requesty model ids by default", async () => {
      process.env.REQUESTY_API_KEY = "rq-env";
      const cfg = await loadConfig();
      assert.ok(cfg, "expected a usable config with only a Requesty key");
      assert.strictEqual(cfg.requestyApiKey, "rq-env");
      assert.strictEqual(cfg.openrouterApiKey, undefined);
      assert.strictEqual(cfg.model, REQUESTY_DEFAULT_MODEL);
      assert.strictEqual(cfg.plumbingModel, REQUESTY_PLUMBING_MODEL);
      assert.strictEqual(cfg.memoryExtractionModel, REQUESTY_PLUMBING_MODEL);
    });

    it("resolves a persisted requestyApiKey and keeps the persisted model", async () => {
      await writeConfigFile({ requestyApiKey: "rq-file", model: "openai/gpt-4o-mini" });
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.requestyApiKey, "rq-file");
      assert.strictEqual(cfg?.model, "openai/gpt-4o-mini");
    });

    it("never changes the defaults when an OpenRouter key is also configured", async () => {
      process.env.OPENROUTER_API_KEY = "sk-or-env";
      process.env.REQUESTY_API_KEY = "rq-env";
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.openrouterApiKey, "sk-or-env");
      assert.strictEqual(cfg?.model, DEFAULT_MODEL);
      assert.strictEqual(cfg?.plumbingModel, DEFAULT_PLUMBING_MODEL);
    });
  });

  describe("provider-aware defaults", () => {
    it("side calls on a custom endpoint use the session model, never an OpenRouter id", async () => {
      process.env.KIMIFLARE_BASE_URL = "http://127.0.0.1:11434/v1";
      process.env.KIMI_MODEL = "llama3.1:8b";
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.plumbingModel, undefined);
      assert.strictEqual(cfg?.memoryExtractionModel, undefined);
      assert.strictEqual(plumbingModelOf(cfg), "llama3.1:8b");
    });

    it("uses the active preset's chat and side-call models", async () => {
      await writeConfigFile({ provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds" } } });
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.model, "deepseek-v4-pro");
      assert.strictEqual(cfg?.plumbingModel, "deepseek-flash");
      assert.strictEqual(plumbingModelOf(cfg), "deepseek-flash");
    });

    it("returns null when the chosen provider has no key", async () => {
      await writeConfigFile({ provider: "deepseek", openrouterApiKey: "sk-or-file" });
      assert.strictEqual(await loadConfig(), null);
    });

    it("ignores an OpenRouter-era model and plumbing model once another provider is active", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", model: "moonshotai/kimi-k3", plumbingModel: "moonshotai/kimi-k2.5" });
      process.env.AUTOPILOT_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-openai";
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.model, "gpt-6.1-sol");
      assert.strictEqual(cfg?.plumbingModel, "gpt-6-luna");
      // …and they still apply to OpenRouter.
      delete process.env.AUTOPILOT_PROVIDER;
      const back = await loadConfig();
      assert.strictEqual(back?.model, "moonshotai/kimi-k3");
      assert.strictEqual(back?.plumbingModel, "moonshotai/kimi-k2.5");
    });

    it("restores a provider's last model from providers.<id>.model", async () => {
      await writeConfigFile({ provider: "openai", providers: { openai: { apiKey: "k", model: "gpt-5.6" } }, model: "moonshotai/kimi-k3" });
      assert.strictEqual((await loadConfig())?.model, "gpt-5.6");
    });

    it("saves a model chosen under a one-off provider override for that provider only", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", model: "moonshotai/kimi-k3" });
      process.env.AUTOPILOT_PROVIDER = "openai";
      process.env.OPENAI_API_KEY = "sk-openai";
      const cfg = await loadConfig();
      await saveConfig({ ...cfg!, model: "gpt-5.6" });
      const onDisk = await readConfigFile();
      assert.strictEqual(onDisk.model, "moonshotai/kimi-k3", "OpenRouter's model is untouched");
      assert.deepStrictEqual((onDisk.providers as Record<string, { model?: string }>).openai?.model, "gpt-5.6");
      assert.strictEqual((await loadConfig())?.model, "gpt-5.6");
      delete process.env.AUTOPILOT_PROVIDER;
      assert.strictEqual((await loadConfig())?.model, "moonshotai/kimi-k3");
    });

    it("still loads a config with retired multi-agent settings, and drops them on rewrite", async () => {
      await writeConfigFile({ openrouterApiKey: "sk-or-file", decompositionStrategy: "llm", workerPreReadFiles: ["a.ts"], synthesisModel: "x/y", shell: "/bin/zsh" });
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.openrouterApiKey, "sk-or-file");
      const onDisk = await readConfigFile();
      assert.strictEqual(onDisk.decompositionStrategy, undefined);
      assert.strictEqual(onDisk.workerPreReadFiles, undefined);
      assert.strictEqual(onDisk.shell, "/bin/zsh");
    });

    it("does not persist preset-derived side-call models", async () => {
      await writeConfigFile({ provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds" } } });
      const cfg = await loadConfig();
      await saveConfig({ ...cfg!, shell: "/bin/zsh" });
      const onDisk = await readConfigFile();
      assert.strictEqual(onDisk.plumbingModel, undefined);
      assert.strictEqual(onDisk.memoryExtractionModel, undefined);
      assert.strictEqual(onDisk.shell, "/bin/zsh");
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
      await writeConfigFile({ shell: "t" });
      assert.strictEqual(await hasLegacyCloudflareConfig(), false);
    });
  });

  describe("free tier default moves to GPT-6 Luna once", () => {
    const DL = "directionally-local";
    const free = (model: string | undefined, extra: Record<string, unknown> = {}) => ({
      provider: DL,
      providers: { [DL]: { apiKey: "access-1", ...(model ? { model } : {}) } },
      ...extra,
    });
    const savedModel = async () =>
      ((await readConfigFile()).providers as Record<string, { model?: string }>)[DL]?.model;
    const flag = async () => ((await readConfigFile()).migrations as { freeDefaultLuna?: boolean } | undefined)?.freeDefaultLuna;

    it("migrates the old DeepSeek default once and shows the notice once", async () => {
      await writeConfigFile(free(DL_FREE_OLD_DEFAULT_MODEL, { shell: "zsh" }));
      const cfg = await loadConfig();
      assert.strictEqual(cfg?.model, "gpt-6-luna");
      assert.strictEqual(await savedModel(), "gpt-6-luna");
      assert.strictEqual(await flag(), true);
      assert.strictEqual((await readConfigFile()).shell, "zsh", "other fields are kept");
      assert.strictEqual((await readConfigFile() as { providers: Record<string, { apiKey?: string }> }).providers[DL]?.apiKey, "access-1");
      assert.strictEqual(await takeFreeDefaultLunaNotice(), FREE_DEFAULT_LUNA_NOTICE);
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null, "the notice shows once");
      assert.strictEqual((await loadConfig())?.model, "gpt-6-luna");
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null, "a second load queues nothing");
    });

    it("keeps the flag through saveConfig (e.g. a later /model)", async () => {
      await writeConfigFile(free(DL_FREE_OLD_DEFAULT_MODEL));
      const cfg = (await loadConfig())!;
      await saveConfig({ ...cfg, providers: { ...cfg.providers, [DL]: { ...cfg.providers?.[DL], model: DL_FREE_OLD_DEFAULT_MODEL } } });
      assert.strictEqual(await flag(), true);
    });

    it("migrates a top-level model saved for the free tier", async () => {
      await writeConfigFile({ ...free(undefined), model: DL_FREE_OLD_DEFAULT_MODEL });
      assert.strictEqual((await loadConfig())?.model, "gpt-6-luna");
      assert.strictEqual(await takeFreeDefaultLunaNotice(), FREE_DEFAULT_LUNA_NOTICE);
    });

    it("does nothing when the flag is already set", async () => {
      await writeConfigFile(free(DL_FREE_OLD_DEFAULT_MODEL, { migrations: { freeDefaultLuna: true } }));
      assert.strictEqual((await loadConfig())?.model, DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await savedModel(), DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null);
    });

    it("never switches someone who picks DeepSeek after the migration", async () => {
      await writeConfigFile(free("gpt-6-luna"));
      await loadConfig();
      assert.strictEqual(await flag(), true, "checked, so the flag is set even with nothing to move");
      const file = await readConfigFile();
      await writeConfigFile({ ...file, providers: { [DL]: { apiKey: "access-1", model: DL_FREE_OLD_DEFAULT_MODEL } } });
      assert.strictEqual((await loadConfig())?.model, DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await savedModel(), DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null);
    });

    it("leaves an env model alone and saves nothing", async () => {
      await writeConfigFile(free(DL_FREE_OLD_DEFAULT_MODEL));
      process.env.KIMI_MODEL = DL_FREE_OLD_DEFAULT_MODEL;
      assert.strictEqual((await loadConfig())?.model, DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await savedModel(), DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await flag(), undefined);
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null);
    });

    it("leaves other providers alone", async () => {
      await writeConfigFile({
        openrouterApiKey: "sk-or-file",
        model: DL_FREE_OLD_DEFAULT_MODEL,
        providers: { [DL]: { apiKey: "access-1", model: DL_FREE_OLD_DEFAULT_MODEL } },
      });
      assert.strictEqual((await loadConfig())?.model, DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await savedModel(), DL_FREE_OLD_DEFAULT_MODEL);
      assert.strictEqual(await flag(), undefined);
      assert.strictEqual(await takeFreeDefaultLunaNotice(), null);
    });

    for (const model of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
      it(`leaves ${model} alone`, async () => {
        await writeConfigFile(free(model));
        assert.strictEqual((await loadConfig())?.model, model);
        assert.strictEqual(await savedModel(), model);
        assert.strictEqual(await takeFreeDefaultLunaNotice(), null);
      });
    }
  });
});
