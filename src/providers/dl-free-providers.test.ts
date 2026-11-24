import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DL_FALLBACK_PROVIDERS,
  DL_PROVIDERS_CACHE_MS,
  DL_UNKNOWN_CONTEXT,
  dlProviderLimitAutoSwitch,
  DL_UNKNOWN_MAX_OUTPUT,
  cachedDlProviders,
  dlServedModelEntry,
  fetchDlServedModels,
  loadDlCatalog,
  dlAccessAllowed,
  dlFreeModelOption,
  dlModelProviderLine,
  fetchDlModelIds,
  fetchDlProviders,
  formatTokPerSec,
  loadUsableDlModels,
  parseDlProviders,
  setDlProvidersCache,
  usableDlModels,
  dlLockedProOption,
  dlProModelRow,
  dlProModels,
  dlResetDay,
  lockedDlProModels,
} from "./dl-free-providers.js";

import { describeDlError, parseDlError } from "./directionally-local.js";
import { dlHeadlessLine } from "./dl-growth.js";

const env = { AUTOPILOT_DL_FREE_URL: "https://free.test" } as NodeJS.ProcessEnv;
const model = (over: Record<string, unknown>) => ({
  id: "deepseek/deepseek-v4.1-flash-1017",
  name: "DeepSeek V4.1 Flash",
  family: "deepseek",
  contextWindow: 1_048_576,
  access: "free",
  status: "on",
  tokensPerSecond: 85.4,
  ttftMs: 640,
  successRate24h: 0.99,
  measuredAt: "2026-11-23T08:00:00.000Z",
  ...over,
});
const body = {
  updatedAt: "2026-11-23T08:00:00.000Z",
  providers: [
    {
      id: "luminal",
      name: "Luminal",
      website: "https://www.luminal.com",
      url: "https://www.luminal.com/?utm_source=dl.new&utm_medium=referral&utm_campaign=providers",
      logo: "/logos/luminal.svg",
      models: [model({}), model({ id: "gpt-6-luna", name: "GPT-6 Luna", family: "gpt6", access: "trusted", tokensPerSecond: 120 })],
    },
    {
      id: "openai",
      name: "OpenAI",
      website: "https://openai.com",
      url: "https://openai.com/?utm_source=dl.new",
      logo: "/logos/openai.svg",
      models: [
        model({ id: "gpt-6.1-sol", name: "GPT-6.1 Sol", family: "gpt6", access: "opt-in", tokensPerSecond: null }),
        model({ id: "gpt-6-astra", name: "GPT-6 Astra", family: "gpt6", access: "free", status: "paused" }),
        model({ id: "someone/unknown-model", name: "Unknown", access: "free" }),
      ],
    },
  ],
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

afterEach(() => setDlProvidersCache(null));

describe("parseDlProviders", () => {
  it("keeps well-formed providers and models, drops the rest", () => {
    const parsed = parseDlProviders({
      ...body,
      providers: [...body.providers, { id: "x", models: [{ id: "m", access: "secret", status: "on" }] }, { name: "no id", models: [] }, "junk"],
    })!;
    assert.equal(parsed.live, true);
    assert.deepEqual(parsed.providers.map((p) => p.id), ["luminal", "openai"]);
    assert.equal(parsed.providers[0]!.models[0]!.tokensPerSecond, 85.4);
    assert.equal(parsed.providers[1]!.models[0]!.tokensPerSecond, null);
  });
  it("is null for a body with nothing usable", () => {
    assert.equal(parseDlProviders(null), null);
    assert.equal(parseDlProviders({ providers: [] }), null);
    assert.equal(parseDlProviders({ error: "not_found" }), null);
  });
});

describe("fetchDlProviders", () => {
  it("reads /v1/providers once and reuses it for 10 minutes", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => (urls.push(url), json(body))) as unknown as typeof fetch;
    const first = await fetchDlProviders({ fetchImpl, env, now: 1_000 });
    assert.equal(first.live, true);
    assert.deepEqual(urls, ["https://free.test/v1/providers"]);
    await fetchDlProviders({ fetchImpl, env, now: 1_000 + DL_PROVIDERS_CACHE_MS - 1 });
    assert.equal(urls.length, 1);
    assert.equal(cachedDlProviders(), first);
    await fetchDlProviders({ fetchImpl, env, now: 1_000 + DL_PROVIDERS_CACHE_MS });
    assert.equal(urls.length, 2);
  });
  it("falls back to DeepSeek V4.1 Flash on Luminal (no speeds) on a 404", async () => {
    const list = await fetchDlProviders({ fetchImpl: (async () => json({ error: { code: "not_found" } }, 404)) as unknown as typeof fetch, env });
    assert.equal(list, DL_FALLBACK_PROVIDERS);
    assert.equal(list.live, false);
    assert.deepEqual(usableDlModels(list), [{ id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", provider: "Luminal", tokensPerSecond: null }]);
  });
  it("falls back when the service is slower than the timeout, or unreachable", async () => {
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as unknown as typeof fetch;
    const started = Date.now();
    // AbortSignal.timeout's timer doesn't hold the event loop open; with nothing else pending, Node 22's
    // test runner ends the test before it fires. A plain timer keeps the loop alive until it does.
    const keepAlive = setTimeout(() => {}, 5_000);
    try {
      assert.equal(await fetchDlProviders({ fetchImpl: slow, env, timeoutMs: 50 }), DL_FALLBACK_PROVIDERS);
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(Date.now() - started < 1_000);
    setDlProvidersCache(null);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.equal(await fetchDlProviders({ fetchImpl: down, env }), DL_FALLBACK_PROVIDERS);
  });
});

describe("fetchDlModelIds", () => {
  it("returns the ids /v1/models serves this person, sending the token", async () => {
    let auth = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).Authorization);
      return json({ object: "list", data: [{ id: "deepseek/deepseek-v4.1-flash-1017" }, { id: "gpt-6-luna" }] });
    }) as unknown as typeof fetch;
    assert.deepEqual([...(await fetchDlModelIds("tok", { fetchImpl, env }))!], ["deepseek/deepseek-v4.1-flash-1017", "gpt-6-luna"]);
    assert.equal(auth, "Bearer tok");
  });
  it("is undefined on an error", async () => {
    assert.equal(await fetchDlModelIds("tok", { fetchImpl: (async () => json({}, 401)) as unknown as typeof fetch, env }), undefined);
  });
});

