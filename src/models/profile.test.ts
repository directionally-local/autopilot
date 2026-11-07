import { describe, it } from "node:test";
import assert from "node:assert";
import {
  _resetModelProfileOverridesForTests,
  configureModelProfiles,
  modelProfileFor,
  modelProfileId,
} from "./profile.js";

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
    assert.match(profile!.promptAddendum ?? "", /issue them all in one response/);
    assert.strictEqual(profile!.strictEditSchema, true);
    assert.strictEqual(profile!.bashReadHint, true);
  });

  it("leaves caps and guardrails at the harness defaults (unset)", () => {
    const profile = modelProfileFor("deepseek/deepseek-v4.1-flash");
    assert.strictEqual(profile!.caps, undefined);
    assert.strictEqual(profile!.guardrails, undefined);
  });
});

describe("configureModelProfiles", () => {
  it("adds a profile for a family the harness does not know", () => {
    configureModelProfiles([
      { match: "qwen3.6", promptAddendum: "Be terse.", maxToolContentChars: 24_000, loopThreshold: 4 },
    ]);
    try {
      const profile = modelProfileFor("qwen/qwen3.6-coder");
      assert.ok(profile);
      assert.strictEqual(profile!.id, "config:qwen3.6");
      assert.strictEqual(profile!.promptAddendum, "Be terse.");
      assert.strictEqual(profile!.caps?.maxToolContentChars, 24_000);
      assert.strictEqual(profile!.guardrails?.loopThreshold, 4);
      // Unset fields keep the default behavior (absent, not falsified).
      assert.strictEqual(profile!.strictEditSchema, undefined);
    } finally {
      _resetModelProfileOverridesForTests();
    }
  });

  it("overrides a built-in profile field-by-field, keeping the rest", () => {
    configureModelProfiles([{ match: "deepseek-v4", webFetchPerTurn: 2 }]);
    try {
      const profile = modelProfileFor("deepseek/deepseek-v4.1-flash");
      assert.ok(profile);
      assert.strictEqual(profile!.id, "deepseek-v4");
      assert.strictEqual(profile!.strictEditSchema, true);
      assert.strictEqual(profile!.caps?.webFetchPerTurn, 2);
      assert.strictEqual(profile!.caps?.maxToolContentChars, undefined);
      assert.match(profile!.promptAddendum!, /Use the `read` tool/);
    } finally {
      _resetModelProfileOverridesForTests();
    }
  });

  it("matches /regex/ literals and an explicit override id", () => {
    configureModelProfiles([{ match: "/^openai\\/gpt-6/", id: "gpt-6", loopThreshold: 4 }]);
    try {
      assert.strictEqual(modelProfileId("openai/gpt-6-luna"), "gpt-6");
      assert.strictEqual(modelProfileFor("openai/gpt-6-luna")?.guardrails?.loopThreshold, 4);
      assert.strictEqual(modelProfileFor("anthropic/claude-6"), undefined);
    } finally {
      _resetModelProfileOverridesForTests();
    }
  });

  it("replaces rules on every call and ignores malformed entries", () => {
    configureModelProfiles([{ match: "first" }]);
    configureModelProfiles([{ match: "second" }, { match: "" } as never, null as never]);
    try {
      assert.strictEqual(modelProfileId("vendor/first-1"), undefined);
      assert.strictEqual(modelProfileId("vendor/second-1"), "config:second");
    } finally {
      _resetModelProfileOverridesForTests();
    }
  });

  it("falls back to substring matching on an invalid /regex/", () => {
    configureModelProfiles([{ match: "/([/" }]);
    try {
      assert.strictEqual(modelProfileId("has-/([/-inside"), "config:/([/");
    } finally {
      _resetModelProfileOverridesForTests();
    }
  });
});
