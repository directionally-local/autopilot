import { describe, it } from "node:test";
import assert from "node:assert";
import { routedModelForTier } from "./model-routing.js";

describe("routedModelForTier", () => {
  const routing = { light: "fast/light-model", medium: "fast/medium-model" };

  it("routes light and medium turns to their configured models", () => {
    assert.strictEqual(routedModelForTier(routing, "light", "default/model"), "fast/light-model");
    assert.strictEqual(routedModelForTier(routing, "medium", "default/model"), "fast/medium-model");
  });

  it("never reroutes heavy turns", () => {
    assert.strictEqual(routedModelForTier(routing, "heavy", "default/model"), undefined);
  });

  it("keeps the session model when routing is off or the tier is unmapped", () => {
    assert.strictEqual(routedModelForTier(undefined, "light", "default/model"), undefined);
    assert.strictEqual(routedModelForTier({}, "light", "default/model"), undefined);
    assert.strictEqual(routedModelForTier({ medium: "m" }, "light", "default/model"), undefined);
  });

  it("is a no-op when the target already is the session model", () => {
    assert.strictEqual(routedModelForTier(routing, "light", "fast/light-model"), undefined);
  });
});
