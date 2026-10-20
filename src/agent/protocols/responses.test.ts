import { describe, it } from "node:test";
import assert from "node:assert";
import { parseResponsesStream, toResponsesInput, toResponsesRequest } from "./responses.js";
import type { KimiEvent } from "../client.js";
import type { ChatMessage, ReasoningDetail } from "../messages.js";

function sseStream(events: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`));
      c.close();
    },
  });
}

async function collect(events: unknown[]): Promise<KimiEvent[]> {
  const out: KimiEvent[] = [];
  for await (const e of parseResponsesStream(sseStream(events), undefined, 5_000, 5_000)) out.push(e);
  return out;
}

describe("toResponsesInput", () => {
  it("maps roles, images, reasoning replay, function calls and outputs in order", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
      {
        role: "assistant",
        content: "checking",
        reasoning_details: [
          { type: "openai.reasoning", index: 0, id: "rs_1", data: "enc", summaryParts: [{ type: "summary_text", text: "s" }] },
          { type: "anthropic.thinking", text: "not for OpenAI", signature: "x" },
        ],
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "contents" },
    ];
    assert.deepStrictEqual(toResponsesInput(messages), [
      { role: "system", content: [{ type: "input_text", text: "rules" }] },
      { role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AA" }] },
      { type: "reasoning", id: "rs_1", encrypted_content: "enc", summary: [{ type: "summary_text", text: "s" }] },
      { role: "assistant", content: [{ type: "output_text", text: "checking" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ]);
  });

  it("asks for encrypted reasoning, maps effort, and sends temperature only to non-reasoning models", () => {
    const tools = [{ type: "function" as const, function: { name: "read", description: "d", parameters: { type: "object" } } }];
    const reasoning = toResponsesRequest({ model: "gpt", messages: [], tools, maxTokens: 100, reasoningEffort: "medium", supportsReasoning: true, supportsTemperature: false, reasoningEfforts: ["low", "high"] });
    assert.deepStrictEqual(reasoning.reasoning, { effort: "high", summary: "auto" });
    assert.deepStrictEqual(reasoning.tools, [{ type: "function", name: "read", description: "d", parameters: { type: "object" }, strict: false }]);
    assert.ok(!("temperature" in reasoning));
    const plain = toResponsesRequest({ model: "gpt-4.1", messages: [], maxTokens: 100, supportsReasoning: false, supportsTemperature: true });
    assert.strictEqual(plain.temperature, 0.2);
    assert.ok(!("include" in plain) && !("reasoning" in plain));
  });
});

describe("parseResponsesStream", () => {
  it("yields reasoning summary, encrypted reasoning, text, tool calls and usage", async () => {
    const events = await collect([
      { type: "response.created", response: { id: "resp_1", model: "gpt-6.1-sol" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
      { type: "response.reasoning_summary_text.delta", delta: "Plan: read it." },
      { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", encrypted_content: "enc-xyz", summary: [{ type: "summary_text", text: "Plan: read it." }] } },
      { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1" } },
      { type: "response.output_text.delta", delta: "Reading." },
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a"}' },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "read", arguments: '{"path":"a"}' } },
      { type: "response.completed", response: { usage: { input_tokens: 500, output_tokens: 30, total_tokens: 530, input_tokens_details: { cached_tokens: 400 } } } },
    ]);
    assert.strictEqual(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join(""), "Plan: read it.");
    const details = events.filter((e) => e.type === "reasoning_details").flatMap((e) => (e as { details: ReasoningDetail[] }).details);
    assert.deepStrictEqual(details, [{ type: "openai.reasoning", index: 0, id: "rs_1", data: "enc-xyz", summaryParts: [{ type: "summary_text", text: "Plan: read it." }] }]);
    assert.strictEqual(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Reading.");
    const call = events.find((e) => e.type === "tool_call_complete") as Extract<KimiEvent, { type: "tool_call_complete" }>;
    assert.deepStrictEqual([call.id, call.name, call.arguments, call.finishReason], ["call_9", "read", '{"path":"a"}', "tool_calls"]);
    const done = events.at(-1) as Extract<KimiEvent, { type: "done" }>;
    assert.deepStrictEqual(done.usage, { prompt_tokens: 500, completion_tokens: 30, total_tokens: 530, prompt_tokens_details: { cached_tokens: 400 } });
  });

  it("reports a truncated response as length and a failed one as an error", async () => {
    const truncated = await collect([{ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }]);
    assert.strictEqual((truncated.at(-1) as Extract<KimiEvent, { type: "done" }>).finishReason, "length");
    await assert.rejects(collect([{ type: "response.failed", response: { error: { message: "server_error" } } }]), /server_error/);
  });
});
