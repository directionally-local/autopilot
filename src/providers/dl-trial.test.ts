import { describe, it } from "node:test";
import assert from "node:assert";
import {
  describeDlError,
  dlHeaderLine,
  DL_OTHER_AGENTS_LINE,
  dlSignedInAgentsLine,
  dlSignedInLine,
  dlStartLine,
  normalizeDlMe,
  parseDlError,
  renderDlUsage,
  type DlMe,
} from "./directionally-local.js";
import { dlHeadlessLine, dlScreenChoices, dlScreenFollowUp, dlScreenFor, runDlScreen, type DlScreenDeps } from "./dl-growth.js";

/**
 * The free tier's one-time trial for new accounts: /v1/me's `trial` ({tokens, used, remaining,
 * ended}, null for accounts on the weekly allowance), the 402 trial_ended paywall, and the lines
 * that say what's left. Accounts on the weekly allowance read exactly as before.
 */

const RESETS = "2026-11-16T00:00:00.000Z";
const NOW = Date.parse("2026-11-12T00:00:00.000Z");
const TZ = { timeZone: "Asia/Tokyo" };
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";
const OFFERS = {
  pro: { priceUsdMonthly: 3.99, price: "$3.99/month", usdPerWeek: 2, deepseekUsdPerWeek: 8, valueLine: "Lots of DeepSeek every week, plus more GPT-6." },
  topup: { unitPriceUsd: 1, minQuantity: 2, maxQuantity: 20, usageMultiplier: 1.25, validDays: 90, fromPrice: "$2" },
};
const BUDGETS = { gpt6: { usdPerWeek: 2, spentUsd: 0.4, tokensThisWeek: 1_000_000 }, deepseek: { usdPerWeek: 8, spentUsd: 1.2, tokensThisWeek: 3_800_000 } };
const TRIAL = { tokens: 10_000_000, used: 3_800_000, remaining: 6_200_000, ended: false };
const ENDED = { tokens: 10_000_000, used: 10_000_000, remaining: 0, ended: true };

/** A /v1/me body as the free tier service sends it (services/free `me`). */
function me(over: Record<string, unknown> = {}): DlMe {
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 5_000_000, remaining: 45_000_000, resetsAt: RESETS, usdPerWeek: 2, spentUsdThisWeek: 0.4 },
    budgets: BUDGETS,
    referral: { code: "abc", link: "https://dl.new/r/abc", joined: 2, activeThisWeek: 1, bonusTokensPerWeek: 0 },
    offers: OFFERS,
    trial: null,
    ...over,
  })!;
}

describe("/v1/me's trial", () => {
  it("is read when well formed and left out for null (the weekly allowance)", () => {
    assert.deepStrictEqual(me({ trial: TRIAL }).trial, TRIAL);
    assert.strictEqual(me().trial, undefined);
    assert.strictEqual("trial" in me(), false);
    assert.strictEqual(me({ trial: { tokens: "10M" } }).trial, undefined);
    assert.strictEqual(me({ trial: { tokens: 10_000_000, used: 10_000_000 } }).trial?.ended, true, "nothing left reads as ended");
  });
});

describe("the startup line and the header", () => {
  it("say what's left of the trial for a trial account", () => {
    assert.strictEqual(dlStartLine(me({ trial: TRIAL }), DEEPSEEK), "free · trial: 6.2M of 10M left · invite friends: dl.new/r/abc (2 joined)");
    assert.strictEqual(dlStartLine(me({ trial: ENDED, referral: null }), DEEPSEEK), "free · trial: used up · /upgrade");
    assert.strictEqual(dlHeaderLine(me({ trial: TRIAL })), "free · trial: 6.2M of 10M left");
  });

  it("are unchanged for accounts on the weekly allowance", () => {
    assert.strictEqual(dlStartLine(me(), DEEPSEEK), "free · DeepSeek $6.80 left this week · invite friends: dl.new/r/abc (2 joined)");
    assert.strictEqual(dlHeaderLine(me()), "free · gpt-6 $1.60 left · deepseek $6.80 left");
  });

  it("show nothing on Pro, trial or not", () => {
    assert.strictEqual(dlStartLine(me({ plan: "pro", trial: ENDED }), DEEPSEEK), undefined);
  });
});