describe("usableDlModels", () => {
  const list = parseDlProviders(body)!;
  it("lists only free, on, known models without /v1/me or /v1/models; DeepSeek first", () => {
    assert.deepEqual(usableDlModels(list).map((m) => m.id), ["deepseek/deepseek-v4.1-flash-1017"]);
  });
  it("adds trusted and opt-in models when /v1/me shows a budget for their family", () => {
    const me = { budgets: { gpt6: { usdPerWeek: 2, spentUsd: 0 }, deepseek: { usdPerWeek: 2, spentUsd: 0 } } };
    const ids = usableDlModels(list, { me }).map((m) => m.id);
    // DeepSeek first, then by speed; the paused Astra and the unknown model are left out.
    assert.deepEqual(ids, ["deepseek/deepseek-v4.1-flash-1017", "gpt-6-luna", "gpt-6.1-sol"]);
  });
  it("leaves them out at a $0 budget or on Starter", () => {
    assert.deepEqual(usableDlModels(list, { me: { budgets: { gpt6: { usdPerWeek: 0, spentUsd: 0 } } } }).map((m) => m.id), ["deepseek/deepseek-v4.1-flash-1017"]);
    assert.deepEqual(usableDlModels(list, { me: { level: "starter", budgets: { gpt6: { usdPerWeek: 2, spentUsd: 0 } } } }).map((m) => m.id), ["deepseek/deepseek-v4.1-flash-1017"]);
  });
  it("goes by /v1/models for availability when it was read", () => {
    const modelIds = new Set(["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"]);
    assert.deepEqual(usableDlModels(list, { modelIds }).map((m) => m.id), ["deepseek/deepseek-v4.1-flash-1017", "gpt-6-luna"]);
    // ...but /v1/me's $0 still closes it.
    assert.deepEqual(usableDlModels(list, { modelIds, me: { budgets: { gpt6: { usdPerWeek: 0, spentUsd: 0 } } } }).map((m) => m.id), ["deepseek/deepseek-v4.1-flash-1017"]);
  });
  it("pro models need Pro", () => {
    const pro = parseDlProviders({ providers: [{ id: "p", name: "P", models: [model({ id: "gpt-6-luna", access: "pro" })] }] })!;
    assert.equal(dlAccessAllowed(pro.providers[0]!.models[0]!, { plan: "free" }), false);
    assert.deepEqual(usableDlModels(pro, { me: { plan: "pro" } }).map((m) => m.id), ["gpt-6-luna"]);
  });
});

