import { describe, it } from "node:test";
import assert from "node:assert";
import { handoffPingNotice, handoffWarningNotice, turnFill, turnNudges, type TurnNudgeInput } from "./turn-nudges.js";

const base: TurnNudgeInput = {
  turn: 1,
  hasContextFile: true,
  contextStale: false,
  mode: "edit",
  estimatedTokens: 0,
  budgetTokens: 1_000,
  pingDelivered: false,
  warningDelivered: false,
};

describe("turnNudges", () => {
  it("shows the /init tip every 15th turn when there's a context file that isn't already flagged stale", () => {
    assert.strictEqual(turnNudges({ ...base, turn: 15 }).initTip, true);
    assert.strictEqual(turnNudges({ ...base, turn: 16 }).initTip, false);
    assert.strictEqual(turnNudges({ ...base, turn: 15, hasContextFile: false }).initTip, false);
    assert.strictEqual(turnNudges({ ...base, turn: 15, contextStale: true }).initTip, false);
  });

  it("criterion 7: a long session below 50% does not auto-fresh; a short session above 80% does", () => {
    // 40 turns at 30% fill: the turn count no longer decides anything.
    assert.strictEqual(turnNudges({ ...base, turn: 40, estimatedTokens: 300 }).fresh, null);
    // 3 turns at 82% fill: the warning is the auto-fresh trigger.
    assert.strictEqual(turnNudges({ ...base, turn: 3, estimatedTokens: 820 }).fresh, "warning");
  });

  it("criterion 11: 49% gets no ping, 79% gets the ping and no transition", () => {
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 490 }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 790 }).fresh, "ping");
  });

  it("delivers each notice once, and the warning supersedes an undelivered ping", () => {
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 550, pingDelivered: true }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 850, warningDelivered: true }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 850, pingDelivered: true }).fresh, "warning");
  });

  it("only nudges auto/edit sessions, and only with a known budget", () => {
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 900, mode: "plan" }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 900, budgetTokens: 0 }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: undefined }).fresh, null);
  });

  it("honors tunable shares", () => {
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 600, shares: { ping: 0.7 } }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, estimatedTokens: 700, shares: { ping: 0.7 } }).fresh, "ping");
  });

  it("phrases the ping and warning with the fill percentage", () => {
    assert.match(handoffPingNotice(0.55), /55% of the input budget.*natural break/);
    assert.match(handoffWarningNotice(0.82), /82% of the input budget.*final handoff/);
  });

  it("computes the fill fraction", () => {
    assert.strictEqual(turnFill({ estimatedTokens: 500, budgetTokens: 1_000 }), 0.5);
    assert.strictEqual(turnFill({ estimatedTokens: 500, budgetTokens: 0 }), 0);
    assert.strictEqual(turnFill({ estimatedTokens: undefined, budgetTokens: 1_000 }), 0);
  });
});
