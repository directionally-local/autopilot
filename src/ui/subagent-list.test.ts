import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isImmediateSubagentCommand, isRunNowCommand } from "./subagent-list.js";
import { cancelSubagents, formatElapsed, formatRunningSubagents } from "./slash-commands.js";
import { workerRegistry } from "../tools/worker-registry.js";

describe("subagent commands", () => {
  it("runs listing and cancel immediately, but not policy changes", () => {
    for (const cmd of ["/subagents", "/subagents list", "/subagents cancel 2", "/subagents cancel all", "/SUBAGENTS stop #1"]) {
      assert.equal(isImmediateSubagentCommand(cmd), true, cmd);
    }
    for (const cmd of ["/subagents auto", "/subagents off", "/subagentsx", "please /subagents cancel 1"]) {
      assert.equal(isImmediateSubagentCommand(cmd), false, cmd);
    }
  });

  it("recognizes /now exactly", () => {
    assert.equal(isRunNowCommand("/now"), true);
    assert.equal(isRunNowCommand(" /NOW "), true);
    assert.equal(isRunNowCommand("/now please"), false);
    assert.equal(isRunNowCommand("do it /now"), false);
  });

  it("lists and cancels running workers by number or all", () => {
    assert.equal(formatRunningSubagents(), "no subagents running");
    const a = workerRegistry.start("Investigate the auth flow", "m");
    const b = workerRegistry.start("Survey test coverage", "m");
    try {
      const listing = formatRunningSubagents(Date.now() + 65_000);
      assert.match(listing, /2 subagents running/);
      assert.match(listing, /#1 {2}1m05s {2}Investigate the auth flow/);
      assert.match(cancelSubagents("#2"), /cancelling subagent #2 \(Survey test coverage\); the turn continues/);
      assert.equal(b.cancelledByUser, true);
      assert.match(cancelSubagents("7"), /no running subagent #7/);
      assert.match(cancelSubagents("all"), /cancelling 1 subagent;/);
      assert.equal(a.cancelledByUser, true);
      assert.match(cancelSubagents(undefined), /usage/);
    } finally {
      a.finish();
      b.finish();
    }
    assert.equal(formatElapsed(9_400), "9s");
  });
});
