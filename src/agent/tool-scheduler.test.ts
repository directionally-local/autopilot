/**
 * One per-call pipeline, two scheduling classes: a batch is split into
 * contiguous segments (read-only/isolated → parallel, everything else →
 * sequential). These tests pin that both classes behave the same — same
 * guardrails, results, ordering, durable-run yields and task auto-advance —
 * and that only the overlap differs.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runAgentTurn, _resetSessionWebFetchHistoryForTests, type AgentCallbacks } from "./loop.js";
import type { ToolExecutor, ToolResult } from "../tools/executor.js";
import type { ChatMessage } from "./messages.js";
import type { RunWaitRequest, ToolSpec } from "../tools/registry.js";

function sse(lines: unknown[]): Response {
  return new Response(lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** First request: the given tool calls; then a final answer. */
function scriptBatch(calls: Array<{ name: string; args: Record<string, unknown> }>): { requests: number } {
  const state = { requests: 0 };
  globalThis.fetch = (async () => {
    state.requests++;
    if (state.requests > 1) return sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }]);
    return sse([
      { choices: [{ delta: { tool_calls: calls.map((c, index) => ({ index, id: `call_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] },
      { choices: [{ finish_reason: "tool_calls" }] },
    ]);
  }) as typeof fetch;
  return state;
}

const spec = (name: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({ name, description: name, parameters: { type: "object" }, needsPermission: false, run: async () => "", ...extra });

interface Harness {
  executor: ToolExecutor;
  log: string[];
  active: number;
  maxActive: number;
}

function harness(specs: ToolSpec[], results: Record<string, Partial<ToolResult>> = {}): Harness {
  const h: Harness = { log: [], active: 0, maxActive: 0, executor: undefined as unknown as ToolExecutor };
  h.executor = {
    list: () => specs,
    run: async (call: { id: string; name: string }) => {
      h.active++;
      h.maxActive = Math.max(h.maxActive, h.active);
      h.log.push(`start:${call.id}`);
      await new Promise((r) => setTimeout(r, 15));
      h.log.push(`end:${call.id}`);
      h.active--;
      return { tool_call_id: call.id, name: call.name, content: `${call.name} ok`, ok: true, ...results[call.name] };
    },
  } as unknown as ToolExecutor;
  return h;
}

async function run(h: Harness, specs: ToolSpec[], callbacks: Partial<AgentCallbacks> = {}): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "go" }];
  await runAgentTurn({
    openrouterApiKey: "sk-or-test",
    model: "test/model",
    messages,
    tools: specs,
    executor: h.executor,
    cwd: "/tmp",
    signal: new AbortController().signal,
    callbacks: { askPermission: async () => "allow", ...callbacks },
  });
  return messages;
}

const toolMessages = (messages: ChatMessage[]) => messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.name, m.content]);

describe("tool scheduler", () => {
  const originalFetch = globalThis.fetch;
  before(() => _resetSessionWebFetchHistoryForTests());
  beforeEach(() => _resetSessionWebFetchHistoryForTests());
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("gives identical results whether a batch runs in parallel or sequentially; only the overlap differs", async () => {
    const calls = [
      { name: "a", args: { n: 1 } },
      { name: "b", args: { n: 2 } },
      { name: "c", args: { n: 3 } },
    ];
    const parallelSpecs = ["a", "b", "c"].map((n) => spec(n, { isReadOnly: true }));
    const sequentialSpecs = ["a", "b", "c"].map((n) => spec(n));
    scriptBatch(calls);
    const p = harness(parallelSpecs);
    const parallel = await run(p, parallelSpecs);
    scriptBatch(calls);
    const s = harness(sequentialSpecs);
    const sequential = await run(s, sequentialSpecs);
    assert.deepStrictEqual(toolMessages(parallel), toolMessages(sequential));
    assert.deepStrictEqual(toolMessages(parallel).map((m) => m[0]), ["call_0", "call_1", "call_2"], "call order kept");
    assert.ok(p.maxActive > 1, "read-only batch overlapped");
    assert.strictEqual(s.maxActive, 1, "mutating batch ran one at a time");
  });

  it("splits a mixed batch into segments: reads in parallel, a write alone, results in call order", async () => {
    const specs = [spec("read", { isReadOnly: true }), spec("write")];
    scriptBatch([
      { name: "read", args: { p: 1 } },
      { name: "read", args: { p: 2 } },
      { name: "write", args: { p: 3 } },
      { name: "read", args: { p: 4 } },
    ]);
    const h = harness(specs);
    const messages = await run(h, specs);
    assert.deepStrictEqual(toolMessages(messages).map((m) => m[0]), ["call_0", "call_1", "call_2", "call_3"]);
    // The write starts only after both earlier reads finished, and the last read only after the write.
    const at = (e: string) => h.log.indexOf(e);
    assert.ok(at("start:call_2") > at("end:call_0") && at("start:call_2") > at("end:call_1"));
    assert.ok(at("start:call_3") > at("end:call_2"));
    assert.ok(at("start:call_1") < at("end:call_0"), "the two reads overlapped");
  });

  it("reports an unavailable tool in a parallel batch instead of skipping it", async () => {
    const specs = [spec("read", { isReadOnly: true })];
    const executorSpecs = [...specs, spec("secret", { isReadOnly: true })];
    scriptBatch([{ name: "read", args: {} }, { name: "secret", args: {} }]);
    const h = harness(executorSpecs);
    const messages = await run(h, specs);
    const out = toolMessages(messages);
    assert.strictEqual(out.length, 2);
    assert.match(String(out[1]![2]), /not available under this turn's policy/);
    assert.ok(!h.log.includes("start:call_1"), "never executed");
  });

  it("yields a durable run from a parallel batch, after recording every result", async () => {
    const wait: RunWaitRequest = { runId: "run-1", timerId: "t-1", condition: { kind: "duration", ms: 1000 }, wakeAt: 123 } as unknown as RunWaitRequest;
    const specs = [spec("read", { isReadOnly: true }), spec("wait_for", { isReadOnly: true })];
    const state = scriptBatch([{ name: "read", args: {} }, { name: "wait_for", args: {} }]);
    const h = harness(specs, { wait_for: { waitRequest: wait } });
    let yielded: RunWaitRequest | undefined;
    const messages = await run(h, specs, { onRunYield: (w) => void (yielded = w) });
    assert.deepStrictEqual(yielded, wait);
    assert.strictEqual(toolMessages(messages).length, 2);
    assert.strictEqual(state.requests, 1, "the turn ended instead of calling the model again");
  });
});
