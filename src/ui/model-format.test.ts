import { describe, it } from "node:test";
import assert from "node:assert";
import { formatModelPrice } from "./model-format.js";

describe("formatModelPrice", () => {
  it("shows free models as free and trims float noise", () => {
    assert.strictEqual(formatModelPrice({ inputPerMtok: 0, outputPerMtok: 0 }), "free");
    assert.strictEqual(formatModelPrice({ inputPerMtok: 0.95000000001, outputPerMtok: 4, cachedInputPerMtok: 0.16 }), "$0.95 / $4 / $0.16");
  });
});
