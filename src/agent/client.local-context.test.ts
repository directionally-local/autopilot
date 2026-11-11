/**
 * runKimi against a local OpenAI-compatible server that reports its context
 * (vLLM's max_model_len): the reply budget is capped at half of it, a prompt
 * that can't fit fails before anything is sent, and a server that doesn't
 * say leaves the request as it was.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runKimi } from "./client.js";
import { ContextBudgetError } from "./context-budget.js";
import { resetLocalContextForTesting } from "../models/local-context.js";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./fake-openai-server.test-support.js";

const MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    /* drain */
  }
}

describe("runKimi: local server context length", () => {
  let server: FakeOpenAiServer | null = null;

  beforeEach(() => resetLocalContextForTesting());
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("caps max_tokens at half of max_model_len", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 16384 });
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } }));
    const [body] = server.chatRequests();
    assert.equal(body?.max_tokens, 8192);
    // Asked once; the second request reuses the answer.
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content: "again" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } }));
    assert.equal(server.requests.filter((r) => r.path === "/v1/models").length, 1);
    assert.equal(server.chatRequests()[1]?.max_tokens, 8192);
  });

  it("keeps a smaller requested max_tokens", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 131072 });
    await drain(runKimi({ model: MODEL, maxCompletionTokens: 300, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } }));
    assert.equal(server.chatRequests()[0]?.max_tokens, 300);
  });

  it("lowers max_tokens to the room a long prompt leaves", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 16384 });
    const content = "x".repeat(35_000); // ~10k tokens by the loop's estimate
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } }));
    const sent = server.chatRequests()[0]?.max_tokens as number;
    assert.ok(sent < 8192 && sent > 0, `max_tokens ${sent}`);
    assert.ok(10_000 + sent <= 16384);
  });

  it("fails fast with a clear message, sending nothing, when the prompt can't fit", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 8192 });
    const content = "x".repeat(70_000); // ~20k tokens
    await assert.rejects(
      drain(runKimi({ model: MODEL, messages: [{ role: "user", content }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } })),
      (err: unknown) => {
        assert.ok(err instanceof ContextBudgetError);
        assert.equal(
          err.message,
          `This prompt is about 20,000 tokens, but ${MODEL} on vLLM has a context of 8,192 tokens, which leaves too little room for a reply. ` +
            "Compact with /compact, start a new session, or raise --max-model-len on the server.",
        );
        assert.equal(err.contextWindow, 8192);
        return true;
      },
    );
    assert.equal(server.chatRequests().length, 0);
  });

  it("counts tool definitions in the prompt", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 8192 });
    const tools = [{ type: "function" as const, function: { name: "big", description: "d".repeat(30_000), parameters: { type: "object", properties: {} } } }];
    await assert.rejects(
      drain(runKimi({ model: MODEL, tools, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } })),
      ContextBudgetError,
    );
    assert.equal(server.chatRequests().length, 0);
  });

  it("leaves max_tokens unchanged when /models fails", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 8192, modelsStatus: 500 });
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "vllm" } }));
    assert.equal(server.chatRequests()[0]?.max_tokens, 16384);
  });

  it("leaves max_tokens unchanged when /models names no context", async () => {
    server = await startFakeOpenAiServer({ model: MODEL });
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl, providerId: "lmstudio" } }));
    assert.equal(server.chatRequests()[0]?.max_tokens, 16384);
  });

  it("applies to a custom OpenAI-compatible endpoint", async () => {
    server = await startFakeOpenAiServer({ model: MODEL, maxModelLen: 4096 });
    await drain(runKimi({ model: MODEL, messages: [{ role: "user", content: "hi" }], customEndpoint: { baseUrl: server.baseUrl } }));
    assert.equal(server.chatRequests()[0]?.max_completion_tokens, 2048);
  });
});