describe("loadUsableDlModels", () => {
  it("is never empty: DeepSeek on Luminal when nothing else is left", async () => {
    const fetchImpl = (async () => json({}, 404)) as unknown as typeof fetch;
    assert.deepEqual((await loadUsableDlModels("tok", { fetchImpl, env })).map((m) => `${m.name} · ${m.provider}`), ["DeepSeek V4.1 Flash · Luminal"]);
  });
  it("combines /v1/providers and /v1/models", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/v1/providers") ? json(body) : json({ data: [{ id: "deepseek/deepseek-v4.1-flash-1017" }, { id: "gpt-6-luna" }] })) as unknown as typeof fetch;
    const rows = (await loadUsableDlModels("tok", { fetchImpl, env })).map(dlFreeModelOption);
    assert.deepEqual(rows, [
      { value: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash · Luminal", columns: ["~85 tok/s"] },
      { value: "gpt-6-luna", label: "GPT-6 Luna · Luminal", columns: ["~120 tok/s"] },
    ]);
  });
});

describe("formatting", () => {
  it("formatTokPerSec", () => {
    assert.equal(formatTokPerSec(85.4), "~85 tok/s");
    assert.equal(formatTokPerSec(null), "");
    assert.equal(formatTokPerSec(0), "");
  });
  it("dlModelProviderLine for /model: provider and speed, provider alone when not measured", () => {
    const list = parseDlProviders(body)!;
    assert.equal(dlModelProviderLine("deepseek/deepseek-v4.1-flash-1017", list), "Luminal · ~85 tok/s");
    assert.equal(dlModelProviderLine("gpt-6.1-sol", list), "OpenAI");
    assert.equal(dlModelProviderLine("nope", list), undefined);
    assert.equal(dlModelProviderLine("gpt-6-luna", null), undefined);
  });
});

