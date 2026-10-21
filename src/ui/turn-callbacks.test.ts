import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyTurnFailure, createTurnCallbacks, settleTurnEvents, toolResultPatch, type TurnCallbackDeps } from "./turn-callbacks.js";
import type { ChatEvent } from "./view-types.js";
import { KimiApiError } from "../util/errors.js";

function harness() {
  let events: ChatEvent[] = [];
  const log: string[] = [];
  let key = 0;
  let asst = 0;
  const deps: TurnCallbackDeps = {
    mkKey: () => `k${key++}`,
    mkAssistantId: () => ++asst,
    setEvents: (update) => {
      events = update(events);
    },
    updateAssistant: (id, patch) => {
      events = events.map((e) => (e.kind === "assistant" && e.id === id ? ({ ...e, ...patch(e) } as ChatEvent) : e));
    },
    updateTool: (id, patch) => {
      events = events.map((e) => (e.kind === "tool" && e.id === id ? ({ ...e, ...patch } as ChatEvent) : e));
    },
    beginTurn: () => log.push("begin"),
    endTurn: () => log.push("end"),
    setTurnPhase: (p) => log.push(`phase:${p}`),
    setCurrentToolName: (n) => log.push(`tool:${n}`),
    activeAsstIdRef: { current: null },
    pendingToolCallsRef: { current: new Map() },
    findTool: (name) => (name === "read" ? { render: (args: { path?: string }) => ({ title: `read ${args.path}` }) } : undefined),
    onUsage: () => {},
    onUsageFinal: () => {},
    onResponseMeta: () => {},
    onTasks: () => {},
    onPlanOptions: () => {},
    askPermission: async () => "allow" as never,
    onKimiMdStale: () => log.push("stale"),
    now: () => 42,
  };
  return { deps, log, events: () => events };
}

const call = (id: string, name = "read", args = `{"path":"a.ts"}`) => ({ id, type: "function" as const, function: { name, arguments: args } });

describe("createTurnCallbacks", () => {
  it("streams an assistant message and ends the turn at the final answer when no tools are pending", () => {
    const h = harness();
    const cb = createTurnCallbacks(h.deps);
    cb.onAssistantStart!();
    cb.onTextDelta!("Hel");
    cb.onTextDelta!("lo");
    cb.onReasoningDelta!("think");
    cb.onAssistantFinal!({ role: "assistant", content: "Hello" });
    const asst = h.events()[0] as Extract<ChatEvent, { kind: "assistant" }>;
    assert.strictEqual(asst.text, "Hello");
    assert.strictEqual(asst.reasoning, "think");
    assert.strictEqual(asst.streaming, false);
    assert.deepStrictEqual(h.log, ["begin", "phase:generating", "phase:waiting", "end"]);
  });

  it("tracks a tool from queued to running to done, and frees the UI when the last result lands", () => {
    const h = harness();
    const cb = createTurnCallbacks(h.deps);
    cb.onToolCallFinalized!(call("c1"));
    cb.onToolCallFinalized!(call("c2", "bash", "{"));
    const queued = h.events() as Array<Extract<ChatEvent, { kind: "tool" }>>;
    assert.deepStrictEqual(queued.map((e) => [e.status, e.render?.title]), [["queued", "read a.ts"], ["queued", undefined]]);
    cb.onToolWillExecute!("c1", "read");
    assert.strictEqual((h.events()[0] as Extract<ChatEvent, { kind: "tool" }>).startedAt, 42);
    cb.onToolResult!({ tool_call_id: "c1", ok: true, content: "file body" } as never);
    assert.ok(!h.log.includes("end"), "one tool still pending");
    cb.onToolResult!({ tool_call_id: "c2", ok: false, content: "Permission denied by user" } as never);
    assert.deepStrictEqual(
      (h.events() as Array<Extract<ChatEvent, { kind: "tool" }>>).map((e) => e.status),
      ["done", "rejected"],
    );
    assert.strictEqual(h.log.at(-1), "end");
  });

  it("surfaces guardrail notices except loop recovery, and memory recall with correct plurals", () => {
    const h = harness();
    const cb = createTurnCallbacks(h.deps);
    cb.onGuardrail!({ kind: "loop_recovery", message: "hidden" } as never);
    cb.onGuardrail!({ kind: "iteration_cap", message: "shown" } as never);
    cb.onMemoryRecalled!(1);
    cb.onMemoryRecalled!(3);
    assert.deepStrictEqual(
      h.events().map((e) => ("text" in e ? e.text : "")),
      ["shown", "recalled 1 memory about this repo", "recalled 3 memories about this repo"],
    );
  });
});

describe("toolResultPatch", () => {
  it("maps guardrail blocks, user rejections, successes and failures", () => {
    assert.deepStrictEqual(toolResultPatch({ tool_call_id: "x", ok: false, content: "loop", guardrail: true } as never), { status: "blocked", result: undefined });
    assert.strictEqual(toolResultPatch({ tool_call_id: "x", ok: false, content: "boom" } as never).status, "error");
  });
});

describe("settleTurnEvents", () => {
  it("stops running tools, cancels queued ones, ends streaming; returns the same array when settled", () => {
    const events: ChatEvent[] = [
      { kind: "tool", key: "a", id: "a", name: "bash", args: "{}", status: "running", expanded: false },
      { kind: "tool", key: "b", id: "b", name: "bash", args: "{}", status: "queued", expanded: false },
      { kind: "assistant", key: "c", id: 1, text: "", reasoning: "", streaming: true },
    ];
    const settled = settleTurnEvents(events);
    assert.deepStrictEqual(
      settled.map((e) => (e.kind === "tool" ? e.status : e.kind === "assistant" ? e.streaming : null)),
      ["error", "cancelled", false],
    );
    assert.strictEqual(settleTurnEvents(settled), settled);
  });
});

describe("classifyTurnFailure", () => {
  it("separates aborts, transient provider errors and everything else", () => {
    assert.deepStrictEqual(classifyTurnFailure(new DOMException("x", "AbortError")), { kind: "aborted" });
    const busy = classifyTurnFailure(new KimiApiError("Too many requests", 7, 429));
    assert.strictEqual(busy.kind, "api_error");
    assert.strictEqual(busy.kind === "api_error" && busy.httpStatus, 429);
    assert.strictEqual(classifyTurnFailure(new KimiApiError("bad request", undefined, 400)).kind, "error");
    assert.deepStrictEqual(classifyTurnFailure(new Error("nope")), { kind: "error", text: "nope" });
  });
});
