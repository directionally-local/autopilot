import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { authorizeUrl, chatgptAccessToken, completeSignIn, TOKEN_SHARING_SCOPE } from "./chatgpt.js";
import { compressLargeBody, runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { ensureProviderCatalog } from "../models/provider-catalog.js";
import { listModels, registerProviderModels } from "../models/registry.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const idToken = (claims: Record<string, unknown>) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

describe("ChatGPT sign-in", () => {
  it("asks for token sharing for the OpenAI API, registering a client on first sign-in", () => {
    const first = new URL(authorizeUrl({ redirect: "http://127.0.0.1:1/auth/callback", challenge: "c", state: "s", nonce: "n", hostId: "urn:uuid:1" }));
    assert.strictEqual(first.origin + first.pathname, "https://auth.openai.com/api/accounts/authorize");
    assert.strictEqual(first.searchParams.get("client_id"), "dynamic_agent_client");
    assert.strictEqual(first.searchParams.get("agent_name_hint"), "Autopilot");
    assert.ok(first.searchParams.get("scope")!.split(" ").includes(TOKEN_SHARING_SCOPE));
    assert.strictEqual(first.searchParams.get("resource"), "https://api.openai.com/v1");
    assert.strictEqual(first.searchParams.get("code_challenge_method"), "S256");
    const again = new URL(authorizeUrl({ redirect: "r", challenge: "c", state: "s", nonce: "n", hostId: "h", clientId: "client_abc" }));
    assert.strictEqual(again.searchParams.get("client_id"), "client_abc");
    assert.strictEqual(again.searchParams.get("agent_name_hint"), null);
  });

  it("requires token sharing and a matching nonce", async () => {
    const tokens = (scope: string, nonce = "n1") => (async () => json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope, id_token: idToken({ nonce }) })) as unknown as typeof fetch;
    const ok = await completeSignIn("code", "client_abc", "r", "v", "n1", tokens(`openid ${TOKEN_SHARING_SCOPE}`));
    assert.strictEqual(ok.apiKey, "at");
    assert.strictEqual(ok.refreshToken, "rt");
    assert.strictEqual(ok.clientId, "client_abc");
    await assert.rejects(completeSignIn("code", "c", "r", "v", "n1", tokens("openid")), /without token sharing/);
    await assert.rejects(completeSignIn("code", "c", "r", "v", "n1", tokens(TOKEN_SHARING_SCOPE, "other")), /different sign-in attempt/);
  });
});

describe("ChatGPT tokens and requests", () => {
  let home: string;
  const ENV = ["XDG_CONFIG_HOME", "CHATGPT_ACCESS_TOKEN", "AUTOPILOT_PROVIDER"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const file = () => join(home, "kimiflare", "config.json");

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "chatgpt-test-"));
  });
  beforeEach(async () => {
    for (const k of ENV) delete process.env[k];
    process.env.XDG_CONFIG_HOME = home;
    await mkdir(join(home, "kimiflare"), { recursive: true });
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  it("refreshes an expiring token and saves the new one", async () => {
    const now = 1_000_000;
    await writeFile(file(), JSON.stringify({ providers: { chatgpt: { apiKey: "old", refreshToken: "rt1", expiresAt: now + 30_000, clientId: "client_abc", hostId: "h" } } }));
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return json(200, { access_token: "new", refresh_token: "rt2", expires_in: 3600 });
    }) as unknown as typeof fetch;
    assert.strictEqual(await chatgptAccessToken(fetchImpl, now), "new");
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /client_id=client_abc/);
    const onDisk = JSON.parse(await readFile(file(), "utf8")).providers.chatgpt;
    assert.deepStrictEqual([onDisk.apiKey, onDisk.refreshToken, onDisk.expiresAt, onDisk.hostId], ["new", "rt2", now + 3_600_000, "h"]);
    // A fresh token is used as is.
    assert.strictEqual(await chatgptAccessToken((async () => { throw new Error("no refresh expected"); }) as unknown as typeof fetch, now), "new");
  });

  it("sends Responses requests with the fresh token and session headers; limits the catalog to plan models", async () => {
    await writeFile(file(), JSON.stringify({ provider: "chatgpt", providers: { chatgpt: { apiKey: "tok", refreshToken: "rt", expiresAt: Date.now() + 3_600_000, clientId: "c" } } }));
    await ensureProviderCatalog("chatgpt", {}, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    const ids = listModels().map((m) => m.id);
    assert.ok(ids.includes("gpt-6.1-sol") && ids.every((id) => id.startsWith("gpt-")));
    assert.ok(listModels().every((m) => m.pricing.inputPerMtok === 0));
    let req: { url: string; headers: Headers } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      req = { url: String(input), headers: new Headers(init?.headers) };
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const auth = llmAuthFromConfig({ provider: "chatgpt", providers: { chatgpt: { apiKey: "tok" } } });
    for await (const _ of runKimi({ ...auth, model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }], sessionId: "sess-1" })) {
      /* drain */
    }
    assert.strictEqual(req!.url, "https://api.openai.com/v1/responses");
    assert.strictEqual(req!.headers.get("authorization"), "Bearer tok");
    assert.strictEqual(req!.headers.get("session-id"), "sess-1");
    assert.strictEqual(req!.headers.get("thread-id"), "sess-1");
  });

  it("does not retry subscription errors", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return json(429, { error: { message: "subscription_sharing_usage_limit_exceeded: you've hit your plan limit" } });
    }) as typeof fetch;
    const auth = llmAuthFromConfig({ provider: "chatgpt", providers: { chatgpt: { apiKey: "tok" } } });
    await assert.rejects(async () => {
      for await (const _ of runKimi({ ...auth, model: "gpt-6.1-sol", messages: [{ role: "user", content: "hi" }] })) {
        /* drain */
      }
    }, /usage_limit_exceeded/);
    assert.strictEqual(calls, 1);
  });

  it("zstd-compresses large bodies when Node supports it", () => {
    const headers: Record<string, string> = {};
    assert.strictEqual(compressLargeBody("small", headers), "small");
    const big = JSON.stringify({ text: "x".repeat(600_000) });
    const out = compressLargeBody(big, headers);
    if ((zlib as { zstdCompressSync?: unknown }).zstdCompressSync) {
      assert.strictEqual(headers["Content-Encoding"], "zstd");
      assert.ok(out instanceof Uint8Array && out.byteLength < big.length / 10);
    } else {
      assert.strictEqual(out, big);
    }
  });
});
