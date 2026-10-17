import assert from "node:assert/strict";
import { test } from "node:test";
import { terminalTitleSequence } from "./terminal-title.js";

test("terminalTitleSequence emits an OSC title sequence", () => {
  assert.equal(terminalTitleSequence("Feature: session topic"), "\u001b]0;Feature: session topic\u0007");
});

test("terminalTitleSequence strips control characters and rejects blank titles", () => {
  assert.equal(terminalTitleSequence("task\u001b]2;injected"), "\u001b]0;task ]2;injected\u0007");
  assert.equal(terminalTitleSequence(" \n\t "), null);
});
