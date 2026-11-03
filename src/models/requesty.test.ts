import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { checkRequestyKey, requestyHeaders, requestyUrl } from "./requesty.js";

const savedBase = process.env.REQUESTY_BASE_URL;
afterEach(() => {
  if (savedBase === undefined) delete process.env.REQUESTY_BASE_URL;
  else process.env.REQUESTY_BASE_URL = savedBase;
});

function statusFetch(status: number, seen?: { url?: string; auth?: string | null }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(input);
      seen.auth = new Headers(init?.headers).get("Authorization");
    }
    return new Response(JSON.stringify({ data: [] }), { status });
  }) as typeof fetch;
}

describe("requestyUrl", () => {
  it("defaults to router.requesty.ai/v1 and honours REQUESTY_BASE_URL (trailing slashes trimmed)", () => {
    delete process.env.REQUESTY_BASE_URL;
    assert.strictEqual(requestyUrl("chat/completions"), "https://router.requesty.ai/v1/chat/completions");
    process.env.REQUESTY_BASE_URL = "https://router.eu.requesty.ai/v1/";
    assert.strictEqual(requestyUrl("/models"), "https://router.eu.requesty.ai/v1/models");
  });

  it("accepts every Requesty regional host", () => {
    for (const host of ["router.requesty.ai", "router.eu.requesty.ai", "router.us.requesty.ai", "router.ap.requesty.ai"]) {
      process.env.REQUESTY_BASE_URL = `https://${host}/v1`;
      assert.strictEqual(requestyUrl("models"), `https://${host}/v1/models`);
    }
  });

  it("rejects a REQUESTY_BASE_URL that is not https on a Requesty host", () => {
    for (const bad of [
      "http://router.requesty.ai/v1",
      "https://evil.example.com/v1",
      "https://router.requesty.ai.evil.example.com/v1",
      "https://evilrouter.requesty.ai/v1",
      "https://requesty.ai/v1",
      "https://user:pass@router.requesty.ai/v1",
      "https://router.requesty.ai:8443/v1",
      "https://router.requesty.ai/v1?x=1",
      "router.requesty.ai/v1",
      "not a url",
    ]) {
      process.env.REQUESTY_BASE_URL = bad;
      assert.throws(() => requestyUrl("models"), /REQUESTY_BASE_URL must be an https URL on a Requesty host/, bad);
    }
  });
});

describe("requestyHeaders", () => {
  it("sends the key as a bearer plus app attribution", () => {
    const h = requestyHeaders("rq-key");
    assert.strictEqual(h.Authorization, "Bearer rq-key");
    assert.strictEqual(h["X-Title"], "Autopilot");
    assert.ok(h["HTTP-Referer"]);
  });
});

describe("checkRequestyKey", () => {
  it("accepts a key when an authenticated GET /models returns 200", async () => {
    delete process.env.REQUESTY_BASE_URL;
    const seen: { url?: string; auth?: string | null } = {};
    assert.deepStrictEqual(await checkRequestyKey("rq-key", statusFetch(200, seen)), { ok: true });
    assert.strictEqual(seen.url, "https://router.requesty.ai/v1/models");
    assert.strictEqual(seen.auth, "Bearer rq-key");
  });

  it("reports 401 and 403 as an invalid key", async () => {
    for (const status of [401, 403]) {
      const res = await checkRequestyKey("bad", statusFetch(status));
      assert.strictEqual(res.ok, false);
      assert.strictEqual(!res.ok && res.reason, "invalid");
    }
  });

  it("reports other failures as http", async () => {
    const res = await checkRequestyKey("rq-key", statusFetch(500));
    assert.strictEqual(!res.ok && res.reason, "http");
  });

  it("refuses to send the key when REQUESTY_BASE_URL is not a Requesty host", async () => {
    process.env.REQUESTY_BASE_URL = "https://evil.example.com/v1";
    const seen: { url?: string; auth?: string | null } = {};
    const res = await checkRequestyKey("rq-key", statusFetch(200, seen));
    assert.strictEqual(!res.ok && res.reason, "config");
    assert.strictEqual(seen.url, undefined);
  });

  it("reports a thrown fetch as a network failure", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const res = await checkRequestyKey("rq-key", failing);
    assert.strictEqual(!res.ok && res.reason, "network");
  });
});
