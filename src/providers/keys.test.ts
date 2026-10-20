import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProviderKey, looksLikeProviderKey, providerStatus, saveProviderKey, switchProvider } from "./keys.js";
import { loadConfig } from "../config.js";

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("checkProviderKey", () => {
  it("validates with an authenticated GET /models", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const ok = await checkProviderKey("deepseek", "sk-deepseek-123", undefined, (async (url: string, init?: RequestInit) => {
      seen = { url, auth: new Headers(init?.headers).get("authorization") };
      return json(200, { data: [] });
    }) as unknown as typeof fetch);
    assert.deepStrictEqual(ok, { ok: true });
    assert.deepStrictEqual(seen, { url: "https://api.deepseek.com/models", auth: "Bearer sk-deepseek-123" });
  });

  it("reports a rejected key, an unreachable local runtime, and a missing key", async () => {
    const rejected = await checkProviderKey("openai", "sk-wrong-key", undefined, (async () => json(401)) as unknown as typeof fetch);
    assert.deepStrictEqual(rejected, { ok: false, reason: "invalid", message: "OpenAI rejected this key." });
    const down = await checkProviderKey("ollama", undefined, undefined, (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    assert.ok(!down.ok && down.reason === "network" && /is it running/.test(down.message));
    const missing = await checkProviderKey("openai", undefined);
    assert.ok(!missing.ok && missing.reason === "invalid");
  });

  it("checks the OpenRouter key format before any request", async () => {
    assert.strictEqual(looksLikeProviderKey("openrouter", "sk-proj-abc12345"), false);
    assert.strictEqual(looksLikeProviderKey("openai", "sk-proj-abc12345"), true);
    const res = await checkProviderKey("openrouter", "sk-proj-abc12345", undefined, (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch);
    assert.ok(!res.ok && res.reason === "format");
  });
});

describe("saving keys and switching providers", () => {
  let home: string;
  const ENV = ["XDG_CONFIG_HOME", "OPENROUTER_API_KEY", "KIMIFLARE_OPENROUTER_KEY", "DEEPSEEK_API_KEY", "OPENAI_API_KEY", "AUTOPILOT_PROVIDER", "KIMIFLARE_BASE_URL", "KIMI_MODEL"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const file = () => join(home, "kimiflare", "config.json");
  const read = async () => JSON.parse(await readFile(file(), "utf8")) as Record<string, unknown>;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "provider-keys-test-"));
  });
  beforeEach(async () => {
    for (const k of ENV) delete process.env[k];
    process.env.XDG_CONFIG_HOME = home;
    await mkdir(join(home, "kimiflare"), { recursive: true });
    await writeFile(file(), JSON.stringify({ openrouterApiKey: "sk-or-file", model: "moonshotai/kimi-k3", theme: "nord" }));
  });
  after(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  it("switches to a new provider and back, restoring each provider's model and keeping other settings", async () => {
    await saveProviderKey("deepseek", "sk-ds-key");
    await switchProvider(await loadConfig(), "deepseek");
    let cfg = await loadConfig();
    assert.strictEqual(cfg?.provider, "deepseek");
    assert.strictEqual(cfg?.model, "deepseek-v4-pro");
    assert.strictEqual(cfg?.openrouterApiKey, "sk-or-file", "the OpenRouter key stays for switching back");
    assert.strictEqual((await read()).theme, "nord");

    await switchProvider(cfg, "openrouter");
    cfg = await loadConfig();
    assert.strictEqual(cfg?.provider, "openrouter");
    assert.strictEqual(cfg?.model, "moonshotai/kimi-k3");
  });

  it("stores keys where each provider reads them", async () => {
    await saveProviderKey("openai", "sk-oa-key", "https://eu.api.openai.example/v1");
    await saveProviderKey("custom", "gw-key", "http://localhost:4000/v1");
    const onDisk = await read();
    assert.deepStrictEqual(onDisk.providers, { openai: { apiKey: "sk-oa-key", baseUrl: "https://eu.api.openai.example/v1" } });
    assert.strictEqual(onDisk.apiKey, "gw-key");
    assert.strictEqual(onDisk.baseUrl, "http://localhost:4000/v1");
    await saveProviderKey("openai", undefined);
    assert.deepStrictEqual((await read()).providers, { openai: { baseUrl: "https://eu.api.openai.example/v1" } });
  });

  it("reports where each provider's key comes from", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-ds-env";
    const rows = providerStatus(await loadConfig());
    const row = (id: string) => rows.find((r) => r.id === id)!;
    assert.strictEqual(row("openrouter").active, true);
    assert.strictEqual(row("openrouter").key, "config");
    assert.strictEqual(row("deepseek").key, "env");
    assert.strictEqual(row("openai").key, null);
    assert.strictEqual(row("ollama").key, "not needed");
  });
});
