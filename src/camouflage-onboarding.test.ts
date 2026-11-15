import { describe, it } from "node:test";
import assert from "node:assert";
import type { AutopilotConfig } from "./config.js";
import { firstRunIntro, onboardingCancelledMessage, ownKeyIntro, runFirstRun, UPGRADE_NOTICE, type FirstRunDeps } from "./camouflage-onboarding.js";
import { freeHeaderLine, sessionHeaderDetail } from "./camouflage-view.js";
import { normalizeDlMe } from "./providers/directionally-local.js";

function deps(over: Partial<FirstRunDeps> & { calls?: string[] } = {}): FirstRunDeps & { shown: string[][]; calls: string[] } {
  const shown: string[][] = [];
  const calls = over.calls ?? [];
  return {
    shown,
    calls,
    upgrading: async () => false,
    configPath: () => "/home/u/.config/kimiflare/config.json",
    show: (lines) => {
      calls.push("show");
      shown.push(lines);
    },
    setup: async () => {
      calls.push("setup");
      return true;
    },
    loadConfig: async () => {
      calls.push("load");
      return { model: "moonshotai/kimi-k2", provider: "openrouter" } as AutopilotConfig;
    },
    ...over,
  };
}

describe("firstRunIntro", () => {
  it("welcomes a new user with one line, nothing about API keys before the question", () => {
    assert.deepStrictEqual(firstRunIntro({ upgrading: false, configPath: "/x/config.json", env: {} }), ["Welcome to Autopilot."]);
    assert.deepStrictEqual(firstRunIntro({ upgrading: false, configPath: "/x/config.json", env: { AUTOPILOT_LAUNCHED_BY: "dl" } }), ["Welcome to dl."]);
    const text = firstRunIntro({ upgrading: false, configPath: "/x/config.json" }).join("\n");
    assert.doesNotMatch(text, /API keys you enter/);
    assert.doesNotMatch(text, /this question is skipped/);
    assert.doesNotMatch(text, /Cloudflare/);
  });

  it("says where keys are stored, and how to skip the question, only for your own key", () => {
    const lines = ownKeyIntro("/x/config.json");
    assert.deepStrictEqual(lines, [
      "API keys you enter are checked with the provider, then saved only in /x/config.json (keys from your environment are never written to disk).",
      "Tip: with a provider's API key in your environment (e.g. OPENROUTER_API_KEY), this question is skipped.",
    ]);
  });

  it("tells an upgrading kimiflare user Cloudflare is gone (the Ink onboarding copy)", () => {
    const lines = firstRunIntro({ upgrading: true, configPath: "/x/config.json" });
    assert.deepStrictEqual(lines.slice(0, UPGRADE_NOTICE.length), UPGRADE_NOTICE);
    assert.match(lines.join("\n"), /no longer runs on Cloudflare/);
    assert.doesNotMatch(lines.join("\n"), /Welcome/);
  });
});

describe("runFirstRun", () => {
  it("shows the intro, runs setup, then starts with the saved config", async () => {
    const d = deps();
    const r = await runFirstRun(d);
    assert.deepStrictEqual(d.calls, ["show", "setup", "load"]);
    assert.strictEqual(r.kind, "ready");
    assert.strictEqual(r.kind === "ready" && r.cfg.model, "moonshotai/kimi-k2");
  });

  it("passes the upgrade state to the provider picker", async () => {
    let seen: boolean | undefined;
    const d = deps({ upgrading: async () => true, setup: async (o) => ((seen = o.upgrading), true) });
    await runFirstRun(d);
    assert.strictEqual(seen, true);
    assert.match(d.shown[0]!.join("\n"), /Cloudflare/);
  });

  it("treats a failing legacy check as a fresh install", async () => {
    const d = deps({ upgrading: async () => Promise.reject(new Error("EACCES")) });
    assert.strictEqual((await runFirstRun(d)).kind, "ready");
    assert.match(d.shown[0]!.join("\n"), /Welcome/);
  });

  it("is cancelled without loading anything when the user backs out", async () => {
    const d = deps({ setup: async () => false });
    const r = await runFirstRun(d);
    assert.deepStrictEqual(r, { kind: "cancelled" });
    assert.ok(!d.calls.includes("load"));
  });

  it("fails rather than starting a session without credentials", async () => {
    const r = await runFirstRun(deps({ loadConfig: async () => null }));
    assert.strictEqual(r.kind, "failed");
    assert.match(r.kind === "failed" ? r.message : "", /no credentials were found in \/home\/u/);
  });

  it("fails rather than starting a session without a model", async () => {
    const r = await runFirstRun(deps({ loadConfig: async () => ({ model: "" }) as AutopilotConfig }));
    assert.strictEqual(r.kind, "failed");
    assert.match(r.kind === "failed" ? r.message : "", /No model selected/);
  });

  it("never says calls are billed to your own account before the question that offers the free tier", () => {
    for (const upgrading of [false, true]) {
      assert.doesNotMatch(firstRunIntro({ upgrading, configPath: "/x/config.json" }).join("\n"), /billed/);
    }
  });

  it("with a provider's key in the environment: one line saying so, and the key is passed on instead of asking", async () => {
    let seen: unknown;
    const envKey = { id: "anthropic" as const, envVar: "ANTHROPIC_API_KEY" };
    const d = deps({ envKey: () => envKey, setup: async (o) => ((seen = o.envKey), true) });
    assert.strictEqual((await runFirstRun(d)).kind, "ready");
    assert.deepStrictEqual(seen, envKey);
    assert.deepStrictEqual(d.shown[0], ["Welcome to Autopilot.", "Using Anthropic with ANTHROPIC_API_KEY from your environment."]);
  });

  it("without one, setup gets no env key (the question is asked)", async () => {
    let seen: unknown = "unset";
    await runFirstRun(deps({ envKey: () => undefined, setup: async (o) => ((seen = o.envKey), true) }));
    assert.strictEqual(seen, undefined);
  });

  it("reports a config that won't load", async () => {
    const r = await runFirstRun(deps({ loadConfig: async () => Promise.reject(new Error("bad json")) }));
    assert.strictEqual(r.kind, "failed");
    assert.match(r.kind === "failed" ? r.message : "", /bad json/);
  });
});

