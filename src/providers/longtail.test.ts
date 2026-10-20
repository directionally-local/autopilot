import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { normalizeToolIds, runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import type { ChatMessage } from "../agent/messages.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";
import { isProviderUsable, resolveActiveProvider } from "./resolve.js";
import { checkProviderKey } from "./keys.js";
import { PROVIDER_PRESETS, type ProviderId } from "./presets.js";

describe("Mistral tool-call ids", () => {
  it("rewrites ids to nine alphanumerics, consistently for a call and its result", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [
        { id: "call_abc123def456", type: "function", function: { name: "read", arguments: "{}" } },
        { id: "toolu_01XyZ", type: "function", function: { name: "grep", arguments: "{}" } },
        { id: "Ab3dE6gH9", type: "function", function: { name: "ls", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "call_abc123def456", content: "a" },
      { role: "tool", tool_call_id: "toolu_01XyZ", content: "b" },
      { role: "tool", tool_call_id: "Ab3dE6gH9", content: "c" },
    ];
    const out = normalizeToolIds(history, "mistral");
    const ids = out[0]!.tool_calls!.map((t) => t.id);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9]{9}$/);
    assert.strictEqual(new Set(ids).size, 3);
    assert.strictEqual(ids[2], "Ab3dE6gH9", "already-valid ids are kept");
    assert.deepStrictEqual(out.slice(1).map((m) => m.tool_call_id), ids);
    assert.strictEqual(normalizeToolIds(history, undefined), history, "other providers untouched");
  });
});

describe("long-tail presets", () => {
  const originalFetch = globalThis.fetch;
  const ENV = ["CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "AUTOPILOT_PROVIDER", "CEREBRAS_API_KEY", "XAI_API_KEY", "MISTRAL_API_KEY"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];

  before(() => {
    for (const k of ENV) delete process.env[k];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : {} });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function send(id: ProviderId, extra: Record<string, unknown> = {}, messages: ChatMessage[] = [{ role: "user", content: "hi" }]) {
    const preset = PROVIDER_PRESETS[id];
    registerProviderModels(id, mapModelsDevProvider(MODELS_DEV_SNAPSHOT[preset.modelsDevId!]!));
    const auth = llmAuthFromConfig({ provider: id, providers: { [id]: { apiKey: "test-key-123" } }, ...extra });
    seen.length = 0;
    for await (const _ of runKimi({ ...auth, model: preset.defaultModel!, messages })) {
      /* drain */
    }
    return seen[0]!;
  }

  const urls: Array<[ProviderId, string]> = [
    ["groq", "https://api.groq.com/openai/v1/chat/completions"],
    ["cerebras", "https://api.cerebras.ai/v1/chat/completions"],
    ["together", "https://api.together.xyz/v1/chat/completions"],
    ["fireworks", "https://api.fireworks.ai/inference/v1/chat/completions"],
    ["deepinfra", "https://api.deepinfra.com/v1/openai/chat/completions"],
    ["vercel", "https://ai-gateway.vercel.sh/v1/chat/completions"],
    ["mistral", "https://api.mistral.ai/v1/chat/completions"],
    ["xai", "https://api.x.ai/v1/responses"],
  ];
  for (const [id, url] of urls) {
    it(`${id} sends its default model to ${url}`, async () => {
      const req = await send(id);
      assert.strictEqual(req.url, url);
      assert.strictEqual(req.headers.get("authorization"), "Bearer test-key-123");
      assert.strictEqual(req.body.model, PROVIDER_PRESETS[id].defaultModel);
    });
  }

  it("Cerebras gets its integration header", async () => {
    assert.strictEqual((await send("cerebras")).headers.get("x-cerebras-3rd-party-integration"), "autopilot");
  });

  it("Mistral receives nine-character tool ids", async () => {
    const req = await send("mistral", {}, [
      { role: "user", content: "x" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_from_another_provider", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_from_another_provider", content: "r" },
    ]);
    const msgs = req.body.messages as ChatMessage[];
    assert.match(msgs[1]!.tool_calls![0]!.id, /^[A-Za-z0-9]{9}$/);
    assert.strictEqual(msgs[2]!.tool_call_id, msgs[1]!.tool_calls![0]!.id);
  });

  it("Cloudflare Workers AI fills the account id and reuses a Cloudflare-era token", async () => {
    const legacy = { provider: "cloudflare" as const, accountId: "acc123", apiToken: "cf-legacy-token" };
    const active = resolveActiveProvider(legacy, {});
    assert.strictEqual(active.baseUrl, "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1");
    assert.strictEqual(active.apiKey, "cf-legacy-token");
    assert.ok(isProviderUsable(active));
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "cloudflare", apiToken: "t" }, {})), false, "no account id");
    const req = await send("cloudflare", { accountId: "acc123" });
    assert.strictEqual(req.url, "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1/chat/completions");
    assert.strictEqual(PROVIDER_PRESETS.cloudflare.embedding?.model, "@cf/baai/bge-base-en-v1.5", "old kimiflare memory stays comparable");
  });

  it("validates a Cloudflare token with the token-verify endpoint", async () => {
    let url = "";
    const res = await checkProviderKey("cloudflare", "cf-token-1234", undefined, (async (u: string) => {
      url = u;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    assert.deepStrictEqual(res, { ok: true });
    assert.strictEqual(url, "https://api.cloudflare.com/client/v4/user/tokens/verify");
  });
});
