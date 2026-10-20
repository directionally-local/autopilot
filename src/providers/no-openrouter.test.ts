/**
 * End-to-end form of the provider invariant: with another provider active,
 * chat, side calls and embeddings all go to that provider and nothing
 * reaches openrouter.ai — even when an OpenRouter key is still configured.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { summarizeMessagesViaLlm } from "../agent/llm-summarize.js";
import { fetchEmbeddings } from "../memory/embeddings.js";
import type { KimiConfig } from "../config.js";

const ENV = ["KIMIFLARE_BASE_URL", "KIMIFLARE_API_KEY", "AUTOPILOT_PROVIDER", "OPENROUTER_API_KEY", "KIMIFLARE_OPENROUTER_KEY", "DEEPSEEK_API_KEY"];

describe("a non-OpenRouter provider never calls openrouter.ai", () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  let originalFetch: typeof globalThis.fetch;
  const urls: string[] = [];

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      if (url.endsWith("/embeddings")) {
        return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const chunk = { choices: [{ index: 0, delta: { content: "summary" }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  beforeEach(() => {
    urls.length = 0;
    for (const k of ENV) delete process.env[k];
  });
  after(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const cfg = {
    provider: "deepseek",
    providers: { deepseek: { apiKey: "sk-ds" } },
    openrouterApiKey: "sk-or-still-configured",
    model: "deepseek-v4-pro",
  } as KimiConfig;

  it("routes chat, compaction and embeddings to the active provider", async () => {
    const auth = llmAuthFromConfig(cfg);
    for await (const _ of runKimi({ ...auth, model: cfg.model, messages: [{ role: "user", content: "hi" }] })) {
      /* drain */
    }
    await summarizeMessagesViaLlm({
      ...auth,
      model: "deepseek-flash",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
        { role: "user", content: "e" },
      ],
      keepLastTurns: 1,
    });
    await fetchEmbeddings({ ...auth, model: "any-embedding-model", texts: ["x"] });

    assert.ok(urls.length >= 3, `expected chat, summary and embedding requests, got ${urls.join(", ")}`);
    for (const url of urls) {
      assert.ok(!url.includes("openrouter.ai"), `request went to OpenRouter: ${url}`);
      assert.ok(url.startsWith("https://api.deepseek.com/"), `request went elsewhere: ${url}`);
    }
  });
});
