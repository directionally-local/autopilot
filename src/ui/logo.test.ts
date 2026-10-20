import { describe, it } from "node:test";
import assert from "node:assert";
import { renderLogo } from "./logo.js";

describe("renderLogo", () => {
  it("names the model and the provider serving it", () => {
    assert.match(renderLogo("1.0.0", "deepseek-v4-pro", "DeepSeek"), /deepseek-v4-pro via DeepSeek/);
    assert.match(renderLogo("1.0.0", "moonshotai/kimi-k2.6"), /kimi-k2\.6 via OpenRouter/);
    assert.match(renderLogo("1.0.0", undefined, "Ollama"), /runs on Ollama/);
  });
});
