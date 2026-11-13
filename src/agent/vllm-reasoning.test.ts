/**
 * Thinking models served by vLLM: reasoning arrives as `reasoning_content` (with a
 * --reasoning-parser) or inline as <think>…</think> in the content (without one), and a reply
 * can be reasoning only. Reasoning goes to the reasoning channel (shown or hidden like any
 * other), the answer is the text after it, and a reasoning-only reply is explained, never
 * treated as an empty answer or retried.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { reasoningOnlyLine, runAgentTurn } from "./loop.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import type { ChatMessage } from "./messages.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import type { AutopilotConfig } from "../config.js";

const MODEL = "Qwen/Qwen3-4B";

/** A fake vLLM: /v1/models, and chat completions streamed from the next queued reply. */
async function fakeVllm(): Promise<{ url: string; replies: unknown[][]; chats: () => number; close: () => Promise<void> }> {
  const replies: unknown[][] = [];
  let chats = 0;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model", max_model_len: 32768 }] }));
        return;
      }
      chats++;
      const chunks = replies.shift() ?? [];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, replies, chats: () => chats, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: "chatcmpl-1", model: MODEL, choices: [{ index: 0, delta: d, finish_reason: finish }] });

const readTool: ToolSpec = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } } },
  needsPermission: false,
  run: async () => "unused",
};

describe("vLLM thinking models", () => {
  let vllm: Awaited<ReturnType<typeof fakeVllm>>;
  before(async () => {
    vllm = await fakeVllm();
  });
  after(() => vllm.close());

  async function turn(tools: ToolSpec[] = []) {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "go" },
    ];
    const reasoning: string[] = [];
    const text: string[] = [];
    const warnings: string[] = [];
    const retries: unknown[] = [];
    const runs: string[] = [];
    const executor = {
      list: () => tools,
      run: async (call: { id: string; name: string; arguments: string }) => {
        runs.push(`${call.name} ${call.arguments}`);
        return { tool_call_id: call.id, ok: true, content: "file contents" };
      },
    } as unknown as ToolExecutor;
    await runAgentTurn({
      ...llmAuthFromConfig({ provider: "vllm", model: MODEL, providers: { vllm: { baseUrl: vllm.url, model: MODEL } } } as AutopilotConfig),
      model: MODEL,
      messages,
      tools,
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      retrySleep: async () => {},
      callbacks: {
        askPermission: async () => "allow",
        onReasoningDelta: (d) => reasoning.push(d),
        onTextDelta: (d) => text.push(d),
        onWarning: (w) => warnings.push(w),
        onModelRetry: (r) => retries.push(r),
      },
    });
    const assistants = messages.filter((m) => m.role === "assistant");
    return { reasoning: reasoning.join(""), text: text.join(""), warnings, retries, runs, assistants };
  }

  it("reasoning_content is reasoning; the tool call after it runs; no empty-answer warning or retry", async () => {
    const before = vllm.chats();
    vllm.replies.push(
      [
        delta({ role: "assistant", reasoning_content: "I should read " }),
        delta({ reasoning_content: "the file first." }),
        delta({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }, "tool_calls"),
      ],
      [delta({ content: "Done reading." }, "stop")],
    );
    const t = await turn([readTool]);
    assert.strictEqual(t.reasoning, "I should read the file first.");
    assert.deepStrictEqual(t.runs, ['read {"path":"a.ts"}']);
    assert.strictEqual(t.text, "Done reading.");
    assert.deepStrictEqual(t.warnings, []);
    assert.deepStrictEqual(t.retries, []);
    assert.strictEqual(vllm.chats() - before, 2);
    assert.strictEqual(t.assistants[0]!.reasoning_content, "I should read the file first.");
  });

  it("inline <think> in the content, split across chunks, is reasoning; the text after </think> is the answer", async () => {
    vllm.replies.push([
      delta({ role: "assistant", content: "<th" }),
      delta({ content: "ink>The user wants a gree" }),
      delta({ content: "ting.</thi" }),
      delta({ content: "nk>\n\nHel" }),
      delta({ content: "lo!" }, "stop"),
    ]);
    const t = await turn();
    assert.strictEqual(t.reasoning, "The user wants a greeting.");
    assert.strictEqual(t.text, "\n\nHello!");
    assert.ok(!t.text.includes("think"), "no tag reaches the answer");
    assert.strictEqual(t.assistants[0]!.content, "\n\nHello!");
    assert.deepStrictEqual(t.warnings, []);
  });

  it("a reply that is only reasoning (out of tokens) says so plainly, and doesn't crash or retry", async () => {
    vllm.replies.push([
      delta({ role: "assistant", content: "<think>Let me think about this carefully" }),
      delta({ content: " and then some more" }, "length"),
    ]);
    const t = await turn();
    assert.strictEqual(t.text, "");
    assert.match(t.reasoning, /Let me think about this carefully and then some more/);
    assert.deepStrictEqual(t.warnings, [reasoningOnlyLine("length")]);
    assert.strictEqual(t.warnings[0], "The model only thought and gave no answer: it ran out of tokens while thinking. Ask again, or ask for less at once.");
    assert.deepStrictEqual(t.retries, []);
    assert.strictEqual(t.assistants[0]!.content, null);

    vllm.replies.push([delta({ role: "assistant", reasoning_content: "Hmm." }, "stop")]);
    const stopped = await turn();
    assert.deepStrictEqual(stopped.warnings, ["The model only thought and gave no answer. Ask again."]);
  });
});
