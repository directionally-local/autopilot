import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchGenerationSnapshot, getCostReport, reconcileTurnCost, recordUsage, usageEvents, type UsageLog } from "../usage-tracker.js";

describe("OpenRouter cost confirmation", () => {
  let originalXdgDataHome: string | undefined;
  const dirs: string[] = [];

  before(() => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
  });

  after(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function freshDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "kimiflare-usage-"));
    dirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return dir;
  }

  async function readSession(dir: string, id: string) {
    const log = JSON.parse(await readFile(join(dir, "autopilot", "usage.json"), "utf8")) as UsageLog;
    return log.sessions.find((s) => s.id === id)!;
  }

  const usage = { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240, prompt_tokens_details: { cached_tokens: 1000 } };

  it("confirms a turn immediately from the stream's inline usage.cost", async () => {
    const dir = await freshDataDir();
    await recordUsage("s-inline", { ...usage, cost: 0.00123 }, { apiKey: "k", meta: { generationId: "gen-1", provider: "Moonshot AI" } }, "moonshotai/kimi-k2.6");
    const s = await readSession(dir, "s-inline");
    const turn = s.turns![0]!;
    assert.strictEqual(turn.confirmedCost, 0.00123);
    assert.strictEqual(turn.logId, "gen-1");
    assert.ok(Math.abs(s.cost - 0.00123) < 1e-12, "session cost moves from the estimate to the billed number");
    assert.strictEqual(s.gatewayCost, 0.00123);
    assert.strictEqual(s.gatewayLogs![0]!.provider, "Moonshot AI");
    const report = await getCostReport("s-inline");
    assert.strictEqual(report.session.reconcilePending, false);
  });

  it("without inline cost, stays pending until the /generation lookup confirms it", async () => {
    const dir = await freshDataDir();
    // No apiKey → recordUsage won't start its own background poll.
    await recordUsage("s-poll", usage, { apiKey: "", meta: { generationId: "gen-2" } }, "moonshotai/kimi-k2.6");
    assert.strictEqual((await getCostReport("s-poll")).session.reconcilePending, true);

    const turnId = (await readSession(dir, "s-poll")).turns![0]!.turnId;
    let calls = 0;
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls++;
      assert.ok(String(url).endsWith("/generation?id=gen-2"));
      assert.strictEqual(new Headers(init?.headers).get("Authorization"), "Bearer sk-or-x");
      if (calls === 1) return new Response("{}", { status: 404 }); // not indexed yet
      return new Response(JSON.stringify({ data: { total_cost: 0.0042, latency: 900, provider_name: "DeepInfra", native_tokens_prompt: 1200, native_tokens_completion: 40 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await reconcileTurnCost("s-poll", turnId, { apiKey: "sk-or-x", meta: { generationId: "gen-2" } }, fetchImpl, [1, 1, 1]);

    const s = await readSession(dir, "s-poll");
    assert.strictEqual(s.turns![0]!.confirmedCost, 0.0042);
    assert.strictEqual(s.turns![0]!.durationMs, 900);
    assert.strictEqual(calls, 2);
    assert.strictEqual((await getCostReport("s-poll")).session.reconcilePending, false);
  });

  it("marks the turn reconcileFailed once the retry budget is spent", async () => {
    const dir = await freshDataDir();
    await recordUsage("s-fail", usage, { apiKey: "", meta: { generationId: "gen-3" } });
    const turnId = (await readSession(dir, "s-fail")).turns![0]!.turnId;
    const fetchImpl = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await reconcileTurnCost("s-fail", turnId, { apiKey: "k", meta: { generationId: "gen-3" } }, fetchImpl, [1, 1]);
    const s = await readSession(dir, "s-fail");
    assert.strictEqual(s.turns![0]!.reconcileFailed, true);
    assert.strictEqual((await getCostReport("s-fail")).session.reconcilePending, false);
  });

  it("maps a /generation record into a snapshot", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { total_cost: 0.5, generation_time: 1200, model: "moonshotai/kimi-k2.6", provider_name: "Fireworks", tokens_prompt: 10, tokens_completion: 5, native_tokens_cached: 3 } }), { status: 200 })) as unknown as typeof fetch;
    const snap = await fetchGenerationSnapshot({ apiKey: "k", meta: { generationId: "gen-4" } }, fetchImpl);
    assert.deepStrictEqual(snap, { logId: "gen-4", cost: 0.5, duration: 1200, model: "moonshotai/kimi-k2.6", provider: "Fireworks", tokensIn: 10, tokensOut: 5, tokensCached: 3 });
  });

  it("emits an update event so the status bar refreshes", async () => {
    await freshDataDir();
    let seen = "";
    const onUpdate = (sid: string) => { seen = sid; };
    usageEvents.on("update", onUpdate);
    await recordUsage("s-evt", { ...usage, cost: 0.001 });
    usageEvents.off("update", onUpdate);
    assert.strictEqual(seen, "s-evt");
  });
});

