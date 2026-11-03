import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  checkOpenRouterKey,
  looksLikeOpenRouterKey,
  openRouterAlphaUrl,
  openRouterUrl,
  openRouterHeaders,
} from "./openrouter.js";

const savedBase = process.env.OPENROUTER_BASE_URL;
afterEach(() => {
  if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = savedBase;
});

describe("openRouterUrl", () => {
  it("defaults to openrouter.ai/api/v1 and honours OPENROUTER_BASE_URL (trailing slashes trimmed)", () => {
    delete process.env.OPENROUTER_BASE_URL;
    assert.strictEqual(openRouterUrl("models"), "https://openrouter.ai/api/v1/models");
    process.env.OPENROUTER_BASE_URL = "http://localhost:8788/api/v1/";
    assert.strictEqual(openRouterUrl("/key"), "http://localhost:8788/api/v1/key");
  });
});

describe("openRouterAlphaUrl", () => {
  it("targets the Alpha API root separately from the v1 API", () => {
    delete process.env.OPENROUTER_BASE_URL;
    assert.strictEqual(openRouterAlphaUrl("decisions"), "https://openrouter.ai/api/alpha/decisions");
    process.env.OPENROUTER_BASE_URL = "http://localhost:8788/api/v1/";
    assert.strictEqual(openRouterAlphaUrl("/decisions"), "http://localhost:8788/api/alpha/decisions");
  });
});

describe("openRouterHeaders", () => {
  it("sends the key as a bearer plus app attribution", () => {
    const h = openRouterHeaders("sk-or-abc");
    assert.strictEqual(h.Authorization, "Bearer sk-or-abc");
    assert.strictEqual(h["X-Title"], "Autopilot");
    assert.ok(h["HTTP-Referer"]);
  });
});

describe("looksLikeOpenRouterKey", () => {
  it("accepts sk-or- keys and rejects others", () => {
    assert.strictEqual(looksLikeOpenRouterKey("sk-or-v1-0123456789abcdef"), true);
    assert.strictEqual(looksLikeOpenRouterKey("  sk-or-v1-0123456789abcdef  "), true);
    assert.strictEqual(looksLikeOpenRouterKey("sk-ant-0123456789"), false);
    assert.strictEqual(looksLikeOpenRouterKey("sk-or-"), false);
  });
});

describe("checkOpenRouterKey", () => {
  it("maps GET /key into key info", async () => {
    let seenUrl = "";
    const fetchImpl = (async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify({ data: { label: "sk-or-v1-a…z", usage: 1.5, limit: 10, limit_remaining: 8.5, is_free_tier: false } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await checkOpenRouterKey("sk-or-test", fetchImpl);
    assert.ok(seenUrl.endsWith("/key"));
    assert.deepStrictEqual(res, { ok: true, info: { label: "sk-or-v1-a…z", limit: 10, limitRemaining: 8.5, usage: 1.5, isFreeTier: false } });
  });

  it("treats unlimited keys as null limits", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: { usage: 0, limit: null, limit_remaining: null, is_free_tier: true } }), { status: 200 })) as unknown as typeof fetch;
    const res = await checkOpenRouterKey("k", fetchImpl);
    assert.ok(res.ok && res.info.limit === null && res.info.limitRemaining === null && res.info.isFreeTier === true);
  });

  it("reports 401 as an invalid key", async () => {
    const fetchImpl = (async () => new Response('{"error":{"code":401,"message":"User not found."}}', { status: 401 })) as unknown as typeof fetch;
    const res = await checkOpenRouterKey("k", fetchImpl);
    assert.deepStrictEqual(res.ok ? null : res.reason, "invalid");
  });

  it("retries a transient network failure before giving up", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error("connect ETIMEDOUT");
      return new Response(JSON.stringify({ data: { usage: 0 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await checkOpenRouterKey("k", fetchImpl);
    assert.ok(res.ok);
    assert.strictEqual(calls, 2);
  });

  it("reports a thrown fetch as a network failure", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const res = await checkOpenRouterKey("k", fetchImpl);
    assert.ok(!res.ok && res.reason === "network" && /ECONNREFUSED/.test(res.message));
  });
});
