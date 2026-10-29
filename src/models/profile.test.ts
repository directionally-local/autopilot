import { describe, it } from "node:test";
import assert from "node:assert";
import { modelProfileFor, modelProfileId } from "./profile.js";

describe("modelProfileFor", () => {
  it("matches DeepSeek V4 ids across vendor prefixes and variants", () => {
    for (const id of [
      "deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash-1017",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4:free",
      "deepseek-v4.1-flash",
    ]) {
      assert.strictEqual(modelProfileFor(id)?.id, "deepseek-v4", id);
    }
  });

  it("does not match other DeepSeek models or other vendors", () => {
    for (const id of [
      "deepseek/deepseek-r1",
      "deepseek/deepseek-chat",
      "openai/gpt-6-luna",
      "moonshotai/kimi-k2.6",
      "deepseek-v3",
    ]) {
      assert.strictEqual(modelProfileFor(id), undefined, id);
    }
  });

  it("returns undefined for a missing model id", () => {
    assert.strictEqual(modelProfileFor(undefined), undefined);
    assert.strictEqual(modelProfileFor(null), undefined);
    assert.strictEqual(modelProfileFor(""), undefined);
  });

  it("exposes the profile id for traces", () => {
    assert.strictEqual(modelProfileId("deepseek/deepseek-v4.1-flash"), "deepseek-v4");
    assert.strictEqual(modelProfileId("openai/gpt-6-luna"), undefined);
  });

  it("carries the DeepSeek prompt addendum and opt-ins", () => {
    const profile = modelProfileFor("deepseek/deepseek-v4.1-flash");
    assert.ok(profile);
    assert.match(profile!.promptAddendum ?? "", /Use the `read` tool to view files/);
    assert.strictEqual(profile!.strictEditSchema, true);
    assert.strictEqual(profile!.bashReadHint, true);
  });
});
