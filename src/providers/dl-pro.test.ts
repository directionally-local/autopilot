import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  describeDlError,
  dlModelAllowanceLine,
  dlProLine,
  normalizeDlMe,
  parseDlOffers,
  renderDlUsage,
  resetDlNoticeState,
  setLastKnownDlMe,
  type DlAllowance,
  type DlMe,
} from "./directionally-local.js";
import { runUpgradeCommand, type DlCommandDeps } from "../dl-commands.js";

/**
 * dl Pro as the way on when free usage runs out: the plain one-line message, /usage and the
 * model picker showing the limit that binds (the weekly dollar cap), and dollar top-ups.
 */

const TZ = "Asia/Tokyo";
/** Tuesday 3 Nov 2026, 12:00 in Tokyo. */
const NOW = Date.parse("2026-11-03T03:00:00Z");
/** Monday 9 Nov, 09:00 in Tokyo. */
const RESETS = "2026-11-09T00:00:00Z";
const OFFERS = {
  pro: { priceUsdMonthly: 3.99, price: "$3.99/month", tokensPerWeek: 300_000_000, usdPerWeek: 10, valueLine: "About 3x the free usage every week, every model." },
  topup: { unitPriceUsd: 1, minQuantity: 2, maxQuantity: 20, usageMultiplier: 1.25, validDays: 90 },
};

function allowance(over: Partial<DlAllowance> = {}): DlAllowance {
  return { tokensPerWeek: 50_000_000, usedThisWeek: 14_000_000, remaining: 36_000_000, resetsAt: RESETS, usdPerWeek: 3, spentUsdThisWeek: 1.2, ...over };
}

function me(over: Partial<DlMe> = {}): DlMe {
  return { login: "octo", plan: "free", allowance: allowance(), offers: OFFERS, ...over };
}

