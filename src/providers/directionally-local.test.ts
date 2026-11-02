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
import { dispatchSlashCommand, usageText, type SlashContext } from "../ui/slash-commands.js";
import { costNote } from "../usage-tracker.js";
import {
  describeDlError,
  dlAccessToken,
  DlError,
  DL_DISCLOSURE,
  DL_FREE_MODEL,
  dlApiBase,
  dlNotFreeLine,
  dlPickerHint,
  dlSignIn,
  fetchDlMe,
  formatReset,
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
  calls: Array<{ path: string; auth: string | undefined; body: string }>;
}

async function startStub(): Promise<Stub> {
  const stub = { tokenReplies: [], refreshReply: null, chatReplies: [], meReply: null, calls: [] } as unknown as Stub;
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
    it("is OpenAI-compatible at AUTOPILOT_DL_FREE_URL + /v1 with one model and no pasted key", () => {
      const p = getPreset("directionally-local");
      assert.strictEqual(p.name, "Directionally Local, free");
      assert.strictEqual(p.protocol ?? "openai-chat", "openai-chat");
      assert.strictEqual(p.defaultModel, "deepseek/deepseek-v4.1-flash-1017");
      assert.strictEqual(p.plumbingModel, "deepseek/deepseek-v4.1-flash-1017");
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
      assert.strictEqual(dlPickerHint(), "free — 50M tokens/week, sign in with GitHub");
      const rows = providerRows(null, { env: {} });
      assert.strictEqual(rows[0]?.id, "directionally-local");
      assert.deepStrictEqual(planConnect("directionally-local", null, {}), { kind: "directionally-local" });
      assert.ok(!HIDDEN_WITHOUT_GATEWAY.has("directionally-local"));
    });

    it("lists only the free model", async () => {
      await ensureProviderCatalog("directionally-local", {}, (async () => { throw new Error("offline"); }) as unknown as typeof fetch);
      assert.deepStrictEqual(listModels().map((m) => m.id), [DL_FREE_MODEL]);
      assert.strictEqual(listModels()[0]?.pricing.inputPerMtok, 0);
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
      assert.match(DL_DISCLOSURE, /No prompts, code or file contents/);
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
      assert.deepStrictEqual(setup, { initial: "openrouter" });
      assert.strictEqual(cfgChanged, false, "the model is not switched before a provider is connected");
      // The free model itself is fine.
      infos.length = 0;
      await dispatchSlashCommand(ctx, `/model ${DL_FREE_MODEL}`);
      assert.strictEqual(cfgChanged, true);
    });

    it("says what sign-in collects, and that cancelling leaves it unconnected", () => {
      const before = dlSignInLines().split("\n");
      assert.deepStrictEqual(before, [
        "Directionally Local, free: 50M tokens a week on deepseek/deepseek-v4.1-flash-1017. Sign in with GitHub to start.",
        DL_DISCLOSURE,
      ]);
      const during = dlSignInLines({ deviceCode: "d", userCode: "ABCD-1234", verificationUri: "u", verificationUriComplete: "https://x/device?code=ABCD-1234", intervalSec: 5, expiresInSec: 600 }, true);
      assert.match(during, /^Your code is ABCD-1234\. Your browser is open at https:\/\/x\/device\?code=ABCD-1234/);
      assert.match(during, /No prompts, code or file contents are ever sent\.$/);
      assert.ok(!DL_SIGN_IN_NEEDED.includes("\n"));
      assert.match(DL_SIGN_IN_NEEDED, /needs a GitHub sign-in/);
    });

    it("warns before leaving the free tier for a provider that needs a key", () => {
      assert.strictEqual(leavingFreeTierLine("directionally-local", "anthropic"), "Anthropic isn't part of the Directionally Local free tier; it needs your own API key.");
      assert.strictEqual(leavingFreeTierLine("directionally-local", "ollama"), undefined, "local runtimes need no key");
      assert.strictEqual(leavingFreeTierLine("openrouter", "anthropic"), undefined);
      assert.strictEqual(leavingFreeTierLine("directionally-local", "directionally-local"), undefined);
    });

    it("writes the access token as apiKey in the connect state file", () => {
      const state = buildConnectState(
        { id: "directionally-local", key: "access-1", model: DL_FREE_MODEL },
        { provider: "directionally-local" },
        { AUTOPILOT_DL_FREE_URL: "http://stub:1" },
      );
      assert.deepStrictEqual(
        [state.provider, state.apiKey, state.baseUrl, state.apiKeyEnv, state.authHeader, state.authFormat, state.model],
        ["directionally-local", "access-1", "http://stub:1/v1", "AUTOPILOT_DL_FREE_TOKEN", "authorization", "Bearer {key}", DL_FREE_MODEL],
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

    for (const [code, pattern] of [
      ["expired_token", /code expired before it was approved/],
      ["access_denied", /declined in the browser/],
      ["not_invited", /isn't on the Directionally Local free tier yet\. Enter an invite code/],
    ] as const) {
      it(`ends the sign-in on ${code} with a plain sentence`, async () => {
        stub.tokenReplies = [{ status: 400, body: { error: { code } } }];
        const c = await startDlDeviceFlow();
        await assert.rejects(pollDlDeviceFlow(c, { sleep: noSleep }), (e: unknown) => e instanceof DlError && e.code === code && pattern.test(e.message));
      });
    }

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
        renderDlUsage(me(), NOW),
        [
          "Directionally Local free tier · signed in as @octo",
          "  used this week  12.5M of 50M tokens (25%)",
          "  left            37.5M tokens",
          "  resets          Mon, Nov 9, 00:00 UTC (in 5 days)",
        ].join("\n"),
      );
      assert.match(renderDlUsage(me({ usedThisWeek: 50_000_000, remaining: 0 }), NOW), /used up\. To keep going now, switch provider with \/model or `autopilot connect`/);
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
      const line = quotaNoticeFromHeaders(h(9_000_000), { now: NOW });
      assert.strictEqual(line, "You've used 82% of this week's free Directionally Local tokens (9M left, resets Mon, Nov 9, 00:00 UTC (in 5 days)); /usage has details.");
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
  });

  describe("error messages", () => {
    it("has a plain sentence for each service error", () => {
      assert.strictEqual(
        describeDlError("quota_exceeded", { resetsAt: "2026-11-09T00:00:00.000Z", now: NOW }),
        "You've used all of this week's free Directionally Local tokens. They reset Mon, Nov 9, 00:00 UTC (in 5 days). To keep going now, switch provider with /model or `autopilot connect`.",
      );
      assert.match(describeDlError("not_invited")!, /isn't on the Directionally Local free tier yet/);
      assert.match(describeDlError("suspended")!, /account is suspended/);
      assert.strictEqual(describeDlError("rate_limited", { retryAfter: 12 }), "Directionally Local is limiting how fast you send requests; try again in 12 seconds.");
      assert.match(describeDlError("service_paused")!, /free tier is paused right now\. Try again later, or switch provider/);
      assert.match(describeDlError("model_not_allowed")!, /only serves deepseek\/deepseek-v4\.1-flash-1017/);
      assert.strictEqual(formatReset(undefined), "at the start of next week (Monday 00:00 UTC)");
    });

    const cases: Array<[number, unknown, RegExp, number]> = [
      [402, { error: { code: "quota_exceeded", message: "quota", resetsAt: "2026-11-09T00:00:00.000Z" } }, /used all of this week's free Directionally Local tokens\. They reset Mon, Nov 9, 00:00 UTC.*\/model or `autopilot connect`/, 1],
      [403, { error: { code: "not_invited" } }, /isn't on the Directionally Local free tier yet/, 1],
      [403, { error: { code: "suspended" } }, /account is suspended/, 1],
      [503, { error: { code: "service_paused" } }, /free tier is paused right now/, 1],
      [400, { error: { code: "model_not_allowed" } }, /only serves deepseek\/deepseek-v4\.1-flash-1017/, 1],
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
});
