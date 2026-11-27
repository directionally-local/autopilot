// Interrupting mid tool call must never leave a history the API rejects:
// each tool call keeps exactly one result, right after its assistant message,
// on every request (not only on session load).
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn } from "./loop.js";
import { appendStoppedToolResults, normalizeToolResults, recordToolResult, repairDanglingToolCalls, STOPPED_TOOL_RESULT, type ChatMessage } from "./messages.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";

const call = (id: string, name = "bash") => ({ id, type: "function" as const, function: { name, arguments: "{}" } });
const shape = (ms: ChatMessage[]) => ms.map((m) => (m.role === "tool" ? `tool:${m.tool_call_id}=${m.content}` : m.role));

/** True when every tool call has exactly one result directly after its assistant message. */
function isValid(ms: ChatMessage[]): boolean {
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!;
    if (m.role === "tool") return false; // reached a result not consumed below: orphan or misplaced
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const ids = m.tool_calls.map((tc) => tc.id).sort();
    const got: string[] = [];
    while (ms[i + 1]?.role === "tool") got.push(ms[++i]!.tool_call_id!);
    if (JSON.stringify(got.sort()) !== JSON.stringify(ids)) return false;
  }
  return true;
}

describe("normalizeToolResults", () => {
  it("collapses (stopped) + late real result into the real one, kept right after the call", () => {
    const ms: ChatMessage[] = [
      { role: "user", content: "run it" },
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: STOPPED_TOOL_RESULT, name: "bash" },
      { role: "user", content: "never mind, do this" },
      { role: "tool", tool_call_id: "a", content: "real output", name: "bash" },
    ];
    assert.ok(normalizeToolResults(ms) > 0);
    assert.deepStrictEqual(shape(ms), ["user", "assistant", "tool:a=real output", "user"]);
    assert.ok(isValid(ms));
    assert.strictEqual(normalizeToolResults(ms), 0);
  });

  it("keeps the first of two real results, moves a misplaced result back and drops orphans", () => {
    const ms: ChatMessage[] = [
      { role: "tool", tool_call_id: "ghost", content: "orphan" },
      { role: "assistant", content: null, tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "first" },
      { role: "user", content: "next" },
      { role: "tool", tool_call_id: "b", content: "late b" },
      { role: "tool", tool_call_id: "a", content: "second" },
    ];
    normalizeToolResults(ms);
    assert.deepStrictEqual(shape(ms), ["assistant", "tool:a=first", "tool:b=late b", "user"]);
  });

  it("keeps ids reused across turns separate", () => {
    const ms: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("call_0")] },
      { role: "tool", tool_call_id: "call_0", content: "turn 1" },
      { role: "user", content: "again" },
      { role: "assistant", content: null, tool_calls: [call("call_0")] },
      { role: "user", content: "interrupted" },
    ];
    normalizeToolResults(ms);
    assert.deepStrictEqual(shape(ms), ["assistant", "tool:call_0=turn 1", "user", "assistant", `tool:call_0=${STOPPED_TOOL_RESULT}`, "user"]);
  });

  it("repairDanglingToolCalls (session load) is the same normalisation", () => {
    const ms: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: STOPPED_TOOL_RESULT },
      { role: "tool", tool_call_id: "a", content: STOPPED_TOOL_RESULT },
    ];
    assert.strictEqual(repairDanglingToolCalls(ms), 1);
    assert.strictEqual(ms.length, 2);
  });
});

describe("recordToolResult", () => {
  it("replaces the (stopped) placeholder in place and ignores a second real result", () => {
    const ms: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a")] },
      { role: "tool", tool_call_id: "a", content: STOPPED_TOOL_RESULT, name: "bash" },
      { role: "user", content: "next" },
    ];
    assert.strictEqual(recordToolResult(ms, { role: "tool", tool_call_id: "a", content: "done", name: "bash" }), "replaced");
    assert.deepStrictEqual(shape(ms), ["assistant", "tool:a=done", "user"]);
    assert.strictEqual(recordToolResult(ms, { role: "tool", tool_call_id: "a", content: "again", name: "bash" }), "ignored");
    assert.deepStrictEqual(shape(ms), ["assistant", "tool:a=done", "user"]);
  });

  it("appends normally and does not match an older turn's reused id", () => {
    const ms: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("call_0")] },
      { role: "tool", tool_call_id: "call_0", content: "old" },
      { role: "assistant", content: null, tool_calls: [call("call_0")] },
    ];
    assert.strictEqual(recordToolResult(ms, { role: "tool", tool_call_id: "call_0", content: "new" }), "appended");
    assert.deepStrictEqual(shape(ms), ["assistant", "tool:call_0=old", "assistant", "tool:call_0=new"]);
  });
});

