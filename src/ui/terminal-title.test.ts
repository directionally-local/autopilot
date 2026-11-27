import assert from "node:assert/strict";
import { test } from "node:test";
import { alertPendingConfirmation, currentTerminalTitle, PENDING_CONFIRMATION_TITLE, pendingAttentionSequence, setTerminalTitle, terminalTitleSequence } from "./terminal-title.js";

test("terminalTitleSequence emits an OSC title sequence", () => {
  assert.equal(terminalTitleSequence("Feature: session topic"), "\u001b]0;Feature: session topic\u0007");
});

test("terminalTitleSequence strips control characters and rejects blank titles", () => {
  assert.equal(terminalTitleSequence("task\u001b]2;injected"), "\u001b]0;task ]2;injected\u0007");
  assert.equal(terminalTitleSequence(" \n\t "), null);
});

test("pendingAttentionSequence rings the bell and titles the prompt", () => {
  assert.equal(pendingAttentionSequence("autopilot: confirmation needed"), "\u0007\u001b]0;autopilot: confirmation needed\u0007");
  assert.match(PENDING_CONFIRMATION_TITLE, /confirmation/);
});

test("alertPendingConfirmation writes the bell and title only on a TTY", () => {
  const written: string[] = [];
  const io = (isTTY: boolean) => ({ isTTY, write: (s: string) => (written.push(s), true) });
  alertPendingConfirmation(undefined, io(false));
  assert.deepEqual(written, []);
  const restore = alertPendingConfirmation(undefined, io(true));
  assert.equal(written.join(""), `\u0007\u001b]0;${PENDING_CONFIRMATION_TITLE}\u0007`);
  written.length = 0;
  restore();
  assert.equal(written.join(""), "\u001b]0;autopilot\u0007");
});

test("alertPendingConfirmation restores the session's title after the answer", () => {
  const written: string[] = [];
  const io = { isTTY: true, write: (s: string) => (written.push(s), true) };
  setTerminalTitle("Feature: session topic", io);
  assert.equal(currentTerminalTitle(), "Feature: session topic");
  written.length = 0;
  const restore = alertPendingConfirmation(undefined, io);
  assert.match(written.join(""), /confirmation needed/);
  written.length = 0;
  restore();
  assert.equal(written.join(""), "\u001b]0;Feature: session topic\u0007");
  assert.equal(currentTerminalTitle(), "Feature: session topic");
});

test("alertPendingConfirmation restores a title set while the prompt was open", () => {
  const written: string[] = [];
  const io = { isTTY: true, write: (s: string) => (written.push(s), true) };
  setTerminalTitle("autopilot", io);
  written.length = 0;
  const restore = alertPendingConfirmation(undefined, io);
  assert.equal(currentTerminalTitle(), "autopilot", "the pending title does not clobber the recorded session title");
  // The first turn generates its real title while the permission prompt is up.
  setTerminalTitle("Fix the confirmation prompts", io);
  written.length = 0;
  restore();
  assert.equal(written.join(""), "\u001b]0;Fix the confirmation prompts\u0007");
  assert.equal(currentTerminalTitle(), "Fix the confirmation prompts");
});
