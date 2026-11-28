import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compactToFit,
  contextFillFraction,
  effectiveInputBudget,
  HANDOFF_PING_SHARE,
  HANDOFF_WARNING_SHARE,
  HARD_COMPACTION_SHARE,
  handoffPingThreshold,
  handoffTrigger,
  handoffWarningThreshold,
  hardCompactionThreshold,
  proactiveCompactionThreshold,
  sessionFileCompactionTarget,
  SOFT_COMPACTION_SHARE,
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

describe("context-fill handoff trigger", () => {
  it("decides on the fill fraction: nothing below 50%, ping to 80%, warning above", () => {
    assert.equal(handoffTrigger(0), "none");
    assert.equal(handoffTrigger(0.49), "none");
    assert.equal(handoffTrigger(0.5), "ping");
    assert.equal(handoffTrigger(0.55), "ping");
    assert.equal(handoffTrigger(0.79), "ping");
    assert.equal(handoffTrigger(0.8), "warning");
    assert.equal(handoffTrigger(0.82), "warning");
    assert.equal(handoffTrigger(1), "warning");
  });

  it("keeps both thresholds below the compaction shares so the handoff fires first", () => {
    assert.ok(HANDOFF_PING_SHARE < SOFT_COMPACTION_SHARE);
    assert.ok(HANDOFF_WARNING_SHARE < HARD_COMPACTION_SHARE);
  });

  it("derives the thresholds from the effective input budget (mocked budget)", () => {
    const budget = effectiveInputBudget("unknown/model");
    assert.equal(handoffPingThreshold("unknown/model"), Math.floor(budget * 0.5));
    assert.equal(handoffWarningThreshold("unknown/model"), Math.floor(budget * 0.8));
    assert.ok(handoffPingThreshold("unknown/model") < softCompactionThreshold("unknown/model"));
    assert.ok(handoffWarningThreshold("unknown/model") < hardCompactionThreshold("unknown/model"));
  });

  it("computes the fill fraction and tolerates a missing budget", () => {
    assert.equal(contextFillFraction(500, 1_000), 0.5);
    assert.equal(contextFillFraction(0, 1_000), 0);
    assert.equal(contextFillFraction(500, 0), 0);
    assert.equal(contextFillFraction(500, Number.NaN), 0);
  });

  it("honors tunable shares", () => {
    assert.equal(handoffTrigger(0.6, { ping: 0.7 }), "none");
    assert.equal(handoffTrigger(0.7, { ping: 0.7 }), "ping");
    assert.equal(handoffTrigger(0.9, { warning: 0.95 }), "ping");
  });
});

describe("context budget: a local server's reported context", () => {
  it("uses the served context, the capped reply and a margin that fits the window", async () => {
    const { localContextLength, resetLocalContextForTesting } = await import("../models/local-context.js");
    const { effectiveInputBudget } = await import("./context-budget.js");
    resetLocalContextForTesting();
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [{ id: "served-model", max_model_len: 32768 }] }))) as unknown as typeof fetch;
    const before = effectiveInputBudget("served-model");
    await localContextLength({ baseUrl: "http://127.0.0.1:8000/v1", providerId: "vllm" }, "served-model", { fetchImpl });
    // 32768 - min(16384, 32768 / 2) - 32768 / 16
    assert.equal(effectiveInputBudget("served-model"), 32768 - 16384 - 2048);
    assert.notEqual(before, effectiveInputBudget("served-model"));
    resetLocalContextForTesting();
  });
});