describe("runAgentTurn with an interrupted tool call", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  const sse = (events: unknown[]) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.enqueue(encoder.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const toolCallResponse = (id: string) =>
    sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: "{}" } }] } }] },
      { choices: [{ finish_reason: "tool_calls" }] },
    ]);
  const tool: ToolSpec = {
    name: "bash",
    description: "Run a command",
    parameters: { type: "object", properties: {} },
    needsPermission: false,
    run: async () => "unused",
  };
  const baseOpts = { openrouterApiKey: "sk-or-test", model: "test/model", tools: [tool], cwd: "/tmp" };

  it("interrupt during a tool, late result, then resume: one result per call on every request", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "run it" },
    ];
    const sent: ChatMessage[][] = [];
    let fetchCalls = 0;
    globalThis.fetch = async (_url, init) => {
      // Like real fetch: an aborted turn's request never goes out.
      if ((init as RequestInit).signal?.aborted) throw new DOMException("aborted", "AbortError");
      fetchCalls++;
      sent.push(JSON.parse(String((init as RequestInit).body)).messages);
      return fetchCalls === 1 ? toolCallResponse("call_1") : sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    };

    // Turn 1: the user interrupts while the tool runs. The interrupt handler
    // answers the call with "(stopped)" at once; the tool finishes a moment
    // later anyway and the loop records its real result.
    const controller = new AbortController();
    const executor = {
      list: () => [tool],
      run: async (c: { id: string; name: string }) => {
        appendStoppedToolResults(messages, [[c.id, c.name]]);
        controller.abort();
        return { tool_call_id: c.id, name: c.name, content: "wrote file.txt", ok: true };
      },
    } as unknown as ToolExecutor;
    let ran = 0;
    const counting = { ...executor, run: async (c: { id: string; name: string }) => (ran++, (executor.run as (c: unknown) => Promise<unknown>)(c)) } as unknown as ToolExecutor;
    // The turn ends as interrupted (an AbortError, or a quiet return).
    await runAgentTurn({ ...baseOpts, messages, executor: counting, signal: controller.signal, callbacks: { askPermission: async () => "allow" } }).catch(
      (err: unknown) => assert.ok(err instanceof DOMException && err.name === "AbortError", String(err)),
    );
    assert.strictEqual(ran, 1, JSON.stringify(messages));
    assert.strictEqual(fetchCalls, 1, "no model request after the interrupt");
    const results = messages.filter((m) => m.role === "tool");
    assert.strictEqual(results.length, 1, "late result must not become a second result");
    assert.strictEqual(results[0]!.content, "wrote file.txt", "the real result replaces the placeholder");
    assert.ok(isValid(messages));

    // Resume: the user sends the next message; the request is valid.
    messages.push({ role: "user", content: "go on" });
    await runAgentTurn({
      ...baseOpts,
      messages,
      executor,
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });
    assert.ok(isValid(sent[1]!), JSON.stringify(sent[1]));
    assert.deepStrictEqual(shape(sent[1]!).slice(1), ["user", "assistant", "tool:call_1=wrote file.txt", "user"]);
  });

  it("repairs a broken history before the request, not only on load", async () => {
    // Saved before the fix: dangling call, then a duplicate result after the next user message.
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "run both" },
      { role: "assistant", content: null, tool_calls: [call("x"), call("y")] },
      { role: "tool", tool_call_id: "x", content: STOPPED_TOOL_RESULT, name: "bash" },
      { role: "user", content: "next" },
      { role: "tool", tool_call_id: "x", content: "late x", name: "bash" },
    ];
    let body: ChatMessage[] = [];
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String((init as RequestInit).body)).messages;
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    };
    const executor = { list: () => [tool], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor;
    await runAgentTurn({ ...baseOpts, messages, executor, signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" } });
    assert.ok(isValid(body), JSON.stringify(body));
    assert.deepStrictEqual(shape(body).slice(0, 6), ["system", "user", "assistant", "tool:x=late x", `tool:y=${STOPPED_TOOL_RESULT}`, "user"]);
    // The stored history is repaired too, so the saved session is valid.
    assert.ok(isValid(messages));
  });
});
