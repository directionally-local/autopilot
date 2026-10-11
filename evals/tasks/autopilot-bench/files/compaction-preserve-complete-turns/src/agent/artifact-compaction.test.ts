import { describe, it } from "node:test";
import assert from "node:assert";
import {
  compactMessagesViaArtifacts,
  shouldCompact,
  recallArtifacts,
} from "./artifact-compaction.js";
import { emptySessionState, ArtifactStore } from "./session-state.js";
import type { ChatMessage } from "./messages.js";

function makeTurn(userText: string, assistantText: string, tools: ChatMessage[] = []): ChatMessage[] {
  const assistant: ChatMessage = {
    role: "assistant",
    content: assistantText,
    tool_calls: tools.length > 0
      ? tools.map((t, i) => {
          const args = t.name === "read" ? JSON.stringify({ path: `src/file${i}.ts` }) : "{}";
          return {
            id: `tc_${i}`,
            type: "function" as const,
            function: { name: t.name ?? "unknown", arguments: args },
          };
        })
      : undefined,
  };
  return [{ role: "user", content: userText }, assistant, ...tools];
}

describe("shouldCompact", () => {
  it("returns false for short history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...makeTurn("hi", "hello"),
    ];
    assert.strictEqual(shouldCompact({ messages, tokenThreshold: 100_000, turnThreshold: 10 }), false);
  });

  it("returns true when turn count exceeds threshold", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 15; i++) {
      messages.push(...makeTurn(`q${i}`, `a${i}`));
    }
    assert.strictEqual(shouldCompact({ messages, tokenThreshold: 100_000, turnThreshold: 10 }), true);
  });
});

describe("compactMessagesViaArtifacts", () => {
  it("returns same messages when below keep threshold", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...makeTurn("q1", "a1"),
      ...makeTurn("q2", "a2"),
    ];
    const state = emptySessionState();
    const store = new ArtifactStore();
    const result = compactMessagesViaArtifacts({ messages, state, store, keepLastTurns: 4 });
    assert.strictEqual(result.metrics.rawTurnsRemoved, 0);
    assert.strictEqual(result.metrics.rawTurnsKept, 2);
    assert.strictEqual(result.newMessages.length, messages.length);
  });

  it("collapses older turns and archives artifacts", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 6; i++) {
      messages.push(
        ...makeTurn(`question ${i}`, `answer ${i}`, [
          { role: "tool", tool_call_id: `tc_${i}`, name: "read", content: `file content ${i} `.repeat(100) },
        ]),
      );
    }
    const state = emptySessionState();
    const store = new ArtifactStore();
    const result = compactMessagesViaArtifacts({ messages, state, store, keepLastTurns: 2 });

    assert.strictEqual(result.metrics.rawTurnsRemoved, 4);
    assert.strictEqual(result.metrics.rawTurnsKept, 2);
    assert.ok(result.metrics.archivedArtifacts > 0);
    assert.ok(result.metrics.estimatedTokensBefore > result.metrics.estimatedTokensAfter);

    // Working memory should only contain last 2 turns
    const userCount = result.newMessages.filter((m) => m.role === "user").length;
    assert.strictEqual(userCount, 2);

    // Session state should have files_touched
    assert.ok(result.newState.files_touched.length > 0);

    // Artifact index should be populated
    assert.ok(Object.keys(result.newState.artifact_index).length > 0);
  });

  it("preserves system prefix", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session" },
      ...makeTurn("q1", "a1"),
      ...makeTurn("q2", "a2"),
      ...makeTurn("q3", "a3"),
    ];
    const state = emptySessionState();
    const store = new ArtifactStore();
    const result = compactMessagesViaArtifacts({ messages, state, store, keepLastTurns: 1 });
    assert.strictEqual(result.newMessages[0]!.role, "system");
    assert.strictEqual(result.newMessages[1]!.role, "system");
    assert.ok(result.newMessages[2]!.content?.toString().includes("compiled session state"));
  });

  it("counts and preserves complete turns with interstitial system messages and tool cycles", () => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    const turns: ChatMessage[][] = [];
    for (let i = 0; i < 100; i++) {
      const callId = `tc_${i}`;
      const turn: ChatMessage[] = [
        { role: "user", content: `question ${i}` },
        // Artifact recall can insert a system message after the user prompt.
        { role: "system", content: `recalled context ${i}` },
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: callId,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: `src/file${i}.ts` }) },
          }],
        },
        { role: "tool", tool_call_id: callId, name: "read", content: `result ${i}` },
        { role: "assistant", content: `final answer ${i}` },
      ];
      messages.push(...turn);
      turns.push(turn);
    }

    assert.strictEqual(shouldCompact({ messages, tokenThreshold: 1_000_000, turnThreshold: 5 }), true);

    const result = compactMessagesViaArtifacts({
      messages,
      state: emptySessionState(),
      store: new ArtifactStore(),
      keepLastTurns: 2,
    });

    assert.strictEqual(result.metrics.rawTurnsRemoved, 98);
    assert.strictEqual(result.metrics.rawTurnsKept, 2);
    assert.deepStrictEqual(result.newMessages.slice(-turns.slice(-2).flat().length), turns.slice(-2).flat());
    assert.ok(result.newMessages.some((m) => m.content === "final answer 98"));
    assert.ok(result.newMessages.some((m) => m.content === "final answer 99"));
  });

  it("extracts decisions from assistant text", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...makeTurn("fix it", "I will refactor the loop into a helper function."),
      ...makeTurn("ok", "done"),
    ];
    const state = emptySessionState();
    const store = new ArtifactStore();
    const result = compactMessagesViaArtifacts({ messages, state, store, keepLastTurns: 1 });
    assert.ok(result.newState.decisions.some((d) => d.includes("refactor")));
  });

  it("extracts failures from bash errors", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      ...makeTurn("run tests", "running", [
        { role: "tool", tool_call_id: "tc_0", name: "bash", content: "Error: test failed" },
      ]),
      ...makeTurn("fix", "ok"),
    ];
    const state = emptySessionState();
    const store = new ArtifactStore();
    const result = compactMessagesViaArtifacts({ messages, state, store, keepLastTurns: 1 });
    assert.ok(result.newState.recent_failures.length > 0);
  });
});

