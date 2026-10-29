import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyAsterEvent, initialAsterState, totalCostUsd, type AsterViewState } from "./attach-adapter.js";
import type { RemoteEvent } from "./client.js";

function feed(events: Array<Omit<RemoteEvent, "id"> & { id?: number }>, state: AsterViewState = initialAsterState()) {
  const effects = [];
  let id = state.lastEventId;
  for (const e of events) effects.push(...applyAsterEvent(state, { id: e.id ?? ++id, type: e.type, data: e.data }));
  return { state, effects };
}

describe("attach-remote adapter: Aster events → UI state", () => {
  it("assistant.delta streams into one open assistant message (text or delta field)", () => {
    const { state } = feed([
      { type: "assistant.delta", data: { text: "Hello " } },
      { type: "assistant.delta", data: { delta: "world" } },
    ]);
    assert.equal(state.events.length, 1);
    const msg = state.events[0]!;
    assert.equal(msg.kind, "assistant");
    assert.equal(msg.kind === "assistant" && msg.text, "Hello world");
    assert.equal(msg.kind === "assistant" && msg.streaming, true);
    assert.equal(state.running, true);
    assert.equal(state.phase, "generating");
  });

  it("assistant.reasoning goes to the message's reasoning", () => {
    const { state } = feed([{ type: "assistant.reasoning", data: { text: "thinking" } }, { type: "assistant.delta", data: { text: "answer" } }]);
    const msg = state.events[0]!;
    assert.ok(msg.kind === "assistant" && msg.reasoning === "thinking" && msg.text === "answer");
  });

  it("tool.activity started/completed becomes one tool row with input and output", () => {
    const { state } = feed([
      { type: "assistant.delta", data: { text: "Let me run the tests." } },
      { type: "tool.activity", data: { tool: "bash", toolCallId: "t1", activity: "started", input: "npm test" } },
    ]);
    assert.equal(state.events[0]!.kind === "assistant" && state.events[0]!.streaming, false, "a tool closes the assistant message");
    assert.equal(state.phase, "executing");
    assert.equal(state.currentTool, "bash");
    feed([{ type: "tool.activity", data: { tool: "bash", toolCallId: "t1", activity: "completed", output: "2 passing" } }], state);
    const tools = state.events.filter((e) => e.kind === "tool");
    assert.equal(tools.length, 1);
    assert.deepEqual(
      tools.map((t) => t.kind === "tool" && { name: t.name, args: t.args, status: t.status, result: t.result }),
      [{ name: "bash", args: "npm test", status: "done", result: "2 passing" }],
    );
    assert.equal(state.currentTool, null);
    // Text after a tool starts a new assistant message, like a new model step.
    feed([{ type: "assistant.delta", data: { text: "Done." } }], state);
    assert.equal(state.events.filter((e) => e.kind === "assistant").length, 2);
  });

  it("a failed tool is an error row; a rejected one is a warning notice", () => {
    const { state } = feed([
      { type: "tool.activity", data: { tool: "edit", toolCallId: "t2", activity: "started", input: "src/a.ts" } },
      { type: "tool.activity", data: { tool: "edit", toolCallId: "t2", activity: "failed", output: "no such file" } },
      { type: "tool.activity", data: { tool: "write", activity: "rejected", reason: "workspace_path_forbidden" } },
      { type: "tool.activity", data: { tool: "edit", activity: "proposed" } },
    ]);
    const tool = state.events.find((e) => e.kind === "tool");
    assert.ok(tool?.kind === "tool" && tool.status === "error" && tool.result === "no such file");
    const warn = state.events.find((e) => e.kind === "info");
    assert.ok(warn?.kind === "info" && warn.tone === "warn" && /write was not run \(workspace path forbidden\)/.test(warn.text));
    assert.equal(state.events.length, 2, "proposed adds nothing");
  });

  it("todo.updated replaces the task list, mapping done → completed", () => {
    const { state } = feed([
      { type: "todo.updated", data: { items: [{ title: "a", status: "done" }, { title: "b", status: "in_progress" }, { title: "c", status: "pending" }] } },
    ]);
    assert.deepEqual(state.tasks, [
      { id: "1", title: "a", status: "completed" },
      { id: "2", title: "b", status: "in_progress" },
      { id: "3", title: "c", status: "pending" },
    ]);
    feed([{ type: "todo.updated", data: { items: [] } }], state);
    assert.deepEqual(state.tasks, []);
  });

  it("usage is cumulative per run; cost carries across runs", () => {
    const { state } = feed([
      { type: "usage", data: { inputTokens: 100, outputTokens: 10, costUsd: 0.01, cumulative: true } },
      { type: "usage", data: { inputTokens: 300, outputTokens: 30, costUsd: 0.03, cumulative: true } },
    ]);
    assert.deepEqual(state.usage, { prompt_tokens: 300, completion_tokens: 30, total_tokens: 330, cost: 0.03 });
    assert.equal(totalCostUsd(state), 0.03);
    feed([{ type: "completed", data: {} }, { type: "usage", data: { inputTokens: 50, outputTokens: 5, costUsd: 0.02, cumulative: true } }], state);
    assert.ok(Math.abs(totalCostUsd(state) - 0.05) < 1e-9);
  });

  it("terminal events end the turn: completed, failed (error), cancelled, interrupted", () => {
    for (const [type, data, check] of [
      ["completed", {}, (s: AsterViewState) => !s.events.some((e) => e.kind === "error")],
      ["failed", { reason: "cell_turn_lost" }, (s: AsterViewState) => s.events.some((e) => e.kind === "error" && /failed: cell_turn_lost/.test(e.text))],
      ["cancelled", { code: "cancelled_by_client" }, (s: AsterViewState) => s.events.some((e) => e.kind === "info" && e.text === "Turn cancelled.")],
      ["interrupted", { reason: "server_restart_recovery" }, (s: AsterViewState) => s.events.some((e) => e.kind === "info" && /interrupted/.test(e.text))],
    ] as const) {
      const { state, effects } = feed([
        { type: "assistant.delta", data: { text: "x" } },
        { type: "tool.activity", data: { tool: "bash", toolCallId: "t", activity: "started", input: "sleep 9" } },
        { type, data },
      ]);
      assert.equal(state.running, false, type);
      assert.ok(check(state), type);
      assert.deepEqual(effects, [{ kind: "turnEnded", status: type }]);
      const tool = state.events.find((e) => e.kind === "tool");
      assert.ok(tool?.kind === "tool" && tool.status !== "running", `${type} settles running tools`);
      const msg = state.events.find((e) => e.kind === "assistant");
      assert.ok(msg?.kind === "assistant" && !msg.streaming);
    }
  });

  it("approval.required asks for a decision; approval.resolved/expired clears it", () => {
    const { state, effects } = feed([{ type: "approval.required", data: { approvalId: "ap1", tool: "edit", explanation: "Edit src/a.ts", expiresAt: 123 } }]);
    assert.deepEqual(effects, [{ kind: "approvalRequired", approvalId: "ap1" }]);
    assert.deepEqual(state.approval, { approvalId: "ap1", tool: "edit", explanation: "Edit src/a.ts", expiresAt: 123 });
    const resolved = feed([{ type: "approval.resolved", data: { approvalId: "ap1", decision: "allow" } }], state);
    assert.deepEqual(resolved.effects, [{ kind: "approvalResolved", approvalId: "ap1" }]);
    assert.equal(state.approval, null);
    feed([{ type: "approval.required", data: { approvalId: "ap2", tool: "write" } }, { type: "approval.expired", data: { approvalId: "ap2" } }], state);
    assert.equal(state.approval, null);
    assert.ok(state.events.some((e) => e.kind === "info" && /expired/.test(e.text)));
  });

  it("checkpoints, outcomes, memory, artifacts and lifecycle events become notices", () => {
    const { state } = feed([
      { type: "checkpoint.created", data: { id: "abcdef1234", message: "Fix tests" } },
      { type: "checkpoint.restored", data: { restoredFrom: "1234567890" } },
      { type: "outcome", data: { summary: "No repository changes were made; no pull request was opened." } },
      { type: "outcome.failed", data: { reason: "git_push_failed" } },
      { type: "memory.updated", data: { items: [{}, {}] } },
      { type: "artifact.updated", data: { path: "artifacts/report.md" } },
      { type: "conversation.paused", data: {} },
      { type: "conversation.created", data: {} },
      { type: "some.future.event", data: {} },
    ]);
    const texts = state.events.map((e) => `${e.kind}:${"text" in e ? e.text : ""}`);
    assert.deepEqual(texts, [
      "info:Checkpoint abcdef1 · Fix tests",
      "info:Workspace restored to checkpoint 1234567",
      "info:No repository changes were made; no pull request was opened.",
      "error:The changes couldn't be pushed to the conversation branch.",
      "memory:Remembered 2 things for this project",
      "info:Artifact updated: artifacts/report.md",
      "info:The conversation's sandbox was paused.",
    ]);
  });

  it("ignores events at or below the last applied ID (at-least-once delivery)", () => {
    const state = initialAsterState();
    applyAsterEvent(state, { id: 1, type: "assistant.delta", data: { text: "a" } });
    assert.deepEqual(applyAsterEvent(state, { id: 1, type: "assistant.delta", data: { text: "a" } }), []);
    applyAsterEvent(state, { id: 2, type: "assistant.delta", data: { text: "b" } });
    const msg = state.events[0]!;
    assert.ok(msg.kind === "assistant" && msg.text === "ab");
    assert.equal(state.lastEventId, 2);
  });
});
