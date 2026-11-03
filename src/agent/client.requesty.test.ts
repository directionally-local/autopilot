/**
 * Requesty routing tests for runKimi.
 *
 * Requesty is opt-in: requests go there only when a Requesty key is set and
 * neither an OpenRouter key nor a custom endpoint is configured. These tests
 * pin that contract:
 *
 *   1. Requests go to `<REQUESTY_BASE_URL or default>/chat/completions` with
 *      `Authorization: Bearer <requesty key>` and the OpenAI-shaped body.
 *   2. Managed policy ids without a vendor prefix ("kimi-k2.6") pass through.
 *   3. An OpenRouter key or a custom endpoint always wins over Requesty.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { runKimi } from "./client.js";

const ENV_KEYS = ["KIMIFLARE_BASE_URL", "KIMIFLARE_API_KEY", "REQUESTY_BASE_URL"] as const;

describe("runKimi: Requesty", () => {
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

  async function drain(opts: Parameters<typeof runKimi>[0]): Promise<void> {
    for await (const _ of runKimi(opts)) {
      /* drain */
    }
  }

  it("routes to Requesty with the Requesty bearer and an OpenAI-shaped body", async () => {
    await drain({
      requestyApiKey: "rq-key",
      sessionId: "sess-1",
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.ok(lastRequest);
    assert.strictEqual(lastRequest!.url, "https://router.requesty.ai/v1/chat/completions");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer rq-key");
    assert.strictEqual(lastRequest!.headers.get("X-Title"), "Autopilot");
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "openai/gpt-4o-mini");
    assert.deepStrictEqual(body.stream_options, { include_usage: true });
    assert.ok(!("provider" in body));
    assert.ok(!("session_id" in body));
    assert.ok(!("response_format" in body));
  });

  it("accepts managed policy ids without a vendor prefix", async () => {
    await drain({ requestyApiKey: "rq-key", model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(await lastRequest!.text()) as Record<string, unknown>;
    assert.strictEqual(body.model, "kimi-k2.6");
  });

  it("honours REQUESTY_BASE_URL (e.g. the EU region)", async () => {
    process.env.REQUESTY_BASE_URL = "https://router.eu.requesty.ai/v1/";
    await drain({ requestyApiKey: "rq-key", model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] });
    assert.strictEqual(lastRequest!.url, "https://router.eu.requesty.ai/v1/chat/completions");
  });

  it("rejects a REQUESTY_BASE_URL outside Requesty's hosts without sending the key", async () => {
    process.env.REQUESTY_BASE_URL = "http://attacker.example.com/v1";
    await assert.rejects(
      () => drain({ requestyApiKey: "rq-key", model: "kimi-k2.6", messages: [{ role: "user", content: "hi" }] }),
      /REQUESTY_BASE_URL must be an https URL on a Requesty host/,
    );
    assert.strictEqual(lastRequest, null);
  });

  it("uses OpenRouter when an OpenRouter key is also configured", async () => {
    await drain({
      openrouterApiKey: "sk-or-key",
      requestyApiKey: "rq-should-not-leak",
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.ok(lastRequest!.url.startsWith("https://openrouter.ai/"));
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer sk-or-key");
  });

  it("uses the custom endpoint when one is configured", async () => {
    await drain({
      requestyApiKey: "rq-should-not-leak",
      model: "my-alias",
      messages: [{ role: "user", content: "hi" }],
      customEndpoint: { baseUrl: "https://aig.example.com/v1", apiKey: "broker-key" },
    });
    assert.strictEqual(lastRequest!.url, "https://aig.example.com/v1/chat/completions");
    assert.strictEqual(lastRequest!.headers.get("Authorization"), "Bearer broker-key");
  });

  it("rejects an empty model id", async () => {
    await assert.rejects(
      () => drain({ requestyApiKey: "rq-key", model: "", messages: [{ role: "user", content: "hi" }] }),
      /Invalid model ID/,
    );
  });
});
