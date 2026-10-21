import { describe, it } from "node:test";
import assert from "node:assert";
import { filterModels, formatModelPrice } from "./model-format.js";
import type { ModelEntry } from "../models/registry.js";

const m = (id: string, name?: string): ModelEntry => ({
  id,
  ...(name ? { name } : {}),
  contextWindow: 1,
  maxOutputTokens: 1,
  pricing: { inputPerMtok: 1, outputPerMtok: 1 },
  supports: { tools: true, reasoning: false, streaming: true },
});

const catalog = [
  m("moonshotai/kimi-k2.6", "MoonshotAI: Kimi K2.6"),
  m("thinkingmachines/inkling-small"),
  m("anthropic/claude-sonnet-5", "Anthropic: Claude Sonnet 5"),
  m("anthropic/claude-opus-5"),
];

describe("filterModels", () => {
  it("fuzzy-matches id or name and ranks the closest matches first", () => {
    const ids = filterModels(catalog, "kimi").map((x) => x.id);
    assert.strictEqual(ids[0], "moonshotai/kimi-k2.6");
  });

  it("requires every term to match", () => {
    assert.deepStrictEqual(filterModels(catalog, "claude sonnet").map((x) => x.id), ["anthropic/claude-sonnet-5"]);
  });

  it("tolerates abbreviations (subsequence match)", () => {
    assert.ok(filterModels(catalog, "clsnt").some((x) => x.id === "anthropic/claude-sonnet-5"));
  });

  it("returns everything for an empty query", () => {
    assert.strictEqual(filterModels(catalog, "  ").length, catalog.length);
  });

  it("lists equally good matches newest first and hides :batch duplicates", () => {
    const models = [
      { ...m("vendor/flash-1"), created: 100 },
      { ...m("vendor/flash-2"), created: 300 },
      { ...m("vendor/flash-2:batch"), created: 300 },
    ];
    assert.deepStrictEqual(filterModels(models, "flash").map((x) => x.id), ["vendor/flash-2", "vendor/flash-1"]);
  });
});

describe("formatModelPrice", () => {
  it("shows free models as free and trims float noise", () => {
    assert.strictEqual(formatModelPrice({ inputPerMtok: 0, outputPerMtok: 0 }), "free");
    assert.strictEqual(formatModelPrice({ inputPerMtok: 0.95000000001, outputPerMtok: 4, cachedInputPerMtok: 0.16 }), "$0.95 / $4 / $0.16");
  });
});
