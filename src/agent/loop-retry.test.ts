/**
 * The agent loop retries a model call that failed on the host (before or
 * during streaming), drops what the failed attempt streamed, never re-runs
 * tools from earlier steps, and never runs a half-received tool call.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn, type AgentCallbacks } from "./loop.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "./messages.js";
import type { ToolSpec } from "../tools/registry.js";
import { ModelHostError, type ModelRetryInfo } from "./model-retry.js";
import { ApiError } from "../util/errors.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import type { AutopilotConfig } from "../config.js";

type Reply = { status: number; body: string; headers?: Record<string, string> } | { sse: unknown[]; done?: boolean };

const MORPH = "Upstream error from Morph: regional pod proxy response stream failed: error decoding response body";
const text = (t: string) => ({ id: "gen-1", choices: [{ delta: { content: t } }] });
const stop = { choices: [{ finish_reason: "stop" }] };
const midStreamError = { error: { message: MORPH } };

function respond(reply: Reply): Response {
  if ("status" in reply) {
    return new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json", ...reply.headers } });
  }
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of reply.sse) controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
      if (reply.done !== false) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("runAgentTurn model-call retries", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  function setup(replies: Reply[], tools: ToolSpec[] = [], auth: Record<string, unknown> = { openrouterApiKey: "sk-or-test" }) {
    let calls = 0;
    globalThis.fetch = async () => {
      const reply = replies[Math.min(calls, replies.length - 1)]!;
      calls++;
      return respond(reply);
    };
    const runs: string[] = [];
    const executor = {
      list: () => tools,
      run: async (call: { id: string; name: string; arguments: string }) => {
        runs.push(`${call.name} ${call.arguments}`);
        return { tool_call_id: call.id, ok: true, content: "file contents" };
      },
    } as unknown as ToolExecutor;
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "go" },
    ];
    const sleeps: number[] = [];
    const retries: ModelRetryInfo[] = [];
    const infos: string[] = [];
    const streamed: string[] = [];
    const run = (callbacks: Partial<AgentCallbacks> = {}, extra: { signal?: AbortSignal } = {}) =>
      runAgentTurn({
        ...auth,
        model: (auth.model as string | undefined) ?? "test/model",
        messages,
        tools,
        executor,
        cwd: "/tmp",
        signal: extra.signal ?? new AbortController().signal,
        retrySleep: async (ms) => {
          sleeps.push(ms);
        },
        callbacks: {
          askPermission: async () => "allow",
          onModelRetry: (r) => retries.push(r),
          onInfo: (t) => infos.push(t),
          onTextDelta: (t) => streamed.push(t),
          ...callbacks,
        },
      });
    return { run, messages, runs, sleeps, retries, infos, streamed, calls: () => calls };
  }

  const readTool: ToolSpec = {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    needsPermission: false,
    run: async () => "unused",
  };

  it("retries a stream that fails mid-answer and keeps only the retried answer", async () => {
    const t = setup([{ sse: [text("Half an ans"), midStreamError], done: false }, { sse: [text("The whole answer."), stop] }]);
    await t.run();
    assert.strictEqual(t.calls(), 2);
    assert.deepStrictEqual(t.sleeps, [1_000]);
    assert.strictEqual(t.retries.length, 1);
    assert.strictEqual(t.retries[0]!.line, "↻ The model's host had a hiccup; retrying (1/2)…");
    assert.strictEqual(t.retries[0]!.discardedText, "Half an ans");
    const assistant = t.messages.filter((m) => m.role === "assistant");
    assert.deepStrictEqual(assistant.map((m) => m.content), ["The whole answer."]);
    assert.ok(!JSON.stringify(t.messages).includes("Half an ans"), "the cut-off text is not in history");
  });

  it("retries an HTTP 503 before streaming, honouring Retry-After", async () => {
    const t = setup([
      { status: 503, body: JSON.stringify({ error: { message: "temporarily unavailable" } }), headers: { "retry-after": "5" } },
      { sse: [text("ok"), stop] },
    ]);
    await t.run();
    assert.strictEqual(t.calls(), 2);
    assert.deepStrictEqual(t.sleeps, [5_000]);
    assert.strictEqual(t.retries[0]!.discardedText, "");
  });

  it("waits 1 s then 3 s, then fails with a plain message and the host's error", async () => {
    const t = setup([{ sse: [text("x"), midStreamError], done: false }]);
    await assert.rejects(t.run(), (e: unknown) => {
      assert.ok(e instanceof ModelHostError);
      assert.strictEqual(e.attempts, 3);
      assert.strictEqual(e.message, 'autopilot: The model\'s host failed 3 times. Type "continue" to try again.');
      assert.strictEqual(e.detail, MORPH);
      return true;
    });
    assert.strictEqual(t.calls(), 3);
    assert.deepStrictEqual(t.sleeps, [1_000, 3_000]);
    assert.deepStrictEqual(t.retries.map((r) => r.line), [
      "↻ The model's host had a hiccup; retrying (1/2)…",
      "↻ The model's host had a hiccup; retrying (2/2)…",
    ]);
    assert.strictEqual(t.messages.filter((m) => m.role === "assistant").length, 0);
  });

  it("does not re-run tools from earlier steps, and never runs a half-received tool call", async () => {
    const call = (id: string, args: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "read", arguments: args } }] } }] });
    const t = setup(
      [
        // Step 1: a complete tool call, which runs.
        { sse: [call("call-1", JSON.stringify({ path: "a.ts" })), { choices: [{ finish_reason: "tool_calls" }] }] },
        // Step 2: a second tool call starts streaming, then the host fails.
        { sse: [call("call-2", '{"path": "b.'), midStreamError], done: false },
        // Retry of step 2: the model answers.
        { sse: [text("Done."), stop] },
      ],
      [readTool],
    );
    await t.run();
    assert.strictEqual(t.calls(), 3);
    assert.deepStrictEqual(t.runs, ['read {"path":"a.ts"}']);
    const toolCallIds = t.messages.flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []));
    assert.deepStrictEqual(toolCallIds, ["call-1"]);
    assert.strictEqual(t.messages.at(-1)?.content, "Done.");
  });

  for (const [name, status, body] of [
    ["a bad key", 401, { error: { code: 401, message: "No auth credentials found" } }],
    ["out of credits", 402, { error: { code: 402, message: "Insufficient credits" } }],
    ["an invalid request", 400, { error: { code: 400, message: "invalid tool schema" } }],
    ["context length", 400, { error: { code: 400, message: "This endpoint's maximum context length is 1000 tokens" } }],
    ["content policy", 403, { error: { code: 403, message: "flagged by moderation" } }],
    ["a quota 429", 429, { error: { code: 429, message: "You exceeded your current quota (insufficient_quota)" } }],
  ] as const) {
    it(`does not retry ${name}`, async () => {
      const t = setup([{ status, body: JSON.stringify(body) }, { sse: [text("unexpected"), stop] }]);
      await assert.rejects(t.run(), (e: unknown) => e instanceof ApiError && !(e instanceof ModelHostError));
      assert.strictEqual(t.calls(), 1);
      assert.deepStrictEqual(t.sleeps, []);
    });
  }

  it("does not retry a mid-stream context-length or content-policy error", async () => {
    for (const message of ["maximum context length exceeded", "Output blocked by content policy"]) {
      const t = setup([{ sse: [text("a"), { error: { message } }], done: false }, { sse: [text("unexpected"), stop] }]);
      await assert.rejects(t.run(), new RegExp(message));
      assert.strictEqual(t.calls(), 1);
    }
  });

  it("falls back to an info line for hosts without onModelRetry", async () => {
    const t = setup([{ sse: [text("x"), midStreamError], done: false }, { sse: [text("ok"), stop] }]);
    await t.run({ onModelRetry: undefined });
    assert.deepStrictEqual(t.infos, ["↻ The model's host had a hiccup; retrying (1/2)…"]);
  });

  it("stops when the user interrupts during the wait", async () => {
    const t = setup([{ sse: [text("x"), midStreamError], done: false }, { sse: [text("unexpected"), stop] }]);
    const ac = new AbortController();
    await assert.rejects(
      t.run({ onModelRetry: () => ac.abort() }, { signal: ac.signal }),
      (e: unknown) => (e as { name?: string }).name === "AbortError",
    );
    assert.strictEqual(t.calls(), 1);
  });

  describe("the free tier's upstream errors", () => {
    const env = { url: process.env.AUTOPILOT_DL_FREE_URL, token: process.env.AUTOPILOT_DL_FREE_TOKEN };
    before(() => {
      process.env.AUTOPILOT_DL_FREE_URL = "https://free.test";
      process.env.AUTOPILOT_DL_FREE_TOKEN = "tok";
    });
    after(() => {
      for (const [k, v] of [["AUTOPILOT_DL_FREE_URL", env.url], ["AUTOPILOT_DL_FREE_TOKEN", env.token]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const dlAuth = () => ({
      ...llmAuthFromConfig({ provider: "directionally-local", model: "deepseek/deepseek-v4.1-flash-1017" } as AutopilotConfig),
      model: "deepseek/deepseek-v4.1-flash-1017",
    });
    const busy = { status: 429, body: JSON.stringify({ error: { code: "upstream_busy", retryable: true, message: "The free tier is busy right now; retrying…" } }) };

    it("retries upstream_busy in the turn with the server's words, 5 s apart without Retry-After", async () => {
      const t = setup([busy, { sse: [text("ok"), stop] }], [], dlAuth());
      await t.run();
      assert.strictEqual(t.calls(), 2);
      assert.deepStrictEqual(t.sleeps, [5_000]);
      assert.strictEqual(t.retries[0]!.line, "↻ The free tier is busy right now; retrying (1/2)…");
    });

    it("keeps the after-3-failures message, and caps Retry-After at 20 s", async () => {
      const t = setup([{ status: 503, body: JSON.stringify({ error: { code: "upstream_unavailable", retryable: true } }), headers: { "retry-after": "15" } }], [], dlAuth());
      await assert.rejects(t.run(), (e: unknown) => {
        assert.ok(e instanceof ModelHostError);
        assert.strictEqual(e.message, 'autopilot: The model\'s host failed 3 times. Type "continue" to try again.');
        return true;
      });
      assert.deepStrictEqual(t.sleeps, [15_000, 15_000]);
    });

    it("does not retry upstream_credit_exhausted", async () => {
      const t = setup([{ status: 503, body: JSON.stringify({ error: { code: "upstream_credit_exhausted", retryable: true } }) }], [], dlAuth());
      await assert.rejects(t.run(), /Free tokens are paused while we top up\. Your own key still works: \/provider/);
      assert.strictEqual(t.calls(), 1);
      assert.strictEqual(t.retries.length, 0);
    });
  });
});
