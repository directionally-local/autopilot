import { describe, it } from "node:test";
import assert from "node:assert";
import { createTriageCoordinator, decideSubmit, describeActivity, pushHistory, type SubmitState, type TriageDeps } from "./input-coordinator.js";
import type { QueuedPrompt } from "../agent/queue-batch.js";
import type { TriageResult } from "../agent/inbox-triage.js";

const idle: SubmitState = { busy: false, queue: [], history: [], historyIndex: -1, editTarget: null, editTargetVisible: false };
const q = (key: string, full = `prompt ${key}`): QueuedPrompt => ({ key, full, display: full });

describe("decideSubmit", () => {
  it("runs when idle, queues chat prompts and commands when busy", () => {
    assert.deepStrictEqual(decideSubmit("", "", idle), { do: "ignore" });
    assert.deepStrictEqual(decideSubmit("fix it", "fix it", idle), { do: "run" });
    const busy = { ...idle, busy: true };
    assert.deepStrictEqual(decideSubmit("also add tests", "also add tests", busy), { do: "enqueue", isChatPrompt: true });
    assert.deepStrictEqual(decideSubmit("/model", "/model", busy), { do: "enqueue", isChatPrompt: false });
    assert.deepStrictEqual(decideSubmit("!ls", "!ls", busy), { do: "enqueue", isChatPrompt: false });
  });

  it("subagent management and /now act immediately", () => {
    assert.deepStrictEqual(decideSubmit("/subagents cancel 1", "/subagents cancel 1", { ...idle, busy: true }), { do: "subagent-command" });
    assert.deepStrictEqual(decideSubmit("/now", "/now", idle), { do: "run-now" });
  });

  it("/queue plan needs two groupable chat prompts", () => {
    assert.match(String((decideSubmit("/queue plan", "/queue plan", { ...idle, queue: [q("a")] }) as { notice?: string }).notice), /at least two/);
    assert.match(String((decideSubmit("/queue plan", "/queue plan", { ...idle, queue: [q("a"), q("b", "/model")] }) as { notice?: string }).notice), /only groups chat prompts/);
    assert.deepStrictEqual(decideSubmit("/queue plan", "/queue plan", { ...idle, queue: [q("a"), q("b")] }), { do: "queue-plan" });
  });

  it("editing the latest prompt: unchanged, still queued, or rerun from before it", () => {
    const target = { key: "k1", historyText: "old", messagesBefore: [{ role: "user" as const, content: "earlier" }] };
    const editing = { ...idle, history: ["x", "old"], historyIndex: 1, editTarget: target, editTargetVisible: true };
    assert.deepStrictEqual(decideSubmit("old", "old", editing), { do: "edit-unchanged" });
    const queued = decideSubmit("new", "new", { ...editing, queue: [q("k1", "old")] });
    assert.strictEqual(queued.do, "edit-queued");
    assert.strictEqual(queued.do === "edit-queued" && queued.queue[0]?.full, "new");
    assert.strictEqual(decideSubmit("new", "new", editing).do, "edit-rerun");
    // Not browsing the latest history entry, or its event is gone: a normal submit.
    assert.strictEqual(decideSubmit("new", "new", { ...editing, historyIndex: 0 }).do, "run");
    assert.strictEqual(decideSubmit("new", "new", { ...editing, editTargetVisible: false }).do, "run");
    // Still queued with no history snapshot and not in the queue anymore: falls through.
    assert.strictEqual(decideSubmit("new", "new", { ...editing, editTarget: { ...target, messagesBefore: null } }).do, "run");
  });
});

describe("pushHistory", () => {
  it("skips an immediate repeat", () => {
    assert.deepStrictEqual(pushHistory(["a"], "a"), ["a"]);
    assert.deepStrictEqual(pushHistory(["a"], "b"), ["a", "b"]);
  });
});

