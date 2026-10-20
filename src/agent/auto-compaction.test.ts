import { describe, it } from "node:test";
import assert from "node:assert";
import { compactAfterTurn, compactConversation, compactMidTurn, type AutoCompactionDeps } from "./auto-compaction.js";
import { prepareAutoFresh, preFreshCheckpoint } from "./auto-fresh.js";
import { ArtifactStore, emptySessionState, type SessionState } from "./session-state.js";
import type { ChatMessage } from "./messages.js";
import { createMemoryRecorder } from "../trace/recorder.js";

function history(turns: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `question ${i} ${"x".repeat(200)}` }, { role: "assistant", content: `answer ${i}` });
  }
  return messages;
}

function harness(over: Partial<AutoCompactionDeps> = {}) {
  let state: SessionState = emptySessionState("the task");
  const notices: Array<[string, string]> = [];
  const calls = { saves: 0, preCompact: 0, summarize: [] as Array<{ keepLastTurns?: number }> };
  const deps: AutoCompactionDeps = {
    compiledContext: true,
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    store: new ArtifactStore(),
    summarize: async (messages, opts) => {
      calls.summarize.push({ ...(opts.keepLastTurns !== undefined ? { keepLastTurns: opts.keepLastTurns } : {}) });
      const keep = messages.slice(-2);
      return { summary: "sum", newMessages: [messages[0]!, { role: "system", content: "summary" }, ...keep], replacedCount: messages.length - 3 };
    },
    cwd: "/repo",
    notify: (kind, text) => notices.push([kind, text]),
    save: () => {
      calls.saves++;
    },
    firePreCompact: () => {
      calls.preCompact++;
    },
    ...over,
  };
  return { deps, notices, calls, state: () => state };
}

describe("compactConversation", () => {
  it("compiled context: archives older turns, updates state, notifies, saves and traces", async () => {
    const trace = createMemoryRecorder();
    const h = harness({ trace, turnId: "t1" });
    const pass = await compactConversation(history(10), h.deps);
    assert.strictEqual(pass.compacted, true);
    assert.ok(pass.messages.length < history(10).length);
    assert.strictEqual(h.calls.saves, 1);
    assert.match(h.notices[0]![1], /^auto-compacted: \d+ → \d+ tokens \(\d+ artifacts\)$/);
    assert.notStrictEqual(h.state(), emptySessionState("the task"));
    assert.strictEqual(trace.ofType("compaction")[0]?.payload.method, "compiled");
    assert.strictEqual(trace.ofType("compaction")[0]?.turn_id, "t1");
  });

  it("does nothing (no save, no notice) when there is nothing to compact", async () => {
    const h = harness();
    const pass = await compactConversation(history(2), h.deps);
    assert.strictEqual(pass.compacted, false);
    assert.strictEqual(h.calls.saves, 0);
    assert.deepStrictEqual(h.notices, []);
  });

  it("plain context: summarizes with the LLM; aggressive keeps one turn and says so", async () => {
    const h = harness({ compiledContext: false });
    const pass = await compactConversation(history(10), h.deps, { aggressive: true });
    assert.strictEqual(pass.compacted, true);
    assert.deepStrictEqual(h.calls.summarize, [{ keepLastTurns: 1 }]);
    assert.match(h.notices[0]![1], /^auto-compacted \(aggressive\): \d+ messages summarized$/);
  });
});

