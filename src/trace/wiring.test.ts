import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runAgentTurn, AgentLoopError, _resetSessionWebFetchHistoryForTests, type AgentTurnOpts } from "../agent/loop.js";
import { runKimi } from "../agent/client.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "../agent/messages.js";
import type { ToolSpec } from "../tools/registry.js";
import { createMemoryRecorder, type MemoryTraceRecorder } from "./recorder.js";

type Step = { tool: string; args: Record<string, unknown> } | { text: string };

function sse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(`data: ${JSON.stringify(l)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Scripted model: each request consumes the next step (the last step repeats). */
function scriptModel(steps: Step[]): { requests: number; bodies: string[] } {
  const state = { requests: 0, bodies: [] as string[] };
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    state.bodies.push(String(init?.body ?? ""));
    const step = steps[Math.min(state.requests, steps.length - 1)]!;
    state.requests++;
    if ("text" in step) {
      return sse([
        { id: `gen_${state.requests}`, choices: [{ delta: { content: step.text } }] },
        { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.001 } },
      ]);
    }
    return sse([
      {
        id: `gen_${state.requests}`,
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: `tc_${state.requests}`, function: { name: step.tool, arguments: JSON.stringify(step.args) } },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls" }] },
    ]);
  };
  return state;
}

const PROBE_TOOL: ToolSpec = {
  name: "probe",
  description: "Test probe.",
  parameters: { type: "object", properties: {}, required: [] },
  needsPermission: false,
  run: async () => "probe output",
};

const GUARDED_TOOL: ToolSpec = {
  name: "guarded",
  description: "Needs permission.",
  parameters: { type: "object", properties: {}, required: [] },
  needsPermission: true,
  run: async () => "guarded output",
};

function baseOpts(rec: MemoryTraceRecorder, extra: Partial<AgentTurnOpts> = {}): AgentTurnOpts {
  const messages: ChatMessage[] = [
    { role: "system", content: "test" },
    { role: "user", content: "do the thing" },
  ];
  return {
    openrouterApiKey: "sk-or-test",
    model: "test/model",
    messages,
    tools: [PROBE_TOOL, GUARDED_TOOL],
    executor: new ToolExecutor([PROBE_TOOL, GUARDED_TOOL]),
    cwd: "/tmp",
    signal: new AbortController().signal,
    callbacks: { askPermission: async () => "allow" },
    trace: rec,
    turnId: "turn-1",
    ...extra,
  };
}

const types = (rec: MemoryTraceRecorder): string[] => rec.events.map((e) => e.type);

describe("trace wiring: runAgentTurn", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });
  beforeEach(() => {
    _resetSessionWebFetchHistoryForTests();
  });

  it("records one text reply as llm_request, llm_response, turn_end{complete}", async () => {
    scriptModel([{ text: "hello" }]);
    const rec = createMemoryRecorder("s");
    await runAgentTurn(baseOpts(rec));
    assert.deepStrictEqual(types(rec), ["llm_request", "llm_response", "turn_end"]);
    for (const e of rec.events) assert.strictEqual(e.turn_id, "turn-1");

    const [req] = rec.ofType("llm_request");
    assert.strictEqual(req!.payload.attempt, 0);
    assert.strictEqual(req!.payload.model, "test/model");
    assert.ok(!("messages" in req!.payload.params) && !("tools" in req!.payload.params));
    assert.ok(req!.payload.estimated_tokens > 0);

    const [res] = rec.ofType("llm_response");
    assert.strictEqual(res!.payload.request_id, req!.payload.request_id);
    assert.strictEqual(rec.blobText(res!.payload.text_blob), "hello");
    assert.strictEqual(res!.payload.finish_reason, "stop");
    assert.strictEqual(res!.payload.generation_id, "gen_1");
    assert.deepStrictEqual(res!.payload.usage, { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 });
    assert.strictEqual(res!.payload.aborted, false);
    assert.deepStrictEqual(res!.payload.tool_calls, []);

    const [end] = rec.ofType("turn_end");
    assert.strictEqual(end!.payload.reason, "complete");
    assert.deepStrictEqual(end!.payload.tools_used, []);
    assert.strictEqual(end!.payload.cost_usd, 0.001);
    assert.strictEqual(rec.blobText(end!.payload.final_text_blob), "hello");
  });

  it("records a tool call, an automatic permission, and the result before the final reply", async () => {
    scriptModel([{ tool: "probe", args: { q: "x" } }, { text: "done" }]);
    const rec = createMemoryRecorder("s");
    await runAgentTurn(baseOpts(rec));
    assert.deepStrictEqual(types(rec), [
      "llm_request",
      "llm_response",
      "tool_call",
      "permission_decision",
      "tool_result",
      "llm_request",
      "llm_response",
      "turn_end",
    ]);
    const [res1] = rec.ofType("llm_response");
    assert.deepStrictEqual(res1!.payload.tool_calls, [{ id: "tc_1", name: "probe", arguments: '{"q":"x"}' }]);
    const [call] = rec.ofType("tool_call");
    assert.strictEqual(call!.payload.tool_call_id, "tc_1");
    assert.strictEqual(call!.payload.name, "probe");
    assert.deepStrictEqual(call!.payload.args_inline, { q: "x" });
    assert.strictEqual(rec.blobText(call!.payload.args_blob), '{"q":"x"}');
    assert.strictEqual(call!.payload.needs_permission, false);
    const [perm] = rec.ofType("permission_decision");
    assert.strictEqual(perm!.payload.decision, "auto");
    assert.strictEqual(perm!.payload.tool_call_id, "tc_1");
    const [result] = rec.ofType("tool_result");
    assert.strictEqual(result!.payload.ok, true);
    assert.strictEqual(rec.blobText(result!.payload.raw_blob), "probe output");
    assert.ok(result!.payload.raw_bytes >= result!.payload.reduced_bytes);
    const [end] = rec.ofType("turn_end");
    assert.deepStrictEqual(end!.payload.tools_used, ["probe"]);
    assert.strictEqual(end!.payload.reason, "complete");
  });

  it("records a denied tool with the decision and the permission_denied result", async () => {
    scriptModel([{ tool: "guarded", args: {} }, { text: "ok, stopping" }]);
    const rec = createMemoryRecorder("s");
    await runAgentTurn(
      baseOpts(rec, {
        callbacks: { askPermission: async () => ({ decision: "deny", scope: "once", feedback: "use the other one" }) },
      }),
    );
    assert.deepStrictEqual(types(rec).slice(2, 5), ["tool_call", "permission_decision", "tool_result"]);
    const [perm] = rec.ofType("permission_decision");
    assert.strictEqual(perm!.payload.decision, "deny");
    assert.strictEqual(perm!.payload.feedback_text, "use the other one");
    const [result] = rec.ofType("tool_result");
    assert.strictEqual(result!.payload.ok, false);
    assert.strictEqual(result!.payload.error_code, "permission_denied");
    assert.strictEqual(types(rec).at(-1), "turn_end");
  });

  it("records loop guardrail trips and ends with turn_end{guardrail}", async () => {
    scriptModel([{ tool: "probe", args: { q: "same" } }]);
    const rec = createMemoryRecorder("s");
    await assert.rejects(runAgentTurn(baseOpts(rec)), (err: unknown) => err instanceof AgentLoopError);
    const guardrails = rec.ofType("guardrail").map((e) => e.payload.kind);
    assert.deepStrictEqual(guardrails, ["loop_recovery", "loop_stopped"]);
    const blocked = rec.ofType("tool_result").filter((e) => e.payload.error_code === "loop_guardrail");
    assert.ok(blocked.length >= 2, "blocked calls are traced");
    const [end] = rec.ofType("turn_end");
    assert.strictEqual(end!.payload.reason, "guardrail");
    assert.strictEqual(types(rec).at(-1), "turn_end");
  });

  it("records an abort mid-stream as turn_end{aborted} with the partial text", async () => {
    const controller = new AbortController();
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n'));
          const t = setTimeout(() => {
            try {
              c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" never seen"}}]}\n\n'));
              c.close();
            } catch {
              /* already cancelled */
            }
          }, 500);
          controller.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const rec = createMemoryRecorder("s");
    const opts = baseOpts(rec, {
      signal: controller.signal,
      callbacks: {
        askPermission: async () => "allow",
        onTextDelta: () => setTimeout(() => controller.abort(), 20),
      },
    });
    await assert.rejects(runAgentTurn(opts), (err: unknown) => err instanceof DOMException && err.name === "AbortError");
    const [res] = rec.ofType("llm_response");
    assert.strictEqual(res!.payload.aborted, true);
    const [end] = rec.ofType("turn_end");
    assert.strictEqual(end!.payload.reason, "aborted");
    assert.strictEqual(rec.blobText(end!.payload.final_text_blob), "partial answer");
    assert.strictEqual(types(rec).at(-1), "turn_end");
  });
});

describe("trace wiring: runKimi", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("stores the exact serialized request and merges streamed reasoning_details", async () => {
    let sentBody = "";
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = String(init?.body ?? "");
      return sse([
        { id: "gen_x", choices: [{ delta: { reasoning: "thinking", reasoning_details: [{ type: "reasoning.text", index: 0, text: "thi" }] } }] },
        { choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", index: 0, text: "nking" }], content: "answer" } }] },
        { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, prompt_tokens_details: { cached_tokens: 3 } } },
      ]);
    };
    const rec = createMemoryRecorder("s");
    const events = [];
    for await (const ev of runKimi({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "probe", description: "d", parameters: { type: "object" } } }],
      trace: rec,
      turnId: "t",
    })) {
      events.push(ev);
    }
    assert.deepStrictEqual(types(rec), ["llm_request", "llm_response"]);
    const [req] = rec.ofType("llm_request");
    assert.strictEqual(rec.blobText(req!.payload.request_blob), sentBody);
    assert.ok(req!.payload.messages_sha.length === 64 && req!.payload.tools_sha.length === 64);
    const [res] = rec.ofType("llm_response");
    assert.strictEqual(rec.blobText(res!.payload.reasoning_blob), "thinking");
    assert.deepStrictEqual(res!.payload.reasoning_details, [{ type: "reasoning.text", index: 0, text: "thinking" }]);
    assert.strictEqual(rec.blobText(res!.payload.text_blob), "answer");
    assert.strictEqual(res!.payload.generation_id, "gen_x");
    assert.deepStrictEqual(res!.payload.usage, { prompt_tokens: 5, completion_tokens: 1, cached_tokens: 3 });
    assert.ok(res!.payload.latency_ms >= 0);
  });

  it("records a failed attempt as llm_response{error} and retries with attempt 1", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ error: { message: "boom", code: 500 } }), { status: 500, headers: { "content-type": "application/json" } });
      return sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ finish_reason: "stop" }] }]);
    };
    const rec = createMemoryRecorder("s");
    for await (const _ev of runKimi({ openrouterApiKey: "sk-or-test", model: "test/model", messages: [{ role: "user", content: "hi" }], trace: rec })) {
      /* drain */
    }
    assert.deepStrictEqual(types(rec), ["llm_request", "llm_response", "llm_request", "llm_response"]);
    const reqs = rec.ofType("llm_request");
    assert.deepStrictEqual(reqs.map((e) => e.payload.attempt), [0, 1]);
    assert.strictEqual(reqs[0]!.payload.request_id, reqs[1]!.payload.request_id);
    const [failed, ok] = rec.ofType("llm_response");
    assert.match(failed!.payload.error ?? "", /boom|HTTP 500|Internal/);
    assert.strictEqual(ok!.payload.error, undefined);
    assert.strictEqual(rec.blobText(ok!.payload.text_blob), "ok");
  });
});

describe("trace wiring: ToolExecutor", () => {
  it("records code-mode inner calls as code_mode_call with the parent id", async () => {
    const rec = createMemoryRecorder("s");
    const exec = new ToolExecutor([PROBE_TOOL]);
    await exec.run(
      { id: "code_1", name: "probe", arguments: "{}" },
      async () => "allow",
      { cwd: "/tmp", trace: rec, turnId: "t", codeModeParentToolCallId: "tc_parent" },
    );
    assert.deepStrictEqual(types(rec), ["permission_decision", "code_mode_call"]);
    const [inner] = rec.ofType("code_mode_call");
    assert.strictEqual(inner!.payload.parent_tool_call_id, "tc_parent");
    assert.strictEqual(inner!.payload.name, "probe");
    assert.strictEqual(inner!.payload.ok, true);
    assert.strictEqual(rec.blobText(inner!.payload.raw_blob), "probe output");
  });

  it("maps allow_session and pattern decisions and records bash exit codes", async () => {
    const rec = createMemoryRecorder("s");
    const exec = new ToolExecutor([GUARDED_TOOL]);
    await exec.run({ id: "a", name: "guarded", arguments: "{}" }, async () => "allow_session", { cwd: "/tmp", trace: rec });
    await exec.run({ id: "b", name: "guarded", arguments: "{}" }, async () => "deny", { cwd: "/tmp", trace: rec });
    const decisions = rec.ofType("permission_decision").map((e) => e.payload.decision);
    // The second call is cached by the session allow and never asks.
    assert.deepStrictEqual(decisions, ["allow_session", "auto"]);

    const { bashTool } = await import("../tools/bash.js");
    const bashExec = new ToolExecutor([bashTool]);
    const bashRec = createMemoryRecorder("s");
    await bashExec.run({ id: "c", name: "bash", arguments: JSON.stringify({ command: "exit 3" }) }, async () => "allow", { cwd: process.cwd(), trace: bashRec });
    const [result] = bashRec.ofType("tool_result");
    assert.strictEqual(result!.payload.exit_code, 3);
    assert.strictEqual(result!.payload.timed_out, false);
    assert.ok(result!.payload.raw_bytes >= result!.payload.reduced_bytes);
  });
});