describe("Persistent history.jsonl", () => {
  let originalXdgDataHome: string | undefined;

  before(() => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
  });

  after(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
  });

  it("writes daily usage to history.jsonl on recordUsage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimiflare-history-"));
    process.env.XDG_DATA_HOME = dir;
    try {
      await recordUsage(
        "session_a",
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 10 },
        },
        undefined,
      );

      const historyRaw = await readFile(join(dir, "autopilot", "history.jsonl"), "utf8");
      const lines = historyRaw.trim().split("\n");
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0]);
      const entry = JSON.parse(lines[0]);
      assert.strictEqual(entry.promptTokens, 100);
      assert.strictEqual(entry.completionTokens, 50);
      assert.strictEqual(entry.cachedTokens, 10);
      assert.ok(entry.date);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deduplicates same-day entries in history.jsonl", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimiflare-history-"));
    process.env.XDG_DATA_HOME = dir;
    try {
      await recordUsage(
        "session_a",
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        undefined,
      );
      await recordUsage(
        "session_a",
        {
          prompt_tokens: 200,
          completion_tokens: 100,
          total_tokens: 300,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        undefined,
      );

      const historyRaw = await readFile(join(dir, "autopilot", "history.jsonl"), "utf8");
      const lines = historyRaw.trim().split("\n");
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0]);
      const entry = JSON.parse(lines[0]);
      assert.strictEqual(entry.promptTokens, 300);
      assert.strictEqual(entry.completionTokens, 150);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("includes history data in allTime and month totals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimiflare-history-"));
    process.env.XDG_DATA_HOME = dir;
    try {
      // Seed history with an old day
      const historyDir = join(dir, "kimiflare");
      await mkdir(historyDir, { recursive: true });
      const historyPath = join(historyDir, "history.jsonl");
      await writeFile(
        historyPath,
        JSON.stringify({
          date: "2025-01-01",
          promptTokens: 1000,
          completionTokens: 500,
          cachedTokens: 100,
          cost: 0.5,
        }) + "\n",
        "utf8",
      );

      // Record usage for today
      await recordUsage(
        "session_b",
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        undefined,
      );

      const report = await getCostReport("session_b");
      // Today's session should only reflect today's usage
      assert.strictEqual(report.session.promptTokens, 100);
      // All time should include the old history entry
      assert.strictEqual(report.allTime.promptTokens, 1100);
      assert.strictEqual(report.allTime.completionTokens, 550);
      assert.strictEqual(report.allTime.cost, 0.5 + report.today.cost);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives usage.json precedence over history for overlapping dates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimiflare-history-"));
    process.env.XDG_DATA_HOME = dir;
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Seed history with today's data (simulating stale data)
      const historyDir = join(dir, "kimiflare");
      await mkdir(historyDir, { recursive: true });
      const historyPath = join(historyDir, "history.jsonl");
      await writeFile(
        historyPath,
        JSON.stringify({
          date: today,
          promptTokens: 9999,
          completionTokens: 9999,
          cachedTokens: 0,
          cost: 9.99,
        }) + "\n",
        "utf8",
      );

      // Record fresh usage for today
      await recordUsage(
        "session_c",
        {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
          prompt_tokens_details: { cached_tokens: 0 },
        },
        undefined,
      );

      const report = await getCostReport("session_c");
      // Today's total should reflect the fresh usage.json data, not stale history
      assert.strictEqual(report.today.promptTokens, 100);
      assert.strictEqual(report.allTime.promptTokens, 100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
