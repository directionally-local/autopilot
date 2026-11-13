import { describe, it } from "node:test";
import assert from "node:assert";
import { dlStartLine, normalizeDlMe, parseDlReferral, type DlMe } from "./directionally-local.js";

const RESETS = "2026-11-16T00:00:00.000Z";
const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";

/** A /v1/me body as the free tier service sends it today (services/free `me`). */
function me(over: Record<string, unknown> = {}): DlMe {
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 1_000_000_000, usedThisWeek: 150_000_000, remaining: 850_000_000, resetsAt: RESETS },
    pools: {
      luna: { tokensPerWeek: 1_000_000_000, usedThisWeek: 150_000_000, remaining: 850_000_000, resetsAt: RESETS, models: ["gpt-6-luna", DEEPSEEK] },
      astra: { tokensPerWeek: 3_000_000, usedThisWeek: 3_000_000, remaining: 0, resetsAt: RESETS, models: ["gpt-6-astra"] },
    },
    referral: { code: "abc", link: "https://dl.new/r/abc", joined: 2, activeThisWeek: 1, bonusTokensPerWeek: 0 },
    ...over,
  })!;
}

describe("the free tier's startup line", () => {
  it("says what's left this week for the session's model, and the invite link with the count", () => {
    assert.strictEqual(dlStartLine(me(), DEEPSEEK), "free · DeepSeek 850M left this week · invite friends: dl.new/r/abc (2 joined)");
    assert.strictEqual(dlStartLine(me(), "gpt-6-astra"), "free · GPT-6 Astra limit reached this week · invite friends: dl.new/r/abc (2 joined)");
    assert.strictEqual(dlStartLine(me({ referral: null }), DEEPSEEK), "free · DeepSeek 850M left this week");
  });

  it("promises no reward of its own; shows the service's offer wording when /v1/me sends referral.offer", () => {
    assert.doesNotMatch(dlStartLine(me(), DEEPSEEK)!, /bonus|credit|\+\d/i);
    const offered = me({ referral: { code: "abc", link: "https://dl.new/r/abc", joined: 0, offer: "you both get a week of Astra" } });
    assert.strictEqual(dlStartLine(offered, DEEPSEEK), "free · DeepSeek 850M left this week · invite friends: dl.new/r/abc (0 joined) · you both get a week of Astra");
  });

  it("reads referral.offer as one short plain line", () => {
    assert.strictEqual(parseDlReferral({ link: "l", offer: "  a\n\x1b[31mb  " })?.offer, "a [31mb");
    assert.strictEqual(parseDlReferral({ link: "l", offer: "x".repeat(81) })?.offer, undefined);
    assert.strictEqual(parseDlReferral({ link: "l", offer: 3 })?.offer, undefined);
    assert.strictEqual(parseDlReferral({ link: "l" })?.offer, undefined);
  });

  it("uses the dollar budgets when the service sends them", () => {
    const budgets = { gpt6: { usdPerWeek: 2, spentUsd: 0.4 }, deepseek: { usdPerWeek: 8, spentUsd: 1.2 } };
    assert.match(dlStartLine(me({ budgets }), DEEPSEEK)!, /^free · DeepSeek \$6\.80 left this week · /);
    assert.match(dlStartLine(me({ budgets: { ...budgets, gpt6: { usdPerWeek: 2, spentUsd: 2 } } }), "gpt-6-luna")!, /^free · GPT-6 Luna limit reached this week/);
  });

  it("shows nothing without an account read, on Pro, or in the queue", () => {
    assert.strictEqual(dlStartLine(null, DEEPSEEK), undefined);
    assert.strictEqual(dlStartLine(me({ plan: "pro" }), DEEPSEEK), undefined);
    assert.strictEqual(dlStartLine(me({ queue: { position: 4, etaAt: RESETS } }), DEEPSEEK), undefined);
  });
});
