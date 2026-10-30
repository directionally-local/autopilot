import assert from "node:assert/strict";
import { test } from "node:test";
import { isExitCommand } from "./exit-command.js";

test("isExitCommand matches the bare word exit", () => {
  assert.equal(isExitCommand("exit"), true);
  assert.equal(isExitCommand("  exit  "), true);
  assert.equal(isExitCommand("EXIT"), true);
  assert.equal(isExitCommand("Exit\n"), true);
});

test("isExitCommand ignores sentences that merely contain exit", () => {
  assert.equal(isExitCommand("how do I exit vim?"), false);
  assert.equal(isExitCommand("exit code 1 means the build failed"), false);
  assert.equal(isExitCommand("please exit the sandbox"), false);
  assert.equal(isExitCommand("exit now"), false);
  assert.equal(isExitCommand("exiting"), false);
  assert.equal(isExitCommand("myexit"), false);
  assert.equal(isExitCommand("/exit"), false);
  assert.equal(isExitCommand("!exit"), false);
  assert.equal(isExitCommand(""), false);
  assert.equal(isExitCommand("   "), false);
});
