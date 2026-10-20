import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runKimi, ThinkTagSplitter, type KimiEvent } from "./client.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import type { ChatMessage } from "./messages.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";

describe("ThinkTagSplitter", () => {
  function run(chunks: string[]) {
    const s = new ThinkTagSplitter();
    const parts = [...chunks.flatMap((c) => s.push(c)), ...s.flush()];
    const join = (k: string) => parts.filter((p) => p.kind === k).map((p) => p.text).join("");
    return { text: join("text"), reasoning: join("reasoning") };
  }

  it("separates inline reasoning, including tags split across chunks", () => {
    assert.deepStrictEqual(run(["<think>plan it</think>Answer."]), { text: "Answer.", reasoning: "plan it" });
    assert.deepStrictEqual(run(["<thi", "nk>pl", "an</th", "ink>Ans", "wer"]), { text: "Answer", reasoning: "plan" });
    assert.deepStrictEqual(run(["no tags at all, a < b"]), { text: "no tags at all, a < b", reasoning: "" });
    assert.deepStrictEqual(run(["ends with <"]), { text: "ends with <", reasoning: "" });
  });
});

describe("MiniMax requests", () => {
  const originalFetch = globalThis.fetch;
  const saved = process.env.MINIMAX_API_KEY;
  let last: { url: string; body: Record<string, unknown> } | null = null;

  before(() => {
    delete process.env.MINIMAX_API_KEY;
    registerProviderModels("minimax", mapModelsDevProvider(MODELS_DEV_SNAPSHOT.minimax!));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      last = { url: String(input), body: JSON.parse(String(init?.body)) };
      const chunks = [
        { choices: [{ delta: { content: "<think>reading the " } }] },
        { choices: [{ delta: { content: "file</think>Done." }, finish_reason: "stop" }] },
      ];
      return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    if (saved === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = saved;
  });

  it("asks for split reasoning, echoes reasoning_details, and still separates inline <think>", async () => {
    const auth = llmAuthFromConfig({ provider: "minimax", providers: { minimax: { apiKey: "mm-test-key" } } });
    const history: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", reasoning_details: [{ type: "reasoning.text", index: 0, text: "earlier thought" }], reasoning_content: "earlier thought" },
      { role: "user", content: "next" },
    ];
    const events: KimiEvent[] = [];
    for await (const e of runKimi({ ...auth, model: "MiniMax-M3", messages: history, reasoningEffort: "high" })) events.push(e);
    assert.strictEqual(last!.url, "https://api.minimax.io/v1/chat/completions");
    assert.strictEqual(last!.body.reasoning_split, true);
    assert.ok("max_tokens" in last!.body);
    assert.ok(!("reasoning_effort" in last!.body));
    const assistant = (last!.body.messages as ChatMessage[])[1]!;
    assert.deepStrictEqual(assistant.reasoning_details, [{ type: "reasoning.text", index: 0, text: "earlier thought" }]);
    assert.ok(!("reasoning_content" in assistant));
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    const reasoning = events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join("");
    assert.deepStrictEqual({ text, reasoning }, { text: "Done.", reasoning: "reading the file" });
  });
});