describe("describeActivity", () => {
  it("summarizes the task, progress, tools and subagents", () => {
    const snap = describeActivity({
      messages: [
        { role: "user", content: "refactor auth" },
        { role: "assistant", content: "Looking at the middleware" },
        { role: "user", content: "[Message from the user while you work] hi" },
      ],
      tasks: [
        { id: "1", title: "read", status: "completed" },
        { id: "2", title: "edit", status: "in_progress" },
      ] as never,
      pendingTools: ["bash"],
      workers: [{ task: "audit tests" }],
    });
    assert.deepStrictEqual(snap, {
      currentTask: "refactor auth",
      recentAssistantText: "Looking at the middleware",
      progress: "1/2 tasks done; working on: edit",
      activity: "tools: bash · 1 subagent(s): audit tests",
    });
  });
});

function triageHarness(result: TriageResult, over: Partial<TriageDeps> = {}) {
  let queue: QueuedPrompt[] = [];
  const log: string[] = [];
  const deps: TriageDeps = {
    isBusy: () => true,
    subagentsRunning: () => false,
    getQueue: () => queue,
    setQueue: (update) => {
      queue = update(queue);
    },
    markDelivered: (key, note) => log.push(`delivered ${key}: ${note}`),
    notice: (text) => log.push(`notice: ${text}`),
    transcriptQueueNotes: false,
    activity: () => ({ currentTask: "t" }),
    triage: async () => result,
    answerAside: async (text) => `answer to ${text}`,
    steer: (item, content) => log.push(`steer ${item.key}: ${content.slice(0, 20)}`),
    interrupt: () => log.push("interrupt"),
    ...over,
  };
  const coord = createTriageCoordinator(deps);
  return { coord, log, queue: () => queue, setQueue: (items: QueuedPrompt[]) => (queue = items) };
}

describe("createTriageCoordinator", () => {
  it("steer: pulls the prompt out of the queue and delivers it to the running turn", async () => {
    const h = triageHarness({ kind: "steer", source: "model", reason: "related" });
    h.setQueue([q("a")]);
    await h.coord.triageQueued(q("a"));
    assert.deepStrictEqual(h.queue(), []);
    assert.match(h.log[0]!, /^steer a:/);
    assert.match(h.log[1]!, /^delivered a: steering the current task/);
  });

  it("interrupt: moves it to the front of the queue and interrupts", async () => {
    const h = triageHarness({ kind: "interrupt", source: "rule", reason: "stop" });
    h.setQueue([q("x"), q("a")]);
    await h.coord.triageQueued(q("a"));
    assert.deepStrictEqual(h.queue().map((i) => i.key), ["a", "x"]);
    assert.deepStrictEqual(h.log.slice(-1), ["interrupt"]);
  });

  it("aside: answers without stopping the agent, unless it already ran", async () => {
    const h = triageHarness({ kind: "aside", source: "model", reason: "question" });
    h.setQueue([q("a", "what's a monad?")]);
    await h.coord.triageQueued(q("a", "what's a monad?"));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(h.log, ["delivered a: aside (the agent keeps working): answer to what's a monad?"]);
  });

  it("queue: keeps it queued with the reason; Camouflage gets a transcript note", async () => {
    const h = triageHarness({ kind: "queue", source: "default", reason: "unsure" }, { transcriptQueueNotes: true });
    h.setQueue([q("a")]);
    await h.coord.triageQueued(q("a"));
    assert.deepStrictEqual(h.queue()[0]?.triage, { source: "default", reason: "unsure" });
    assert.match(h.log[0]!, /queued \(unsure\) — runs after the current turn/);
  });

  it("ignores results for prompts that already ran; promoteLatest steers the newest triaged prompt", async () => {
    const h = triageHarness({ kind: "steer", source: "model", reason: "r" });
    await h.coord.triageQueued(q("gone"));
    assert.deepStrictEqual(h.log, []);
    h.setQueue([{ ...q("a"), triage: { source: "pending", reason: "deciding…" } }, q("plain")]);
    assert.strictEqual(h.coord.promoteLatest(), true);
    assert.deepStrictEqual(h.queue().map((i) => i.key), ["plain"]);
    assert.match(h.log.at(-1)!, /running this first/);
  });
});
