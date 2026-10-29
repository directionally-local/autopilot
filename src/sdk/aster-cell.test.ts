import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGatewayBaseUrl } from "./aster-cell.js";

test("appends /v1 to the Hotcell gateway base URL exactly once", () => {
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter/"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeGatewayBaseUrl(undefined), undefined);
});

test("registers the server's entry for the session's model, so the cell knows its real context window", async () => {
  const { acceptModelInfo } = await import("./aster-cell.js");
  const { getModelOrInfer, registerOpenRouterModels } = await import("../models/registry.js");
  const id = "test-vendor/huge-window-1017";
  assert.equal(getModelOrInfer(id).contextWindow, 128_000, "unknown here: the generic guess");
  const entry = { id, contextWindow: 1_048_576, maxOutputTokens: 65_536, pricing: { inputPerMtok: 0.3, outputPerMtok: 1.2 }, supports: { tools: true, reasoning: true, streaming: true }, parameters: ["tools", "reasoning"] };
  assert.equal(acceptModelInfo(entry, id), entry);
  assert.equal(getModelOrInfer(id).contextWindow, 1_048_576);
  assert.deepEqual(getModelOrInfer(id).parameters, ["tools", "reasoning"]);

  // A live catalog, when one loads, still wins over the hint.
  registerOpenRouterModels([{ ...entry, contextWindow: 2_000_000 }]);
  assert.equal(getModelOrInfer(id).contextWindow, 2_000_000);
  registerOpenRouterModels([]);

  // Anything that isn't an entry for this model is ignored.
  const other = "test-vendor/other-model";
  assert.equal(acceptModelInfo(entry, other), undefined, "an entry for another model");
  assert.equal(acceptModelInfo({ ...entry, id: other, contextWindow: 12 }, other), undefined);
  assert.equal(acceptModelInfo({ ...entry, id: other, contextWindow: "1m" }, other), undefined);
  assert.equal(acceptModelInfo({ id: other, contextWindow: 1_048_576 }, other), undefined, "no pricing or supports");
  assert.equal(acceptModelInfo(undefined, other), undefined);
  assert.equal(getModelOrInfer(other).contextWindow, 128_000);
});