describe("dl Pro when free usage runs out", () => {
  beforeEach(() => resetDlNoticeState());

  describe("the plain one-line message", () => {
    const at = { resetsAt: RESETS, now: NOW, timeZone: TZ };

    it("ends with dl Pro at the service's price when it offers Pro", () => {
      assert.strictEqual(
        describeDlError("quota_exceeded", { ...at, offers: OFFERS }),
        "You've used this week's free usage. It's back Mon 09:00. To keep going now: /provider to use your own key. Get dl Pro for $3.99/month: /upgrade",
      );
      assert.match(describeDlError("basic_limit", { ...at, offers: OFFERS })!, / Get dl Pro for \$3\.99\/month: \/upgrade$/);
      assert.match(describeDlError("starter_limit", { ...at, offers: OFFERS, where: "cli" })!, / Get dl Pro for \$3\.99\/month: `autopilot upgrade`$/);
    });

    it("leaves Pro out without offers, and on Pro says it's Pro's usage", () => {
      assert.strictEqual(describeDlError("quota_exceeded", at), "You've used this week's free usage. It's back Mon 09:00. To keep going now: /provider to use your own key.");
      setLastKnownDlMe(me({ plan: "pro" }));
      assert.strictEqual(
        describeDlError("quota_exceeded", { ...at, offers: OFFERS }),
        "You've used this week's Pro usage. It's back Mon 09:00. To keep going now: /provider to use your own key.",
      );
    });

    it("never carries the invite promise", () => {
      for (const code of ["quota_exceeded", "basic_limit", "starter_limit"]) {
        assert.doesNotMatch(describeDlError(code, { ...at, offers: OFFERS, referralLink: "https://dl.new/r/x" })!, /invite|\+10M/i);
      }
    });

    it("shows the price exactly: never $4 for $3.99", () => {
      assert.strictEqual(dlProLine({ pro: { priceUsdMonthly: 3.99 } }), "Get dl Pro for $3.99/month: /upgrade");
      assert.strictEqual(dlProLine({ pro: { priceUsdMonthly: 3.99, price: "$3.99/month" } }, { plan: "pro" }), undefined);
      assert.strictEqual(dlProLine(undefined), undefined);
    });
  });

  describe("offers from the service", () => {
    it("keeps Pro's price text, ceiling and value line, and the dollar top-up", () => {
      assert.deepStrictEqual(parseDlOffers(OFFERS), OFFERS);
      assert.deepStrictEqual(parseDlOffers({ topup: { unitPriceUsd: 1, minQuantity: 5, maxQuantity: 2, usageMultiplier: 1.25 } }), undefined, "a backwards range is dropped");
      assert.deepStrictEqual(parseDlOffers({ topup: { priceUsd: 3, tokens: 50e6, validDays: 30 } }), { topup: { priceUsd: 3, tokens: 50e6, validDays: 30 } }, "the old token kind");
    });

    it("reads the dollar top-up balance and its expiry from /v1/me", () => {
      const read = normalizeDlMe({ login: "octo", allowance: allowance(), topupUsdLeft: 6.25, topupUsdExpiresAt: "2027-02-01T00:00:00.000Z" })!;
      assert.strictEqual(read.topupUsdLeft, 6.25);
      assert.strictEqual(read.topupUsdExpiresAt, "2027-02-01T00:00:00.000Z");
    });
  });

  describe("/usage", () => {
    it("shows this week's free usage in dollars, tokens second", () => {
      assert.strictEqual(
        renderDlUsage(me(), NOW, TZ),
        [
          "Directionally Local free tier · signed in as @octo",
          "  plan            Free",
          "  this week       $1.20 of $3 free usage (40%)",
          "  tokens          14M used",
          "  resets          Mon 09:00 GMT+9 (in 5 days 21 h)",
        ].join("\n"),
      );
    });

    it("says the limit is reached when the dollar cap is spent, never \"36M of 50M left\"", () => {
      const text = renderDlUsage(me({ allowance: allowance({ spentUsdThisWeek: 9.13 }) }), NOW, TZ);
      assert.match(text, /\n {2}this week {7}limit reached, resets Mon 09:00\n/);
      assert.doesNotMatch(text, /36M|left {12}/);
      assert.match(text, /\n {2}You've used this week's free usage\. It's back Mon 09:00\. To keep going now: \/provider to use your own key\. Get dl Pro for \$3\.99\/month: \/upgrade$/);
    });

    it("shows Pro's usage against Pro's ceiling, without offering Pro", () => {
      const text = renderDlUsage(me({ plan: "pro", allowance: allowance({ usdPerWeek: 10, spentUsdThisWeek: 2.5, tokensPerWeek: 300e6 }) }), NOW, TZ);
      assert.match(text, /\n {2}this week {7}\$2\.50 of \$10 Pro usage \(25%\)\n/);
      assert.doesNotMatch(text, /Get dl Pro/);
      const spent = renderDlUsage(me({ plan: "pro", allowance: allowance({ usdPerWeek: 10, spentUsdThisWeek: 10 }) }), NOW, TZ);
      assert.match(spent, /\n {2}You've used this week's Pro usage\. It's back Mon 09:00\. To keep going now: \/provider to use your own key\.$/);
    });

    it("shows the top-up balance in dollars and when it expires", () => {
      const text = renderDlUsage(me({ topupUsdLeft: 6.25, topupUsdExpiresAt: "2027-02-01T00:00:00.000Z", allowance: allowance({ spentUsdThisWeek: 3 }) }), NOW, TZ);
      assert.match(text, /\n {2}top-up {10}\$6\.25 left · until Feb 1\n/);
      assert.doesNotMatch(text, /You've used this week's/, "the top-up keeps going");
    });
  });

  describe("the model picker", () => {
    const pools = {
      luna: { tokensPerWeek: 50_000_000, usedThisWeek: 14_000_000, remaining: 36_000_000, models: ["gpt-6-luna", "deepseek/deepseek-v4.1-flash-1017"] },
      sol: { tokensPerWeek: 10_000_000, usedThisWeek: 0, remaining: 10_000_000, models: ["gpt-6.1-sol"] },
    };

    it("shows the dollar cap, and the limit reached once it is spent", () => {
      assert.strictEqual(dlModelAllowanceLine("gpt-6-luna", me({ pools })), "this week: $1.20 of $3 free usage");
      const spent = me({ pools, allowance: allowance({ spentUsdThisWeek: 9.13 }) });
      assert.match(dlModelAllowanceLine("gpt-6-luna", spent)!, /^limit reached, resets \w{3} \d\d:\d\d$/);
      assert.match(dlModelAllowanceLine("gpt-6.1-sol", spent)!, /^limit reached/);
    });

    it("keeps tokens when the service sends no dollar cap", () => {
      assert.strictEqual(dlModelAllowanceLine("gpt-6-luna", me({ pools, allowance: allowance({ usdPerWeek: null }) })), "36M of 50M left this week");
    });
  });

  describe("`autopilot upgrade topup`", () => {
    function deps(printed: string[], answers: string[] | null, checkouts: string[]): DlCommandDeps {
      let reads = 0;
      return {
        providerId: "directionally-local",
        providerName: "Directionally Local, free",
        print: (line) => void printed.push(line),
        fetchMe: async () => (++reads > 2 ? me({ topupUsdLeft: 12.5 }) : me()),
        copy: () => false,
        checkout: async (product, quantity) => (checkouts.push(`${product}×${quantity}`), "https://pay.example/topup"),
        portal: async () => "",
        openBrowser: () => true,
        ask: answers ? async () => answers.shift() ?? "" : null,
        sleep: async () => {},
        now: () => NOW,
      };
    }

    it("asks how much, checks out that many $1 units, and says what was added", async () => {
      const printed: string[] = [];
      const checkouts: string[] = [];
      assert.strictEqual(await runUpgradeCommand("topup", deps(printed, ["3"], checkouts)), 0);
      assert.deepStrictEqual(printed.slice(0, 5), ["How much?", "  1) $2 — adds $2.50 of usage", "  2) $5 — adds $6.25 of usage", "  3) $10 — adds $12.50 of usage", "  4) $20 — adds $25 of usage"]);
      assert.deepStrictEqual(checkouts, ["topup×10"]);
      assert.strictEqual(printed.at(-1), "✓ Top-up added: $12.50 of usage to use.");
      const typed: string[] = [];
      assert.strictEqual(await runUpgradeCommand("topup", deps([], ["$7"], typed)), 0);
      assert.deepStrictEqual(typed, ["topup×7"]);
      assert.strictEqual(await runUpgradeCommand("topup", deps([], ["$25"], [])), 1, "out of range");
    });

    it("uses the smallest amount without a terminal", async () => {
      const checkouts: string[] = [];
      assert.strictEqual(await runUpgradeCommand("topup", deps([], null, checkouts)), 0);
      assert.deepStrictEqual(checkouts, ["topup×2"]);
    });
  });
});
