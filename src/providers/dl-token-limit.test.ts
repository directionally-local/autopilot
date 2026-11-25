import { beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import {
  DL_DEFAULT_MIX,
  describeDlError,
  dlBindingLimit,
  dlBudgetDetail,
  dlBudgetText,
  dlHeaderLine,
  dlLimitName,
  dlModelAllowanceLine,
  dlNamedProPrompt,
  dlTokenLimit,
  normalizeDlMe,
  renderDlUsage,
  resetDlNoticeState,
  setLastKnownDlMe,
  type DlMe,
} from "./directionally-local.js";
import { dlHeadlessLine, dlScreenFor } from "./dl-growth.js";

/**
 * A smaller free level has a weekly token limit on DeepSeek (counted tokens: cached input
 * weighted 0.02) besides its $8 DeepSeek budget. The token limit usually binds first, so /usage,
 * the header and the limit errors must show it, not "$0.22 of $8" as if most of the week were left.
 */

const NOW = Date.parse("2026-11-12T03:00:00Z"); // a Thursday
const RESETS = "2026-11-16T00:00:00.000Z"; // Mon 09:00 in Tokyo
const TZ = "Asia/Tokyo";
const MIX = { cached: 0.955, fresh: 0.038, output: 0.007, label: "95.5% caching applied", cachedTokenWeight: 0.02, countedFactor: 0.0641 };

/** /v1/me for a Starter account: GPT-6's $2 spent, DeepSeek's 1.2M counted tokens (~18.7M real) used, $0.22 of $8. */
function starter(o: { used?: number; spent?: number; real?: boolean; mix?: boolean; gpt6Spent?: number } = {}): DlMe {
  const used = o.used ?? 1_200_000;
  const pool = (tokens: number, usedTokens: number, family: string, models: string[]) => ({
    tokensPerWeek: tokens,
    usedThisWeek: usedTokens,
    remaining: Math.max(0, tokens - usedTokens),
    family,
    resetsAt: RESETS,
    models,
    ...(o.real === false ? {} : { realTokensPerWeek: Math.round(tokens / 0.0641), realUsedThisWeek: Math.round(usedTokens / 0.0641) }),
  });
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 1_200_000, usedThisWeek: 0, remaining: 1_200_000, resetsAt: RESETS, usdPerWeek: 2, spentUsdThisWeek: o.gpt6Spent ?? 2 },
    budgets: {
      gpt6: { usdPerWeek: 2, spentUsd: o.gpt6Spent ?? 2, tokensThisWeek: 3_000_000 },
      deepseek: { usdPerWeek: 8, spentUsd: o.spent ?? 0.22, tokensThisWeek: 21_400_000 },
    },
    pools: {
      luna: pool(1_200_000, 0, "gpt6", ["gpt-6-luna"]),
      sol: pool(1_200_000, 0, "gpt6", ["gpt-6.1-sol"]),
      astra: pool(1_200_000, 0, "gpt6", ["gpt-6-astra"]),
      deepseek: pool(1_200_000, used, "deepseek", ["deepseek/deepseek-v4.1-flash-1017"]),
    },
    ...(o.mix === false ? {} : { mix: MIX }),
    referral: { code: "abc", link: "https://dl.new/r/abc", joined: 1, activeThisWeek: 1, bonusTokensPerWeek: 10_000_000 },
  })!;
}

/** A Full account: DeepSeek has no token cap (null pools are left out), only its $8 budget. */
function full(): DlMe {
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 0, remaining: 50_000_000, resetsAt: RESETS, usdPerWeek: 2, spentUsdThisWeek: 0.4 },
    budgets: { gpt6: { usdPerWeek: 2, spentUsd: 0.4, tokensThisWeek: 6_000_000 }, deepseek: { usdPerWeek: 8, spentUsd: 1.2, tokensThisWeek: 58_000_000 } },
    pools: {
      luna: { tokensPerWeek: 50_000_000, usedThisWeek: 100_000, remaining: 49_900_000, family: "gpt6", models: ["gpt-6-luna"] },
      deepseek: { tokensPerWeek: null, usedThisWeek: 900_000, remaining: null, family: "deepseek", models: ["deepseek/deepseek-v4.1-flash-1017"] },
    },
    mix: MIX,
  })!;
}

beforeEach(() => resetDlNoticeState());