describe("compactMidTurn", () => {
  it("fires PreCompact, compacts and re-anchors memories once", async () => {
    const h = harness({
      memory: { recall: async () => [{ id: 1 }, { id: 2 }], synthesizeRecalled: async () => "remember: tabs" },
    });
    const out = await compactMidTurn(history(10), h.deps, new AbortController().signal);
    assert.strictEqual(h.calls.preCompact, 1);
    assert.ok(out.some((m) => typeof m.content === "string" && m.content.includes("remember: tabs")));
    assert.deepStrictEqual(h.notices.at(-1), ["memory", "recalled 2 memories after compaction"]);
  });

  it("keeps the original messages when the summarizer fails, and skips work once aborted", async () => {
    const h = harness({ compiledContext: false, summarize: async () => { throw new Error("down"); } });
    const input = history(10);
    assert.strictEqual(await compactMidTurn(input, h.deps, new AbortController().signal), input);
    const aborted = AbortSignal.abort();
    assert.strictEqual(await compactMidTurn(input, h.deps, aborted), input);
    assert.strictEqual(h.calls.preCompact, 1, "aborted turn: no PreCompact");
  });
});

describe("compactAfterTurn", () => {
  const run = async (h: ReturnType<typeof harness>, messages: ChatMessage[], o: { overThreshold: boolean; tokens: (m: ChatMessage[]) => number }) => {
    let current = messages;
    const after = await compactAfterTurn(
      {
        getMessages: () => current,
        setMessages: (m) => {
          current = m;
        },
        overThreshold: o.overThreshold,
        estimateTokens: o.tokens,
        aggressiveTokenThreshold: 1000,
        signal: new AbortController().signal,
      },
      h.deps,
    );
    return { after, current };
  };

  it("proactive pass only when over the threshold; null when the history isn't huge", async () => {
    const h = harness();
    const { after, current } = await run(h, history(10), { overThreshold: true, tokens: () => 10 });
    assert.strictEqual(after, null);
    assert.ok(current.length < history(10).length);
    assert.strictEqual(h.calls.preCompact, 1);
    const idle = harness();
    const r = await run(idle, history(10), { overThreshold: false, tokens: () => 10 });
    assert.strictEqual(r.current.length, history(10).length);
    assert.strictEqual(idle.calls.preCompact, 0);
  });

  it("runs the aggressive pass when still huge and reports the tokens left (host decides on auto-fresh)", async () => {
    const h = harness({ compiledContext: false });
    const { after } = await run(h, history(10), { overThreshold: false, tokens: (m) => m.length * 1000 });
    assert.deepStrictEqual(h.calls.summarize, [{ keepLastTurns: 1 }]);
    assert.strictEqual(after, 4000);
  });

  it("reports summarizer failures (but not aborts) as notices", async () => {
    const h = harness({ compiledContext: false, summarize: async () => { throw new Error("rate limited"); } });
    await run(h, history(10), { overThreshold: true, tokens: () => 10 });
    assert.deepStrictEqual(h.notices, [["info", "auto-compact failed: rate limited"]]);
    const quiet = harness({
      compiledContext: false,
      summarize: async () => { throw new DOMException("aborted", "AbortError"); },
    });
    await run(quiet, history(10), { overThreshold: true, tokens: () => 10 });
    assert.deepStrictEqual(quiet.notices, []);
  });
});

describe("auto-fresh", () => {
  const base = { compiledContext: true, sessionState: emptySessionState("t"), artifactStore: new ArtifactStore(), now: () => 1_700_000_000_000 };

  it("checkpoints a non-empty session before summarizing", async () => {
    const order: string[] = [];
    const summary = await prepareAutoFresh({
      ...base,
      messages: history(1),
      saveCheckpoint: async (cp) => {
        order.push(`checkpoint ${cp.id} @${cp.turnIndex}`);
      },
      summarize: async () => {
        order.push("summarize");
        return "carry on";
      },
    });
    assert.strictEqual(summary, "carry on");
    assert.deepStrictEqual(order, ["checkpoint cp_prefresh_1700000000000 @3", "summarize"]);
  });

  it("has no checkpoint for an empty session, and keeps state only for compiled context", () => {
    assert.strictEqual(preFreshCheckpoint({ ...base, messages: [] }), null);
    assert.ok(preFreshCheckpoint({ ...base, messages: history(1) })?.sessionState);
    assert.strictEqual(preFreshCheckpoint({ ...base, compiledContext: false, messages: history(1) })?.sessionState, undefined);
  });
});
