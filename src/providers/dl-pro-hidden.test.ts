import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { describeDlError, dlQuotaLine, dlTrialEndedLine, normalizeDlMe, parseDlError, renderDlUsage, resetDlNoticeState, type DlMe } from "./directionally-local.js";
import { dlHeadlessLine, dlScreenChoices, dlScreenFor, dlUpgradeStep, runDlScreen, type DlScreen, type DlScreenDeps } from "./dl-growth.js";
import { runUpgradeCommand, type DlCommandDeps } from "../dl-commands.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";
import { CATEGORIES } from "../ui/help-catalog.js";

/**
 * The service stops offering dl Pro by leaving `pro` out of `offers` (its `proOffered` setting).
 * Then a free account sees no "dl Pro" anywhere: the limit, trial, GPT-6 and queue screens, the
 * lines in a session, the CLI and headless runs, /usage, and /upgrade, which offers the top-up
 * alone. A Pro subscriber still manages or cancels the plan from /upgrade.
 */

const TZ = "Asia/Tokyo";
const NOW = Date.parse("2026-11-03T03:00:00Z");
const RESETS = "2026-11-09T00:00:00Z";
const LINK = "https://dl.new/r/octo42";
/** What the service sends while Pro isn't offered: the top-up only. */
const TOPUP_ONLY = { topup: { unitPriceUsd: 1, minQuantity: 2, maxQuantity: 20, usageMultiplier: 1.25, validDays: 90, fromPrice: "$2" } };
const PRO = /\bpro\b/i;

function me(over: Record<string, unknown> = {}): DlMe {
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 30_000_000, remaining: 20_000_000, resetsAt: RESETS },
    referral: { code: "octo42", link: LINK, joined: 0, activeThisWeek: 0, bonusTokensPerWeek: 0 },
    offers: TOPUP_ONLY,
    ...over,
  })!;
}

function selectWorld(answer: string | null = null) {
  const selects: { title: string; labels: string[]; values: string[] }[] = [];
  const deps = {
    select: async (title: string, options: Array<{ label: string; value: string; description?: string }>) => {
      selects.push({ title, labels: options.map((o) => `${o.label}${o.description ? ` ${o.description}` : ""}`), values: options.map((o) => o.value) });
      return answer;
    },
    say: () => {},
    copy: () => true,
    checkout: async () => "https://pay.example/x",
    openBrowser: () => true,
    wait: async () => () => {},
    sleep: async () => {},
    now: () => NOW,
    fetchMe: async () => me(),
    timeZone: TZ,
  } as unknown as DlScreenDeps;
  return { deps, selects };
}

function cliDeps(printed: string[], over: Partial<DlCommandDeps> = {}): DlCommandDeps {
  return {
    providerId: "directionally-local",
    providerName: "Directionally Local, free",
    print: (line) => void printed.push(line),
    fetchMe: async () => me(),
    copy: () => true,
    checkout: async (product) => `https://pay.example/${product}`,
    portal: async () => "https://billing.example/portal",
    openBrowser: () => true,
    ask: null,
    sleep: async () => {},
    now: () => NOW,
    ...over,
  };
}

