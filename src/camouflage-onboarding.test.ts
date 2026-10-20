import { describe, it } from "node:test";
import assert from "node:assert";
import type { KimiConfig } from "./config.js";
import { firstRunIntro, onboardingCancelledMessage, runFirstRun, UPGRADE_NOTICE, type FirstRunDeps } from "./camouflage-onboarding.js";
import { sessionHeaderDetail } from "./camouflage-view.js";

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
      return { model: "moonshotai/kimi-k2", provider: "openrouter" } as KimiConfig;
    },
    ...over,
  };
}

describe("firstRunIntro", () => {
  it("welcomes a new user and says where keys are stored", () => {
    const text = firstRunIntro({ upgrading: false, configPath: "/x/config.json" }).join("\n");
    assert.match(text, /Welcome to autopilot/);
    assert.match(text, /saved only in \/x\/config\.json/);
    assert.match(text, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(text, /Cloudflare/);
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
    const r = await runFirstRun(deps({ loadConfig: async () => ({ model: "" }) as KimiConfig }));
    assert.strictEqual(r.kind, "failed");
    assert.match(r.kind === "failed" ? r.message : "", /No model selected/);
  });

  it("reports a config that won't load", async () => {
    const r = await runFirstRun(deps({ loadConfig: async () => Promise.reject(new Error("bad json")) }));
    assert.strictEqual(r.kind, "failed");
    assert.match(r.kind === "failed" ? r.message : "", /bad json/);
  });
});

describe("onboardingCancelledMessage", () => {
  it("says nothing was saved and how to get going", () => {
    const m = onboardingCancelledMessage();
    assert.match(m, /nothing was saved/);
    assert.match(m, /OPENROUTER_API_KEY/);
    assert.match(m, /autopilot auth status/);
  });
});

describe("sessionHeaderDetail", () => {
  it("has no model line on first run", () => {
    const d = sessionHeaderDetail(null, process.cwd(), "main");
    assert.strictEqual(d.length, 2);
    assert.match(d[0]!, /main$/);
    assert.match(d[1]!, /connect a model provider/);
  });

  it("names the model once configured", () => {
    const d = sessionHeaderDetail({ model: "moonshotai/kimi-k2", modesEnabled: true }, process.cwd(), null);
    assert.match(d[0]!, /kimi-k2/);
    assert.match(d[1]!, /shift\+tab/);
  });
});
