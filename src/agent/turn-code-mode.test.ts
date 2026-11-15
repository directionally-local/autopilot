import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveTurnCodeMode } from "./turn-code-mode.js";

describe("resolveTurnCodeMode", () => {
  for (const configured of [false, undefined, true]) {
    for (const tier of ["light", "medium", "heavy"] as const) {
      const expected = tier === "heavy" && configured !== false;
      it(`${String(configured)} on a ${tier} turn resolves to ${expected}`, () => {
        assert.equal(resolveTurnCodeMode(configured, tier), expected);
      });
    }
  }
});
