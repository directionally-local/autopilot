/**
 * Key mode: dl signed the person in at dl.new and passed their dl key (dl_sk_…) in
 * AUTOPILOT_DL_FREE_TOKEN, with AUTOPILOT_LAUNCHED_BY=dl. Autopilot uses dl's plan at
 * api.dl.new with no first run and no GitHub sign-in of its own; standalone is unchanged.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DL_API_URL, DL_FREE_DEFAULT_URL, dlKeyMode, dlOrigin, isDlApiKey } from "./dl-endpoint.js";
import { resolveActiveProvider } from "./resolve.js";
import { configPath, loadConfig } from "../config.js";
import { DL_KEY_REFUSED_LINE, describeDlError, dlSignedInLine, dlStartLine, fetchDlMe, renderDlUsage, isDlAuthError, DlError } from "./directionally-local.js";
import { DL_FREE_PLAN_LINE, dlPlanHeaderLine, dlPlanSignedInLine, parseDlPlanUsage, renderDlPlanUsage } from "./dl-plan.js";
import { dlPlanCatalog } from "./dl-free-providers.js";
import { sendFeedback } from "../feedback.js";
import { ACCESS_DL_KEY_LINE, runAccessRequest } from "../access-request.js";

const KEY = `dl_sk_abc_aaaaaaaaaaaa_${"A".repeat(43)}`;
const keyEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ AUTOPILOT_DL_FREE_TOKEN: KEY, AUTOPILOT_LAUNCHED_BY: "dl", ...extra });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const STARTER_USAGE = {
  plan: "starter",
  resetsAt: "2026-11-30T00:00:00.000Z",
  mix: { label: "95.5% caching applied" },
  models: [
    { model: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", realLimit: 62_000_000, usedAtPlanMix: 8_000_000, usedShare: 0.129 },
    { model: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1", realLimit: 5_000_000, usedAtPlanMix: 0, usedShare: 0 },
  ],
  bonus: { enabled: true, granted: true, leftUsd: 4, weeklyUsd: 5 },
};

describe("dl key mode: endpoints", () => {
  it("tells a dl key from a sign-in token", () => {
    assert.equal(isDlApiKey(KEY), true);
    assert.equal(isDlApiKey("eyJhbGciOi.jwt"), false);
    assert.equal(isDlApiKey(undefined), false);
    assert.equal(dlKeyMode(keyEnv()), true);
    assert.equal(dlKeyMode({ AUTOPILOT_DL_FREE_TOKEN: "eyJ.jwt" }), false);
  });

  it("sends a dl key to api.dl.new; AUTOPILOT_DL_FREE_URL still wins; standalone keeps its default", () => {
    assert.equal(dlOrigin(keyEnv()), DL_API_URL);
    assert.equal(dlOrigin(keyEnv({ AUTOPILOT_DL_FREE_URL: "http://localhost:8787/v1" })), "http://localhost:8787");
    assert.equal(dlOrigin({}), DL_FREE_DEFAULT_URL);
    assert.equal(dlOrigin({ AUTOPILOT_DL_FREE_TOKEN: "eyJ.jwt" }), DL_FREE_DEFAULT_URL);
  });

  it("ignores a base URL an older GitHub sign-in saved", () => {
    const cfg = { provider: "directionally-local" as const, providers: { "directionally-local": { baseUrl: "https://free.example/v1" } } };
    assert.equal(resolveActiveProvider(cfg, keyEnv()).baseUrl, `${DL_API_URL}/v1`);
    assert.equal(resolveActiveProvider(cfg, keyEnv()).apiKey, KEY);
    assert.equal(resolveActiveProvider(cfg, {}).baseUrl, "https://free.example/v1", "standalone keeps the saved one");
  });
});

describe("dl key mode: no first run", () => {
  const KEYS = ["AUTOPILOT_DL_FREE_TOKEN", "AUTOPILOT_LAUNCHED_BY", "AUTOPILOT_PROVIDER", "XDG_CONFIG_HOME", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY"] as const;
  const saved: Record<string, string | undefined> = {};
  let home: string;
  before(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    home = await mkdtemp(join(tmpdir(), "dl-key-mode-"));
  });
  beforeEach(async () => {
    for (const k of KEYS) delete process.env[k];
    process.env.XDG_CONFIG_HOME = home;
    await rm(configPath(), { force: true });
  });
  after(async () => {
    for (const k of KEYS) (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]));
    await rm(home, { recursive: true, force: true });
  });
  const writeConfig = async (contents: Record<string, unknown>) => {
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify(contents));
  };

  it("uses dl's plan when dl passes the key and Autopilot has no provider (dl sets AUTOPILOT_PROVIDER)", async () => {
    Object.assign(process.env, { AUTOPILOT_DL_FREE_TOKEN: KEY, AUTOPILOT_LAUNCHED_BY: "dl", AUTOPILOT_PROVIDER: "directionally-local" });
    const cfg = await loadConfig();
    assert.equal(cfg?.model, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(resolveActiveProvider(cfg).id, "directionally-local");
  });

  it("uses dl's plan instead of the first-run question when Autopilot's own provider has no key left", async () => {
    await writeConfig({ provider: "anthropic", model: "claude-x" });
    Object.assign(process.env, { AUTOPILOT_DL_FREE_TOKEN: KEY, AUTOPILOT_LAUNCHED_BY: "dl" });
    const cfg = await loadConfig();
    assert.equal(cfg?.provider, "directionally-local");
    assert.equal(cfg?.model, "deepseek/deepseek-v4.1-flash-1017", "never the other provider's model");
  });

  it("keeps Autopilot's own working provider: dl never overrides it", async () => {
    await writeConfig({ provider: "anthropic", model: "claude-x" });
    Object.assign(process.env, { AUTOPILOT_DL_FREE_TOKEN: KEY, AUTOPILOT_LAUNCHED_BY: "dl", ANTHROPIC_API_KEY: "sk-ant" });
    const cfg = await loadConfig();
    assert.equal(cfg?.provider, "anthropic");
    assert.equal(cfg?.model, "claude-x");
  });

  it("standalone (not started by dl) still asks: nothing usable is still nothing", async () => {
    await writeConfig({ provider: "anthropic" });
    process.env.AUTOPILOT_DL_FREE_TOKEN = KEY;
    assert.equal(await loadConfig(), null);
  });
});

describe("dl key mode: the plan", () => {
  it("reads /v1/usage", () => {
    const u = parseDlPlanUsage(STARTER_USAGE)!;
    assert.equal(u.plan, "starter");
    assert.equal(u.models.length, 2);
    assert.deepEqual(u.bonus, { leftUsd: 4, weeklyUsd: 5 });
    assert.equal(parseDlPlanUsage({ nope: 1 }), undefined);
    assert.equal(parseDlPlanUsage({ ...STARTER_USAGE, bonus: { enabled: false, leftUsd: 0, weeklyUsd: 5 } })!.bonus, undefined);
  });

  it("says the plan in tokens with the caching label, Free as dl.new states it", () => {
    assert.equal(
      dlPlanSignedInLine(parseDlPlanUsage(STARTER_USAGE)),
      "✓ Signed in with your dl key · Starter: DeepSeek V4.1 Flash 62M, Kimi K3.1 5M tokens a week (95.5% caching applied) · GPT-6.1 Sol bonus $4 left",
    );
    assert.equal(dlPlanSignedInLine(parseDlPlanUsage({ plan: "none", models: [] })), `✓ Signed in with your dl key · ${DL_FREE_PLAN_LINE}`);
    assert.equal(DL_FREE_PLAN_LINE, "Free: DeepSeek V4.1 Flash, 10M tokens a week (95.5% caching applied)");
    assert.equal(dlPlanSignedInLine(undefined), "✓ Signed in with your dl key");
  });

  it("header and /usage", () => {
    const u = parseDlPlanUsage(STARTER_USAGE)!;
    assert.equal(dlPlanHeaderLine(u), "Starter · DeepSeek V4.1 Flash ~54M left this week (95.5% caching applied)");
    assert.equal(dlPlanHeaderLine(u, "moonshotai/kimi-k3.1-pro"), "Starter · Kimi K3.1 ~5M left this week (95.5% caching applied)");
    const usage = renderDlPlanUsage(u, { timeZone: "UTC" });
    assert.match(usage, /^dl · Starter plan · signed in with your dl key/);
    assert.match(usage, /DeepSeek V4\.1 Flash +~8M of 62M tokens used \(95\.5% caching applied\)/);
    assert.match(usage, /GPT-6\.1 Sol bonus +\$4 of \$5 left this week/);
    assert.match(usage, /Plans and upgrades: https:\/\/dl\.new\/plans$/);
    assert.doesNotMatch(usage, /Luminal|Liquid|OpenRouter/);
  });

  it("fetchDlMe reads the plan alongside /v1/me, at api.dl.new", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.endsWith("/v1/usage")) return json(STARTER_USAGE);
      return json({ login: "octo", allowance: { tokensPerWeek: 0, usedThisWeek: 0, remaining: 0, resetsAt: "2026-11-30T00:00:00.000Z" } });
    }) as unknown as typeof fetch;
    const me = await fetchDlMe({ fetchImpl, env: keyEnv() });
    assert.deepEqual(urls.sort(), [`${DL_API_URL}/v1/me`, `${DL_API_URL}/v1/usage`]);
    assert.equal(me.planUsage?.plan, "starter");
    assert.match(dlSignedInLine(me), /^✓ Signed in with your dl key · Starter: /);
    assert.match(dlStartLine(me, "deepseek/deepseek-v4.1-flash-1017")!, /^Starter · DeepSeek V4\.1 Flash ~54M left/);
    assert.match(renderDlUsage(me), /^dl · Starter plan/);
  });

  it("a refused dl key asks for dl login, not a GitHub sign-in", () => {
    assert.equal(describeDlError("invalid_key"), DL_KEY_REFUSED_LINE);
    assert.equal(describeDlError("invalid_token", { env: keyEnv() }), DL_KEY_REFUSED_LINE);
    assert.ok(isDlAuthError(new DlError("invalid_key", DL_KEY_REFUSED_LINE)));
    assert.match(describeDlError("invalid_token", { env: {} })!, /autopilot auth directionally-local/, "standalone unchanged");
  });
});

describe("dl key mode: models", () => {
  it("lists exactly what the plan serves, DeepSeek first, without (free)", () => {
    const ids = (served: Array<{ id: string; name?: string }> | undefined) => dlPlanCatalog(served, null).map((m) => `${m.id}|${m.name}`);
    assert.deepEqual(ids(undefined), ["deepseek/deepseek-v4.1-flash-1017|DeepSeek V4.1 Flash"]);
    assert.deepEqual(ids([{ id: "deepseek/deepseek-v4.1-flash-1017" }]), ["deepseek/deepseek-v4.1-flash-1017|DeepSeek V4.1 Flash"]);
    assert.deepEqual(ids([{ id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1" }, { id: "deepseek/deepseek-v4.1-flash-1017" }, { id: "gpt-6.1-sol" }]), [
      "deepseek/deepseek-v4.1-flash-1017|DeepSeek V4.1 Flash",
      "moonshotai/kimi-k3.1-pro|Kimi K3.1",
      "gpt-6.1-sol|GPT-6.1 Sol",
    ]);
  });
});

describe("dl key mode: endpoints that take no dl key", () => {
  it("feedback goes out without the dl key", async () => {
    let auth: string | null | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = new Headers(init.headers).get("authorization");
      return json({ ok: true, replyTo: null });
    }) as unknown as typeof fetch;
    const r = await sendFeedback({ message: "hi" } as Parameters<typeof sendFeedback>[0], { token: KEY, fetchImpl, env: keyEnv() });
    assert.equal(r.kind, "sent");
    assert.equal(auth, null);
  });

  it("/request points to the plans", async () => {
    const line = await runAccessRequest({ providerId: "directionally-local", env: keyEnv() } as unknown as Parameters<typeof runAccessRequest>[0]);
    assert.equal(line.text, ACCESS_DL_KEY_LINE);
    assert.match(ACCESS_DL_KEY_LINE, /https:\/\/dl\.new\/plans/);
  });
});