describe("/usage", () => {
  it("shows the trial's tokens left for a trial account", () => {
    const text = renderDlUsage(me({ trial: TRIAL }), NOW, TZ.timeZone);
    assert.match(text, /^ {2}trial {11}6\.2M of 10M left$/m);
    assert.doesNotMatch(text, /used up/);
  });

  it("shows the paywall once the trial is used up, unless a top-up is left", () => {
    const text = renderDlUsage(me({ trial: ENDED }), NOW, TZ.timeZone);
    assert.match(text, /^ {2}trial {11}used up$/m);
    assert.match(text, /You've used your 10M free trial tokens\. Keep going with dl Pro for \$3\.99\/month or a top-up: \/upgrade\. Or use your own key: \/provider\.$/m);
    assert.doesNotMatch(renderDlUsage(me({ trial: ENDED, topupUsdLeft: 2 }), NOW, TZ.timeZone), /Keep going with dl Pro/);
  });

  it("is unchanged for accounts on the weekly allowance, and on Pro", () => {
    const text = renderDlUsage(me(), NOW, TZ.timeZone);
    assert.doesNotMatch(text, /trial/);
    assert.match(text, /^ {2}gpt-6 {11}\$0\.40 of \$2 this week · 1M tokens$/m);
    assert.doesNotMatch(renderDlUsage(me({ plan: "pro", trial: ENDED }), NOW, TZ.timeZone), /trial/);
  });
});

describe("the sign-in line", () => {
  it("says the trial for a trial account", () => {
    assert.strictEqual(dlSignedInLine(me({ trial: TRIAL }), TZ), "✓ Signed in as @octo · 10M free tokens to try dl");
    assert.strictEqual(dlSignedInLine(me({ trial: ENDED }), TZ), "✓ Signed in as @octo · your free trial is used up: /upgrade");
  });

  it("says the weekly allowance as the other screens do, never a stale 50M", () => {
    // Free accounts: DeepSeek only, in tokens with the caching label, never GPT-6 dollars.
    assert.strictEqual(dlSignedInLine(me(), TZ), "✓ Signed in as @octo · Free: DeepSeek V4.1 Flash, 10M tokens a week (95.5% caching applied) · back every Monday");
    assert.strictEqual(
      dlSignedInLine(me({ budgets: { gpt6: { usdPerWeek: 2, spentUsd: 0 }, deepseek: { usdPerWeek: null, spentUsd: 0 } } }), TZ),
      "✓ Signed in as @octo · Free: DeepSeek V4.1 Flash, 10M tokens a week (95.5% caching applied) · back every Monday",
    );
    assert.strictEqual(dlSignedInLine(me({ plan: "pro" }), TZ), "✓ Signed in as @octo · dl Pro: $2 GPT-6 + $8 DeepSeek each week · back every Monday");
    assert.strictEqual(
      dlSignedInLine(me({ budgets: { gpt6: { usdPerWeek: 0, spentUsd: 0 }, deepseek: { usdPerWeek: 0, spentUsd: 0 } } }), TZ),
      "✓ Signed in as @octo · no free usage on this account yet: /request",
    );
  });
  it("is followed by the dl claude / dl opencode tip when dl started Autopilot and there are free tokens to use", () => {
    const dl = { AUTOPILOT_LAUNCHED_BY: "dl" };
    assert.strictEqual(dlSignedInAgentsLine(me(), dl), DL_OTHER_AGENTS_LINE);
    assert.strictEqual(dlSignedInAgentsLine(me({ trial: TRIAL }), dl), DL_OTHER_AGENTS_LINE);
    assert.strictEqual(dlSignedInAgentsLine(null, dl), DL_OTHER_AGENTS_LINE, "no account read: the tip still holds");
    assert.strictEqual(dlSignedInAgentsLine(me(), {}), undefined, "plain autopilot: dl may not be installed");
    assert.strictEqual(dlSignedInAgentsLine(me({ plan: "pro" }), dl), undefined, "not free tokens on Pro");
    assert.strictEqual(dlSignedInAgentsLine(me({ trial: ENDED }), dl), undefined, "a used-up trial");
    assert.strictEqual(dlSignedInAgentsLine(me({ budgets: { gpt6: { usdPerWeek: 0, spentUsd: 0 }, deepseek: { usdPerWeek: 0, spentUsd: 0 } } }), dl), undefined, "no free usage yet");
  });
});

describe("402 trial_ended", () => {
  const body = {
    error: {
      code: "trial_ended",
      message: "Your 10M free trial tokens are used up. Keep going with dl Pro for $3.99 a month, or add a top-up: /upgrade",
      trial: ENDED,
      offers: OFFERS,
    },
  };

  it("reads the trial and says the paywall in a session and the CLI", () => {
    const e = parseDlError(body)!;
    assert.deepStrictEqual(e.trial, ENDED);
    assert.strictEqual(describeDlError(e.code, { ...e, where: "session" }), "You've used your 10M free trial tokens. Keep going with dl Pro for $3.99/month or a top-up: /upgrade. Or use your own key: /provider.");
    assert.strictEqual(
      describeDlError(e.code, { ...e, where: "cli" }),
      "You've used your 10M free trial tokens. Keep going with dl Pro for $3.99/month or a top-up: `autopilot upgrade`. Or use your own key: `autopilot connect`.",
    );
    assert.strictEqual(
      dlHeadlessLine(e.code, e),
      "You've used your 10M free trial tokens. Keep going with dl Pro for $3.99/month or a top-up: `autopilot upgrade`. Or use your own key: `autopilot connect`.",
    );
  });

  it("opens the paywall screen: Pro first, then a top-up, your own key, your own GPUs; no waiting and no free ask", () => {
    const e = parseDlError(body)!;
    const screen = dlScreenFor(e.code, e, undefined, "free")!;
    assert.deepStrictEqual(screen, { kind: "trial", tokens: 10_000_000, offers: e.offers, plan: "free" });
    const choices = dlScreenChoices(screen.kind, screen);
    assert.deepStrictEqual(
      choices.map((c) => c.value),
      ["pro", "topup", "own-key", "gpus"],
    );
    assert.strictEqual(choices[0]!.label, "Get dl Pro: $3.99/month");
  });

  it("buys through the existing checkout and sends the blocked request again", async () => {
    const e = parseDlError(body)!;
    const screen = dlScreenFor(e.code, e, undefined, "free")!;
    let title = "";
    const bought: string[] = [];
    let polls = 0;
    const deps = {
      now: () => NOW,
      timeZone: TZ.timeZone,
      say: () => {},
      copy: () => true,
      select: async (t: string, options: Array<{ value: string }>) => {
        title = t;
        return options[0]!.value;
      },
      checkout: async (product: string) => {
        bought.push(product);
        return "https://checkout.example/pro";
      },
      openBrowser: () => true,
      wait: async () => () => {},
      sleep: async () => {},
      fetchMe: async () => me({ plan: polls++ === 0 ? "free" : "pro", trial: ENDED }),
      intervalMs: 1,
    } as unknown as DlScreenDeps;
    const outcome = await runDlScreen(screen, deps);
    assert.strictEqual(title, "You've used your 10M free trial tokens. Keep going with dl Pro or a top-up.");
    assert.deepStrictEqual(bought, ["pro"]);
    assert.strictEqual(outcome, "retry");
    assert.deepStrictEqual(dlScreenFollowUp(outcome, "line", { text: "fix it", display: "fix it" }), { kind: "retry", text: "fix it", display: "fix it" });
  });
});
