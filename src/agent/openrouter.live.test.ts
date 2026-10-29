/**
 * Live smoke test against the real OpenRouter API — the "does what we send
 * match what comes back" check from OPENROUTER-PROVIDER-PLAN.md §5.
 *
 * Skipped unless explicitly enabled, so `npm test` / CI never spend money:
 *
 *   KIMIFLARE_LIVE_TESTS=1 OPENROUTER_API_KEY=sk-or-… npx tsx --test src/agent/openrouter.live.test.ts
 *
 * Uses a cheap tool-capable model (override with KIMIFLARE_LIVE_MODEL); a run
 * costs a fraction of a cent.
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { runKimi, type KimiEvent } from "./client.js";
import type { ChatMessage, ToolDef, Usage } from "./messages.js";
import { ensureOpenRouterCatalog } from "../models/openrouter-catalog.js";
import { checkOpenRouterKey } from "../models/openrouter.js";
import { readEnv } from "../util/env.js";

const key = process.env.OPENROUTER_API_KEY;
const enabled = readEnv("LIVE_TESTS") === "1" && !!key;
const model = readEnv("LIVE_MODEL") ?? "moonshotai/kimi-k2.5";

const tools: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "get_secret_number",
      description: "Returns the secret number. Always call this when asked for the secret number.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

async function collect(messages: ChatMessage[]) {
  const events: KimiEvent[] = [];
  for await (const ev of runKimi({
    openrouterApiKey: key,
    model,
    messages,
    tools,
    reasoningEffort: "low",
    sessionId: "kimiflare-live-test",
    idleTimeoutMs: 90_000,
  })) {
    events.push(ev);
  }
  return events;
}

describe("OpenRouter live smoke test", { skip: !enabled && "set KIMIFLARE_LIVE_TESTS=1 and OPENROUTER_API_KEY" }, () => {
  it("the key is valid", async () => {
    const res = await checkOpenRouterKey(key!);
    assert.ok(res.ok, res.ok ? "" : res.message);
  });

  it("the catalog lists the test model with tool support", async () => {
    assert.ok((await ensureOpenRouterCatalog({ ttlMs: 0 })) > 100);
  });

  it("round-trips a tool call and reports billed usage", { timeout: 180_000 }, async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a test harness. Use tools when asked." },
      { role: "user", content: "What is the secret number? Use the tool, then reply with just the number." },
    ];

    const first = await collect(messages);
    const meta = first.find((e) => e.type === "response_meta");
    assert.ok(meta && meta.type === "response_meta" && meta.meta.generationId?.startsWith("gen-"), "generation id reported");
    const call = first.find((e) => e.type === "tool_call_complete");
    assert.ok(call && call.type === "tool_call_complete", "model called the tool");
    assert.strictEqual(call.name, "get_secret_number");
    const usage1 = first.find((e) => e.type === "usage");
    assert.ok(usage1 && usage1.type === "usage" && typeof (usage1.usage as Usage).cost === "number", "inline billed cost present");

    const reasoning = first.filter((e) => e.type === "reasoning").map((e) => (e.type === "reasoning" ? e.delta : "")).join("");
    messages.push({
      role: "assistant",
      content: null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments || "{}" } }],
    });
    messages.push({ role: "tool", tool_call_id: call.id, name: call.name, content: "4217" });

    const second = await collect(messages);
    const text = second.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.delta : "")).join("");
    assert.match(text, /4217/, `final answer should contain the tool result, got: ${text}`);
  });
});
