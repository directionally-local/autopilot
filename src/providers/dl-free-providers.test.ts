import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DL_FALLBACK_PROVIDERS,
  DL_PROVIDERS_CACHE_MS,
  cachedDlProviders,
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
} from "./dl-free-providers.js";

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
    assert.equal(await fetchDlProviders({ fetchImpl: slow, env, timeoutMs: 50 }), DL_FALLBACK_PROVIDERS);
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
