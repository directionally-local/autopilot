import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeCellPromptMode, normalizeGatewayBaseUrl } from "./aster-cell.js";

test("accepts only the server-selected prompt modes and defaults legacy requests to auto", () => {
  assert.equal(normalizeCellPromptMode("plan"), "plan");
  assert.equal(normalizeCellPromptMode("edit"), "edit");
  assert.equal(normalizeCellPromptMode("auto"), "auto");
  assert.equal(normalizeCellPromptMode("ask"), "auto");
  assert.equal(normalizeCellPromptMode(undefined), "auto");
});

test("appends /v1 to the Hotcell gateway base URL exactly once", () => {
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter/"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeGatewayBaseUrl(undefined), undefined);
});