describe("recallArtifacts", () => {
  it("recalls artifacts by file path reference", () => {
    const state = emptySessionState();
    state.artifact_index["a1"] = { type: "read_slice", summary: "read x", source: "read", path: "src/index.ts" };
    const store = new ArtifactStore();
    store.add({ id: "a1", type: "read_slice", summary: "read x", raw: "content", source: "read", path: "src/index.ts", ts: "2024-01-01T00:00:00Z" });

    const messages: ChatMessage[] = [{ role: "user", content: "check src/index.ts" }];
    const { ids, recalled } = recallArtifacts(messages, store, state);
    assert.strictEqual(ids.length, 1);
    assert.strictEqual(recalled.length, 1);
    assert.strictEqual(recalled[0]!.id, "a1");
  });

  it("returns empty when no match", () => {
    const state = emptySessionState();
    const store = new ArtifactStore();
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const { ids, recalled } = recallArtifacts(messages, store, state);
    assert.strictEqual(ids.length, 0);
    assert.strictEqual(recalled.length, 0);
  });

  it("does not pull unrelated bash artifacts when failure keyword matches text", () => {
    const state = emptySessionState();
    state.recent_failures.push("failed: npm test");
    state.artifact_index["b1"] = {
      type: "bash_log",
      summary: "bash: failed test run",
      source: "bash",
    };
    state.artifact_index["b2"] = {
      type: "bash_log",
      summary: "bash: ls -la",
      source: "bash",
    };
    const store = new ArtifactStore();
    store.add({ id: "b1", type: "bash_log", summary: "bash: failed test run", raw: "x", source: "bash", ts: "2024-01-01T00:00:00Z" });
    store.add({ id: "b2", type: "bash_log", summary: "bash: ls -la", raw: "y", source: "bash", ts: "2024-01-01T00:00:00Z" });

    const messages: ChatMessage[] = [{ role: "user", content: "the build failed again" }];
    const { ids } = recallArtifacts(messages, store, state);

    // Only b1 should match: keyword "failed" appears in user text and in b1's summary.
    // b2 must not be pulled in just because it's a bash artifact.
    assert.deepStrictEqual(ids, ["b1"]);
  });
});
