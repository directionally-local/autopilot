import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactToFit,
  effectiveInputBudget,
  hardCompactionThreshold,
  proactiveCompactionThreshold,
  sessionFileCompactionTarget,
  softCompactionThreshold,
} from "./context-budget.js";
import { estimatePromptTokens } from "./artifact-compaction.js";
import type { ChatMessage } from "./messages.js";
import type { SerializedArtifact, SessionState } from "./session-state.js";

/** A complete turn: user → assistant tool call → tool result → assistant answer. */
function turn(i: number, payloadChars: number): ChatMessage[] {
  return [
    { role: "user", content: `question ${i}` },
    { role: "assistant", content: null, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }] },
    { role: "tool", tool_call_id: `c${i}`, name: "read", content: "x".repeat(payloadChars) },
    { role: "assistant", content: `answer ${i}` },
  ];
}

function history(turns: number, payloadChars: number): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < turns; i++) out.push(...turn(i, payloadChars));
  return out;
}

function memoryTarget() {
  const file: { sessionState?: SessionState; artifactStore?: SerializedArtifact[] } = {};
  return { file, target: sessionFileCompactionTarget(file) };
}

describe("context budget", () => {
  it("derives the input budget and proactive threshold from the model", () => {
    // Unknown models are inferred at a 128k window.
    assert.equal(effectiveInputBudget("unknown/model"), 128_000 - 16_384 - 8_192);
    assert.equal(effectiveInputBudget("unknown/model", 4_096), 128_000 - 4_096 - 8_192);
    const budget = 128_000 - 16_384 - 8_192;
    assert.equal(softCompactionThreshold("unknown/model"), Math.floor(budget * 0.6));
    assert.equal(hardCompactionThreshold("unknown/model"), Math.floor(budget * 0.85));
    // The deprecated alias now follows the budget instead of the 80k cap.
    assert.equal(proactiveCompactionThreshold("unknown/model"), softCompactionThreshold("unknown/model"));
  });

  it("scales thresholds with large windows and honors an opt-in absolute cap", () => {
    const large = effectiveInputBudget("moonshotai/kimi-k3");
    assert.equal(softCompactionThreshold("moonshotai/kimi-k3"), Math.floor(large * 0.6));
    assert.ok(softCompactionThreshold("moonshotai/kimi-k3") > 80_000, "no 80k cap by default");
    assert.equal(softCompactionThreshold("moonshotai/kimi-k3", { absoluteCapTokens: 80_000 }), 80_000);
    assert.equal(hardCompactionThreshold("moonshotai/kimi-k3", { absoluteCapTokens: 80_000 }), 80_000);
  });

  it("compacts older complete turns until the history fits, keeping the active turn", () => {
    const messages = history(8, 35_000); // ~10k tokens per turn
    const active = messages.slice(-4);
    const { file, target } = memoryTarget();
    const budget = 25_000;
    const outcome = compactToFit(messages, budget, target)!;
    assert.ok(outcome, "compaction ran");
    assert.ok(outcome.tokensAfter <= budget, `fits: ${outcome.tokensAfter}`);
    assert.equal(outcome.tokensAfter, estimatePromptTokens(outcome.messages));
    assert.deepEqual(outcome.messages.slice(-4), active, "active turn kept intact");
    assert.equal(outcome.messages[0]!.content, "system prompt");
    // Every kept tool result still has its assistant tool call.
    const callIds = new Set(outcome.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
    for (const m of outcome.messages.filter((m) => m.role === "tool")) assert.ok(callIds.has(m.tool_call_id!));
    // Archived raw content is persisted on the session file, not dropped.
    assert.ok((file.artifactStore?.length ?? 0) > 0);
    assert.ok(Object.keys(file.sessionState?.artifact_index ?? {}).length > 0);
  });

  it("keeps the larger working set when it already fits", () => {
    const messages = history(8, 35_000);
    const { target } = memoryTarget();
    const outcome = compactToFit(messages, 60_000, target)!;
    assert.equal(outcome.turnsRemoved, 4, "kept the last four turns");
  });

  it("returns null when only the active turn exists", () => {
    const { target } = memoryTarget();
    assert.equal(compactToFit(history(1, 500_000), 1_000, target), null);
  });

  it("does not stack compiled state messages across repeated compactions", () => {
    const { target } = memoryTarget();
    const first = compactToFit(history(8, 35_000), 25_000, target)!;
    const grown = [...first.messages, ...turn(100, 35_000), ...turn(101, 35_000), ...turn(102, 35_000)];
    const second = compactToFit(grown, 25_000, target)!;
    const stateMessages = second.messages.filter((m) => m.role === "system" && String(m.content).startsWith("[compiled session state]"));
    assert.equal(stateMessages.length, 1);
  });
});
