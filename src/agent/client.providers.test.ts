/**
 * Request shape per provider preset: each gets the OpenAI-compatible body its
 * API accepts (presets.ts `compat`), reasoning echo only where it is needed,
 * and provider-specific error text.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { effortFor, normalizeUsage, runKimi, stripReasoningEcho } from "./client.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";
import { PROVIDER_PRESETS, type ProviderId } from "../providers/presets.js";
import type { ChatMessage } from "./messages.js";
import { KimiApiError } from "../util/errors.js";

const ENV = ["KIMIFLARE_BASE_URL", "KIMIFLARE_API_KEY", "AUTOPILOT_PROVIDER", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "ZHIPU_API_KEY", "OLLAMA_API_KEY"];

const history: ChatMessage[] = [
  { role: "user", content: "fix the bug" },
  {
    role: "assistant",
    content: "",
    reasoning_content: "thinking…",
    reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
    tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{}" } }],
  },
  { role: "tool", tool_call_id: "call_1", content: "file" },
];
const tools = [{ type: "function" as const, function: { name: "read", description: "read", parameters: { type: "object" } } }];

describe("request body per provider", () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let last: { url: string; body: Record<string, unknown> } | null = null;
  let respond: () => Response = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      last = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
      return respond();
    }) as typeof fetch;
  });
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    last = null;
    respond = () => new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  async function send(provider: ProviderId, model: string, effort?: "low" | "medium" | "high") {
    const preset = PROVIDER_PRESETS[provider];
    registerProviderModels(provider, preset.modelsDevId ? mapModelsDevProvider(MODELS_DEV_SNAPSHOT[preset.modelsDevId]!) : []);
    const auth = llmAuthFromConfig({ provider, providers: { [provider]: { apiKey: "k" } } });
    for await (const _ of runKimi({ ...auth, model, messages: history, tools, ...(effort ? { reasoningEffort: effort } : {}) })) {
      /* drain */
    }
    return last!;
  }

  const cases: Array<{
    provider: ProviderId;
    model: string;
    url: string;
    maxField: string;
    parallel: boolean;
    echoContent: boolean;
    effort?: string;
  }> = [
    { provider: "deepseek", model: "deepseek-v4-pro", url: "https://api.deepseek.com/chat/completions", maxField: "max_tokens", parallel: false, echoContent: true, effort: "high" },
    { provider: "moonshot", model: "kimi-k2.6", url: "https://api.moonshot.ai/v1/chat/completions", maxField: "max_tokens", parallel: false, echoContent: true },
    { provider: "zai", model: "glm-5.3", url: "https://api.z.ai/api/paas/v4/chat/completions", maxField: "max_tokens", parallel: false, echoContent: true, effort: "high" },
    { provider: "ollama", model: "llama3.1:8b", url: "http://127.0.0.1:11434/v1/chat/completions", maxField: "max_tokens", parallel: false, echoContent: false },
  ];

  for (const c of cases) {
    it(`${c.provider}: OpenAI-shaped body with its own quirks and no OpenRouter fields`, async () => {
      const { url, body } = await send(c.provider, c.model, "medium");
      assert.strictEqual(url, c.url);
      assert.strictEqual(body.model, c.model);
      assert.ok(c.maxField in body, `${c.maxField} set`);
      assert.strictEqual("parallel_tool_calls" in body, c.parallel);
      assert.strictEqual(body.reasoning_effort, c.effort);
      for (const k of ["provider", "session_id", "cache_control", "reasoning"]) assert.ok(!(k in body), `no OpenRouter field ${k}`);
      const assistant = (body.messages as ChatMessage[])[1]!;
      assert.strictEqual("reasoning_details" in assistant, false, "reasoning_details is OpenRouter-only");
      assert.strictEqual("reasoning_content" in assistant, c.echoContent);
    });
  }

  it("OpenAI uses the Responses API: stateless, encrypted reasoning, no OpenRouter fields", async () => {
    const { url, body } = await send("openai", "gpt-6.1-sol", "medium");
    assert.strictEqual(url, "https://api.openai.com/v1/responses");
    assert.strictEqual(body.store, false);
    assert.deepStrictEqual(body.include, ["reasoning.encrypted_content"]);
    assert.deepStrictEqual(body.reasoning, { effort: "medium", summary: "auto" });
    assert.strictEqual(body.parallel_tool_calls, true);
    assert.ok("max_output_tokens" in body);
    assert.ok(!("temperature" in body), "omitted for models that reject it");
    for (const k of ["messages", "provider", "session_id", "max_completion_tokens", "stream_options"]) assert.ok(!(k in body), `no ${k}`);
    const input = body.input as Array<Record<string, unknown>>;
    assert.deepStrictEqual(input.find((i) => i.type === "function_call"), { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" });
    assert.deepStrictEqual(input.find((i) => i.type === "function_call_output"), { type: "function_call_output", call_id: "call_1", output: "file" });
  });

  it("names the provider and its key in auth errors", async () => {
    respond = () => new Response(JSON.stringify({ error: { message: "Authentication Fails" } }), { status: 401, headers: { "content-type": "application/json" } });
    await assert.rejects(send("deepseek", "deepseek-v4-pro"), (e: unknown) => {
      assert.ok(e instanceof KimiApiError);
      assert.match(e.message, /DeepSeek rejected the request \(HTTP 401\)/);
      assert.match(e.message, /DEEPSEEK_API_KEY/);
      assert.doesNotMatch(e.message, /OpenRouter/);
      return true;
    });
  });

  it("does not retry a 402 'in-flight' on providers other than OpenRouter", async () => {
    let calls = 0;
    respond = () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: "in-flight budget" } }), { status: 402, headers: { "content-type": "application/json" } });
    };
    await assert.rejects(send("openai", "gpt-6.1-sol"), /OpenAI account is out of credit/);
    assert.strictEqual(calls, 1);
  });
});

describe("effortFor", () => {
  it("keeps allowed levels and maps missing ones to the nearest stronger level", () => {
    assert.strictEqual(effortFor("medium", undefined), "medium");
    assert.strictEqual(effortFor("medium", ["low", "medium", "high"]), "medium");
    assert.strictEqual(effortFor("medium", ["low", "high", "max"]), "high");
    assert.strictEqual(effortFor("low", ["high", "max"]), "high");
    assert.strictEqual(effortFor("high", ["none", "low"]), "low");
  });
});

describe("stripReasoningEcho", () => {
  it("keeps reasoning_content when the model declares it even if the preset doesn't", () => {
    const out = stripReasoningEcho(history, PROVIDER_PRESETS.ollama.compat, "reasoning_content");
    assert.strictEqual(out[1]!.reasoning_content, "thinking…");
    assert.ok(!("reasoning_details" in out[1]!));
  });
});

describe("normalizeUsage", () => {
  it("reads DeepSeek's and Moonshot's cache-hit fields into cached_tokens", () => {
    const ds = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_cache_hit_tokens: 80 } as never);
    assert.strictEqual(ds.prompt_tokens_details?.cached_tokens, 80);
    const ms = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_tokens: 64 } as never);
    assert.strictEqual(ms.prompt_tokens_details?.cached_tokens, 64);
    const oa = normalizeUsage({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 10 } });
    assert.strictEqual(oa.prompt_tokens_details?.cached_tokens, 10);
  });
});
