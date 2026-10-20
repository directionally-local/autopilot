import { describe, it } from "node:test";
import assert from "node:assert";
import {
  credentialLabel,
  filterProviderRows,
  isVertexProjectId,
  maskKey,
  normalizeEndpoint,
  planConnect,
  PROVIDER_CHOICES,
  providerRows,
  switchedMessage,
} from "./connect.js";
import { PROVIDER_IDS } from "./presets.js";
import type { KimiConfig } from "../config.js";

const env = {} as NodeJS.ProcessEnv;

describe("providerRows", () => {
  it("offers every provider", () => {
    assert.deepStrictEqual(new Set(PROVIDER_CHOICES.map((c) => c.id)), new Set(PROVIDER_IDS));
  });

  it("puts current, env-keyed and saved providers first, with their status", () => {
    const rows = providerRows(
      { provider: "anthropic", providers: { gemini: { apiKey: "g" }, anthropic: { apiKey: "a" } } },
      { env: { OPENAI_API_KEY: "sk" } as NodeJS.ProcessEnv },
    );
    assert.deepStrictEqual(rows.slice(0, 3).map((r) => [r.id, credentialLabel(r)]), [
      ["anthropic", "key saved"],
      ["openai", "key in environment"],
      ["gemini", "key saved"],
    ]);
    assert.ok(rows[0]!.active);
    assert.strictEqual(credentialLabel(rows.find((r) => r.id === "ollama")!), "no key needed");
    assert.strictEqual(credentialLabel(rows.find((r) => r.id === "bedrock")!), "AWS credentials");
    assert.strictEqual(credentialLabel(rows.find((r) => r.id === "copilot")!), "sign-in needed");
    assert.strictEqual(credentialLabel(rows.find((r) => r.id === "xai")!), "needs a key");
  });

  it("first run marks nothing as current; an upgrading kimiflare config puts Workers AI first", () => {
    const rows = providerRows({}, { env, markActive: false, upgrading: true });
    assert.ok(!rows.some((r) => r.active));
    assert.strictEqual(rows[0]!.id, "cloudflare");
  });

  it("fuzzy search covers names, ids and hints", () => {
    const rows = providerRows(null, { env });
    assert.deepStrictEqual(filterProviderRows(rows, "claude").map((r) => r.id).slice(0, 1), ["anthropic"]);
    assert.ok(filterProviderRows(rows, "local").some((r) => r.id === "ollama"));
    assert.strictEqual(filterProviderRows(rows, "").length, rows.length);
  });
});

describe("planConnect", () => {
  it("names the step each provider needs", () => {
    assert.deepStrictEqual(planConnect("openrouter", null, env), { kind: "openrouter" });
    assert.deepStrictEqual(planConnect("copilot", null, env), { kind: "copilot" });
    assert.deepStrictEqual(planConnect("custom", null, env), { kind: "baseUrl", purpose: "custom" });
    assert.deepStrictEqual(planConnect("azure", null, env), { kind: "baseUrl", purpose: "azure" });
    // A gcloud default project skips the step.
    assert.ok(["project", "ready"].includes(planConnect("vertex", null, env).kind));
    assert.deepStrictEqual(planConnect("xai", null, env), { kind: "key" });
    assert.deepStrictEqual(planConnect("ollama", null, env), { kind: "ready", source: "none" });
  });

  it("existing credentials: from the environment or the config file", () => {
    assert.deepStrictEqual(planConnect("openai", null, { OPENAI_API_KEY: "sk-env" } as NodeJS.ProcessEnv), { kind: "ready", key: "sk-env", source: "env" });
    assert.deepStrictEqual(planConnect("gemini", { providers: { gemini: { apiKey: "g-1" } } } as Partial<KimiConfig>, env), { kind: "ready", key: "g-1", source: "config" });
  });
});

describe("helpers", () => {
  it("normalizes endpoints (an Azure resource name is enough)", () => {
    assert.deepStrictEqual(normalizeEndpoint("azure", "my-res"), { url: "https://my-res.openai.azure.com/openai/v1" });
    assert.deepStrictEqual(normalizeEndpoint("custom", " http://localhost:4000/v1 "), { url: "http://localhost:4000/v1" });
    assert.ok("error" in normalizeEndpoint("custom", "localhost:4000"));
  });

  it("validates Vertex project ids and masks keys", () => {
    assert.ok(isVertexProjectId("my-project-1"));
    assert.ok(!isVertexProjectId("My Project"));
    assert.strictEqual(maskKey("sk-or-v1-abcdef123456"), "sk-or-…3456");
    assert.strictEqual(maskKey("short"), "•••••");
  });

  it("says what happened after a switch, including an environment override", () => {
    const cfg = { provider: "anthropic", model: "claude-x" } as unknown as KimiConfig;
    assert.match(switchedMessage(cfg, "anthropic", env), /^provider: Anthropic · model claude-x\. Conversation history is kept/);
    assert.match(switchedMessage(cfg, "anthropic", { AUTOPILOT_PROVIDER: "openai" } as NodeJS.ProcessEnv), /AUTOPILOT_PROVIDER in the environment keeps OpenAI active/);
  });
});
