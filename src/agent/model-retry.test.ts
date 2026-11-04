import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isTransientModelError,
  MAX_RETRY_AFTER_MS,
  ModelHostError,
  modelHostFailedText,
  modelRetryCount,
  modelRetryDelay,
  modelRetryLine,
  parseRetryAfter,
  shouldRetryModelCall,
} from "./model-retry.js";
import { ApiError, humanizeApiError } from "../util/errors.js";

const api = (message: string, status?: number, extra: Partial<ApiError> = {}): ApiError => Object.assign(new ApiError(message, undefined, status), extra);

describe("model retry policy", () => {
  it("retries twice by default and clamps overrides", () => {
    const prev = process.env.AUTOPILOT_NETWORK_RETRIES;
    delete process.env.AUTOPILOT_NETWORK_RETRIES;
    try {
      assert.strictEqual(modelRetryCount(), 2);
      assert.strictEqual(modelRetryCount(5), 5);
      assert.strictEqual(modelRetryCount(-1), 0);
      assert.strictEqual(modelRetryCount(99), 20);
      assert.strictEqual(modelRetryCount(Number.NaN), 2);
      process.env.AUTOPILOT_NETWORK_RETRIES = "0";
      assert.strictEqual(modelRetryCount(), 0);
    } finally {
      if (prev === undefined) delete process.env.AUTOPILOT_NETWORK_RETRIES;
      else process.env.AUTOPILOT_NETWORK_RETRIES = prev;
    }
  });

  it("waits 1 s, then 3 s, or the host's Retry-After up to 20 s", () => {
    assert.strictEqual(modelRetryDelay(0), 1_000);
    assert.strictEqual(modelRetryDelay(1), 3_000);
    assert.strictEqual(modelRetryDelay(5), 3_000);
    assert.strictEqual(modelRetryDelay(0, 7_000), 7_000);
    assert.strictEqual(modelRetryDelay(0, 60_000), MAX_RETRY_AFTER_MS);
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    assert.strictEqual(parseRetryAfter("2"), 2_000);
    assert.strictEqual(parseRetryAfter(0.5), 500);
    assert.strictEqual(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.strictEqual(parseRetryAfter(null), undefined);
    assert.strictEqual(parseRetryAfter("soon"), undefined);
    assert.strictEqual(parseRetryAfter("0"), undefined);
  });

  describe("retried: the host's transient trouble", () => {
    const retried: Array<[string, unknown]> = [
      ["the free tier's mid-stream decode failure", api("autopilot: Upstream error from Morph: regional pod proxy response stream failed: error decoding response body")],
      ["a mid-stream error chunk with a 502", api("autopilot: Provider returned error", 502)],
      ["HTTP 500", api("autopilot: boom", 500)],
      ["HTTP 503", api("autopilot: Service Unavailable", 503)],
      ["HTTP 504", api("autopilot: gateway timeout", 504)],
      ["Anthropic overloaded (529)", api("autopilot: Overloaded", 529)],
      ["HTTP 429 rate limit", api("autopilot: Rate limit exceeded", 429)],
      ["HTTP 408", api("autopilot: request timeout", 408)],
      ["an overloaded event without a status", api("autopilot: The server is overloaded, please try again")],
      ["a connection reset", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET", message: "read ECONNRESET" } })],
      ["undici's terminated", new TypeError("terminated")],
      ["socket hang up", new Error("socket hang up")],
      ["a stalled stream", new DOMException("autopilot: stream idle for 30000ms — no data received from API", "TimeoutError")],
      ["a network error the client wrapped", api("autopilot: network error: fetch failed", undefined, { transient: true })],
      ["the free tier's rate limit", api("autopilot: slow down", 429, { providerCode: "rate_limited" })],
    ];
    for (const [name, err] of retried) {
      it(name, () => assert.strictEqual(isTransientModelError(err), true));
    }
  });

  describe("not retried", () => {
    const notRetried: Array<[string, unknown]> = [
      ["an abort", new DOMException("aborted", "AbortError")],
      ["a bad key (401)", api("autopilot: OpenRouter rejected your API key", 401)],
      ["forbidden (403)", api("autopilot: refused", 403)],
      ["out of credits (402)", api("autopilot: Your OpenRouter account is out of credits", 402)],
      ["an invalid request (400)", api("autopilot: Bad request", 400)],
      ["unknown model (404)", api("autopilot: not found", 404)],
      ["context length, mid-stream", api("autopilot: This model's maximum context length is 128000 tokens")],
      ["context length as a 5xx body", api("autopilot: context_length_exceeded", 500)],
      ["content policy, mid-stream", api("autopilot: Output blocked by content policy")],
      ["moderation flag", api("autopilot: Input was flagged by moderation")],
      ["a quota 429", api("autopilot: You exceeded your current quota", 429)],
      ["the free tier's weekly quota", api("autopilot: You've used this week's free tokens", 402, { providerCode: "quota_exceeded" })],
      ["the free tier paused for everyone (503)", api("autopilot: Free tokens are paused", 503, { providerCode: "service_paused" })],
      ["an HTTP error the client judged permanent", api("autopilot: whatever", 503, { transient: false })],
      ["ChatGPT sharing limit", api("autopilot: subscription_sharing_usage_limit_exceeded", 429)],
      ["a plain bug", new TypeError("Cannot read properties of undefined")],
      ["a non-error", "nope"],
    ];
    for (const [name, err] of notRetried) {
      it(name, () => assert.strictEqual(isTransientModelError(err), false));
    }
  });

  it("stops after the last retry and when the host wants more than 20 s", () => {
    const busy = api("autopilot: busy", 503);
    assert.strictEqual(shouldRetryModelCall(busy, 0, 2), true);
    assert.strictEqual(shouldRetryModelCall(busy, 1, 2), true);
    assert.strictEqual(shouldRetryModelCall(busy, 2, 2), false);
    assert.strictEqual(shouldRetryModelCall(api("autopilot: wait", 429, { retryAfterMs: 20_000 }), 0, 2), true);
    assert.strictEqual(shouldRetryModelCall(api("autopilot: wait", 429, { retryAfterMs: 30_000 }), 0, 2), false);
  });

  it("words the retry line and the final failure plainly", () => {
    assert.strictEqual(modelRetryLine(1, 2), "↻ The model's host had a hiccup; retrying (1/2)…");
    assert.strictEqual(modelHostFailedText(3), 'The model\'s host failed 3 times. Type "continue" to try again.');
    const err = new ModelHostError(3, api("autopilot: Upstream error from Morph: error decoding response body", 502));
    assert.ok(err instanceof ApiError);
    assert.strictEqual(err.httpStatus, 502);
    assert.strictEqual(humanizeApiError(err), 'The model\'s host failed 3 times. Type "continue" to try again.');
    assert.strictEqual(err.detail, "Upstream error from Morph: error decoding response body");
  });
});
