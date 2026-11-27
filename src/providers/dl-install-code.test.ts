import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "../config.js";
import {
  dlInstallOption,
  INSTALL_CODE_FAILED_LINE,
  INSTALL_CODE_USED_LINE,
  redeemDlInstallCode,
  resetDlInstallCodeForTesting,
  takeDlInstallNotice,
} from "./dl-install-code.js";

const CODE = "AbCdEfGhIjKlMnOpQrStUvWxYz0";
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ AUTOPILOT_DL_FREE_URL: "https://free.test", DL_INSTALL_CODE: CODE, ...extra });

type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

const tokens = (extra: Record<string, unknown> = {}) => ({ access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600, login: "octo", option: "computer", plan: "free", ...extra });
const saved = async () => JSON.parse(await readFile(configPath(), "utf8")) as { provider?: string; model?: string; providers?: Record<string, { apiKey?: string; refreshToken?: string; model?: string }> };

describe("dl.new's install code", () => {
  beforeEach(async () => {
    resetDlInstallCodeForTesting();
    await rm(configPath(), { force: true });
  });
  afterEach(() => resetDlInstallCodeForTesting());

  it("is exchanged once for the free tier's tokens, and makes the free tier the provider on this computer", async () => {
    const calls: Call[] = [];
    const out = await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(200, tokens(), calls) });
    assert.equal(out.kind, "signed-in");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://free.test/v1/install-code/exchange");
    assert.deepEqual(calls[0]!.body, { code: CODE });
    const cfg = await saved();
    assert.equal(cfg.provider, "directionally-local");
    assert.equal(cfg.providers?.["directionally-local"]?.apiKey, "at-1");
    assert.equal(cfg.providers?.["directionally-local"]?.refreshToken, "rt-1");
    assert.ok(cfg.model);
    assert.equal(dlInstallOption(), "computer");
    assert.deepEqual(takeDlInstallNotice(), ["✓ Signed in as @octo from dl.new."]);
    assert.deepEqual(takeDlInstallNotice(), [], "said once");
  });

  it("keeps the sign-in but leaves the provider to the GPU first run when the choice was the GPU", async () => {
    const out = await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(200, tokens({ option: "gpu", plan: null })) });
    assert.equal(out.kind, "signed-in");
    const cfg = await saved();
    assert.equal(cfg.provider, undefined);
    assert.equal(cfg.providers?.["directionally-local"]?.refreshToken, "rt-1");
    assert.equal(dlInstallOption(), "gpu");
  });

  it("doesn't switch away from a provider that's already set up", async () => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: "openrouter", openrouterApiKey: "sk-or-x", model: "some/model" }));
    await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(200, tokens()) });
    const cfg = await saved();
    assert.equal(cfg.provider, "openrouter");
    assert.equal(cfg.providers?.["directionally-local"]?.refreshToken, "rt-1");
  });

  it("falls back to the normal sign-in with one line when the code was used or expired", async () => {
    const out = await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(400, { error: { code: "invalid_install_code", message: "This install command was already used.", reason: "used" } }) });
    assert.deepEqual(out, { kind: "fallback", line: INSTALL_CODE_USED_LINE });
    assert.equal(dlInstallOption(), undefined);
    await assert.rejects(readFile(configPath(), "utf8"), "nothing saved");
    assert.deepEqual(takeDlInstallNotice(), [INSTALL_CODE_USED_LINE]);
  });

  it("says the service's reason for any other refusal, and a plain line when the service can't be reached", async () => {
    const blocked = await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(403, { error: { code: "blocked", message: "This account is blocked." } }) });
    assert.equal(blocked.kind, "fallback");
    assert.match((blocked as { line: string }).line, /^This account is blocked\. Sign in with GitHub below/);
    const down = await redeemDlInstallCode({ env: env(), fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    assert.deepEqual(down, { kind: "fallback", line: INSTALL_CODE_FAILED_LINE });
  });

  it("does nothing without a code, with something that isn't one, or when already signed in", async () => {
    const calls: Call[] = [];
    assert.equal((await redeemDlInstallCode({ env: env({ DL_INSTALL_CODE: "" }), fetchImpl: fakeFetch(200, tokens(), calls) })).kind, "none");
    assert.equal((await redeemDlInstallCode({ env: env({ DL_INSTALL_CODE: "not a code" }), fetchImpl: fakeFetch(200, tokens(), calls) })).kind, "none");
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "old", refreshToken: "old-rt" } } }));
    assert.equal((await redeemDlInstallCode({ env: env(), fetchImpl: fakeFetch(200, tokens(), calls) })).kind, "none");
    assert.equal(calls.length, 0);
    assert.equal((await saved()).providers?.["directionally-local"]?.refreshToken, "old-rt");
  });
});

describe("dl install-code gate", () => {
  beforeEach(async () => {
    resetDlInstallCodeForTesting();
    await rm(configPath(), { force: true });
  });
  afterEach(() => resetDlInstallCodeForTesting());

  it("refuses a public-resolving cleartext DL origin before the install code is sent", async () => {
    const calls: Call[] = [];
    const out = await redeemDlInstallCode({
      env: env({ AUTOPILOT_DL_FREE_URL: "http://proxy:8080" }),
      fetchImpl: fakeFetch(200, tokens(), calls),
      resolver: async () => [{ address: "203.0.113.9", family: 4 }],
    });
    assert.equal(out.kind, "fallback");
    assert.equal(calls.length, 0, "no request was sent, so the code never left");
  });
});
