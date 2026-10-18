/**
 * runKimi stream parsing for OpenRouter's SSE format: text, reasoning (both
 * field spellings), structured reasoning_details, tool calls, per-response
 * metadata (generation id / upstream provider), inline usage cost, keepalive
 * comments, and mid-stream errors.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runKimi, type KimiEvent } from "./client.js";
import { KimiApiError } from "../util/errors.js";

function sse(...events: (string | object)[]): string {
  return events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}`).join("\n\n") + "\n\n";
}

describe("runKimi: OpenRouter stream parsing", () => {
  let originalFetch: typeof globalThis.fetch;
  let nextBody = "";

  before(() => {
    originalFetch = globalThis.fetch;
    delete process.env.KIMIFLARE_BASE_URL;
    globalThis.fetch = async () =>
      new Response(nextBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  async function collect(body: string): Promise<KimiEvent[]> {
    nextBody = body;
    const out: KimiEvent[] = [];
    for await (const ev of runKimi({
      openrouterApiKey: "sk-or-test-key-123456",
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    })) {
      out.push(ev);
    }
    return out;
  }

  const head = { id: "gen-abc123", model: "moonshotai/kimi-k2.6", provider: "Moonshot AI", object: "chat.completion.chunk" };

  it("reports the generation id, model and upstream provider once, first", async () => {
    const events = await collect(
      sse(
        { ...head, choices: [{ index: 0, delta: { content: "a" } }] },
        { ...head, choices: [{ index: 0, delta: { content: "b" } }] },
        "[DONE]",
      ),
    );
    const metas = events.filter((e) => e.type === "response_meta");
    assert.strictEqual(metas.length, 1);
    assert.deepStrictEqual(events[0], {
      type: "response_meta",
      meta: { generationId: "gen-abc123", model: "moonshotai/kimi-k2.6", provider: "Moonshot AI" },
    });
  });

  it("yields reasoning from `delta.reasoning` (OpenRouter) and `delta.reasoning_content` (OpenAI-compat)", async () => {
    const events = await collect(
      sse(
        { ...head, choices: [{ index: 0, delta: { reasoning: "think " } }] },
        { ...head, choices: [{ index: 0, delta: { reasoning_content: "more" } }] },
        { ...head, choices: [{ index: 0, delta: { content: "answer" } }] },
        "[DONE]",
      ),
    );
    const reasoning = events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta);
    assert.deepStrictEqual(reasoning, ["think ", "more"]);
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);
    assert.deepStrictEqual(text, ["answer"]);
  });

  it("yields structured reasoning_details deltas as-is", async () => {
    const details = [{ type: "reasoning.text", index: 0, text: "step", format: "anthropic-claude-v1" }];
    const events = await collect(
      sse({ ...head, choices: [{ index: 0, delta: { reasoning_details: details } }] }, "[DONE]"),
    );
    const got = events.find((e) => e.type === "reasoning_details");
    assert.deepStrictEqual(got, { type: "reasoning_details", details });
  });

  it("assembles streamed tool calls", async () => {
    const events = await collect(
      sse(
        {
          ...head,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":' } }] },
            },
          ],
        },
        {
          ...head,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: "tool_calls" }],
        },
        "[DONE]",
      ),
    );
    const complete = events.find((e) => e.type === "tool_call_complete");
    assert.deepStrictEqual(complete, {
      type: "tool_call_complete",
      index: 0,
      id: "call_1",
      name: "bash",
      arguments: '{"cmd":"ls"}',
      finishReason: "tool_calls",
    });
    const done = events.at(-1);
    assert.strictEqual(done?.type, "done");
    assert.strictEqual((done as { finishReason: string | null }).finishReason, "tool_calls");
  });

  it("preserves malformed tool arguments and reports finish_reason", async () => {
    const rawArguments = '{"html":"<main><script>const dashboard = ';
    const events = await collect(
      sse(
        {
          ...head,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call_truncated", type: "function", function: { name: "create_artifact", arguments: rawArguments } }] },
            },
          ],
        },
        { ...head, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        "[DONE]",
      ),
    );
    const complete = events.find((e) => e.type === "tool_call_complete");
    assert.deepStrictEqual(complete, {
      type: "tool_call_complete",
      index: 0,
      id: "call_truncated",
      name: "create_artifact",
      arguments: rawArguments,
      finishReason: "tool_calls",
    });
  });

  it("passes OpenRouter's inline billed cost through on the usage event", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      prompt_tokens_details: { cached_tokens: 60 },
      cost: 0.00042,
    };
    const events = await collect(
      sse(
        { ...head, choices: [{ index: 0, delta: { content: "x" }, finish_reason: "stop" }] },
        { ...head, choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage },
        "[DONE]",
      ),
    );
    const u = events.find((e) => e.type === "usage");
    assert.deepStrictEqual(u, { type: "usage", usage });
    const done = events.at(-1) as { type: string; usage: unknown };
    assert.deepStrictEqual(done.usage, usage);
  });

  it("ignores SSE keepalive comments", async () => {
    const events = await collect(
      ": OPENROUTER PROCESSING\n\n" + sse({ ...head, choices: [{ index: 0, delta: { content: "ok" } }] }, "[DONE]"),
    );
    assert.deepStrictEqual(
      events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta),
      ["ok"],
    );
  });

  it("throws a KimiApiError on a mid-stream error chunk (HTTP 200 already sent)", async () => {
    await assert.rejects(
      collect(
        sse(
          { ...head, choices: [{ index: 0, delta: { content: "partial" } }] },
          {
            ...head,
            error: { code: 502, message: "Provider disconnected", metadata: { error_type: "provider_error" } },
            choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
          },
        ),
      ),
      (err: unknown) => {
        assert.ok(err instanceof KimiApiError);
        assert.match(err.message, /Provider disconnected/);
        assert.strictEqual(err.httpStatus, 502);
        return true;
      },
    );
  });
});
