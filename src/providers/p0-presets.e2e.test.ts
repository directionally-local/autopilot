/**
 * End-to-end check of each P0 preset with only that provider's key: a full
 * agent turn with a tool call, compaction, a memory save and recall, and the
 * cost record — all against the provider's own endpoint, none to OpenRouter.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "../agent/loop.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { summarizeMessagesViaLlm } from "../agent/llm-summarize.js";
import type { ChatMessage } from "../agent/messages.js";
import { MemoryManager } from "../memory/manager.js";
import { ensureProviderCatalog } from "../models/provider-catalog.js";
import { registerProviderModels } from "../models/registry.js";
import { getCostReport, recordUsage } from "../usage-tracker.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { PROVIDER_PRESETS, type ProviderId } from "./presets.js";

const P0: Array<{ id: ProviderId; model: string }> = [
  { id: "openai", model: "gpt-6.1-sol" },
  { id: "deepseek", model: "deepseek-v4-pro" },
  { id: "moonshot", model: "kimi-k2.6" },
  { id: "kimi-code", model: "k3" },
  { id: "zai", model: "glm-5.3" },
  { id: "zai-coding", model: "glm-5.3" },
  { id: "ollama", model: "llama3.1:8b" },
  { id: "lmstudio", model: "qwen2.5-coder-32b" },
];

const ENV = ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "AUTOPILOT_PROVIDER", "KIMIFLARE_BASE_URL", "OPENROUTER_API_KEY", "KIMIFLARE_OPENROUTER_KEY"];

function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("P0 presets end to end", () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let dir: string;
  let requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let chatCalls = 0;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "p0-e2e-"));
    for (const k of ENV) delete process.env[k];
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CONFIG_HOME = dir;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      requests.push({ url, body });
      if (url.endsWith("/embeddings")) {
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "llama3.1:8b" }] }), { status: 200 });
      if (url.endsWith("/api/show")) return new Response(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "llama.context_length": 131072 } }), { status: 200 });
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder-32b" }] }), { status: 200 });
      // Responses API (OpenAI): a reasoning item + tool call, then text.
      if (url.endsWith("/responses")) {
        const first = body.tools && chatCalls++ === 0;
        return sse(
          first
            ? [
                { type: "response.output_item.done", item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] } },
                { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } },
                { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"README.md"}' },
                { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 600 } } } },
              ]
            : [
                { type: "response.output_text.delta", delta: '{"valid":true,"corrected_content":null}' },
                { type: "response.completed", response: { usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 600 } } } },
              ],
        );
      }
      // Agent turn: first a tool call (with reasoning), then the answer; side calls get plain text.
      if (body.tools && chatCalls++ === 0) {
        return sse([
          { id: "resp-1", choices: [{ delta: { reasoning_content: "need the readme" } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }] } }] },
          { choices: [{ finish_reason: "tool_calls" }] },
        ]);
      }
      return sse([
        { choices: [{ delta: { content: '{"valid":true,"corrected_content":null}' }, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 600 } },
      ]);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  for (const { id, model } of P0) {
    it(`${id}: turn with a tool call, compaction, memory and cost — only its own endpoint`, async () => {
      requests = [];
      chatCalls = 0;
      const preset = PROVIDER_PRESETS[id];
      const cfg = { provider: id, providers: { [id]: { apiKey: "sk-test-key-123" } }, openrouterApiKey: "sk-or-still-configured" };
      const auth = llmAuthFromConfig(cfg);
      await ensureProviderCatalog(id, auth.customEndpoint ?? {});

      const tool: ToolSpec = { name: "read", description: "read a file", parameters: { type: "object" }, needsPermission: false, run: async () => "# README" };
      const executor = {
        list: () => [tool],
        run: async (call: { id: string; name: string }) => ({ tool_call_id: call.id, name: call.name, content: "# README", ok: true }),
      } as unknown as ToolExecutor;
      const messages: ChatMessage[] = [
        { role: "system", content: "test" },
        { role: "user", content: "summarize the readme" },
      ];
      await runAgentTurn({
        ...auth,
        model,
        messages,
        tools: [tool],
        executor,
        cwd: dir,
        signal: new AbortController().signal,
        callbacks: { askPermission: async () => "allow" },
        reasoningEffort: "medium",
      });
      const turnRequests = requests.filter((r) => /\/(chat\/completions|responses)$/.test(r.url) && r.body.tools);
      assert.strictEqual(turnRequests.length, 2, "tool call, then the answer");
      if (preset.protocol === "openai-responses") {
        // Encrypted reasoning from the first response is replayed before the call it preceded.
        const input = turnRequests[1]!.body.input as Array<Record<string, unknown>>;
        assert.deepStrictEqual(input.find((i) => i.type === "reasoning"), { type: "reasoning", id: "rs_1", encrypted_content: "enc-1", summary: [] });
      } else {
        const followUp = (turnRequests[1]!.body.messages as ChatMessage[]).find((m) => m.role === "assistant" && m.tool_calls);
        assert.strictEqual("reasoning_content" in followUp!, preset.compat.reasoningEcho.content, "reasoning echo per provider");
        assert.ok(!("reasoning_details" in followUp!));
      }

      await summarizeMessagesViaLlm({ ...auth, model: preset.plumbingModel ?? model, messages: [...messages, { role: "user", content: "next" }], keepLastTurns: 1 });

      const memory = new MemoryManager({ dbPath: join(dir, `${id}.db`), ...auth, model, plumbingModel: preset.plumbingModel });
      memory.open();
      try {
        await memory.remember("The release script is scripts/release.sh", "fact", 3, dir, "s1");
        const recalled = await memory.recall({ text: "release script", repoPath: dir });
        assert.ok(recalled.length > 0, "memory recall works with or without embeddings");
        assert.strictEqual(requests.some((r) => r.url.endsWith("/embeddings")), preset.embedding !== null);
      } finally {
        memory.close();
      }

      await recordUsage(`s-${id}`, { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 600 } }, undefined, model);
      const report = await getCostReport(`s-${id}`);
      assert.ok(report.session.cachedTokens === 600);
      assert.ok(!report.session.reconcilePending);

      const base = (preset.baseUrl ?? "").replace(/\/v1$/, "");
      // The public model catalog (models.dev) is the one other host allowed.
      for (const r of requests.filter((x) => !x.url.startsWith("https://models.dev/"))) {
        assert.ok(!r.url.includes("openrouter.ai"), `${id} reached OpenRouter: ${r.url}`);
        assert.ok(r.url.startsWith(base), `${id} request went elsewhere: ${r.url}`);
      }
    });
  }
});
