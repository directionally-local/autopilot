import { describe, it } from "node:test";
import assert from "node:assert";
import { freshSuggestion, turnNudges, type TurnNudgeInput } from "./turn-nudges.js";

const base: TurnNudgeInput = {
  turn: 1,
  hasContextFile: true,
  contextStale: false,
  mode: "edit",
  freshAfterTurns: 30,
  freshSuggested: false,
  autoFreshEnabled: false,
};

describe("turnNudges", () => {
  it("shows the /init tip every 15th turn when there's a context file that isn't already flagged stale", () => {
    assert.strictEqual(turnNudges({ ...base, turn: 15 }).initTip, true);
    assert.strictEqual(turnNudges({ ...base, turn: 16 }).initTip, false);
    assert.strictEqual(turnNudges({ ...base, turn: 15, hasContextFile: false }).initTip, false);
    assert.strictEqual(turnNudges({ ...base, turn: 15, contextStale: true }).initTip, false);
  });

  it("long auto/edit sessions: suggest /fresh once, or start fresh when auto-fresh is on", () => {
    assert.strictEqual(turnNudges({ ...base, turn: 29 }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, turn: 30 }).fresh, "suggest");
    assert.strictEqual(turnNudges({ ...base, turn: 30, autoFreshEnabled: true }).fresh, "auto");
    assert.strictEqual(turnNudges({ ...base, turn: 40, freshSuggested: true }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, turn: 40, mode: "plan" }).fresh, null);
    assert.strictEqual(turnNudges({ ...base, turn: 40, freshAfterTurns: 0 }).fresh, null);
  });

  it("phrases the suggestion with the turn count", () => {
    assert.match(freshSuggestion(31), /^Session has run for 31 turns\..*\/fresh.*\/compact/);
  });
});
