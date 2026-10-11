import assert from "node:assert/strict";
import test from "node:test";
import { ANIMATION_TICK_MS, animationTickAt } from "./spinner.js";

test("spinner clock catches up after delayed timer callbacks", () => {
  const startedAt = 1_000;

  // A callback delivered a second late should jump to the current frame rather
  // than advancing only once and permanently lagging behind real time.
  assert.equal(animationTickAt(startedAt, startedAt + 1_050), 10);
});

test("spinner clock advances only after a full animation interval", () => {
  const startedAt = 5_000;

  assert.equal(animationTickAt(startedAt, startedAt + ANIMATION_TICK_MS - 1), 0);
  assert.equal(animationTickAt(startedAt, startedAt + ANIMATION_TICK_MS), 1);
});
