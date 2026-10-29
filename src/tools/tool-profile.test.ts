import { describe, it } from "node:test";
import assert from "node:assert";
import { applyToolProfile } from "./tool-profile.js";
import { editTool } from "./edit.js";
import { readTool } from "./read.js";

const tools = [editTool, readTool];

describe("applyToolProfile", () => {
  it("gives DeepSeek a strict edit schema with required replacement text", () => {
    const profiled = applyToolProfile(tools, "deepseek/deepseek-v4.1-flash");
    const edit = profiled.find((t) => t.name === "edit")!;
    const params = edit.parameters as {
      required: string[];
      properties: Record<string, { default?: unknown }>;
    };
    assert.deepStrictEqual(params.required, ["path", "old_string", "new_string"]);
    assert.strictEqual(params.properties.replace_all?.default, undefined);
    assert.strictEqual(params.properties.edits, undefined);
  });

  it("leaves the module-level edit schema untouched", () => {
    applyToolProfile(tools, "deepseek/deepseek-v4.1-flash");
    const params = editTool.parameters as { required: string[]; properties: Record<string, unknown> };
    assert.deepStrictEqual(params.required, ["path"]);
    assert.ok(params.properties.edits);
  });

  it("returns the same tools for models without a profile", () => {
    assert.strictEqual(applyToolProfile(tools, "openai/gpt-6-luna"), tools);
    assert.strictEqual(applyToolProfile(tools, undefined), tools);
  });

  it("does not change non-edit tools", () => {
    const profiled = applyToolProfile(tools, "deepseek/deepseek-v4.1-flash");
    assert.strictEqual(profiled.find((t) => t.name === "read"), readTool);
  });
});