describe("a weekly token limit besides the dollar budget", () => {
  it("reads the pool's family, real tokens and the mix from /v1/me", () => {
    const me = starter();
    assert.strictEqual(me.pools?.deepseek?.family, "deepseek");
    assert.strictEqual(me.pools?.deepseek?.realTokensPerWeek, 18_720_749);
    assert.deepStrictEqual(me.mix, { countedFactor: 0.0641, label: "95.5% caching applied" });
    const t = dlTokenLimit(me, "deepseek")!;
    assert.deepStrictEqual(t, { limit: 1_200_000, used: 1_200_000, realLimit: 18_720_749, realUsed: 18_720_749, label: "95.5% caching applied", usedUp: true, share: 1 });
    // GPT-6's models each have their own pool: no one token limit for the family.
    assert.strictEqual(dlTokenLimit(me, "gpt6"), undefined);
    // A Full account: no DeepSeek token cap.
    assert.strictEqual(dlTokenLimit(full(), "deepseek"), undefined);
  });

  it("converts counted tokens itself on an older server (no real tokens, no mix)", () => {
    const t = dlTokenLimit(starter({ real: false, mix: false }), "deepseek")!;
    assert.ok(Math.abs(DL_DEFAULT_MIX.countedFactor - 0.0641) < 1e-12);
    assert.strictEqual(t.realLimit, 18_720_749);
    assert.strictEqual(t.label, "95.5% caching applied");
  });

  it("knows which limit binds", () => {
    const b = { usdPerWeek: 8, spentUsd: 0.22 };
    assert.strictEqual(dlBindingLimit(b, dlTokenLimit(starter(), "deepseek")), "tokens", "used up");
    assert.strictEqual(dlBindingLimit(b, dlTokenLimit(starter({ used: 600_000 }), "deepseek")), "tokens", "50% of the tokens, 3% of the dollars");
    assert.strictEqual(dlBindingLimit({ usdPerWeek: 8, spentUsd: 6 }, dlTokenLimit(starter({ used: 600_000 }), "deepseek")), "spend", "75% of the dollars");
    assert.strictEqual(dlBindingLimit({ usdPerWeek: 8, spentUsd: 8 }, dlTokenLimit(starter({ used: 600_000 }), "deepseek")), "spend", "dollars spent");
    assert.strictEqual(dlBindingLimit(b, undefined), "spend", "no token limit");
  });

  it("/usage shows the binding token limit first, the dollars second, never 97% left", () => {
    const text = renderDlUsage(starter(), NOW, TZ);
    assert.strictEqual(
      text,
      [
        "Directionally Local free tier · signed in as @octo",
        "  plan            Free",
        "  gpt-6           limit reached, resets Mon 09:00",
        "  deepseek        token limit reached: ~18.7M of ~18.7M tokens (95.5% caching applied), resets Mon 09:00",
        "                  $0.22 of $8 spending limit · 21.4M tokens processed",
        "  invite bonus    +10M a week (1 joined, 1 active this week)",
        "  resets          Mon 09:00 GMT+9 (in 3 days 21 h)",
        "  You've used this week's free usage. It's back Mon 09:00. To keep going now: /provider to use your own key.",
      ].join("\n"),
    );
    assert.doesNotMatch(text, /DeepSeek V4\.1 Flash still has free usage/, "no GPT-6 hint pointing at a used-up DeepSeek");
  });

  it("/usage before the limit: the tokens left, and the 80% line from the token share", () => {
    const text = renderDlUsage(starter({ used: 1_000_000, gpt6Spent: 0.5 }), NOW, TZ);
    assert.match(text, /^ {2}deepseek {8}~15\.6M of ~18\.7M tokens \(95\.5% caching applied\) this week$/m);
    assert.match(text, /^ {18}\$0\.22 of \$8 spending limit · 21\.4M tokens processed$/m);
    assert.match(text, /You've used 83% of this week's free usage\./);
  });

  it("/usage when the dollars bind: dollars first, the token limit second", () => {
    const text = renderDlUsage(starter({ used: 100_000, spent: 6, gpt6Spent: 0.5 }), NOW, TZ);
    assert.match(text, /^ {2}deepseek {8}\$6 of \$8 this week · 21\.4M tokens$/m);
    assert.match(text, /^ {18}token limit: ~1\.6M of ~18\.7M tokens \(95\.5% caching applied\)$/m);
    const spent = renderDlUsage(starter({ used: 100_000, spent: 8 }), NOW, TZ);
    assert.match(spent, /^ {2}deepseek {8}spending limit reached: \$8 of \$8, resets Mon 09:00$/m);
  });

  it("leaves a Full account's /usage as it was (no token limit on DeepSeek)", () => {
    const text = renderDlUsage(full(), NOW, TZ);
    assert.match(text, /^ {2}gpt-6 {11}\$0\.40 of \$2 this week · 6M tokens$/m);
    assert.match(text, /^ {2}deepseek {8}\$1\.20 of \$8 this week · 58M tokens$/m);
    assert.doesNotMatch(text, /token limit|caching applied/);
  });

  it("words the budget, its detail, the header and the model line by the binding limit", () => {
    const me = starter({ used: 1_000_000, gpt6Spent: 0.5 });
    const t = dlTokenLimit(me, "deepseek");
    assert.strictEqual(dlBudgetText({ usdPerWeek: 8, spentUsd: 0.22 }, RESETS, { now: NOW, timeZone: TZ }, t), "~15.6M of ~18.7M tokens (95.5% caching applied) this week");
    assert.strictEqual(dlBudgetDetail({ usdPerWeek: 8, spentUsd: 0.22 }, t), "$0.22 of $8 spending limit");
    assert.strictEqual(dlBudgetDetail({ usdPerWeek: 8, spentUsd: 0.22 }, undefined), undefined);
    assert.strictEqual(dlHeaderLine(me), "free · gpt-6 $1.50 left · deepseek ~3.1M left");
    assert.strictEqual(dlHeaderLine(starter()), "free · limit reached");
    setLastKnownDlMe(me);
    assert.strictEqual(dlModelAllowanceLine("deepseek/deepseek-v4.1-flash-1017"), "~15.6M of ~18.7M tokens (95.5% caching applied) this week");
  });
});

