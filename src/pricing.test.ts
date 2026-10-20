import { describe, it, after, before } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "./pricing.js";
import { costNote, recordUsage, type UsageLog } from "./usage-tracker.js";
import { registerProviderModels } from "./models/registry.js";
import { mapModelsDevProvider } from "./models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "./models/models-dev-snapshot.js";
import { PROVIDER_PRESETS } from "./providers/presets.js";

describe("cost on providers without cost confirmation", () => {
  let dir: string;
  const saved = process.env.XDG_DATA_HOME;
  const originalFetch = globalThis.fetch;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "pricing-test-"));
    process.env.XDG_DATA_HOME = dir;
    registerProviderModels("deepseek", mapModelsDevProvider(MODELS_DEV_SNAPSHOT.deepseek!));
    globalThis.fetch = (async () => {
      throw new Error("no network call expected");
    }) as typeof fetch;
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
    await rm(dir, { recursive: true, force: true });
  });

  it("prices a DeepSeek turn from the models.dev catalog, including cache hits, with no confirmation pending", async () => {
    // deepseek-flash: $0.15 in, $0.003 cached, $0.60 out per Mtok.
    const usage = { prompt_tokens: 1_000_000, completion_tokens: 100_000, total_tokens: 1_100_000, prompt_tokens_details: { cached_tokens: 800_000 } };
    await recordUsage("s-deepseek", usage, undefined, "deepseek-flash");
    const log = JSON.parse(await readFile(join(dir, "kimiflare", "usage.json"), "utf8")) as UsageLog;
    const s = log.sessions.find((x) => x.id === "s-deepseek")!;
    const expected = 0.2 * 0.15 + 0.8 * 0.003 + 0.1 * 0.6;
    assert.ok(Math.abs(s.cost - expected) < 1e-9, `cost ${s.cost} ≈ ${expected}`);
    assert.strictEqual(s.turns![0]!.logId, undefined, "nothing to confirm with a provider");
    assert.strictEqual(s.gatewayRequests, undefined);
  });

  it("bills cache writes at the cache-write rate when the model has one", () => {
    registerProviderModels("x", [
      { id: "m", contextWindow: 1, maxOutputTokens: 1, pricing: { inputPerMtok: 3, cachedInputPerMtok: 0.3, cacheWritePerMtok: 3.75, outputPerMtok: 15 }, supports: { tools: true, reasoning: false, streaming: true } },
    ]);
    const c = calculateCost(1_000_000, 0, 200_000, "m", 500_000);
    assert.deepStrictEqual({ uncachedIn: c.uncachedIn, cachedIn: c.cachedIn, cacheWrite: c.cacheWrite }, { uncachedIn: 300_000, cachedIn: 200_000, cacheWrite: 500_000 });
    assert.ok(Math.abs(c.total - (0.3 * 3 + 0.2 * 0.3 + 0.5 * 3.75)) < 1e-9);
    registerProviderModels("deepseek", mapModelsDevProvider(MODELS_DEV_SNAPSHOT.deepseek!));
  });

  it("explains how /cost figures were produced for each kind of provider", () => {
    assert.strictEqual(costNote(PROVIDER_PRESETS.openrouter), undefined);
    assert.match(costNote(PROVIDER_PRESETS.deepseek)!, /estimates from DeepSeek's published prices/);
    assert.match(costNote(PROVIDER_PRESETS.ollama)!, /runs locally: no per-token cost/);
    assert.match(costNote(PROVIDER_PRESETS.custom)!, /gateway's own metering/);
  });
});
