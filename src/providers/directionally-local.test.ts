import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "../config.js";
import { getPreset, PROVIDER_PRESETS } from "./presets.js";
import { resolveActiveProvider } from "./resolve.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { runKimi } from "../agent/client.js";
import { ensureProviderCatalog } from "../models/provider-catalog.js";
import { listModels, registerProviderModels } from "../models/registry.js";
import { DL_SIGN_IN_NEEDED, dlSignInLines, leavingFreeTierLine, PROVIDER_CHOICES, planConnect, providerRows } from "./connect.js";
import { buildConnectState, HIDDEN_WITHOUT_GATEWAY } from "./connect-state.js";
import { switchProvider } from "./keys.js";
import { dispatchSlashCommand, logoutLine, logoutPatch, usageText, type SlashContext } from "../ui/slash-commands.js";
import { costNote } from "../usage-tracker.js";
import {
  describeDlError,
  dlAccessToken,
  DL_DENIALS,
  dlDenialLine,
  dlDenialOf,
  DlError,
  dlSignedInLine,
  dlSignOut,
  formatLocalTime,
  localResetWeekday,
  nextWeekStart,
  normalizeDlMe,
  parseDlError,
  DL_DISCLOSURE,
  DL_FREE_MODEL,
  DL_FREE_MODELS,
  dlApiBase,
  dlFallbackNotice,
  dlModelAllowanceLine,
  dlNotFreeLine,
  dlPickerHint,
  dlSignIn,
  fetchDlMe,
  formatCountdown,
  formatReset,
  formatUsd,
  pollDlDeviceFlow,
  quotaNoticeFromHeaders,
  renderDlUsage,
  resetDlNoticeState,
  startDlDeviceFlow,
  type DlMe,
} from "./directionally-local.js";

/** A local stand-in for the free-tier service, scripted per test. */
interface Stub {
  url: string;
  server: Server;
  tokenReplies: Array<{ status: number; body: unknown }>;
  refreshReply: { status: number; body: unknown } | null;
  chatReplies: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>;
  meReply: { status: number; body: unknown } | null;
  revokeStatus: number;
  calls: Array<{ path: string; auth: string | undefined; body: string }>;
}

async function startStub(): Promise<Stub> {
  const stub = { tokenReplies: [], refreshReply: null, chatReplies: [], meReply: null, revokeStatus: 404, calls: [] } as unknown as Stub;
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  };
  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url ?? "/";
      stub.calls.push({ path, auth: req.headers.authorization, body });
      if (path === "/v1/device/code") {
        return send(res, 200, {
          device_code: "dev-1",
          user_code: "ABCD-1234",
          verification_uri: `${stub.url}/device`,
          verification_uri_complete: `${stub.url}/device?code=ABCD-1234`,
          interval: 5,
          expires_in: 600,
        });
      }
      if (path === "/v1/device/token") {
        const r = stub.tokenReplies.shift() ?? { status: 400, body: { error: { code: "authorization_pending" } } };
        return send(res, r.status, r.body);
      }
      if (path === "/v1/token/refresh") {
        const r = stub.refreshReply ?? { status: 401, body: { error: { code: "invalid_grant" } } };
        return send(res, r.status, r.body);
      }
      if (path === "/v1/me") {
        const r = stub.meReply ?? { status: 200, body: me() };
        return send(res, r.status, r.body);
      }
      if (path === "/v1/chat/completions") {
        const r = stub.chatReplies.shift() ?? { status: 200 };
        if (r.status === 200) {
          res.writeHead(200, { "content-type": "text/event-stream", ...(r.headers ?? {}) });
          return res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
        }
        return send(res, r.status, r.body, r.headers);
      }
      if (path === "/v1/events") return send(res, 202, { accepted: 1 });
      if (path === "/v1/token/revoke") return send(res, stub.revokeStatus, stub.revokeStatus === 404 ? { error: { code: "not_found" } } : { revoked: true });
      send(res, 404, { error: { code: "not_found" } });
    });
  });
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", () => r()));
  const addr = stub.server.address();
  stub.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  return stub;
}

function me(over: Partial<DlMe["allowance"]> = {}): DlMe {
  return {
    login: "octo",
    githubId: 1,
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 12_500_000, remaining: 37_500_000, resetsAt: "2026-11-09T00:00:00.000Z", ...over },
    models: [DL_FREE_MODEL],
  };
}

const NOW = Date.parse("2026-11-04T00:00:00.000Z");
const noSleep = async () => {};