describe("the limit-reached errors name the limit", () => {
  it("names the token limit or the spending limit, from the refusal and the last account read", () => {
    setLastKnownDlMe(starter());
    assert.strictEqual(dlLimitName("tokens", "deepseek"), "token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied)");
    assert.strictEqual(dlLimitName("tokens", undefined), "token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied)", "the family /v1/me shows used up");
    assert.strictEqual(dlLimitName("spend", "gpt6"), "$2 spending limit on GPT-6");
    assert.strictEqual(dlLimitName("spend", "deepseek"), "$8 spending limit on DeepSeek V4.1 Flash");
    assert.strictEqual(dlLimitName(undefined, "deepseek"), undefined);
    setLastKnownDlMe(null);
    assert.strictEqual(dlLimitName("tokens", undefined), "token limit");
  });

  it("puts the name in dl Pro's prompt (an older server's generic one) and in the plain line", () => {
    setLastKnownDlMe(starter());
    const prompt = { text: "You've hit this week's free limit. dl Pro: $7/month for higher limits and early access to new models." };
    assert.strictEqual(
      describeDlError("starter_limit", { reason: "tokens", family: "deepseek", proPrompt: prompt, resetsAt: RESETS, now: NOW, timeZone: TZ }),
      "You've hit this week's free token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied). dl Pro: $7/month for higher limits and early access to new models. Upgrade: /upgrade",
    );
    // A prompt that names its limit already (a newer server) is shown as sent.
    const named = { text: "You've hit this week's free token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied). dl Pro: $7/month." };
    assert.deepStrictEqual(dlNamedProPrompt(named, "spending limit"), named);
    assert.strictEqual(
      describeDlError("quota_exceeded", { reason: "tokens", family: "deepseek", resetsAt: RESETS, now: NOW, timeZone: TZ }),
      "You've hit this week's free token limit on DeepSeek V4.1 Flash (~18.7M tokens, 95.5% caching applied). It's back Mon 09:00. To keep going now: /provider to use your own key.",
    );
    assert.match(dlHeadlessLine("quota_exceeded", { reason: "spend", family: "deepseek", resetsAt: RESETS }, { now: NOW, timeZone: TZ })!, /^You've hit this week's free \$8 spending limit on DeepSeek V4\.1 Flash\. It's back Mon 09:00\./);
    const screen = dlScreenFor("starter_limit", { reason: "tokens", family: "deepseek", proPrompt: prompt });
    assert.ok(screen?.kind === "quota" && screen.proPrompt?.startsWith("You've hit this week's free token limit on DeepSeek V4.1 Flash"));
  });
});
