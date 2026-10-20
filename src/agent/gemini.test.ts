/**
 * Gemini 3 function calling needs each tool call's thought signature sent
 * back with that call on the next request, or later turns fail. On Gemini's
 * OpenAI-compatible endpoint the signature arrives as `extra_content` on the
 * streamed tool call.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn } from "./loop.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import { stripReasoningEcho } from "./client.js";
import type { ChatMessage } from "./messages.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";

const SIGNATURE = { google: { thought_signature: "sig-gemini-1" } };

function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Gemini thought signatures", () => {
  const originalFetch = globalThis.fetch;
  const ENV = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "AUTOPILOT_PROVIDER"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const requests: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];
  let call = 0;

  before(() => {
    for (const k of ENV) delete process.env[k];
    registerProviderModels("gemini", mapModelsDevProvider(MODELS_DEV_SNAPSHOT.google!));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return call++ === 0
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "fc-1", type: "function", function: { name: "read", arguments: '{"path":"README.md"}' }, extra_content: SIGNATURE }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ])
        : sse([{ choices: [{ delta: { content: "A title." }, finish_reason: "stop" }] }]);
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

  it("sends the signature back with its tool call on the follow-up request", async () => {
    const auth = llmAuthFromConfig({ provider: "gemini", providers: { gemini: { apiKey: "AIza-test-key" } } });
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
      model: "gemini-3.8-flash",
      messages,
      tools: [spec],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
      reasoningEffort: "medium",
    });
    assert.strictEqual(requests[0]!.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.strictEqual(requests[0]!.auth, "Bearer AIza-test-key");
    assert.strictEqual(requests[0]!.body.reasoning_effort, "medium");
    const followUp = (requests[1]!.body.messages as ChatMessage[]).find((m) => m.role === "assistant")!;
    assert.deepStrictEqual(followUp.tool_calls![0]!.extra_content, SIGNATURE);
    assert.strictEqual(messages.at(-1)!.content, "A title.");
  });

  it("drops Gemini's extra_content when the conversation continues on another provider", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "fc-1", type: "function", function: { name: "read", arguments: "{}" }, extra_content: SIGNATURE }] },
    ];
    assert.ok(!("extra_content" in stripReasoningEcho(history, PROVIDER_PRESETS.deepseek.compat)[0]!.tool_calls![0]!));
    assert.ok(!("extra_content" in stripReasoningEcho(history, PROVIDER_PRESETS.openrouter.compat)[0]!.tool_calls![0]!));
    assert.deepStrictEqual(stripReasoningEcho(history, PROVIDER_PRESETS.gemini.compat)[0]!.tool_calls![0]!.extra_content, SIGNATURE);
  });
});
