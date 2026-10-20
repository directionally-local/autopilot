/**
 * Custom OpenAI-compatible endpoint routing tests for runKimi.
 *
 * A host application (e.g. an agents platform running kimiflare inside a
 * container) points the CLI at its own gateway/broker with
 * KIMIFLARE_BASE_URL + KIMIFLARE_API_KEY. These tests pin the contract:
 *
 *   1. Requests go to `<baseUrl>/chat/completions` with
 *      `Authorization: Bearer <apiKey>` — never the OpenRouter key, and none
 *      of the OpenRouter-only body fields (provider, session_id, cache_control).
 *   2. The custom endpoint wins over OpenRouter even when a key is configured.
 *   3. Model ids pass through in the body unchanged — no id-shape validation.
 *   4. Works with no OpenRouter key at all.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runKimi } from "./client.js";

const ENV_KEYS = ["KIMIFLARE_BASE_URL", "KIMIFLARE_API_KEY"] as const;

describe("runKimi: custom OpenAI-compatible endpoint", () => {
  let originalFetch: typeof globalThis.fetch;
  let lastRequest: Request | null = null;
  const savedEnv: Record<string, string | undefined> = {};

  before(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      lastRequest = new Request(input, init);
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });
  beforeEach(() => {
    lastRequest = null;
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("routes to <baseUrl>/chat/completions with the custom bearer and no OpenRouter key", async () => {
    for await (const _ of runKimi({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "https://aig.example.com/v1", apiKey: "broker-key" },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.url, "https://aig.example.com/v1/chat/completions");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer broker-key");
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "moonshotai/kimi-k2.6");
    // Plain OpenAI-compatible upstreams need the opt-in to stream usage.
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
  });

  it("wins over a configured OpenRouter key and sends no OpenRouter-only fields", async () => {
    for await (const _ of runKimi({
      openrouterApiKey: "sk-or-should-not-leak",
      openrouterRouting: { ignore: ["X"] },
      sessionId: "sess-1",
      model: "anthropic/claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "https://aig.example.com/v1", apiKey: "broker-key" },
    })) {
      /* drain */
    }
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.url, "https://aig.example.com/v1/chat/completions");
    // The broker bearer replaces the OpenRouter key — never both.
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer broker-key");
    assert.strictEqual(lastRequest!.headers.get("HTTP-Referer"), null);
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.ok(!("provider" in body));
    assert.ok(!("session_id" in body));
    assert.ok(!("cache_control" in body));
  });

  it("accepts model ids the OpenRouter path would reject (host gateway owns dispatch)", async () => {
    for await (const _ of runKimi({
      model: "my-broker-alias", // no vendor/model shape
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "https://aig.example.com/v1", apiKey: "broker-key" },
    })) {
      /* drain */
    }
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "my-broker-alias");
  });

  it("omits the Authorization header entirely when no apiKey is configured", async () => {
    for await (const _ of runKimi({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "http://127.0.0.1:11434/v1" },
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.headers.get("Authorization"), null);
  });

  it("does not double /chat/completions when the base already includes it", async () => {
    for await (const _ of runKimi({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "https://aig.example.com/v1/chat/completions", apiKey: "k" },
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.url, "https://aig.example.com/v1/chat/completions");
  });

  it("falls back to KIMIFLARE_BASE_URL / KIMIFLARE_API_KEY from the environment", async () => {
    process.env.KIMIFLARE_BASE_URL = "https://env.example.com/v1";
    process.env.KIMIFLARE_API_KEY = "env-key";
    for await (const _ of runKimi({
      openrouterApiKey: "sk-or-should-not-leak",
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    })) {
      /* drain */
    }
    assert.strictEqual(lastRequest!.url, "https://env.example.com/v1/chat/completions");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer env-key");
  });

  it("rejects an empty model id", async () => {
    await assert.rejects(async () => {
      for await (const _ of runKimi({
        model: "",
        messages: [{ role: "user", content: "hi" }],
        customEndpoint: { baseUrl: "https://aig.example.com/v1", apiKey: "k" },
      })) {
        /* drain */
      }
    }, /Invalid model ID/);
  });
});