describe("onboardingCancelledMessage", () => {
  it("names dl's command when dl started it", () => {
    const m = onboardingCancelledMessage({ AUTOPILOT_LAUNCHED_BY: "dl" });
    assert.match(m, /Run `dl` again/);
    assert.doesNotMatch(m, /autopilot/);
  });

  it("says nothing was saved and how to get going", () => {
    const m = onboardingCancelledMessage();
    assert.match(m, /nothing was saved/);
    assert.match(m, /OPENROUTER_API_KEY/);
    assert.match(m, /autopilot auth status/);
  });
});

describe("sessionHeaderDetail", () => {
  it("has no model line on first run: just \"First run\"", () => {
    const d = sessionHeaderDetail(null, process.cwd(), "main");
    assert.strictEqual(d.length, 2);
    assert.match(d[0]!, /main$/);
    assert.strictEqual(d[1], "First run");
  });

  it("names the model once configured, and nothing else by default", () => {
    const d = sessionHeaderDetail({ model: "moonshotai/kimi-k2" }, process.cwd(), null);
    assert.match(d[0]!, /kimi-k2/);
    assert.strictEqual(d.length, 1, "no command hints, folder notices or other startup text");
  });

  it("adds the /tour hint and the free tier's line when given", () => {
    const cfg = { model: "deepseek/deepseek-v4.1-flash-1017" };
    const free = "free · DeepSeek 49.9M left this week · invite friends: dl.new/r/abc (2 joined)";
    const d = sessionHeaderDetail(cfg, process.cwd(), null, { tourHint: "/tour · what's different about dl", free });
    assert.deepStrictEqual(d.slice(1), ["/tour · what's different about dl", free]);
    assert.strictEqual(sessionHeaderDetail(cfg, process.cwd(), null, { free }).length, 2, "no hint once /tour was opened");
    assert.strictEqual(sessionHeaderDetail(cfg, process.cwd(), null, {}).length, 1);
  });
});

describe("freeHeaderLine", () => {
  const me = normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 50e6, usedThisWeek: 1e6, remaining: 49e6, resetsAt: "2026-11-16T00:00:00.000Z" },
    referral: { link: "https://dl.new/r/abc", joined: 2 },
  });
  const model = "deepseek/deepseek-v4.1-flash-1017";
  const cfg = (c: Partial<AutopilotConfig>) => ({ model, ...c }) as AutopilotConfig;

  it("shows only for the free tier provider, with an account read", () => {
    assert.strictEqual(freeHeaderLine(cfg({ provider: "directionally-local" }), me, {}), "free · DeepSeek 49M left this week · invite friends: dl.new/r/abc (2 joined)");
  });

  it("hides when /v1/me is unavailable, and for every other provider", () => {
    assert.strictEqual(freeHeaderLine(cfg({ provider: "directionally-local" }), null, {}), undefined);
    assert.strictEqual(freeHeaderLine(cfg({ provider: "openrouter", openrouterApiKey: "sk-or-x" }), me, {}), undefined, "own key");
    assert.strictEqual(freeHeaderLine(cfg({ provider: "vllm" as AutopilotConfig["provider"] }), me, {}), undefined, "local GPU server");
    assert.strictEqual(freeHeaderLine(cfg({ provider: "directionally-local" }), me, { AUTOPILOT_PROVIDER: "deepseek" }), undefined, "provider from the environment");
    assert.strictEqual(freeHeaderLine(null, me, {}), undefined, "first run");
  });
});
