import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  authHeaderFor,
  buildConnectState,
  CONNECT_EXIT,
  HIDDEN_WITHOUT_GATEWAY,
  writeConnectState,
  type ConnectState,
} from "./connect-state.js";
import { providerRows } from "./connect.js";
import { PROVIDER_IDS } from "./presets.js";

const env = {} as NodeJS.ProcessEnv;

describe("buildConnectState", () => {
  const savedBase = process.env.OPENROUTER_BASE_URL;
  before(() => delete process.env.OPENROUTER_BASE_URL);
  after(() => {
    if (savedBase !== undefined) process.env.OPENROUTER_BASE_URL = savedBase;
  });

  it("OpenRouter: the public API root, its env var and a Bearer header", () => {
    const state = buildConnectState({ id: "openrouter", key: "sk-or-v1-abc", model: "moonshotai/kimi-k2.6" }, null, env);
    assert.deepStrictEqual(state, {
      provider: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-v1-abc",
      apiKeyEnv: "OPENROUTER_API_KEY",
      keyRequired: true,
      model: "moonshotai/kimi-k2.6",
      authHeader: "authorization",
      authFormat: "Bearer {key}",
    } satisfies ConnectState);
  });

  it("a keyless local runtime: null key, keyRequired false, the preset's URL", () => {
    const state = buildConnectState({ id: "ollama", model: "qwen3:8b" }, { provider: "ollama" }, env);
    assert.deepStrictEqual(state, {
      provider: "ollama",
      name: "Ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiKey: null,
      apiKeyEnv: "OLLAMA_API_KEY",
      keyRequired: false,
      model: "qwen3:8b",
      authHeader: "authorization",
      authFormat: "Bearer {key}",
    } satisfies ConnectState);
    assert.strictEqual(buildConnectState({ id: "lmstudio", model: "m" }, null, env).apiKey, null);
  });

  it("a saved per-provider base URL wins over the preset's", () => {
    const state = buildConnectState({ id: "ollama", model: "m" }, { providers: { ollama: { baseUrl: "http://gpu-box:11434/v1" } } }, env);
    assert.strictEqual(state.baseUrl, "http://gpu-box:11434/v1");
  });

  it("Anthropic sends the key in x-api-key, not as a Bearer token", () => {
    const state = buildConnectState({ id: "anthropic", key: "sk-ant-1", model: "claude-sonnet-5-5" }, null, env);
    assert.strictEqual(state.baseUrl, "https://api.anthropic.com/v1");
    assert.strictEqual(state.authHeader, "x-api-key");
    assert.strictEqual(state.authFormat, "{key}");
    assert.deepStrictEqual(authHeaderFor("azure"), { authHeader: "api-key", authFormat: "{key}" });
    assert.deepStrictEqual(authHeaderFor("deepseek"), { authHeader: "authorization", authFormat: "Bearer {key}" });
  });

  it("a hosted provider: preset URL, and a key the screens reused from the saved config", () => {
    const state = buildConnectState({ id: "deepseek", model: "deepseek-v4-pro" }, { provider: "deepseek", providers: { deepseek: { apiKey: "sk-saved" } } }, env);
    assert.strictEqual(state.baseUrl, "https://api.deepseek.com");
    assert.strictEqual(state.apiKey, "sk-saved");
    assert.strictEqual(state.apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.strictEqual(state.keyRequired, true);
  });

  it("a custom endpoint uses the URL the user entered; without one there is nothing to connect to", () => {
    const state = buildConnectState({ id: "custom", baseUrl: "http://localhost:4000/v1", key: "k", model: "gpt-x" }, null, env);
    assert.strictEqual(state.baseUrl, "http://localhost:4000/v1");
    assert.strictEqual(state.apiKey, "k");
    assert.strictEqual(state.keyRequired, false);
    const saved = buildConnectState({ id: "custom", model: "m" }, { provider: "custom", baseUrl: "http://gw:8000/v1" }, env);
    assert.strictEqual(saved.baseUrl, "http://gw:8000/v1");
    assert.strictEqual(saved.apiKey, null);
    assert.throws(() => buildConnectState({ id: "custom", model: "m" }, null, env), /no base URL/);
  });
});

describe("HIDDEN_WITHOUT_GATEWAY", () => {
  it("hides exactly the providers a plain key gateway can't proxy", () => {
    assert.deepStrictEqual([...HIDDEN_WITHOUT_GATEWAY].sort(), ["azure", "bedrock", "chatgpt", "cloudflare", "copilot", "vertex"]);
  });

  it("filtering the picker rows keeps every other provider, custom included", () => {
    const rows = providerRows(null, { env }).filter((r) => !HIDDEN_WITHOUT_GATEWAY.has(r.id));
    const ids = new Set(rows.map((r) => r.id));
    for (const hidden of HIDDEN_WITHOUT_GATEWAY) assert.ok(!ids.has(hidden), `${hidden} should be hidden`);
    for (const id of ["openrouter", "anthropic", "deepseek", "ollama", "lmstudio", "custom"] as const) assert.ok(ids.has(id), `${id} should stay`);
    assert.strictEqual(rows.length, PROVIDER_IDS.length - HIDDEN_WITHOUT_GATEWAY.size);
  });
});

describe("writeConnectState", () => {
  const state = buildConnectState({ id: "ollama", model: "qwen3:8b" }, null, env);

  it("creates the parent directory and writes owner-only JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connect-state-"));
    try {
      const path = join(dir, "nested", "deeper", "state.json");
      await writeConnectState(path, state);
      const text = await readFile(path, "utf8");
      assert.ok(text.endsWith("\n"));
      assert.deepStrictEqual(JSON.parse(text), state);
      assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("tightens the mode of a file that already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "connect-state-"));
    try {
      const path = join(dir, "state.json");
      await writeFile(path, "{}", { mode: 0o644 });
      await writeConnectState(path, state);
      assert.strictEqual((await stat(path)).mode & 0o777, 0o600);
      assert.deepStrictEqual(JSON.parse(await readFile(path, "utf8")), state);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("CONNECT_EXIT", () => {
  it("is the documented contract", () => {
    assert.deepStrictEqual(CONNECT_EXIT, { success: 0, cancelled: 1, usage: 2 });
  });
});