describe("Directionally Local free tier", () => {
  let home: string;
  let stub: Stub;
  const ENV = ["XDG_CONFIG_HOME", "AUTOPILOT_DL_FREE_URL", "AUTOPILOT_DL_FREE_TOKEN", "AUTOPILOT_PROVIDER", "AUTOPILOT_BASE_URL", "KIMIFLARE_BASE_URL"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const writeCfg = async (cfg: unknown) => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify(cfg));
  };
  const readCfg = async () => JSON.parse(await readFile(configPath(), "utf8"));
  const drain = async (auth: ReturnType<typeof llmAuthFromConfig>, extra: Record<string, unknown> = {}) => {
    for await (const _ of runKimi({ ...auth, model: DL_FREE_MODEL, messages: [{ role: "user", content: "hi" }], networkRetries: 0, ...extra })) {
      /* drain */
    }
  };

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "dl-free-test-"));
    stub = await startStub();
  });
  beforeEach(async () => {
    for (const k of ENV) delete process.env[k];
    process.env.XDG_CONFIG_HOME = home;
    process.env.AUTOPILOT_DL_FREE_URL = stub.url;
    stub.tokenReplies = [];
    stub.refreshReply = null;
    stub.chatReplies = [];
    stub.meReply = null;
    stub.revokeStatus = 404;
    stub.calls = [];
    resetDlNoticeState();
    await rm(configPath(), { force: true });
  });
  after(async () => {
    stub.server.close();
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  describe("preset", () => {
    it("is OpenAI-compatible at AUTOPILOT_DL_FREE_URL + /v1 with the free models and no pasted key", () => {
      const p = getPreset("directionally-local");
      assert.strictEqual(p.name, "Directionally Local, free");
      assert.strictEqual(p.protocol ?? "openai-chat", "openai-chat");
      assert.strictEqual(p.defaultModel, "gpt-6-luna");
      assert.strictEqual(p.plumbingModel, "gpt-6-luna");
      assert.strictEqual(p.catalog, "directionally-local");
      assert.strictEqual(p.keysUrl, undefined);
      assert.strictEqual(dlApiBase({ AUTOPILOT_DL_FREE_URL: "http://x:9/" }), "http://x:9/v1");
      assert.strictEqual(dlApiBase({}), "https://free.directionallylocal.com/v1");
      const active = resolveActiveProvider({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at" } } }, { AUTOPILOT_DL_FREE_URL: "http://stub:1" });
      assert.deepStrictEqual([active.id, active.baseUrl, active.apiKey], ["directionally-local", "http://stub:1/v1", "at"]);
      // A sandbox's Hotcell route: AUTOPILOT_PROVIDER + AUTOPILOT_BASE_URL, token in the env.
      const cell = resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "directionally-local", AUTOPILOT_BASE_URL: "http://gw/directionally-local/v1", AUTOPILOT_DL_FREE_TOKEN: "egress" });
      assert.deepStrictEqual([cell.baseUrl, cell.apiKey], ["http://gw/directionally-local/v1", "egress"]);
      assert.ok(PROVIDER_PRESETS["directionally-local"]);
      assert.match(costNote(p) ?? "", /weekly free allowance/);
    });

    it("is first in the picker with the weekly allowance, and a sign-in (not a key) to connect", () => {
      assert.strictEqual(PROVIDER_CHOICES[0]?.id, "directionally-local");
      assert.strictEqual(dlPickerHint(), "free — GPT-6 Luna + DeepSeek, 50M tokens/week, sign in with GitHub");
      const rows = providerRows(null, { env: {} });
      assert.strictEqual(rows[0]?.id, "directionally-local");
      assert.deepStrictEqual(planConnect("directionally-local", null, {}), { kind: "directionally-local" });
      assert.ok(HIDDEN_WITHOUT_GATEWAY.has("directionally-local"), "not offered with --state-file");
    });

    it("lists every free model, all priced at zero", async () => {
      await ensureProviderCatalog("directionally-local", {}, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      assert.deepStrictEqual(listModels().map((m) => m.id), DL_FREE_MODELS.map((m) => m.id));
      assert.strictEqual(listModels()[0]?.id, DL_FREE_MODEL);
      for (const model of listModels()) assert.strictEqual(model.pricing.inputPerMtok, 0);
    });

    it("restores the free model when switching back to the free tier", async () => {
      await writeCfg({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5", providers: { "directionally-local": { apiKey: "at", model: "something/else" } } });
      await switchProvider({ provider: "openrouter", model: "anthropic/claude-sonnet-5.5" } as never, "directionally-local", "something/else");
      const cfg = await readCfg();
      assert.deepStrictEqual([cfg.provider, cfg.model], ["directionally-local", DL_FREE_MODEL]);
      assert.strictEqual(cfg.providers.openrouter.model, "anthropic/claude-sonnet-5.5");
    });

    it("says a non-free model or provider needs the person's own key", () => {
      assert.strictEqual(dlNotFreeLine("Anthropic"), "Anthropic isn't part of the Directionally Local free tier; it needs your own API key.");
      assert.strictEqual(
        DL_DISCLOSURE,
        "Free tokens come with usage counts: tokens, cost, sessions, turns, tool counts, errors, model, Autopilot version and OS. Never your prompts, code or file contents.",
      );
    });

    it("/model to a non-free model says it needs your own key and opens provider setup", async () => {
      const infos: string[] = [];
      let setup: unknown = "unset";
      let cfgChanged = false;
      const ctx = {
        cfg: { provider: "directionally-local", model: DL_FREE_MODEL, providers: { "directionally-local": { apiKey: "at" } } },
        busy: false,
        mkKey: () => "k",
        setEvents: (f: (e: Array<{ text: string }>) => Array<{ text: string }>) => infos.push(...f([]).map((e) => e.text)),
        setCfg: () => void (cfgChanged = true),
        setProviderSetup: (v: unknown) => void (setup = v),
      } as unknown as SlashContext;
      await dispatchSlashCommand(ctx, "/model anthropic/claude-sonnet-5.5");
      assert.strictEqual(infos.length, 1);
      assert.match(infos[0]!, /^anthropic\/claude-sonnet-5\.5 isn't part of the Directionally Local free tier; it needs your own API key\./);
      assert.deepStrictEqual(setup, {}, "the whole provider list opens, nothing preselected");
      assert.match(infos[0]!, /Pick a provider for your own key below \(or any time with \/provider\)/);
      assert.strictEqual(cfgChanged, false, "the model is not switched before a provider is connected");
      // The free model itself is fine.
      infos.length = 0;
      await dispatchSlashCommand(ctx, `/model ${DL_FREE_MODEL}`);
      assert.strictEqual(cfgChanged, true);
    });

    it("says what sign-in collects, and that cancelling leaves it unconnected", () => {
      const before = dlSignInLines().split("\n");
      assert.deepStrictEqual(before, [
        "Free: GPT-6 Luna + DeepSeek, 50M tokens a week, no credit card. Sign in with GitHub to start.",
        DL_DISCLOSURE,
      ]);
      const code = { deviceCode: "d", userCode: "ABCD-1234", verificationUri: "u", verificationUriComplete: "https://x/device?code=ABCD-1234", intervalSec: 5, expiresInSec: 600 };
      assert.strictEqual(
        dlSignInLines(code, true),
        "Your code is ABCD-1234. Opened your browser at https://x/device?code=ABCD-1234 — sign in with GitHub and approve it (enter an invite code there if asked).",
      );
      assert.strictEqual(
        dlSignInLines(code, false),
        "Your code is ABCD-1234. Open https://x/device?code=ABCD-1234 in a browser on any device, sign in with GitHub and approve it (enter an invite code there if asked).",
      );
      assert.ok(!dlSignInLines(code, true).includes(DL_DISCLOSURE), "the disclosure is said once, before the code");
      assert.ok(!DL_SIGN_IN_NEEDED.includes("\n"));
      assert.doesNotMatch(DL_SIGN_IN_NEEDED, /choose it again/i, "no choose-it-again loop");
    });

    it("warns before leaving the free tier for a provider that needs a key", () => {
      assert.strictEqual(leavingFreeTierLine("directionally-local", "anthropic"), "Anthropic isn't part of the Directionally Local free tier; it needs your own API key.");
      assert.strictEqual(leavingFreeTierLine("directionally-local", "ollama"), undefined, "local runtimes need no key");
      assert.strictEqual(leavingFreeTierLine("openrouter", "anthropic"), undefined);
      assert.strictEqual(leavingFreeTierLine("directionally-local", "directionally-local"), undefined);
    });

    it("is kept out of the connect state file (servers get free-tier keys later)", () => {
      assert.throws(
        () => buildConnectState({ id: "directionally-local", key: "access-1", model: DL_FREE_MODEL }, { provider: "directionally-local" }, { AUTOPILOT_DL_FREE_URL: "http://stub:1" }),
        /can't be handed to a key gateway/,
      );
    });
  });

  describe("device sign-in against a stub", () => {
    it("polls through authorization_pending to tokens and saves them 0600", async () => {
      stub.tokenReplies = [
        { status: 400, body: { error: { code: "authorization_pending" } } },
        { status: 400, body: { error: { code: "authorization_pending" } } },
        { status: 200, body: { access_token: "at-1", refresh_token: "rt-1", token_type: "Bearer", expires_in: 3600 } },
      ];
      const waits: number[] = [];
      let shown: string | undefined;
      const token = await dlSignIn((c) => (shown = `${c.userCode} ${c.verificationUriComplete}`), { sleep: async (ms) => void waits.push(ms) });
      assert.strictEqual(token, "at-1");
      assert.strictEqual(shown, `ABCD-1234 ${stub.url}/device?code=ABCD-1234`);
      assert.deepStrictEqual(waits, [5000, 5000, 5000]);
      assert.deepStrictEqual(JSON.parse(stub.calls.find((c) => c.path === "/v1/device/token")!.body), { device_code: "dev-1" });
      const s = (await readCfg()).providers["directionally-local"];
      assert.deepStrictEqual([s.apiKey, s.refreshToken], ["at-1", "rt-1"]);
      assert.ok(s.expiresAt > Date.now() + 3_500_000);
      assert.strictEqual((await stat(configPath())).mode & 0o777, 0o600);
    });

    it("adds five seconds to the interval on slow_down", async () => {
      stub.tokenReplies = [
        { status: 400, body: { error: { code: "slow_down" } } },
        { status: 400, body: { error: { code: "slow_down" } } },
        { status: 200, body: { access_token: "at", refresh_token: "rt", expires_in: 3600 } },
      ];
      const waits: number[] = [];
      const code = await startDlDeviceFlow();
      await pollDlDeviceFlow(code, { sleep: async (ms) => void waits.push(ms) });
      assert.deepStrictEqual(waits, [5000, 10000, 15000]);
    });

    for (const [code, reason, expected] of [
      ["expired_token", undefined, /^The sign-in code expired before it was approved/],
      ["access_denied", undefined, /^The sign-in was declined in the browser, so nothing was saved\.$/],
      ["access_denied", "account_too_new", /^New GitHub accounts \(under 30 days\) need an invite code for the free tier\. Have one\? Choose Free again and enter it in the browser\. Or use your own API key\.$/],
      ["access_denied", "device_taken", /^This device already has a free allowance under another GitHub account; sign in with that account instead\.$/],
      ["access_denied", "something_new", /^The sign-in was declined in the browser/],
      ["not_invited", undefined, /^This GitHub account needs an invite code for the free tier\. Have one\? Choose Free again and enter it in the browser\. Or use your own API key\.$/],
      // The codes the service is adding; the same sentences.
      ["account_too_new", undefined, /^New GitHub accounts \(under 30 days\) need an invite code/],
      ["invalid_invite", undefined, /^This GitHub account needs an invite code for the free tier\. Have one\?/],
      ["access_denied", "invalid_invite", /^This GitHub account needs an invite code for the free tier\. Have one\?/],
      ["cohort_full", undefined, /^The free tier is full right now\. Use your own API key meanwhile\.$/],
      ["not_invited", "cohort_full", /^The free tier is full right now\. Use your own API key meanwhile\.$/],
      ["paused", undefined, /^Free tokens are paused for everyone\. Your own key still works\.$/],
      ["service_paused", "total_budget", /^Free tokens are paused for everyone\. Your own key still works\.$/],
      // The service's final sign-in codes (400, reason = code).
      ["invite_required", "invite_required", /^This GitHub account needs an invite code for the free tier\. Have one\? Choose Free again/],
      ["cohort_full", "cohort_full", /^The free tier is full right now\. Use your own API key meanwhile\.$/],
      ["too_many_signups", "too_many_signups", /^Too many new free-tier accounts from this network today\. Try again tomorrow, or use your own API key\.$/],
      ["service_paused", "paused", /^Free tokens are paused for everyone\. Your own key still works\.$/],
      ["account_too_new", "account_too_new", /^New GitHub accounts \(under 30 days\)/],
    ] as const) {
      it(`ends the sign-in on ${code}${reason ? ` (${reason})` : ""} with one plain sentence`, async () => {
        stub.tokenReplies = [{ status: 400, body: { error: { code, message: "service wording", ...(reason ? { reason } : {}) } } }];
        const c = await startDlDeviceFlow();
        await assert.rejects(pollDlDeviceFlow(c, { sleep: noSleep }), (e: unknown) => e instanceof DlError && e.code === code && expected.test(e.message) && !e.message.includes("\n"));
      });
    }

    it("keeps polling while the person types an invite code (authorization_pending)", async () => {
      stub.tokenReplies = [
        { status: 400, body: { error: { code: "authorization_pending" } } },
        { status: 400, body: { error: { code: "authorization_pending" } } },
        { status: 400, body: { error: { code: "authorization_pending" } } },
        { status: 200, body: { access_token: "at-inv", refresh_token: "rt", expires_in: 3600 } },
      ];
      const c = await startDlDeviceFlow();
      assert.strictEqual((await pollDlDeviceFlow(c, { sleep: noSleep })).access_token, "at-inv");
    });

    it("gives up when the code's lifetime runs out", async () => {
      let t = 0;
      const c = await startDlDeviceFlow();
      await assert.rejects(
        pollDlDeviceFlow(c, { sleep: async (ms) => void (t += ms), now: () => t }),
        (e: unknown) => e instanceof DlError && e.code === "expired_token",
      );
    });

    it("stops polling when cancelled", async () => {
      const ctrl = new AbortController();
      const c = await startDlDeviceFlow();
      ctrl.abort();
      await assert.rejects(pollDlDeviceFlow(c, { signal: ctrl.signal }), /aborted/);
    });
  });

  describe("token refresh", () => {
    it("refreshes before expiry and stores the rotated refresh token", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "old", refreshToken: "rt-1", expiresAt: NOW + 30_000 } } });
      stub.refreshReply = { status: 200, body: { access_token: "new", refresh_token: "rt-2", token_type: "Bearer", expires_in: 3600 } };
      assert.strictEqual(await dlAccessToken({ now: NOW }), "new");
      assert.deepStrictEqual(JSON.parse(stub.calls.at(-1)!.body), { refresh_token: "rt-1" });
      const s = (await readCfg()).providers["directionally-local"];
      assert.deepStrictEqual([s.apiKey, s.refreshToken, s.expiresAt], ["new", "rt-2", NOW + 3_600_000]);
      stub.calls = [];
      assert.strictEqual(await dlAccessToken({ now: NOW }), "new");
      assert.strictEqual(stub.calls.length, 0, "a fresh token is used as is");
    });

    it("asks to sign in again in one line on invalid_grant", async () => {
      await writeCfg({ providers: { "directionally-local": { apiKey: "old", refreshToken: "dead", expiresAt: NOW - 1 } } });
      await assert.rejects(dlAccessToken({ now: NOW }), (e: unknown) =>
        e instanceof DlError && e.code === "invalid_grant" && e.message === "Your Directionally Local sign-in has expired; sign in again with `autopilot auth directionally-local`.",
      );
    });

    it("under dl, points at /provider instead of a command dl users don't have", () => {
      const env = { AUTOPILOT_LAUNCHED_BY: "dl" };
      assert.strictEqual(describeDlError("invalid_grant", { env }), "Your free-tier sign-in expired. Run /provider and choose Free to sign in again.");
      assert.strictEqual(describeDlError("invalid_token", { env }), "The free tier didn't accept your sign-in. Run /provider and choose Free to sign in again.");
      assert.ok(!/autopilot/.test(describeDlError("invalid_grant", { env })!));
      assert.match(describeDlError("invalid_grant", { env: {} })!, /`autopilot auth directionally-local`/, "standalone wording unchanged");
    });

    describe("a refresh lost to another session on this machine", () => {
      const invalidGrant = () => new Response(JSON.stringify({ error: { code: "invalid_grant" } }), { status: 401, headers: { "content-type": "application/json" } });
      const winner = { apiKey: "winner-at", refreshToken: "rt-2", expiresAt: NOW + 3_600_000 };

      it("uses the pair the other session already saved", async () => {
        await writeCfg({ providers: { "directionally-local": { apiKey: "old", refreshToken: "rt-1", expiresAt: NOW - 1 } } });
        const sleeps: number[] = [];
        const fetchImpl = (async () => {
          // The other session rotated rt-1 and saved its pair while this request was in flight.
          await writeCfg({ providers: { "directionally-local": winner } });
          return invalidGrant();
        }) as unknown as typeof fetch;
        assert.strictEqual(await dlAccessToken({ now: NOW, fetchImpl, sleep: async (ms) => void sleeps.push(ms) }), "winner-at");
        assert.deepStrictEqual(sleeps, [], "already on disk: no wait");
        assert.deepStrictEqual((await readCfg()).providers["directionally-local"], winner, "the winner's pair is left as is");
      });

      it("waits once for a winner that is still saving", async () => {
        await writeCfg({ providers: { "directionally-local": { apiKey: "old", refreshToken: "rt-1", expiresAt: NOW - 1 } } });
        const sleeps: number[] = [];
        const fetchImpl = (async () => invalidGrant()) as unknown as typeof fetch;
        const sleep = async (ms: number) => {
          sleeps.push(ms);
          await writeCfg({ providers: { "directionally-local": winner } });
        };
        assert.strictEqual(await dlAccessToken({ now: NOW, fetchImpl, sleep }), "winner-at");
        assert.strictEqual(sleeps.length, 1);
        assert.ok(sleeps[0]! >= 750 && sleeps[0]! < 1_500, String(sleeps[0]));
      });

      it("still asks to sign in again when nobody rotated it", async () => {
        await writeCfg({ providers: { "directionally-local": { apiKey: "old", refreshToken: "rt-1", expiresAt: NOW - 1 } } });
        let calls = 0;
        const fetchImpl = (async () => {
          calls++;
          return invalidGrant();
        }) as unknown as typeof fetch;
        const sleeps: number[] = [];
        await assert.rejects(dlAccessToken({ now: NOW, fetchImpl, sleep: async (ms) => void sleeps.push(ms) }), (e: unknown) => e instanceof DlError && e.code === "invalid_grant");
        assert.strictEqual(calls, 1, "the dead token is not sent again");
        assert.strictEqual(sleeps.length, 1, "one re-check, then give up");
      });
    });

    it("uses AUTOPILOT_DL_FREE_TOKEN as is", async () => {
      process.env.AUTOPILOT_DL_FREE_TOKEN = "env-token";
      assert.strictEqual(await dlAccessToken(), "env-token");
    });

    it("refreshes once and resends after a 401 invalid_token", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "stale", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 } } });
      stub.refreshReply = { status: 200, body: { access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 } };
      stub.chatReplies = [{ status: 401, body: { error: { code: "invalid_token", message: "token expired" } } }, { status: 200 }];
      await drain(llmAuthFromConfig(await readCfg()));
      const chats = stub.calls.filter((c) => c.path === "/v1/chat/completions");
      assert.deepStrictEqual(chats.map((c) => c.auth), ["Bearer stale", "Bearer fresh"]);
      assert.strictEqual((await readCfg()).providers["directionally-local"].refreshToken, "rt-2");
    });

    it("asks to sign in again when the refreshed token is also refused", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "stale", refreshToken: "rt-1", expiresAt: Date.now() + 3_600_000 } } });
      stub.refreshReply = { status: 200, body: { access_token: "fresh", refresh_token: "rt-2", expires_in: 3600 } };
      stub.chatReplies = [
        { status: 401, body: { error: { code: "invalid_token" } } },
        { status: 401, body: { error: { code: "invalid_token" } } },
      ];
      await assert.rejects(drain(llmAuthFromConfig(await readCfg())), /sign in again with `autopilot auth directionally-local`/);
      assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/token/refresh").length, 1);
    });
  });

  describe("/usage and the allowance", () => {
    it("renders used, left and the reset time", () => {
      assert.strictEqual(
        renderDlUsage(me(), NOW, "Asia/Tokyo"),
        [
          "Directionally Local free tier · signed in as @octo",
          "  plan            Free",
          "  used this week  12.5M of 50M tokens (25%)",
          "  left            37.5M tokens",
          "  spending limit  $5 a week",
          "  resets          Mon 09:00 GMT+9 (in 5 days)",
        ].join("\n"),
      );
      assert.match(renderDlUsage(me(), NOW, "America/Los_Angeles"), /resets {10}Sun 16:00 PST \(in 5 days\)$/, "local time, not UTC");
      assert.match(
        renderDlUsage(me({ usedThisWeek: 50_000_000, remaining: 0 }), NOW, "Asia/Tokyo"),
        /\n  You've used this week's free tokens\. They're back Mon 09:00\. To keep going now: \/provider to use your own key\.$/,
      );
    });

    it("shows the spending limit, names the time zone, and counts down in days and hours", () => {
      const tuesday = Date.parse("2026-11-03T09:13:38.000Z");
      assert.strictEqual(
        renderDlUsage(me({ usedThisWeek: 32_200, remaining: 49_967_800, usdPerWeek: 5, spentUsdThisWeek: 0.0112 }), tuesday, "UTC"),
        [
          "Directionally Local free tier · signed in as @octo",
          "  plan            Free",
          "  used this week  32.2k of 50M tokens (0%)",
          "  left            50M tokens",
          "  spending limit  spent $0.01 of $5",
          "  resets          Mon 00:00 UTC (in 5 days 15 h)",
        ].join("\n"),
      );
      assert.doesNotMatch(renderDlUsage(me({ usdPerWeek: null }), NOW, "UTC"), /spending limit/, "no line when the service has no spending limit");
      assert.strictEqual(formatCountdown(26 * 3_600_000), "in 1 day 2 h");
      assert.strictEqual(formatCountdown(48 * 3_600_000), "in 2 days");
      assert.strictEqual(formatCountdown(3 * 3_600_000), "in 3 hours");
      assert.strictEqual(formatCountdown(20 * 60_000), "in under an hour");
      assert.strictEqual(formatUsd(0), "$0");
      assert.strictEqual(formatUsd(0.004), "under $0.01");
      assert.strictEqual(formatUsd(2.5), "$2.50");
    });

    it("reads GET /v1/me for /usage on the free tier, and points elsewhere on other providers", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 } } });
      const text = await usageText({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at" } } } as never, { now: NOW });
      assert.match(text, /signed in as @octo/);
      assert.match(text, /37\.5M tokens/);
      assert.strictEqual(stub.calls.find((c) => c.path === "/v1/me")?.auth, "Bearer at");
      assert.match(await usageText({ provider: "anthropic" } as never), /you're on Anthropic\. Use \/cost/);
    });

    it("explains a signed-out /usage", async () => {
      await assert.rejects(fetchDlMe(), /not signed in .*autopilot auth directionally-local/);
    });

    it("shows a one-line notice once 80% of the week is used, once per week", () => {
      const h = (remaining: number, resets = "2026-11-09T00:00:00.000Z") => new Headers({ "x-dl-tokens-remaining": String(remaining), "x-dl-quota-resets-at": resets });
      assert.strictEqual(quotaNoticeFromHeaders(h(20_000_000), { now: NOW }), undefined);
      const line = quotaNoticeFromHeaders(h(9_000_000), { now: NOW, timeZone: "Asia/Tokyo" });
      assert.strictEqual(line, "You've used 82% of this week's free Directionally Local tokens (9M left, resets Mon 09:00 GMT+9 (in 5 days)); /usage has details.");
      assert.ok(!line!.includes("\n"));
      assert.strictEqual(quotaNoticeFromHeaders(h(8_000_000), { now: NOW }), undefined, "only once per week");
      assert.ok(quotaNoticeFromHeaders(h(8_000_000, "2026-11-16T00:00:00.000Z"), { now: NOW }), "again the next week");
    });

    it("passes the 80% notice from a chat response to onNotice", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
      stub.chatReplies = [{ status: 200, headers: { "X-DL-Tokens-Remaining": "1000000", "X-DL-Quota-Resets-At": "2026-11-09T00:00:00.000Z" } }];
      const notices: string[] = [];
      await drain(llmAuthFromConfig(await readCfg()), { onNotice: (m: string) => notices.push(m) });
      assert.strictEqual(notices.length, 1);
      assert.match(notices[0]!, /^You've used 98% of this week's free Directionally Local tokens \(1M left/);
    });

    it("shows each free model's own weekly allowance from /v1/me's pools", () => {
      const me = normalizeDlMe({
        login: "alice",
        allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 1_000_000, remaining: 49_000_000, resetsAt: "2026-11-09T00:00:00.000Z" },
        pools: {
          luna: { tokensPerWeek: 50_000_000, usedThisWeek: 1_000_000, remaining: 49_000_000, models: ["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"] },
          sol: { tokensPerWeek: 10_000_000, usedThisWeek: 0, remaining: 10_000_000, models: ["gpt-6.1-sol"] },
          astra: { tokensPerWeek: 3_000_000, usedThisWeek: 3_000_000, remaining: 0, models: ["gpt-6-astra"] },
        },
      })!;
      assert.strictEqual(dlModelAllowanceLine("gpt-6-luna", me), "49M of 50M left this week");
      assert.strictEqual(dlModelAllowanceLine("deepseek/deepseek-v4.1-flash-1017", me), "49M of 50M left this week", "Luna and DeepSeek share one pool");
      assert.strictEqual(dlModelAllowanceLine("gpt-6.1-sol", me), "10M of 10M left this week");
      assert.strictEqual(dlModelAllowanceLine("gpt-6-astra", me), "0 of 3M left this week");
      assert.strictEqual(dlModelAllowanceLine("openai/gpt-5", me), undefined, "not a free model");
      assert.strictEqual(dlModelAllowanceLine("gpt-6-luna", null), undefined, "no account read yet");
    });

    it("says plainly when GPT-6 Luna fell back to DeepSeek, once", () => {
      resetDlNoticeState();
      assert.strictEqual(dlFallbackNotice(null), undefined);
      assert.strictEqual(dlFallbackNotice("deepseek/deepseek-v4.1-flash-1017"), "OpenAI didn't answer, so this turn ran on DeepSeek V4.1 Flash.");
      assert.strictEqual(dlFallbackNotice("deepseek/deepseek-v4.1-flash-1017"), undefined, "once per process");
      resetDlNoticeState();
      assert.ok(dlFallbackNotice("deepseek/deepseek-v4.1-flash-1017"));
    });

    it("says the Starter line once, from the service's thresholds, not the OpenAI notice", () => {
      resetDlNoticeState();
      const me = normalizeDlMe({
        login: "starter",
        level: "starter",
        levelReason: "account_too_new",
        thresholds: { minAccountAgeDays: 90, minPublicRepos: 3, minContributions: 50 },
        allowance: { tokensPerWeek: 5_000_000, usedThisWeek: 0, remaining: 5_000_000, resetsAt: "2026-11-09T00:00:00.000Z" },
        pools: { luna: { tokensPerWeek: 5_000_000, usedThisWeek: 0, remaining: 5_000_000, models: ["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"] } },
      })!;
      const line = dlFallbackNotice("starter", me);
      assert.match(line!, /Your account is on Starter: DeepSeek only, 5M tokens a week/);
      assert.match(line!, /90\+ days old with 3 public repos or 50 contributions/);
      assert.doesNotMatch(line!, /OpenAI didn't answer/);
      assert.strictEqual(dlFallbackNotice("starter", me), undefined, "once per process");
    });
  });

  describe("error messages", () => {
    it("has a plain sentence for each service error, with /provider as the way on", () => {
      const tokyo = { now: NOW, timeZone: "Asia/Tokyo" };
      const quota = "You've used this week's free tokens. They're back Mon 09:00. To keep going now: /provider to use your own key.";
      assert.strictEqual(describeDlError("quota_exceeded", { resetsAt: "2026-11-09T00:00:00.000Z", ...tokyo }), quota);
      // The token and the spending allowance read the same.
      assert.strictEqual(describeDlError("quota_exceeded", { reason: "tokens", resetsAt: "2026-11-09T00:00:00.000Z", ...tokyo }), quota);
      assert.strictEqual(describeDlError("quota_exceeded", { reason: "spend", resetsAt: "2026-11-09T00:00:00.000Z", ...tokyo }), quota);
      // No reset time from the service: its week ends Monday 00:00 UTC, shown locally.
      assert.strictEqual(describeDlError("quota_exceeded", tokyo), quota);
      assert.strictEqual(
        describeDlError("service_paused", { reason: "weekly_budget", resetsAt: "2026-11-09T00:00:00.000Z", ...tokyo }),
        "Free tokens are paused for everyone until Mon 09:00. Your own key works now: /provider",
      );
      assert.strictEqual(
        describeDlError("paused", { resetsAt: "2026-11-05T03:30:00.000Z", now: NOW, timeZone: "America/New_York" }),
        "Free tokens are paused for everyone until Wed 22:30. Your own key works now: /provider",
      );
      assert.strictEqual(describeDlError("service_paused", { reason: "paused" }), "Free tokens are paused for everyone. Your own key works now: /provider");
      assert.strictEqual(describeDlError("service_paused", { reason: "ended" }), "The free tier has ended. Your own key works now: /provider");
      assert.strictEqual(
        describeDlError("global_weekly_budget_reached", { reason: "weekly_budget", resetsAt: "2026-11-09T00:00:00.000Z", pausedForEveryone: true, ...tokyo }),
        "Free tokens are paused for everyone until Mon 09:00. Your own key works now: /provider",
      );
      assert.strictEqual(
        describeDlError("global_total_budget_reached", { reason: "total_budget", pausedForEveryone: true }),
        "Free tokens are paused for everyone. Your own key works now: /provider",
      );
      assert.strictEqual(describeDlError("some_future_pause", { pausedForEveryone: true }), "Free tokens are paused for everyone. Your own key works now: /provider");
      assert.strictEqual(describeDlError("some_future_code"), undefined, "unknown codes show the service's own sentence");
      assert.match(describeDlError("not_invited")!, /^This GitHub account isn't on the free tier\. Your own key works now: \/provider$/);
      assert.match(describeDlError("suspended")!, /account is suspended.*Your own key works now: \/provider$/);
      assert.strictEqual(describeDlError("rate_limited", { retryAfter: 12 }), "Directionally Local is limiting how fast you send requests; try again in 12 seconds.");
      assert.match(describeDlError("model_not_allowed")!, /serves gpt-6-luna, gpt-6\.1-sol, gpt-6-astra, deepseek\/deepseek-v4\.1-flash-1017/);
      for (const code of ["quota_exceeded", "service_paused", "suspended", "not_invited", "cohort_full", "account_too_new"]) {
        assert.doesNotMatch(describeDlError(code, tokyo)!, /\/model or|autopilot connect|UTC/, `${code}: the switch is /provider, times are local`);
      }
    });

    it("words sign-in denials for the sign-in screen and for `autopilot auth`", () => {
      const tokyo = { now: NOW, timeZone: "Asia/Tokyo" };
      assert.strictEqual(
        dlDenialLine("account_too_new", { where: "signin" }),
        "New GitHub accounts (under 30 days) need an invite code for the free tier. Have one? Choose Free again and enter it in the browser. Or use your own API key.",
      );
      assert.strictEqual(
        dlDenialLine("not_invited", { where: "signin" }),
        "This GitHub account needs an invite code for the free tier. Have one? Choose Free again and enter it in the browser. Or use your own API key.",
      );
      assert.strictEqual(dlDenialLine("cohort_full", { where: "signin" }), "The free tier is full right now. Use your own API key meanwhile.");
      assert.doesNotMatch(dlDenialLine("cohort_full", { where: "signin" }), /invite/);
      assert.strictEqual(
        dlDenialLine("paused", { where: "signin", resetsAt: "2026-11-09T00:00:00.000Z", ...tokyo }),
        "Free tokens are paused for everyone until Mon 09:00. Your own key still works.",
      );
      assert.match(dlDenialLine("not_invited", { where: "cli" }), /Run `autopilot auth directionally-local` again and enter it in the browser\. Or use your own API key: `autopilot connect`\.$/);
    });

    it("takes the minimum account age from the service, 30 days when it doesn't say", () => {
      assert.match(describeDlError("access_denied", { reason: "account_too_new", minAccountAgeDays: 90, where: "signin" })!, /^New GitHub accounts \(under 90 days\)/);
      assert.match(describeDlError("account_too_new", { where: "signin" })!, /^New GitHub accounts \(under 30 days\)/);
      assert.deepStrictEqual(parseDlError({ error: { code: "account_too_new", min_account_age_days: 45 } }), { code: "account_too_new", minAccountAgeDays: 45 });
      assert.deepStrictEqual(parseDlError({ error: { code: "paused", paused_until: "2026-11-09T00:00:00.000Z" } }), { code: "paused", resetsAt: "2026-11-09T00:00:00.000Z" });
      // The number from the service's sentence when there's no field.
      const fromMessage = parseDlError({ error: { code: "account_too_new", reason: "account_too_new", message: "GitHub accounts under 60 days old need an invite code." } })!;
      assert.strictEqual(fromMessage.minAccountAgeDays, 60);
      assert.match(describeDlError(fromMessage.code, { ...fromMessage, where: "signin" })!, /under 60 days/);
      assert.deepStrictEqual(
        parseDlError({ error: { code: "global_total_budget_reached", reason: "total_budget", resetsAt: null, pausedForEveryone: true, message: "x" } }),
        { code: "global_total_budget_reached", message: "x", reason: "total_budget", pausedForEveryone: true },
      );
    });

    it("maps old and new service codes through one table", () => {
      assert.deepStrictEqual(
        ["account_too_new", "invite_required", "not_invited", "invalid_invite", "cohort_full", "too_many_signups", "service_paused", "global_weekly_budget_reached", "global_total_budget_reached", "ended"].map((c) => DL_DENIALS[c]),
        ["account_too_new", "not_invited", "not_invited", "not_invited", "cohort_full", "too_many_signups", "paused", "paused", "paused", "ended"],
      );
      assert.strictEqual(dlDenialOf("access_denied"), undefined, "declining in the browser isn't a denial");
      assert.strictEqual(dlDenialOf("access_denied", "device_taken"), undefined);
      assert.strictEqual(dlDenialOf("not_invited", "cohort_full"), "cohort_full", "the reason is more specific than the code");
      assert.strictEqual(new DlError("access_denied", "x", 400, { reason: "account_too_new" }).denial, "account_too_new");
    });

    it("shows times in the local time zone", () => {
      assert.strictEqual(formatLocalTime("2026-11-09T00:00:00.000Z", { now: NOW, timeZone: "Asia/Tokyo" }), "Mon 09:00");
      assert.strictEqual(formatLocalTime("2026-11-09T00:00:00.000Z", { now: NOW, timeZone: "America/Los_Angeles" }), "Sun 16:00");
      assert.strictEqual(formatLocalTime("2026-11-20T00:00:00.000Z", { now: NOW, timeZone: "Asia/Tokyo" }), "Fri, Nov 20, 09:00", "further than a week: with the date");
      assert.strictEqual(formatLocalTime(undefined), undefined);
      assert.strictEqual(formatReset(undefined, NOW, "Asia/Tokyo"), "Mon 09:00 GMT+9 (in 5 days)", "the service's week end when it didn't say");
      assert.strictEqual(nextWeekStart(NOW), Date.parse("2026-11-09T00:00:00.000Z"));
      assert.strictEqual(localResetWeekday("2026-11-09T00:00:00.000Z", { timeZone: "Asia/Tokyo" }), "Monday");
      assert.strictEqual(localResetWeekday("2026-11-09T00:00:00.000Z", { timeZone: "America/Los_Angeles" }), "Sunday");
    });

    it("says who signed in and the real weekly allowance", () => {
      assert.strictEqual(dlSignedInLine(me(), { timeZone: "Asia/Tokyo" }), "✓ Signed in as @octo · 50M free tokens this week · back every Monday");
      assert.strictEqual(dlSignedInLine(me({ tokensPerWeek: 20_000_000 }), { timeZone: "Asia/Tokyo" }), "✓ Signed in as @octo · 20M free tokens this week · back every Monday");
      assert.match(dlSignedInLine(null, { now: NOW, timeZone: "Asia/Tokyo" }), /^✓ Signed in · 50M free tokens this week · back every Monday$/);
    });

    const cases: Array<[number, unknown, RegExp, number]> = [
      [402, { error: { code: "quota_exceeded", message: "quota", resetsAt: "2026-11-09T00:00:00.000Z", reason: "tokens" } }, /You've used this week's free tokens\. They're back \w{3} \d\d:\d\d\. To keep going now: \/provider to use your own key\.$/, 1],
      [402, { error: { code: "quota_exceeded", message: "quota", resetsAt: "2026-11-09T00:00:00.000Z", reason: "spend" } }, /You've used this week's free tokens\. They're back \w{3} \d\d:\d\d\./, 1],
      [403, { error: { code: "not_invited" } }, /isn't on the free tier.*\/provider$/, 1],
      [403, { error: { code: "suspended" } }, /account is suspended/, 1],
      [503, { error: { code: "service_paused" } }, /Free tokens are paused for everyone\. Your own key works now: \/provider$/, 1],
      [503, { error: { code: "service_paused", reason: "weekly_budget", resetsAt: "2026-11-09T00:00:00.000Z" } }, /Free tokens are paused for everyone until \w{3} \d\d:\d\d\. Your own key works now: \/provider$/, 1],
      [503, { error: { code: "paused", resets_at: "2026-11-09T00:00:00.000Z" } }, /Free tokens are paused for everyone until \w{3} \d\d:\d\d\./, 1],
      [503, { error: { code: "global_weekly_budget_reached", reason: "weekly_budget", resetsAt: "2026-11-09T00:00:00.000Z", pausedForEveryone: true, message: "m" } }, /^autopilot: Free tokens are paused for everyone until \w{3} \d\d:\d\d\. Your own key works now: \/provider$/, 1],
      [503, { error: { code: "global_total_budget_reached", reason: "total_budget", resetsAt: null, pausedForEveryone: true, message: "m" } }, /^autopilot: Free tokens are paused for everyone\. Your own key works now: \/provider$/, 1],
      [400, { error: { code: "model_not_allowed" } }, /serves gpt-6-luna, gpt-6\.1-sol, gpt-6-astra, deepseek\/deepseek-v4\.1-flash-1017/, 1],
    ];
    for (const [status, body, pattern, calls] of cases) {
      const code = (body as { error: { code: string } }).error.code;
      it(`turns a ${status} ${code} into a clear message without retrying`, async () => {
        await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
        stub.chatReplies = [{ status, body }, { status, body }];
        await assert.rejects(drain(llmAuthFromConfig(await readCfg()), { networkRetries: 3 }), (e: Error & { providerCode?: string }) => pattern.test(e.message) && e.providerCode === code);
        assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, calls);
      });
    }

    it("/usage says the week's free tokens are used, whichever limit was hit", async () => {
      const resetsAt = "2026-11-09T00:00:00.000Z";
      const used = /\n  You've used this week's free tokens\. They're back Mon 09:00\. To keep going now: \/provider to use your own key\.$/;
      assert.match(renderDlUsage(me({ usedThisWeek: 50_000_000, remaining: 0 }), NOW, "Asia/Tokyo"), used);
      assert.match(renderDlUsage(me({ usdPerWeek: 5, spentUsdThisWeek: 5 }), NOW, "Asia/Tokyo"), used);
      assert.ok(!/free tokens\./.test(renderDlUsage(me({ usdPerWeek: 5, spentUsdThisWeek: 1 }), NOW)));
      // A 402 with reason "spend" seen this week shows up in /usage too.
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
      stub.chatReplies = [{ status: 402, body: { error: { code: "quota_exceeded", resetsAt, reason: "spend" } } }];
      await assert.rejects(drain(llmAuthFromConfig(await readCfg())), /this week's free tokens/);
      assert.match(renderDlUsage(me(), NOW, "Asia/Tokyo"), used);
      assert.ok(!/They're back/.test(renderDlUsage(me({ resetsAt: "2026-11-16T00:00:00.000Z" }), NOW)), "not after the week resets");
    });

    it("keeps the limit screen's details (offers, invite link, reset, place in line) on the error", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
      const offers = { pro: { priceUsdMonthly: 10, tokensPerWeek: 100_000_000 }, topup: { priceUsd: 3, tokens: 50_000_000, validDays: 30 } };
      stub.chatReplies = [{ status: 402, body: { error: { code: "quota_exceeded", resetsAt: "2026-11-09T00:00:00.000Z", offers, referralLink: "https://dl.new/r/x" } } }];
      await assert.rejects(drain(llmAuthFromConfig(await readCfg())), (e: Error & { providerCode?: string; providerDetail?: Record<string, unknown> }) => {
        assert.strictEqual(e.providerCode, "quota_exceeded");
        assert.deepStrictEqual(e.providerDetail, { resetsAt: "2026-11-09T00:00:00.000Z", offers, referralLink: "https://dl.new/r/x" });
        return true;
      });
      const etaAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
      stub.chatReplies = [{ status: 402, body: { error: { code: "free_tier_queued", position: 214, etaAt } } }];
      await assert.rejects(drain(llmAuthFromConfig(await readCfg())), (e: Error & { providerCode?: string; providerDetail?: Record<string, unknown> }) => {
        assert.strictEqual(e.providerCode, "free_tier_queued");
        assert.deepStrictEqual(e.providerDetail, { position: 214, etaAt });
        assert.match(e.message, /^autopilot: You're #214 in line for free tokens \(about \d+ days?, by \w+\)\. \/invite moves you up; \/provider uses your own key now\.$/);
        return true;
      });
      assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 2, "neither is retried");
    });

    describe("the new upstream's transient errors", () => {
      const cases: Array<[number, string, string | undefined]> = [
        [429, "upstream_busy", "The free tier is busy right now; retrying…"],
        [503, "upstream_unavailable", "The model host is unavailable"],
        [503, "upstream_timeout", undefined],
        [502, "some_new_code", "Something new went wrong upstream"],
      ];
      for (const [status, code, message] of cases) {
        it(`retries a ${status} ${code} with the server's words in the retry line`, async () => {
          await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
          const body = { error: { code, retryable: true, retryAfter: 0.01, ...(message ? { message } : {}) } };
          stub.chatReplies = [{ status, body }, { status, body }, { status: 200 }];
          const lines: string[] = [];
          await drain(llmAuthFromConfig(await readCfg()), { networkRetries: 2, onRetry: (l: string) => lines.push(l) });
          assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 3);
          const said = message ? message.replace(/; retrying…$/, "") : "The model's host had a hiccup";
          assert.deepStrictEqual(lines, [`↻ ${said}; retrying (1/2)…`, `↻ ${said}; retrying (2/2)…`]);
        });
      }

      it("waits 5 s for upstream_busy without Retry-After, honours one up to 20 s, and gives up past that", async () => {
        await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
        stub.chatReplies = [{ status: 429, body: { error: { code: "upstream_busy", retryable: true, message: "The free tier is busy right now; retrying…" } } }];
        await assert.rejects(drain(llmAuthFromConfig(await readCfg())), (e: Error & { retryAfterMs?: number; transient?: boolean }) => e.retryAfterMs === 5_000 && e.transient === true);
        stub.chatReplies = [{ status: 503, body: { error: { code: "upstream_unavailable", retryable: true } }, headers: { "retry-after": "12" } }];
        await assert.rejects(drain(llmAuthFromConfig(await readCfg())), (e: Error & { retryAfterMs?: number }) => e.retryAfterMs === 12_000);
        // Longer than 20 s: not retried at all, and the user is told.
        stub.calls = [];
        stub.chatReplies = [{ status: 503, body: { error: { code: "upstream_unavailable", retryable: true } }, headers: { "retry-after": "60" } }];
        await assert.rejects(drain(llmAuthFromConfig(await readCfg()), { networkRetries: 2 }), /model host is unavailable right now; try again shortly/);
        assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 1);
      });

      it("says the plain sentence after the last retry fails", async () => {
        await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
        const body = { error: { code: "upstream_timeout", retryable: true, retryAfter: 0.01 } };
        stub.calls = [];
        stub.chatReplies = [{ status: 503, body }, { status: 503, body }, { status: 503, body }];
        await assert.rejects(drain(llmAuthFromConfig(await readCfg()), { networkRetries: 2 }), /^Error: autopilot: The free tier's model host took too long to answer; try again shortly\.$|took too long to answer/);
        assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 3);
      });

      it("never retries upstream_credit_exhausted, even marked retryable, and words it like the pause", async () => {
        await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
        stub.calls = [];
        stub.chatReplies = [{ status: 503, body: { error: { code: "upstream_credit_exhausted", retryable: true, message: "m" } } }, { status: 200 }];
        await assert.rejects(
          drain(llmAuthFromConfig(await readCfg()), { networkRetries: 2 }),
          (e: Error & { transient?: boolean }) => e.message === "autopilot: Free tokens are paused while we top up. Your own key still works: /provider" && e.transient === false,
        );
        assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 1);
        assert.strictEqual(describeDlError("upstream_credit_exhausted", { where: "cli" }), "Free tokens are paused while we top up. Your own key still works: `autopilot connect`.");
        assert.strictEqual(describeDlError("upstream_credit_exhausted", { where: "signin" }), "Free tokens are paused while we top up. Your own key still works.");
      });
    });

    it("retries a 429 rate_limited after retryAfter, then says when to try again", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", expiresAt: Date.now() + 3_600_000 } } });
      const body = { error: { code: "rate_limited", retryAfter: 0.01 } };
      stub.chatReplies = [{ status: 429, body }, { status: 200 }];
      await drain(llmAuthFromConfig(await readCfg()), { networkRetries: 2 });
      assert.strictEqual(stub.calls.filter((c) => c.path === "/v1/chat/completions").length, 2);
      stub.calls = [];
      stub.chatReplies = [{ status: 429, body: { error: { code: "rate_limited", retryAfter: 30 } } }];
      await assert.rejects(drain(llmAuthFromConfig(await readCfg()), { networkRetries: 0 }), /limiting how fast you send requests; try again in 30 seconds/);
    });
  });

  describe("sign-out", () => {
    it("removes the access and refresh tokens, revokes on the service, and says exactly that", async () => {
      await writeCfg({ provider: "directionally-local", model: DL_FREE_MODEL, providers: { "directionally-local": { apiKey: "at-9", refreshToken: "rt-9", expiresAt: NOW, model: DL_FREE_MODEL } } });
      stub.revokeStatus = 200;
      const line = await dlSignOut();
      assert.strictEqual(line, `Removed the Directionally Local free-tier access token and refresh token from ${configPath()}. The service revoked the sign-in.`);
      const call = stub.calls.find((c) => c.path === "/v1/token/revoke")!;
      assert.deepStrictEqual([call.auth, JSON.parse(call.body)], ["Bearer at-9", { refresh_token: "rt-9" }]);
      const cfg = await readCfg();
      assert.deepStrictEqual(cfg.providers["directionally-local"], { model: DL_FREE_MODEL }, "both tokens and the expiry are gone; the model stays");
      assert.strictEqual(cfg.provider, "directionally-local");
    });

    it("works against a service without the revoke endpoint (404)", async () => {
      await writeCfg({ providers: { "directionally-local": { apiKey: "at", refreshToken: "rt" } } });
      stub.revokeStatus = 404;
      const line = await dlSignOut();
      assert.match(line, /^Removed the Directionally Local free-tier access token and refresh token from .*\. The service had nothing to revoke\.$/);
      assert.deepStrictEqual((await readCfg()).providers["directionally-local"], {});
    });

    it("says when nothing was saved", async () => {
      stub.calls = [];
      assert.strictEqual(await dlSignOut(), `No Directionally Local free-tier sign-in was saved in ${configPath()}; nothing was removed.`);
      assert.strictEqual(stub.calls.length, 0, "nothing to revoke");
    });

    it("/logout removes the free tier's refresh token too, and names what it removed", async () => {
      const { patch, removed, dlTokens } = logoutPatch({
        openrouterApiKey: "sk-or-1",
        providers: { "directionally-local": { apiKey: "at", refreshToken: "rt", expiresAt: 1, model: DL_FREE_MODEL }, anthropic: { apiKey: "sk-ant", model: "claude" } },
      } as never);
      assert.deepStrictEqual(patch.providers, { "directionally-local": { model: DL_FREE_MODEL }, anthropic: { model: "claude" } });
      assert.strictEqual(patch.openrouterApiKey, undefined);
      assert.deepStrictEqual(removed, ["OpenRouter key", "Directionally Local free-tier access token and refresh token", "Anthropic key"]);
      assert.deepStrictEqual(dlTokens, { accessToken: "at", refreshToken: "rt" });
      assert.strictEqual(
        logoutLine({ removed, path: "/c.json", revoke: "revoked", envKeys: [] }),
        "Removed from /c.json: OpenRouter key, Directionally Local free-tier access token and refresh token, Anthropic key. The free-tier sign-in was revoked on the service.",
      );
    });

    it("/logout revokes and clears the saved free-tier sign-in end to end", async () => {
      await writeCfg({ provider: "directionally-local", providers: { "directionally-local": { apiKey: "at", refreshToken: "rt", expiresAt: NOW } } });
      stub.revokeStatus = 404;
      const infos: string[] = [];
      const ctx = {
        cfg: { provider: "directionally-local", providers: {} },
        mkKey: () => "k",
        setEvents: (f: (e: Array<{ text: string }>) => Array<{ text: string }>) => infos.push(...f([]).map((e) => e.text)),
        setCfg: () => {},
      } as unknown as SlashContext;
      await dispatchSlashCommand(ctx, "/logout");
      assert.match(infos[0]!, /^Removed from .*: Directionally Local free-tier access token and refresh token\. The service had nothing to revoke\.$/);
      assert.deepStrictEqual((await readCfg()).providers["directionally-local"], {});
    });
  });
});
