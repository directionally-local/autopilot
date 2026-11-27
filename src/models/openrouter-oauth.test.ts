import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  isHeadlessEnvironment,
  OpenRouterSignInError,
  pkceChallenge,
  startLoopbackListener,
} from "./openrouter-oauth.js";

const savedAuthUrl = process.env.OPENROUTER_AUTH_URL;
afterEach(() => {
  if (savedAuthUrl === undefined) delete process.env.OPENROUTER_AUTH_URL;
  else process.env.OPENROUTER_AUTH_URL = savedAuthUrl;
});

describe("PKCE", () => {
  it("computes the S256 challenge from RFC 7636's published example", () => {
    assert.strictEqual(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a fresh 43-char verifier with the matching challenge", () => {
    const a = createPkce();
    const b = createPkce();
    assert.strictEqual(a.verifier.length, 43);
    assert.notStrictEqual(a.verifier, b.verifier);
    assert.strictEqual(a.challenge, pkceChallenge(a.verifier));
  });
});

describe("buildAuthUrl", () => {
  it("includes the callback, S256 challenge and key label", () => {
    const u = new URL(buildAuthUrl({ challenge: "ch", callbackUrl: "http://127.0.0.1:5555/callback", keyLabel: "autopilot (box)" }));
    assert.strictEqual(u.origin + u.pathname, "https://openrouter.ai/auth");
    assert.strictEqual(u.searchParams.get("callback_url"), "http://127.0.0.1:5555/callback");
    assert.strictEqual(u.searchParams.get("code_challenge"), "ch");
    assert.strictEqual(u.searchParams.get("code_challenge_method"), "S256");
    assert.strictEqual(u.searchParams.get("key_label"), "autopilot (box)");
  });

  it("omits callback_url for the headless (paste-the-code) flow, and honours OPENROUTER_AUTH_URL", () => {
    process.env.OPENROUTER_AUTH_URL = "http://localhost:9/auth/";
    const u = new URL(buildAuthUrl({ challenge: "ch" }));
    assert.strictEqual(u.origin + u.pathname, "http://localhost:9/auth");
    assert.strictEqual(u.searchParams.has("callback_url"), false);
    assert.ok(u.searchParams.get("key_label")?.startsWith("autopilot ("));
  });
});

describe("isHeadlessEnvironment", () => {
  it("is true over SSH and on display-less Linux, false on a desktop", () => {
    assert.strictEqual(isHeadlessEnvironment({ SSH_CONNECTION: "1 2 3 4" }, "darwin"), true);
    assert.strictEqual(isHeadlessEnvironment({}, "linux"), true);
    assert.strictEqual(isHeadlessEnvironment({ DISPLAY: ":0" }, "linux"), false);
    assert.strictEqual(isHeadlessEnvironment({}, "darwin"), false);
    assert.strictEqual(isHeadlessEnvironment({}, "win32"), false);
  });
});

describe("exchangeCode", () => {
  it("POSTs code + verifier to /auth/keys and returns the key", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ key: "sk-or-v1-minted", user_id: "u1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const key = await exchangeCode("  auth_code_1 \n", "verifier-1", fetchImpl);
    assert.strictEqual(key, "sk-or-v1-minted");
    assert.ok(seen!.url.endsWith("/api/v1/auth/keys"));
    assert.deepStrictEqual(seen!.body, { code: "auth_code_1", code_verifier: "verifier-1", code_challenge_method: "S256" });
  });

  it("explains a rejected or expired code", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { code: 400, message: "Invalid code" } }), { status: 400 })) as unknown as typeof fetch;
    await assert.rejects(exchangeCode("x", "v", fetchImpl), (e: unknown) => e instanceof OpenRouterSignInError && /single-use/.test(e.message));
  });
});

describe("startLoopbackListener", () => {
  it("resolves with the code when the browser is redirected to the callback, then stops listening", async () => {
    const l = await startLoopbackListener({ timeoutMs: 5_000 });
    assert.match(l.callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const res = await fetch(`${l.callbackUrl}?code=auth_code_xyz`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /Signed in/);
    assert.strictEqual(await l.code, "auth_code_xyz");
    await assert.rejects(fetch(`${l.callbackUrl}?code=again`)); // server closed
  });

  it("ignores requests without a code and other paths", async () => {
    const l = await startLoopbackListener({ timeoutMs: 5_000 });
    const base = l.callbackUrl.replace("/callback", "");
    assert.strictEqual((await fetch(`${base}/favicon.ico`)).status, 404);
    assert.strictEqual((await fetch(l.callbackUrl)).status, 400);
    await fetch(`${l.callbackUrl}?code=ok`);
    assert.strictEqual(await l.code, "ok");
  });

  it("rejects on timeout and on close", async () => {
    const slow = await startLoopbackListener({ timeoutMs: 20 });
    await assert.rejects(slow.code, /Timed out/);
    const cancelled = await startLoopbackListener({ timeoutMs: 5_000 });
    cancelled.close();
    await assert.rejects(cancelled.code, /cancelled/);
  });
});

describe("exchangeCode gate", () => {
  it("refuses a public-resolving cleartext base before the code is sent", async () => {
    const savedBase = process.env.OPENROUTER_BASE_URL;
    process.env.OPENROUTER_BASE_URL = "http://proxy:8080/api/v1";
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => exchangeCode("code", "verifier", fetchImpl, async () => [{ address: "203.0.113.9", family: 4 }]),
        /base URL must use https/,
      );
      assert.strictEqual(called, false);
    } finally {
      if (savedBase === undefined) delete process.env.OPENROUTER_BASE_URL;
      else process.env.OPENROUTER_BASE_URL = savedBase;
    }
  });
});
