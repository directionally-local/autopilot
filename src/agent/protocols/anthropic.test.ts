import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { parseAnthropicStream, sanitizeToolId, toAnthropicMessages, toAnthropicRequest } from "./anthropic.js";
import { runKimi, type KimiEvent } from "../client.js";
import { llmAuthFromConfig } from "../llm-auth.js";
import { mergeReasoningDetails, type ChatMessage, type ReasoningDetail } from "../messages.js";
import { runAgentTurn } from "../loop.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolSpec } from "../../tools/registry.js";
import { registerProviderModels } from "../../models/registry.js";
import { mapModelsDevProvider } from "../../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../../models/models-dev-snapshot.js";

const tool = { type: "function" as const, function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } };

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

/** A Messages stream: thinking (signed), text, a tool call, usage with cache figures. */
const STREAM = [
  { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look at " } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "the readme." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading it." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_01", name: "read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"README.md"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
  { type: "message_stop" },
];

describe("toAnthropicRequest", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "static rules" },
    { role: "system", content: "session context" },
    { role: "user", content: "summarize the readme" },
    {
      role: "assistant",
      content: "Reading it.",
      reasoning_content: "ignored by Anthropic",
      reasoning_details: [{ type: "anthropic.thinking", index: 0, text: "Look at the readme.", signature: "sig-abc" }, { type: "reasoning.encrypted", data: "openrouter-only" }],
      tool_calls: [{ id: "call:1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
    },
    { role: "tool", tool_call_id: "call:1", content: "# Title" },
    { role: "user", content: [{ type: "text", text: "and this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
  ];

  it("maps system, tool_use/tool_result, images and replays signed thinking", () => {
    const { system, messages } = toAnthropicMessages(history);
    assert.deepStrictEqual(system.map((b) => b.text), ["static rules", "session context"]);
    assert.deepStrictEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
    assert.deepStrictEqual(messages[1]!.content, [
      { type: "thinking", thinking: "Look at the readme.", signature: "sig-abc" },
      { type: "text", text: "Reading it." },
      { type: "tool_use", id: "call_1", name: "read", input: { path: "README.md" } },
    ]);
    // The tool result and the following user message share one user turn.
    assert.deepStrictEqual(messages[2]!.content, [
      { type: "tool_result", tool_use_id: "call_1", content: "# Title" },
      { type: "text", text: "and this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ]);
  });

  it("places cache breakpoints on the last tool, last system block and the conversation tail", () => {
    const body = toAnthropicRequest({ model: "m", messages: history, tools: [tool], maxTokens: 1000, supportsReasoning: false, supportsTemperature: true });
    const tools = body.tools as Array<Record<string, unknown>>;
    const system = body.system as Array<Record<string, unknown>>;
    const msgs = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepStrictEqual(tools[0]!.cache_control, { type: "ephemeral" });
    assert.ok(!("cache_control" in system[0]!));
    assert.deepStrictEqual(system[1]!.cache_control, { type: "ephemeral" });
    assert.deepStrictEqual(msgs.at(-1)!.content.at(-1)!.cache_control, { type: "ephemeral" });
    assert.deepStrictEqual(tools[0]!.input_schema, tool.function.parameters);
    assert.strictEqual(body.temperature, 0.2);
  });

  it("uses a thinking budget for budget models and adaptive effort for newer ones", () => {
    const budget = toAnthropicRequest({ model: "m", messages: history, maxTokens: 1000, reasoningEffort: "medium", supportsReasoning: true, supportsTemperature: true, reasoningBudget: true, reasoningEfforts: ["low", "medium", "high"] });
    assert.deepStrictEqual(budget.thinking, { type: "enabled", budget_tokens: 16_000 });
    assert.ok((budget.max_tokens as number) > 16_000, "max_tokens exceeds the budget");
    assert.ok(!("temperature" in budget), "temperature stays default while thinking");
    const adaptive = toAnthropicRequest({ model: "m", messages: history, maxTokens: 1000, reasoningEffort: "medium", supportsReasoning: true, supportsTemperature: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] });
    assert.deepStrictEqual(adaptive.thinking, { type: "adaptive" });
    assert.deepStrictEqual(adaptive.output_config, { effort: "medium" });
  });

  it("sanitizes tool ids from other providers", () => {
    assert.strictEqual(sanitizeToolId("call:abc.1"), "call_abc_1");
    assert.strictEqual(sanitizeToolId("toolu_01AbC-x"), "toolu_01AbC-x");
  });
});

describe("parseAnthropicStream", () => {
  it("yields text, reasoning with its signature, tool calls and cache-aware usage", async () => {
    const events: KimiEvent[] = [];
    for await (const e of parseAnthropicStream(sseStream(STREAM), undefined, 5_000, 5_000)) events.push(e);
    assert.strictEqual(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Reading it.");
    assert.strictEqual(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join(""), "Look at the readme.");
    const details = events.filter((e) => e.type === "reasoning_details").flatMap((e) => (e as { details: ReasoningDetail[] }).details);
    assert.deepStrictEqual(details, [{ type: "anthropic.thinking", index: 0, text: "Look at the readme.", signature: "sig-abc" }]);
    const complete = events.find((e) => e.type === "tool_call_complete") as Extract<KimiEvent, { type: "tool_call_complete" }>;
    assert.deepStrictEqual([complete.id, complete.name, complete.arguments, complete.finishReason], ["toolu_01", "read", '{"path":"README.md"}', "tool_calls"]);
    const done = events.at(-1) as Extract<KimiEvent, { type: "done" }>;
    assert.deepStrictEqual(done.usage, {
      prompt_tokens: 1000,
      completion_tokens: 42,
      total_tokens: 1042,
      prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 90 },
    });
  });

  it("surfaces a mid-stream error", async () => {
    await assert.rejects(async () => {
      for await (const _ of parseAnthropicStream(sseStream([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]), undefined, 5_000, 5_000)) {
        /* drain */
      }
    }, /Overloaded/);
  });
});

describe("Anthropic through the agent loop", () => {
  const originalFetch = globalThis.fetch;
  const saved = { a: process.env.ANTHROPIC_API_KEY, p: process.env.AUTOPILOT_PROVIDER };
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let call = 0;

  before(() => {
    delete process.env.AUTOPILOT_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
    registerProviderModels("anthropic", mapModelsDevProvider(MODELS_DEV_SNAPSHOT.anthropic!));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const events = call++ === 0
        ? STREAM
        : [
            { type: "message_start", message: { id: "msg_2", usage: { input_tokens: 5, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "It is a title." } },
            { type: "content_block_stop", index: 0 },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } },
          ];
      return new Response(sseStream(events), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const [k, v] of [["ANTHROPIC_API_KEY", saved.a], ["AUTOPILOT_PROVIDER", saved.p]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("runs a tool loop and replays the signed thinking block on the follow-up request", async () => {
    const auth = llmAuthFromConfig({ provider: "anthropic", providers: { anthropic: { apiKey: "sk-ant-test" } } });
    const spec: ToolSpec = { name: "read", description: "Read a file", parameters: { type: "object" }, needsPermission: false, run: async () => "# Title" };
    const executor = {
      list: () => [spec],
      run: async (c: { id: string; name: string }) => ({ tool_call_id: c.id, name: c.name, content: "# Title", ok: true }),
    } as unknown as ToolExecutor;
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "summarize the readme" },
    ];
    await runAgentTurn({
      ...auth,
      model: "claude-sonnet-5-5",
      messages,
      tools: [spec],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
      reasoningEffort: "medium",
    });
    assert.strictEqual(requests.length, 2);
    assert.strictEqual(requests[0]!.url, "https://api.anthropic.com/v1/messages");
    assert.strictEqual(requests[0]!.headers.get("x-api-key"), "sk-ant-test");
    assert.strictEqual(requests[0]!.headers.get("anthropic-version"), "2023-06-01");
    assert.ok(!requests[0]!.headers.get("authorization"));
    const followUp = requests[1]!.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    const assistant = followUp.find((m) => m.role === "assistant")!;
    assert.deepStrictEqual(assistant.content[0], { type: "thinking", thinking: "Look at the readme.", signature: "sig-abc" });
    assert.deepStrictEqual(followUp.at(-1)!.content[0], { type: "tool_result", tool_use_id: "toolu_01", content: "# Title", cache_control: { type: "ephemeral" } });
    assert.strictEqual(messages.at(-1)!.content, "It is a title.");
  });

  it("merges streamed thinking details the way the loop stores them", () => {
    const merged = mergeReasoningDetails([], [{ type: "anthropic.thinking", index: 0, text: "a", signature: "s" }]);
    assert.deepStrictEqual(merged, [{ type: "anthropic.thinking", index: 0, text: "a", signature: "s" }]);
  });

  it("runKimi sends no OpenRouter fields to Anthropic", async () => {
    requests.length = 0;
    call = 1;
    const auth = llmAuthFromConfig({ provider: "anthropic", providers: { anthropic: { apiKey: "sk-ant-test" } } });
    for await (const _ of runKimi({ ...auth, model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }], sessionId: "s1" })) {
      /* drain */
    }
    for (const k of ["provider", "session_id", "reasoning", "max_completion_tokens", "parallel_tool_calls", "stream_options"]) {
      assert.ok(!(k in requests[0]!.body), `no ${k}`);
    }
  });
});