describe("free models this Autopilot doesn't know yet", () => {
  const kimi = { id: "moonshotai/kimi-k3.1-pro", name: "Kimi K3.1 Pro", family: "kimi", contextWindow: 262_144, access: "free", status: "on", tokensPerSecond: 64, ttftMs: 990, successRate24h: 0.99, measuredAt: "2026-11-23T08:00:00.000Z" };
  const withKimi = { ...body, providers: [...body.providers, { id: "liquid", name: "Liquid Inference", website: "https://liquidinference.ai", url: "https://liquidinference.ai/", logo: "/logos/liquid.svg", models: [kimi] }] };

  it("are offered when /v1/models serves them, with provider and speed", () => {
    const list = parseDlProviders(withKimi)!;
    assert.ok(!usableDlModels(list).some((m) => m.id === kimi.id), "not without /v1/models: the catalog would have no entry for it");
    const usable = usableDlModels(list, { modelIds: new Set(["deepseek/deepseek-v4.1-flash-1017", kimi.id]) });
    assert.deepEqual(usable.map(dlFreeModelOption), [
      { value: "deepseek/deepseek-v4.1-flash-1017", label: "DeepSeek V4.1 Flash · Luminal", columns: ["~85 tok/s"] },
      { value: kimi.id, label: "Kimi K3.1 Pro · Liquid Inference", columns: ["~64 tok/s"] },
    ]);
  });

  it("get a catalog entry from /v1/models, else /v1/providers, else safe defaults", () => {
    const list = parseDlProviders(withKimi)!;
    const fromModels = dlServedModelEntry({ id: kimi.id, name: "Kimi K3.1 Pro", contextWindow: 200_000, maxOutputTokens: 16_000 }, list);
    assert.equal(fromModels.name, "Kimi K3.1 Pro (free)");
    assert.equal(fromModels.contextWindow, 200_000);
    assert.equal(fromModels.maxOutputTokens, 16_000);
    assert.deepEqual(fromModels.pricing, { inputPerMtok: 0, outputPerMtok: 0 });
    assert.equal(fromModels.supports.tools, true);
    const fromProviders = dlServedModelEntry({ id: kimi.id }, list);
    assert.equal(fromProviders.name, "Kimi K3.1 Pro (free)");
    assert.equal(fromProviders.contextWindow, 262_144);
    assert.equal(fromProviders.maxOutputTokens, DL_UNKNOWN_MAX_OUTPUT);
    const bare = dlServedModelEntry({ id: "new/model" }, null);
    assert.equal(bare.name, "new/model (free)");
    assert.equal(bare.contextWindow, DL_UNKNOWN_CONTEXT);
  });

  it("loadDlCatalog adds them to the built-in models; the built-in list alone without a token or an answer", async () => {
    const fetchImpl = (async (url: string) =>
      url.endsWith("/v1/providers")
        ? json(withKimi)
        : json({ object: "list", data: [{ id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" }, { id: kimi.id, name: "Kimi K3.1 Pro", context_window: 262_144 }] })) as unknown as typeof fetch;
    const catalog = await loadDlCatalog("tok", { fetchImpl, env });
    const ids = catalog.map((m) => m.id);
    assert.ok(ids.includes("deepseek/deepseek-v4.1-flash-1017") && ids.includes("gpt-6-luna"), "built-in models stay");
    const entry = catalog.find((m) => m.id === kimi.id)!;
    assert.equal(entry.name, "Kimi K3.1 Pro (free)");
    assert.equal(entry.contextWindow, 262_144);
    assert.equal(ids.filter((id) => id === "deepseek/deepseek-v4.1-flash-1017").length, 1, "a known model isn't added twice");
    setDlProvidersCache(null);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.deepEqual((await loadDlCatalog("tok", { fetchImpl: offline, env })).map((m) => m.id), ids.filter((id) => id !== kimi.id));
    assert.deepEqual((await loadDlCatalog(undefined, { fetchImpl, env })).map((m) => m.id), ids.filter((id) => id !== kimi.id));
  });

  it("fetchDlServedModels keeps name and limits", async () => {
    const fetchImpl = (async () => json({ data: [{ id: "a", name: "A", context_window: 1000, max_output_tokens: 100 }, { id: "b" }, { nope: 1 }] })) as unknown as typeof fetch;
    assert.deepEqual(await fetchDlServedModels("tok", { fetchImpl, env }), [{ id: "a", name: "A", contextWindow: 1000, maxOutputTokens: 100 }, { id: "b" }]);
  });
});

describe("402 provider_limit: switch to the alternative and resend once", () => {
  const kimiId = "moonshotai/kimi-k3.1-pro";
  const list = parseDlProviders({
    providers: [
      { id: "luminal", name: "Luminal", models: [model({})] },
      { id: "liquid", name: "Liquid Inference", models: [model({ id: kimiId, name: "Kimi K3.1 Pro", family: "kimi", access: "opt-in" })] },
    ],
  });
  const base = { provider: "directionally-local", model: kimiId, code: "provider_limit", alternative: "deepseek/deepseek-v4.1-flash-1017", servedBy: "liquid", retried: false, list };

  it("reads the error like gpt_limit, with the provider", () => {
    const body = { error: { code: "provider_limit", message: "Kimi K3.1 Pro is paused.", family: "kimi", provider: "liquid", reason: "paused", resetsAt: "2026-11-30T00:00:00.000Z", alternative: "deepseek/deepseek-v4.1-flash-1017" } };
    assert.deepEqual(parseDlError(body), { code: "provider_limit", message: "Kimi K3.1 Pro is paused.", family: "kimi", provider: "liquid", reason: "paused", resetsAt: "2026-11-30T00:00:00.000Z", alternative: "deepseek/deepseek-v4.1-flash-1017" });
    assert.equal(describeDlError("provider_limit", {}), "This free model's provider is at its limit for now; pick another free model with /model.");
    assert.equal(dlHeadlessLine("provider_limit", { message: "Kimi K3.1 Pro is paused." }), "Kimi K3.1 Pro is paused. Run with `-m deepseek/deepseek-v4.1-flash-1017` to use another free model.");
  });

  it("switches any free model to the alternative, with one line naming model and provider", () => {
    assert.deepEqual(dlProviderLimitAutoSwitch(base), {
      model: "deepseek/deepseek-v4.1-flash-1017",
      notice: "Kimi K3.1 Pro on Liquid Inference is at its limit for now; switched to DeepSeek V4.1 Flash.",
    });
    // A provider given by name, or none (then whoever /v1/providers says serves it); GPT-6 too.
    assert.match(dlProviderLimitAutoSwitch({ ...base, servedBy: "Liquid Inference" })!.notice, /^Kimi K3\.1 Pro on Liquid Inference is/);
    assert.match(dlProviderLimitAutoSwitch({ ...base, servedBy: undefined })!.notice, /^Kimi K3\.1 Pro on Liquid Inference is/);
    assert.equal(dlProviderLimitAutoSwitch({ ...base, model: "gpt-6-luna", servedBy: "openai", list: null })!.notice, "GPT-6 Luna on openai is at its limit for now; switched to DeepSeek V4.1 Flash.");
    assert.equal(dlProviderLimitAutoSwitch({ ...base, servedBy: undefined, list: null })!.notice, "moonshotai/kimi-k3.1-pro is at its limit for now; switched to DeepSeek V4.1 Flash.");
  });

  it("resends once only, and leaves other cases alone", () => {
    assert.equal(dlProviderLimitAutoSwitch({ ...base, retried: true }), null);
    assert.equal(dlProviderLimitAutoSwitch({ ...base, model: "deepseek/deepseek-v4.1-flash-1017" }), null);
    assert.equal(dlProviderLimitAutoSwitch({ ...base, provider: "openrouter" }), null);
    assert.equal(dlProviderLimitAutoSwitch({ ...base, code: "gpt_limit" }), null);
    assert.equal(dlProviderLimitAutoSwitch({ ...base, model: undefined }), null);
  });

  it("falls back to DeepSeek when the alternative isn't a free model", () => {
    assert.equal(dlProviderLimitAutoSwitch({ ...base, alternative: undefined })!.model, "deepseek/deepseek-v4.1-flash-1017");
    assert.equal(dlProviderLimitAutoSwitch({ ...base, alternative: "evil/model" })!.model, "deepseek/deepseek-v4.1-flash-1017");
  });
});

describe("dl Pro only models (Kimi K3.1 Pro)", () => {
  const KIMI = "moonshotai/kimi-k3.1-pro";
  const withKimi = parseDlProviders({
    ...body,
    providers: [...body.providers, { id: "liquid", name: "Liquid Inference", website: "", url: "", logo: "", models: [model({ id: KIMI, name: "Kimi K3.1 Pro", family: "kimi", access: "pro", tokensPerSecond: 40 })] }],
  })!;
  const freeMe = {
    plan: "free" as const,
    proModels: [{ id: KIMI, name: "Kimi K3.1 Pro", provider: "liquid", access: "pro", available: false, usdPerWeek: 0.25, approxTokensPerWeek: 140_000, ration: null, text: "Kimi K3.1 Pro is a dl Pro perk: about 140K tokens a week, then DeepSeek." }],
  };
  const proMe = (remainingUsd: number, left: number) => ({
    plan: "pro" as const,
    proModels: [{ id: KIMI, name: "Kimi K3.1 Pro", provider: "liquid", access: "pro", available: true, usdPerWeek: 0.25, approxTokensPerWeek: 140_000, ration: { usdPerWeek: 0.25, usedUsd: 0.25 - remainingUsd, remainingUsd, approxTokensPerWeek: 140_000, approxTokensLeft: left, resetsAt: "2026-11-30T00:00:00.000Z" }, text: "" }],
  });

  it("isn't offered to a free account on the first run, but shown as a locked Pro row", () => {
    assert.ok(!usableDlModels(withKimi, { me: freeMe }).some((m) => m.id === KIMI));
    const locked = lockedDlProModels(withKimi, freeMe);
    assert.deepEqual(locked.map((m) => m.id), [KIMI]);
    assert.deepEqual(dlLockedProOption(locked[0]!), { value: KIMI, label: "Kimi K3.1 Pro · Liquid Inference", description: "Pro — dl Pro only: /upgrade", state: "off", columns: ["~40 tok/s"] });
    assert.deepEqual(lockedDlProModels(withKimi, { plan: "pro" }), [], "Pro's are usable, not locked");
    assert.ok(usableDlModels(withKimi, { modelIds: new Set([KIMI]), me: { plan: "pro" } }).some((m) => m.id === KIMI));
  });

  it("marks the /model row Pro: off with the ration's size for free, the ration left for Pro", () => {
    assert.deepEqual(dlProModelRow(KIMI, freeMe, withKimi), { locked: true, description: "Pro — dl Pro only, about 140K tokens a week: /upgrade" });
    assert.deepEqual(dlProModelRow(KIMI, { plan: "free" }, withKimi), { locked: true, description: "Pro — dl Pro only: /upgrade" }, "an older /v1/me: from /v1/providers");
    assert.deepEqual(dlProModelRow(KIMI, proMe(0.15, 86_000), withKimi), { locked: false, description: "Pro", column: "~86K of 140K left" });
    assert.deepEqual(dlProModelRow(KIMI, proMe(0, 0), withKimi), { locked: false, description: "Pro", column: "used up this week" });
    assert.equal(dlProModelRow("deepseek/deepseek-v4.1-flash-1017", freeMe, withKimi), undefined);
    assert.deepEqual(dlProModels({ proModels: [{ id: "" }, "junk", { id: KIMI, available: "yes" }] }).map((m) => [m.id, m.available]), [[KIMI, false]]);
    assert.deepEqual(dlProModels({}), []);
  });

  it("adds Kimi to a free account's /model catalog as a Pro entry, once", async () => {
    const providersBody = { ...body, providers: [...body.providers, { id: "liquid", name: "Liquid Inference", models: [model({ id: KIMI, name: "Kimi K3.1 Pro", access: "pro" })] }] };
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith("/v1/providers")) return json(providersBody);
      return json({ object: "list", data: [{ id: "deepseek/deepseek-v4.1-flash-1017" }] });
    }) as typeof fetch;
    const catalog = await loadDlCatalog("tok", { fetchImpl, env });
    const kimi = catalog.filter((m) => m.id === KIMI);
    assert.equal(kimi.length, 1);
    assert.equal(kimi[0]!.name, "Kimi K3.1 Pro (Pro)");
  });

  it("a free account's pro_only: the perk, its size and the Upgrade link, then DeepSeek", () => {
    const detail = parseDlError({ error: { code: "provider_limit", reason: "pro_only", plans: "pro", approxTokensPerWeek: 140_000, upgradeUrl: "https://dl.new/account", alternative: "deepseek/deepseek-v4.1-flash-1017", provider: "liquid", message: "Kimi K3.1 Pro is a dl Pro perk: about 140K tokens a week, then DeepSeek. Upgrade: https://dl.new/account" } })!;
    assert.equal(detail.plans, "pro");
    assert.equal(detail.upgradeUrl, "https://dl.new/account");
    assert.equal(detail.approxTokensPerWeek, 140_000);
    const r = dlProviderLimitAutoSwitch({ provider: "directionally-local", model: KIMI, code: "provider_limit", alternative: detail.alternative, servedBy: detail.provider, reason: detail.reason, plans: detail.plans, upgradeUrl: detail.upgradeUrl, approxTokensPerWeek: detail.approxTokensPerWeek, resetsAt: detail.resetsAt, retried: false, list: withKimi });
    assert.deepEqual(r, { model: "deepseek/deepseek-v4.1-flash-1017", notice: "Kimi K3.1 Pro is a dl Pro perk (about 140K tokens a week); switched to DeepSeek V4.1 Flash. Upgrade: https://dl.new/account" });
    assert.equal(parseDlError({ error: { code: "provider_limit", upgradeUrl: "javascript:alert(1)" } })!.upgradeUrl, undefined);
  });

  it("a free model's weekly cap or the provider's weekly budget: the reset day, then DeepSeek", () => {
    const GLM = "z-ai/glm-5.3-flash";
    const withGlm = { ...withKimi, providers: [...withKimi.providers, { id: "openrelay", name: "Open Relay", website: "", url: "", logo: "", models: [{ ...withKimi.providers[0]!.models[0]!, id: GLM, name: "GLM 5.3 Flash", access: "free" as const }] }] };
    const base = { provider: "directionally-local", model: GLM, code: "provider_limit", alternative: "deepseek/deepseek-v4.1-flash-1017", servedBy: "openrelay", resetsAt: "2026-11-30T00:00:00.000Z", timeZone: "UTC", retried: false, list: withGlm };
    assert.deepEqual(dlProviderLimitAutoSwitch({ ...base, reason: "person_cap" }), { model: "deepseek/deepseek-v4.1-flash-1017", notice: "This week's free GLM 5.3 Flash is used up (it resets Monday 30 Nov); switched to DeepSeek V4.1 Flash." });
    assert.equal(dlProviderLimitAutoSwitch({ ...base, reason: "weekly_budget" })!.notice, "GLM 5.3 Flash on Open Relay has used its free budget for this week (it resets Monday 30 Nov); switched to DeepSeek V4.1 Flash.");
    // No reset day for a pause or the credit.
    assert.equal(dlProviderLimitAutoSwitch({ ...base, reason: "out_of_credit", resetsAt: undefined })!.notice, "GLM 5.3 Flash on Open Relay is at its limit for now; switched to DeepSeek V4.1 Flash.");
  });

  it("Pro's used-up ration: the reset day, then DeepSeek", () => {
    const r = dlProviderLimitAutoSwitch({ provider: "directionally-local", model: KIMI, code: "provider_limit", alternative: "deepseek/deepseek-v4.1-flash-1017", reason: "person_cap", plans: "pro", resetsAt: "2026-11-30T00:00:00.000Z", timeZone: "UTC", retried: false, list: withKimi });
    assert.deepEqual(r, { model: "deepseek/deepseek-v4.1-flash-1017", notice: "This week's Kimi K3.1 Pro with dl Pro is used up (it resets Monday 30 Nov); switched to DeepSeek V4.1 Flash." });
    assert.equal(dlResetDay("2026-11-30T00:00:00.000Z", "Asia/Tokyo"), "Monday 30 Nov");
  });
});