describe("dl Pro hidden by the service (no offers.pro)", () => {
  beforeEach(() => resetDlNoticeState());

  it("leaves Pro off every out-of-usage screen, titles included", async () => {
    const detail = parseDlError({ error: { code: "x", offers: TOPUP_ONLY, referralLink: LINK, trial: { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true } } })!;
    for (const code of ["quota_exceeded", "basic_limit", "gpt_limit", "trial_ended", "free_tier_queued"]) {
      const screen = dlScreenFor(code, { ...detail, resetsAt: RESETS, position: 3 }, undefined, "free")!;
      assert.ok(screen, code);
      const choices = dlScreenChoices(screen.kind, screen);
      assert.ok(!choices.some((c) => c.value === "pro"), code);
      const { deps, selects } = selectWorld();
      assert.strictEqual(await runDlScreen(screen, deps), "dismissed");
      assert.doesNotMatch(selects[0]!.title, PRO, `${code}: ${selects[0]!.title}`);
      for (const label of selects[0]!.labels) assert.doesNotMatch(label, PRO, `${code}: ${label}`);
    }
    const trial = dlScreenFor("trial_ended", detail, undefined, "free")!;
    const { deps, selects } = selectWorld();
    await runDlScreen(trial, deps);
    assert.strictEqual(selects[0]!.title, "You've used your 10M free trial tokens. Keep going with a top-up.");
    assert.deepStrictEqual(selects[0]!.values, ["topup", "own-key", "gpus"]);
  });

  it("still offers Pro on the trial screen while the service does", async () => {
    const offers = { ...TOPUP_ONLY, pro: { priceUsdMonthly: 3.99, price: "$3.99/month" } };
    const { deps, selects } = selectWorld();
    await runDlScreen({ kind: "trial", tokens: 10_000_000, offers }, deps);
    assert.strictEqual(selects[0]!.title, "You've used your 10M free trial tokens. Keep going with dl Pro or a top-up.");
    assert.strictEqual(selects[0]!.values[0], "pro");
  });

  it("says no Pro in a session's, the CLI's or a headless run's lines", () => {
    const trial = { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true };
    const lines = [
      dlTrialEndedLine(10_000_000, { offers: TOPUP_ONLY }),
      dlTrialEndedLine(10_000_000, { where: "cli", offers: TOPUP_ONLY }),
      dlTrialEndedLine(10_000_000),
      describeDlError("trial_ended", { trial, offers: TOPUP_ONLY })!,
      describeDlError("quota_exceeded", { resetsAt: RESETS, offers: TOPUP_ONLY, now: NOW, timeZone: TZ })!,
      dlQuotaLine(RESETS, { offers: TOPUP_ONLY, where: "cli", now: NOW, timeZone: TZ }),
      dlHeadlessLine("quota_exceeded", { resetsAt: RESETS, offers: TOPUP_ONLY }, { now: NOW, timeZone: TZ })!,
      dlHeadlessLine("trial_ended", { trial, offers: TOPUP_ONLY })!,
      dlHeadlessLine("free_tier_queued", { position: 3, offers: TOPUP_ONLY, referralLink: LINK }, { now: NOW, timeZone: TZ })!,
    ];
    for (const line of lines) assert.doesNotMatch(line, PRO, line);
    assert.strictEqual(dlTrialEndedLine(10_000_000, { offers: TOPUP_ONLY }), "You've used your 10M free trial tokens. Keep going with a top-up: /upgrade. Or use your own key: /provider.");
  });

  it("shows no Pro line in /usage for a free account, used or not", () => {
    for (const used of [30_000_000, 45_000_000, 50_000_000]) {
      const text = renderDlUsage(me({ allowance: { tokensPerWeek: 50_000_000, usedThisWeek: used, remaining: 50_000_000 - used, resetsAt: RESETS } }), NOW, TZ);
      assert.doesNotMatch(text, PRO, text);
    }
    const ended = renderDlUsage(me({ trial: { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true } }), NOW, TZ);
    assert.doesNotMatch(ended, PRO, ended);
    assert.match(ended, /Keep going with a top-up/);
  });

  it("/upgrade offers the top-up alone on the free tier", async () => {
    const step = await dlUpgradeStep({ providerId: "directionally-local", providerName: "Directionally Local, free", fetchMe: async () => me(), portal: async () => "", openBrowser: () => true });
    assert.strictEqual(step.kind, "screen");
    const { deps, selects } = selectWorld();
    await runDlScreen((step as { screen: DlScreen }).screen, deps);
    assert.strictEqual(selects[0]!.title, "Upgrade Directionally Local");
    assert.deepStrictEqual(selects[0]!.values, ["topup"]);
    assert.doesNotMatch(selects[0]!.labels.join(" "), PRO);
  });

  it("/upgrade still opens manage or cancel for a Pro subscriber", async () => {
    const opened: string[] = [];
    const step = await dlUpgradeStep({
      providerId: "directionally-local",
      providerName: "Directionally Local, free",
      fetchMe: async () => me({ plan: "pro" }),
      portal: async () => "https://billing.example/portal",
      openBrowser: (url) => (opened.push(url), true),
    });
    assert.deepStrictEqual(step, { kind: "text", text: "Manage or cancel your plan: opened https://billing.example/portal in your browser." });
    assert.deepStrictEqual(opened, ["https://billing.example/portal"]);
    // A subscriber's own words still say Pro.
    assert.match(dlQuotaLine(RESETS, { offers: TOPUP_ONLY, plan: "pro", now: NOW, timeZone: TZ }), /this week's Pro usage/);
  });

  it("`autopilot upgrade`: the top-up only; `pro` isn't a choice; a subscriber gets the portal", async () => {
    const printed: string[] = [];
    assert.strictEqual(await runUpgradeCommand(undefined, cliDeps(printed)), 1);
    assert.strictEqual(printed[0], "Upgrade Directionally Local");
    assert.match(printed[1]!, /^ {2}1\) Top up from \$2/);
    assert.strictEqual(printed[2], "Run `autopilot upgrade topup`.");
    assert.strictEqual(printed.length, 3);
    for (const line of printed) assert.doesNotMatch(line, PRO, line);
    const refused: string[] = [];
    assert.strictEqual(await runUpgradeCommand("pro", cliDeps(refused)), 1);
    assert.deepStrictEqual(refused, ["Choose one of: topup."]);
    const subscriber: string[] = [];
    assert.strictEqual(await runUpgradeCommand(undefined, cliDeps(subscriber, { fetchMe: async () => me({ plan: "pro" }) })), 0);
    assert.deepStrictEqual(subscriber, ["Manage or cancel your plan: opened https://billing.example/portal in your browser."]);
  });

  it("describes /upgrade without naming dl Pro as something to buy", () => {
    const builtin = BUILTIN_COMMANDS.find((c) => c.name === "upgrade")!;
    assert.strictEqual(builtin.description, "Directionally Local: a one-time top-up; on Pro, manage or cancel your plan");
    const help = CATEGORIES.flatMap((c) => c.commands).find((c) => c.command === "/upgrade")!;
    assert.strictEqual(help.description, "Directionally Local: a one-time top-up; on Pro, manage or cancel your plan");
  });
});
