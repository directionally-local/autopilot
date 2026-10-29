import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeInsights, formatInsights } from "./metrics.js";
import type { PayloadFor, TraceEvent, TraceEventType } from "../trace/types.js";

let seq = 0;

function ev<T extends TraceEventType>(type: T, payload: PayloadFor<T>, sessionId = "s1"): TraceEvent {
  return {
    v: 1,
    ts: "2026-10-29T00:00:00.000Z",
    seq: seq++,
    session_id: sessionId,
    turn_id: "t1",
    type,
    payload,
  } as TraceEvent;
}

function start(model: string, profile?: string, sessionId = "s1"): TraceEvent {
  return ev(
    "session_start",
    {
      autopilot_version: "2.9.0",
      harness_commit: null,
      cwd: "/repo",
      model,
      mode: "tui",
      config: {},
      tool_profile: "full",
      ...(profile ? { model_profile: profile } : {}),
      tool_schemas_sha: "a",
      tools_blob: "b",
      system_prompt_sha: "c",
    },
    sessionId,
  );
}

function response(toolCalls: number, usage?: { prompt_tokens: number; cached_tokens?: number; cost?: number }): TraceEvent {
  return ev("llm_response", {
    request_id: "r",
    text_blob: "",
    tool_calls: Array.from({ length: toolCalls }, (_, i) => ({ id: `c${i}`, name: "read", arguments: "{}" })),
    finish_reason: "tool_calls",
    latency_ms: 10,
    aborted: false,
    ...(usage ? { usage: { completion_tokens: 10, ...usage } } : {}),
  });
}

function toolCall(name: string, args: Record<string, unknown>): TraceEvent {
  return ev("tool_call", {
    tool_call_id: "c",
    name,
    args_blob: "x",
    args_inline: args,
    needs_permission: false,
    code_mode_redirected: false,
  });
}

function toolResult(ok: boolean, errorCode?: string): TraceEvent {
  return ev("tool_result", {
    tool_call_id: "c",
    name: "read",
    ok,
    ...(errorCode ? { error_code: errorCode } : {}),
    raw_blob: "a",
    raw_bytes: 1,
    reduced_blob: "b",
    reduced_bytes: 1,
    duration_ms: 1,
  });
}

describe("computeInsights", () => {
  it("computes the per-model metrics from one session", () => {
    const events: TraceEvent[] = [
      start("deepseek/deepseek-v4.1-flash", "deepseek-v4"),
      ev("user_message", { content_blob: "a", source: "typed", attachments: 0 }),
      ev("user_message", { content_blob: "b", source: "typed", attachments: 0 }),
      ev("llm_request", { request_id: "r1", attempt: 0, model: "m", params: {}, request_blob: "a", messages_sha: "b", tools_sha: "c", estimated_tokens: 1 }),
      ev("llm_request", { request_id: "r2", attempt: 0, model: "m", params: {}, request_blob: "a", messages_sha: "b", tools_sha: "c", estimated_tokens: 1 }),
      ev("llm_request", { request_id: "r3", attempt: 0, model: "m", params: {}, request_blob: "a", messages_sha: "b", tools_sha: "c", estimated_tokens: 1 }),
      ev("llm_request", { request_id: "r4", attempt: 0, model: "m", params: {}, request_blob: "a", messages_sha: "b", tools_sha: "c", estimated_tokens: 1 }),
      response(1, { prompt_tokens: 1_000, cached_tokens: 400, cost: 0.01 }),
      response(2, { prompt_tokens: 1_000, cached_tokens: 600, cost: 0.02 }),
      toolCall("bash", { command: "sed -n '1,40p' src/a.ts" }),
      toolCall("bash", { command: "npm test" }),
      toolCall("read", { path: "src/a.ts" }),
      toolCall("read", { path: "src/a.ts" }),
      toolResult(true),
      toolResult(false, "invalid_arguments"),
      ev("guardrail", { kind: "loop_recovery", message: "loop" }),
    ];

    const [row] = computeInsights([events]);
    assert.ok(row);
    assert.equal(row.model, "deepseek/deepseek-v4.1-flash");
    assert.equal(row.model_profile, "deepseek-v4");
    assert.equal(row.sessions, 1);
    assert.equal(row.user_messages, 2);
    assert.equal(row.requests, 4);
    assert.equal(row.requests_per_user_message, 2);
    assert.equal(row.responses_with_tools, 2);
    assert.equal(row.responses_with_parallel_tools, 1);
    assert.equal(row.parallel_call_share, 0.5);
    assert.equal(row.tool_calls, 4);
    assert.equal(row.bash_calls, 2);
    assert.equal(row.bash_share, 0.5);
    assert.equal(row.bash_read_calls, 1);
    assert.equal(row.bash_as_read_share, 0.5);
    assert.equal(row.tool_results, 2);
    assert.equal(row.tool_failures, 1);
    assert.equal(row.tool_failure_rate, 0.5);
    assert.deepEqual(row.failures_by_code, { invalid_arguments: 1 });
    assert.deepEqual(row.guardrail_hits, { loop_recovery: 1 });
    assert.equal(row.prompt_tokens, 2_000);
    assert.equal(row.cached_tokens, 1_000);
    assert.equal(row.cache_hit_rate, 0.5);
    assert.equal(row.redundant_reads, 1);
    assert.equal(row.cost_usd, 0.03);
  });

  it("groups sessions by model and skips sessions without a start event", () => {
    const a = [start("model-a"), ev("user_message", { content_blob: "a", source: "typed", attachments: 0 })];
    const b = [start("model-a"), ev("user_message", { content_blob: "b", source: "typed", attachments: 0 })];
    const c = [start("model-b")];
    const orphan = [ev("user_message", { content_blob: "c", source: "typed", attachments: 0 })];

    const rows = computeInsights([a, b, c, orphan]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.model, "model-a");
    assert.equal(rows[0]!.sessions, 2);
    assert.equal(rows[0]!.user_messages, 2);
    assert.equal(rows[1]!.model, "model-b");
  });

  it("returns zeroed ratios instead of NaN when there is nothing to divide", () => {
    const [row] = computeInsights([[start("model-a")]]);
    assert.ok(row);
    assert.equal(row.requests_per_user_message, 0);
    assert.equal(row.parallel_call_share, 0);
    assert.equal(row.bash_share, 0);
    assert.equal(row.bash_as_read_share, 0);
    assert.equal(row.tool_failure_rate, 0);
    assert.equal(row.cache_hit_rate, 0);
  });

  it("formats a readable summary", () => {
    const text = formatInsights(computeInsights([[start("model-a", "deepseek-v4")]]));
    assert.match(text, /model-a · profile deepseek-v4/);
    assert.match(text, /requests\/msg 0/);
    assert.equal(formatInsights([]), "no traced sessions found");
  });
});
