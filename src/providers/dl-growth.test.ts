import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath } from "../config.js";
import { ApiError } from "../util/errors.js";
import {
  cleanReferralCode,
  describeDlError,
  dlBillingPortal,
  dlHeaderLine,
  dlSignedInInviteLine,
  fetchDlMe,
  quotaNoticeFromHeaders,
  dlCheckout,
  dlSignIn,
  normalizeDlMe,
  parseDlError,
  renderDlUsage,
  resetDlNoticeState,
  startDlDeviceFlow,
  type DlMe,
} from "./directionally-local.js";
import {
  DL_CHECKOUT_CANCELLED_LINE,
  DL_CHECKOUT_TIMEOUT_LINE,
  dlHeadlessMessage,
  dlInviteReport,
  dlScreenChoices,
  dlScreenFollowUp,
  dlScreenFor,
  dlUpgradeStep,
  inviteTipAfterWin,
  isTestCommand,
  noteToolForWin,
  runDlScreen,
  withWinTracking,
  won,
  type DlScreen,
  type DlScreenDeps,
  type WinTracker,
} from "./dl-growth.js";
import { runInviteCommand, runUpgradeCommand, type DlCommandDeps } from "../dl-commands.js";
import { dispatchSlashCommand, type SlashContext } from "../ui/slash-commands.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtins.js";
import { CATEGORIES } from "../ui/help-catalog.js";

const TZ = "Asia/Tokyo";
/** Tuesday 3 Nov 2026, 12:00 in Tokyo. */
const NOW = Date.parse("2026-11-03T03:00:00Z");
/** Monday 9 Nov, 09:00 in Tokyo. */
const RESETS = "2026-11-09T00:00:00Z";
const LINK = "https://dl.new/r/octo42";
const OFFERS = { pro: { priceUsdMonthly: 10, tokensPerWeek: 100_000_000 }, topup: { priceUsd: 3, tokens: 50_000_000, validDays: 30 } };
/** What a current server sends: Pro's exact price text and value line, and a dollar top-up. */
const PRO_OFFERS = {
  pro: { priceUsdMonthly: 3.99, price: "$3.99/month", tokensPerWeek: 300_000_000, usdPerWeek: 10, valueLine: "About 3x the free usage every week, every model." },
  topup: { unitPriceUsd: 1, minQuantity: 2, maxQuantity: 20, usageMultiplier: 1.25, validDays: 90 },
};

function me(over: Partial<DlMe> = {}): DlMe {
  return {
    login: "octo",
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 50_000_000, remaining: 0, resetsAt: RESETS },
    referral: { link: LINK, joined: 3, activeThisWeek: 2, bonusTokensPerWeek: 30_000_000, bonusCapPerWeek: 50_000_000 },
    offers: OFFERS,
    ...over,
  };
}

/** A screen's world: scripted answers, a fake clock and a fake /v1/me. */
function world(o: { select?: (string | null)[]; meSeq?: DlMe[]; opened?: boolean; copied?: boolean; cancelAfterPolls?: number; checkoutError?: Error } = {}) {
  let clock = NOW;
  const said: string[] = [];
  const selects: { title: string; labels: string[]; values: string[]; subtitle?: string }[] = [];
  const checkouts: string[] = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const waits: string[] = [];
  let polls = 0;
  let cancel: (() => void) | null = null;
  const seq = [...(o.meSeq ?? [])];
  const deps: DlScreenDeps = {
    select: async (title, options, subtitle) => {
      selects.push({ title, labels: options.map((x) => x.label), values: options.map((x) => x.value), ...(subtitle ? { subtitle } : {}) });
      return o.select?.shift() ?? null;
    },
    say: (m) => void said.push(m),
    copy: (t) => (copied.push(t), o.copied ?? true),
    openBrowser: (url) => (opened.push(url), o.opened ?? true),
    checkout: async (product, quantity) => {
      if (o.checkoutError) throw o.checkoutError;
      checkouts.push(quantity === undefined ? product : `${product}×${quantity}`);
      return `https://pay.example/${product}`;
    },
    fetchMe: async () => {
      polls++;
      if (o.cancelAfterPolls !== undefined && polls > o.cancelAfterPolls) cancel?.();
      return seq.length > 1 ? seq.shift()! : seq[0] ?? me();
    },
    wait: async (text, c) => {
      waits.push(text);
      cancel = c;
      return () => void waits.push("(ended)");
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    timeZone: TZ,
  };
  return { deps, said, selects, checkouts, opened, copied, waits, polls: () => polls };
}

const quota: DlScreen = { kind: "quota", resetsAt: RESETS, offers: PRO_OFFERS, referralLink: LINK };

describe("free tier growth", () => {
  beforeEach(() => resetDlNoticeState());

  describe("limit screen (quota_exceeded)", () => {
    it("reads offers, the invite link and the reset from the 402 body (camelCase and snake_case)", () => {
      const parsed = parseDlError({
        error: { code: "quota_exceeded", resetsAt: RESETS, referralLink: LINK, offers: { pro: { priceUsdMonthly: 10, tokensPerWeek: 100e6 }, topup: { price_usd: 3, tokens: 50e6, valid_days: 30 } } },
      });
      assert.deepStrictEqual(parsed, { code: "quota_exceeded", resetsAt: RESETS, referralLink: LINK, offers: OFFERS });
      // Incomplete offers are dropped rather than shown with a blank price.
      assert.strictEqual(parseDlError({ error: { code: "quota_exceeded", offers: { pro: { tokensPerWeek: 10 } } } })?.offers, undefined);
      // A current server's offers: the exact price text, the value line and a dollar top-up.
      assert.deepStrictEqual(parseDlError({ error: { code: "quota_exceeded", offers: PRO_OFFERS } })?.offers, PRO_OFFERS);
    });

    it("puts dl Pro first and default, then a top-up, more free usage, your own key and your own GPUs", async () => {
      const w = world({ select: [null] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "dismissed");
      assert.deepStrictEqual(w.selects[0], {
        title: "You've used this week's free usage. It's back Mon 09:00.",
        labels: ["Get dl Pro: $3.99/month", "Top up from $2", "Ask for more free usage", "Use your own key", "Run it on your own GPUs"],
        values: ["pro", "topup", "request", "own-key", "gpus"],
        subtitle: "Enter to choose · Esc to close",
      });
      const choices = dlScreenChoices("quota", { offers: PRO_OFFERS });
      assert.strictEqual(choices[0]!.description, "About 3x the free usage every week, every model.", "the value line from the service");
      assert.strictEqual(choices[1]!.description, "each $1 adds $1.25 of usage, lasts 90 days");
      assert.deepStrictEqual(choices.slice(2).map((c) => c.description), ["/request", "/provider", "dl model up"]);
    });

    it("shows the price exactly as the service sends it, never rounded", () => {
      const label = (pro: Record<string, unknown>) => dlScreenChoices("quota", { offers: { pro: pro as never } })[0]!.label;
      assert.strictEqual(label({ priceUsdMonthly: 3.99, price: "$3.99/month" }), "Get dl Pro: $3.99/month");
      assert.strictEqual(label({ priceUsdMonthly: 3.99 }), "Get dl Pro: $3.99/month", "an older server without the text: still not $4");
      assert.strictEqual(label({ priceUsdMonthly: 12.5, tokensPerWeek: 80e6 }), "Get dl Pro: $12.50/month");
    });

    it("leaves Pro out without offers (older server) or when already on Pro, and the top-up out unless it is the dollar kind", () => {
      assert.deepStrictEqual(dlScreenChoices("quota", { referralLink: LINK }).map((c) => c.value), ["request", "own-key", "gpus"]);
      assert.deepStrictEqual(dlScreenChoices("quota", {}).map((c) => c.value), ["request", "own-key", "gpus"]);
      assert.deepStrictEqual(dlScreenChoices("quota", { offers: PRO_OFFERS, plan: "pro" }).map((c) => c.value), ["topup", "own-key", "gpus"]);
      assert.deepStrictEqual(dlScreenChoices("quota", { offers: OFFERS }).map((c) => c.value), ["pro", "request", "own-key", "gpus"], "an old token top-up stays in /upgrade");
      assert.ok(!dlScreenChoices("quota", { offers: PRO_OFFERS, referralLink: LINK }).some((c) => /invite|\+10M/i.test(c.label)), "no invite promise here");
    });

    it("asks for more free usage through /request, and points to `dl model up`", async () => {
      assert.strictEqual(await runDlScreen(quota, world({ select: ["request"] }).deps), "request");
      assert.deepStrictEqual(dlScreenFollowUp("request", "x", null), { kind: "command", command: "/request" });
      const gpus = world({ select: ["gpus"] });
      assert.strictEqual(await runDlScreen(quota, gpus.deps), "handled");
      assert.deepStrictEqual(gpus.said, ["Run it on your own GPUs: `dl model up` serves an open model on this machine's Nvidia GPU and points Autopilot at it."]);
    });

    it("the queue's invite copies the link (OSC 52) and shows it", async () => {
      const queued: DlScreen = { kind: "queued", position: 3, offers: PRO_OFFERS, referralLink: LINK };
      const w = world({ select: ["invite"] });
      assert.strictEqual(await runDlScreen(queued, w.deps), "handled");
      assert.deepStrictEqual(w.copied, [LINK]);
      assert.deepStrictEqual(w.said, [`Your invite link (copied): ${LINK} — each friend who starts using dl moves you up the line.`]);
      const plain = world({ select: ["invite"], copied: false });
      await runDlScreen(queued, plain.deps);
      assert.strictEqual(plain.said[0], `Your invite link: ${LINK} — each friend who starts using dl moves you up the line.`);
    });

    it("Pro: checkout, browser, then polls /v1/me until Pro shows, and retries", async () => {
      const w = world({ select: ["pro"], meSeq: [me(), me(), me(), me({ plan: "pro" })] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "retry");
      assert.deepStrictEqual(w.checkouts, ["pro"]);
      assert.deepStrictEqual(w.opened, ["https://pay.example/pro"]);
      assert.deepStrictEqual(w.waits, ["Opened your browser at https://pay.example/pro to start Pro.\nWaiting for the payment (up to 10 minutes)… Esc to cancel", "(ended)"]);
      assert.deepStrictEqual(w.said, ["✓ Pro active. Continuing."]);
      assert.strictEqual(w.polls(), 4, "one read before the checkout, then one every 5 s");
    });

    it("prints the payment link when no browser can open (same detection as sign-in)", async () => {
      const w = world({ select: ["pro"], opened: false, meSeq: [me(), me({ plan: "pro" })] });
      await runDlScreen(quota, w.deps);
      assert.match(w.waits[0]!, /^Open https:\/\/pay\.example\/pro in a browser on any device to start Pro\./);
    });

    it("top-up: picks an amount, checks out that many $1 units, done once more top-up usage shows", async () => {
      const w = world({ select: ["topup", "5"], meSeq: [me({ topupUsdLeft: 0 }), me({ topupUsdLeft: 0 }), me({ topupUsdLeft: 6.25 })] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "retry");
      assert.deepStrictEqual(w.selects[1], {
        title: "How much do you want to top up?",
        labels: ["$2 — adds $2.50 of usage", "$5 — adds $6.25 of usage", "$10 — adds $12.50 of usage", "$20 — adds $25 of usage"],
        values: ["2", "5", "10", "20"],
        subtitle: "each $1 adds $1.25 of usage, lasts 90 days · Enter to choose · Esc to close",
      });
      assert.deepStrictEqual(w.checkouts, ["topup×5"]);
      assert.deepStrictEqual(w.said, ["✓ Top-up added: $6.25 of usage to use. Continuing."]);
      // Esc on the amount buys nothing.
      const esc = world({ select: ["topup", null] });
      assert.strictEqual(await runDlScreen(quota, esc.deps), "dismissed");
      assert.deepStrictEqual(esc.checkouts, []);
    });

    it("top-up: another amount from 2 to 20 dollars, typed", async () => {
      const typed: string[] = [];
      const w = world({ select: ["topup", "custom"], meSeq: [me(), me({ topupUsdLeft: 8.75 })] });
      w.deps.input = async (title) => (typed.push(title), "$7");
      assert.strictEqual(await runDlScreen(quota, w.deps), "retry");
      assert.strictEqual(w.selects[1]!.labels.at(-1), "Another amount ($2–$20)");
      assert.deepStrictEqual(typed, ["Amount in dollars, $2 to $20"]);
      assert.deepStrictEqual(w.checkouts, ["topup×7"]);
      for (const bad of ["1", "21", "2.5", "lots"]) {
        const b = world({ select: ["topup", "custom"] });
        b.deps.input = async () => bad;
        assert.strictEqual(await runDlScreen(quota, b.deps), "dismissed", bad);
        assert.deepStrictEqual(b.checkouts, []);
        assert.deepStrictEqual(b.said, ["Choose a whole-dollar amount from $2 to $20."]);
      }
    });

    it("an old token top-up offer still checks out once, without an amount", async () => {
      const w = world({ select: ["topup"], meSeq: [me({ topupTokensLeft: 0 }), me({ topupTokensLeft: 0 }), me({ topupTokensLeft: 50e6 })] });
      assert.strictEqual(await runDlScreen({ kind: "upgrade", offers: OFFERS }, w.deps), "handled");
      assert.deepStrictEqual(w.checkouts, ["topup"]);
      assert.deepStrictEqual(w.said, ["✓ Top-up added: 50M tokens to use."]);
    });

    it("stops after 10 minutes without the payment, and on Esc", async () => {
      const w = world({ select: ["pro"] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "handled");
      assert.deepStrictEqual(w.said, [DL_CHECKOUT_TIMEOUT_LINE]);
      assert.strictEqual(w.polls(), 1 + 120, "every 5 s for 10 minutes");
      const esc = world({ select: ["pro"], cancelAfterPolls: 3 });
      assert.strictEqual(await runDlScreen(quota, esc.deps), "handled");
      assert.deepStrictEqual(esc.said, [DL_CHECKOUT_CANCELLED_LINE]);
      assert.ok(esc.polls() < 10);
    });

    it("says why when the checkout can't start", async () => {
      const w = world({ select: ["pro"], checkoutError: new Error("Paid plans aren't available from this Directionally Local server yet.") });
      assert.strictEqual(await runDlScreen(quota, w.deps), "handled");
      assert.deepStrictEqual(w.said, ["Paid plans aren't available from this Directionally Local server yet."]);
    });

    it("own key opens the provider picker; Esc keeps the usual line", async () => {
      assert.strictEqual(await runDlScreen(quota, world({ select: ["own-key"] }).deps), "own-key");
      assert.strictEqual(await runDlScreen(quota, world({ select: [null] }).deps), "dismissed");
      assert.match(describeDlError("quota_exceeded", { resetsAt: RESETS, timeZone: TZ, now: NOW })!, /^You've used this week's free usage\. It's back Mon 09:00\. To keep going now: \/provider/);
    });

    it("builds the screen from the error, with the last known link when the error has none", () => {
      assert.deepStrictEqual(dlScreenFor("quota_exceeded", { resetsAt: RESETS }, LINK), { kind: "quota", resetsAt: RESETS, referralLink: LINK });
      assert.deepStrictEqual(dlScreenFor("quota_exceeded", { resetsAt: RESETS }, undefined, "pro"), { kind: "quota", resetsAt: RESETS, plan: "pro" });
      assert.strictEqual(dlScreenFor("rate_limited", {}), undefined);
    });

    it("after the screen: Esc shows the usual line, own key opens the picker, a purchase retries the prompt", () => {
      const prompt = { text: "fix the tests", display: "fix the tests" };
      assert.deepStrictEqual(dlScreenFollowUp("dismissed", "You've used this week's free tokens. …", prompt), { kind: "show-error", text: "You've used this week's free tokens. …" });
      assert.deepStrictEqual(dlScreenFollowUp("own-key", "x", prompt), { kind: "provider-picker" });
      assert.deepStrictEqual(dlScreenFollowUp("retry", "x", prompt), { kind: "retry", text: "fix the tests", display: "fix the tests" });
      assert.deepStrictEqual(dlScreenFollowUp("handled", "x", prompt), { kind: "none" });
      assert.deepStrictEqual(dlScreenFollowUp("retry", "x", null), { kind: "none" });
    });

    it("headless: one plain line ending with dl Pro when the service offers it", () => {
      const err = new ApiError("autopilot: …", undefined, 402);
      err.providerCode = "quota_exceeded";
      err.providerDetail = { resetsAt: RESETS, referralLink: LINK, offers: PRO_OFFERS };
      assert.strictEqual(
        dlHeadlessMessage(err, { now: NOW, timeZone: TZ }),
        "You've used this week's free usage. It's back Mon 09:00. To keep going now, use your own key: `autopilot connect`. Get dl Pro for $3.99/month: `autopilot upgrade`",
      );
      assert.strictEqual(
        dlHeadlessMessage(err, { now: NOW, timeZone: TZ, plan: "pro" }),
        "You've used this week's Pro usage. It's back Mon 09:00. To keep going now, use your own key: `autopilot connect`.",
        "already on Pro",
      );
      err.providerDetail = { resetsAt: RESETS, referralLink: LINK };
      assert.doesNotMatch(dlHeadlessMessage(err, { now: NOW, timeZone: TZ })!, /\n|Invite|\+10M|Pro/, "no offers: no Pro, and never the invite promise");
      const other = new ApiError("x", undefined, 500);
      assert.strictEqual(dlHeadlessMessage(other), undefined);
    });
  });

  describe("queue screen (free_tier_queued)", () => {
    const etaAt = "2026-11-06T03:00:00Z"; // Friday, three days on
    it("reads the place in line and says when, with the link and the ways on", async () => {
      const d = parseDlError({ error: { code: "free_tier_queued", position: 214, etaAt, offers: OFFERS, referralLink: LINK } })!;
      const { code, ...detail } = d;
      const screen = dlScreenFor(code, detail)!;
      const w = world({ select: [null] });
      assert.strictEqual(await runDlScreen(screen, w.deps), "dismissed");
      assert.deepStrictEqual(w.selects[0], {
        title: "You're #214 in line for free tokens (about 3 days, by Fri). Each friend who starts using dl moves you up.",
        labels: ["Invite a friend (moves you up the line)", "Get dl Pro: $10/month", "Use my own API key now"],
        values: ["invite", "pro", "own-key"],
        subtitle: `Your invite link: ${LINK} · Enter to choose · Esc to close`,
      });
    });

    it("has a session line, and a headless one", () => {
      assert.strictEqual(
        describeDlError("free_tier_queued", { position: 214, etaAt, now: NOW, timeZone: TZ }),
        "You're #214 in line for free tokens (about 3 days, by Fri). /invite moves you up; /provider uses your own key now.",
      );
      const err = new ApiError("x", undefined, 402);
      err.providerCode = "free_tier_queued";
      err.providerDetail = { position: 214, etaAt, referralLink: LINK };
      assert.strictEqual(
        dlHeadlessMessage(err, { now: NOW, timeZone: TZ }),
        `You're #214 in line for free tokens (about 3 days, by Fri). Each friend who starts using dl moves you up: ${LINK}. Start now: \`autopilot upgrade\`, or your own key: \`autopilot connect\`.`,
      );
    });

    it("Pro from the queue retries the request once Pro shows", async () => {
      const w = world({ select: ["pro"], meSeq: [me(), me({ plan: "pro" })] });
      assert.strictEqual(await runDlScreen({ kind: "queued", position: 3, offers: OFFERS, referralLink: LINK }, w.deps), "retry");
    });
  });

  describe("/invite", () => {
    const report = (o: { providerId?: string; me?: DlMe; copied?: boolean; where?: "cli" }) =>
      dlInviteReport({
        providerId: o.providerId ?? "directionally-local",
        providerName: o.providerId === "openrouter" ? "OpenRouter" : "Directionally Local, free",
        fetchMe: async () => o.me ?? me(),
        copy: () => o.copied ?? true,
        ...(o.where ? { where: o.where } : {}),
      });

    it("shows the link (copied), who joined, active this week, and the bonus", async () => {
      assert.strictEqual(
        await report({}),
        [
          `Your invite link (copied): ${LINK}`,
          "  joined            3",
          "  active this week  2",
          "  bonus             +30M a week of +50M",
          "Each friend who starts using dl gives you both +10M a week.",
        ].join("\n"),
      );
      assert.match(await report({ copied: false }), /^Your invite link: https:\/\/dl\.new\/r\/octo42\n/);
    });

    it("explains off the free tier, on Pro, and on an older server", async () => {
      assert.strictEqual(await report({ providerId: "openrouter" }), "/invite is for the Directionally Local free tier; you're on OpenRouter. /provider switches to it.");
      assert.strictEqual(await report({ me: me({ plan: "pro" }) }), "You're on Pro, so invites don't add tokens. /upgrade manages your plan.");
      assert.strictEqual(await report({ me: me({ referral: undefined }) }), "Invites aren't available from this Directionally Local server yet.");
      assert.match(await report({ providerId: "openrouter", where: "cli" }), /^`autopilot invite` is for .*`autopilot auth directionally-local` switches to it\.$/);
    });

    it("`autopilot invite` prints the same", async () => {
      const printed: string[] = [];
      const code = await runInviteCommand({ ...cliDeps(printed), copy: () => false });
      assert.strictEqual(code, 0);
      assert.match(printed[0]!, /^Your invite link: https:\/\/dl\.new\/r\/octo42\n {2}joined {12}3/);
    });
  });

  describe("/upgrade", () => {
    it("on Pro opens the billing portal to manage or cancel", async () => {
      const opened: string[] = [];
      const step = await dlUpgradeStep({
        providerId: "directionally-local",
        providerName: "Directionally Local, free",
        fetchMe: async () => me({ plan: "pro" }),
        portal: async () => "https://billing.example/portal",
        openBrowser: (u) => (opened.push(u), true),
      });
      assert.deepStrictEqual(step, { kind: "text", text: "Manage or cancel your plan: opened https://billing.example/portal in your browser." });
      assert.deepStrictEqual(opened, ["https://billing.example/portal"]);
    });

    it("on the free tier opens the Pro and top-up choice; explains without offers or off dl", async () => {
      const base = { providerName: "Directionally Local, free", portal: async () => "", openBrowser: () => true };
      const step = await dlUpgradeStep({ ...base, providerId: "directionally-local", fetchMe: async () => me() });
      assert.strictEqual(step.kind, "screen");
      const w = world({ select: [null] });
      await runDlScreen((step as { screen: DlScreen }).screen, w.deps);
      assert.deepStrictEqual(w.selects[0]!.labels, ["dl Pro: $10/month", "Top up 50M tokens — $3, one time"]);
      const current = await dlUpgradeStep({ ...base, providerId: "directionally-local", fetchMe: async () => me({ offers: PRO_OFFERS }) });
      const w2 = world({ select: [null] });
      await runDlScreen((current as { screen: DlScreen }).screen, w2.deps);
      assert.deepStrictEqual(w2.selects[0]!.labels, ["dl Pro: $3.99/month", "Top up from $2"]);
      assert.strictEqual(w.selects[0]!.title, "Upgrade Directionally Local");
      assert.deepStrictEqual(await dlUpgradeStep({ ...base, providerId: "directionally-local", fetchMe: async () => me({ offers: undefined }) }), {
        kind: "text",
        text: "Pro and top-ups aren't available from this Directionally Local server yet.",
      });
      const off = await dlUpgradeStep({ ...base, providerId: "openrouter", providerName: "OpenRouter", fetchMe: async () => me() });
      assert.strictEqual(off.kind === "text" && off.text, "/upgrade is for Directionally Local; you're on OpenRouter, billed by that provider. /provider switches to it.");
    });

    it("buying from /upgrade doesn't retry anything", async () => {
      const w = world({ select: ["pro"], meSeq: [me(), me({ plan: "pro" })] });
      assert.strictEqual(await runDlScreen({ kind: "upgrade", offers: OFFERS }, w.deps), "handled");
      assert.deepStrictEqual(w.said, ["✓ Pro active."]);
    });

    it("`autopilot upgrade pro` checks out and waits; asks when no product is named", async () => {
      const printed: string[] = [];
      let n = 0;
      const deps = { ...cliDeps(printed), fetchMe: async () => (++n > 2 ? me({ plan: "pro" as const }) : me()) };
      assert.strictEqual(await runUpgradeCommand("pro", deps), 0);
      assert.deepStrictEqual(printed, [
        "Opened your browser at https://pay.example/pro to start Pro.\nWaiting for the payment (up to 10 minutes)… Ctrl+C to stop",
        "✓ Pro active.",
      ]);
      const asked: string[] = [];
      const printed2: string[] = [];
      let m = 0;
      const code = await runUpgradeCommand(undefined, {
        ...cliDeps(printed2),
        fetchMe: async () => (++m > 2 ? me({ topupTokensLeft: 50e6 }) : me()),
        ask: async (q) => (asked.push(q), "2"),
      });
      assert.strictEqual(code, 0);
      assert.deepStrictEqual(printed2.slice(0, 3), ["Upgrade Directionally Local", "  1) dl Pro: $10/month", "  2) Top up 50M tokens — $3, one time (lasts 30 days)"]);
      assert.deepStrictEqual(asked, ["Choose 1-2 (Enter to cancel): "]);
      assert.strictEqual(printed2.at(-1), "✓ Top-up added: 50M tokens to use.");
      const printed3: string[] = [];
      assert.strictEqual(await runUpgradeCommand("gold", cliDeps(printed3)), 1);
      assert.deepStrictEqual(printed3, ["Choose one of: pro, topup."]);
    });
  });

  describe("visible invites on the free tier", () => {
    const free = (over: Partial<DlMe> = {}) => me({ plan: "free", allowance: { tokensPerWeek: 50e6, usedThisWeek: 100_000, remaining: 49_900_000, resetsAt: RESETS }, ...over });
    const maxed = { link: LINK, joined: 6, activeThisWeek: 5, bonusTokensPerWeek: 50_000_000, bonusCapPerWeek: 50_000_000 };

    it("shows the invite link under the sign-in line, without promising tokens", () => {
      assert.strictEqual(dlSignedInInviteLine(free()), `Your invite link: ${LINK} (/invite)`);
      assert.strictEqual(dlSignedInInviteLine(free(), "cli"), `Your invite link: ${LINK} (\`autopilot invite\`)`);
      assert.strictEqual(dlSignedInInviteLine(free({ plan: "pro" })), undefined, "not on Pro");
      assert.strictEqual(dlSignedInInviteLine(free({ referral: undefined })), undefined, "not without a link");
      assert.strictEqual(dlSignedInInviteLine(free({ referral: maxed })), undefined, "not once the bonus is maxed");
      assert.strictEqual(dlSignedInInviteLine(null), undefined);
    });

    it("shows what's left in the header, in dollars when the week has a dollar cap", () => {
      assert.strictEqual(dlHeaderLine(free()), "free · 49.9M left");
      assert.strictEqual(dlHeaderLine(free({ allowance: { tokensPerWeek: 50e6, usedThisWeek: 1e6, remaining: 49e6, resetsAt: RESETS, usdPerWeek: 3, spentUsdThisWeek: 1.2 } })), "free · $1.80 of $3 left");
      assert.strictEqual(dlHeaderLine(free({ allowance: { tokensPerWeek: 50e6, usedThisWeek: 14e6, remaining: 36e6, resetsAt: RESETS, usdPerWeek: 3, spentUsdThisWeek: 9.13 } })), "free · limit reached");
      assert.strictEqual(dlHeaderLine(free({ plan: "pro" })), undefined);
      assert.strictEqual(dlHeaderLine(free({ queue: { position: 3 } })), undefined);
      assert.strictEqual(dlHeaderLine(null), undefined);
    });

    it("never ends /usage with the invite promise", () => {
      for (const account of [free(), free({ referral: maxed }), free({ plan: "pro" })]) assert.doesNotMatch(renderDlUsage(account, NOW, TZ), /Get more|\+10M a week\)/);
    });

    it("never adds the invite promise to the 80% notice; offers dl Pro once the account is known", async () => {
      resetDlNoticeState();
      const h = (resets: string) => new Headers({ "x-dl-tokens-remaining": "9000000", "x-dl-quota-resets-at": resets });
      assert.doesNotMatch(quotaNoticeFromHeaders(h("2026-11-09T00:00:00.000Z"), { now: NOW, timeZone: TZ })!, /Invite|Pro/, "unknown account");
      const read = (body: DlMe) => fetchDlMe({ token: "t", fetchImpl: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });
      await read(free({ offers: PRO_OFFERS }));
      assert.match(
        quotaNoticeFromHeaders(h("2026-11-16T00:00:00.000Z"), { now: NOW, timeZone: TZ })!,
        /^You've used 82% of this week's free Directionally Local tokens \(9M left, resets .+\); \/usage has details\. Get dl Pro for \$3\.99\/month: \/upgrade$/,
      );
      await read(free({ plan: "pro", offers: PRO_OFFERS }));
      assert.doesNotMatch(quotaNoticeFromHeaders(h("2026-11-23T00:00:00.000Z"), { now: NOW, timeZone: TZ })!, /Invite|Get dl Pro/, "not on Pro");
      resetDlNoticeState();
    });
  });

  describe("/usage", () => {
    it("shows the plan, top-up left, invite bonus and queue position", () => {
      const text = renderDlUsage(me({ plan: "free", topupTokensLeft: 12_000_000, allowance: { tokensPerWeek: 50e6, usedThisWeek: 10e6, remaining: 40e6, resetsAt: RESETS } }), NOW, TZ);
      assert.match(text, /^Directionally Local free tier · signed in as @octo\n {2}plan {12}Free\n/);
      assert.match(text, /\n {2}top-up left {5}12M tokens\n/);
      assert.match(text, /\n {2}invite bonus {4}\+30M a week of \+50M \(3 joined, 2 active this week\)\n/);
      const pro = renderDlUsage(me({ plan: "pro", referral: undefined, allowance: { tokensPerWeek: 100e6, usedThisWeek: 1e6, remaining: 99e6, resetsAt: RESETS } }), NOW, TZ);
      assert.match(pro, /^Directionally Local Pro · signed in as @octo\n {2}plan {12}Pro\n/);
      assert.doesNotMatch(pro, /spending limit/);
      const queued = normalizeDlMe({ login: "octo", queue: { position: 214, etaAt: "2026-11-06T03:00:00Z" } })!;
      assert.strictEqual(renderDlUsage(queued, NOW, TZ), [
        "Directionally Local free tier · signed in as @octo",
        "  plan            Free",
        "  queue           #214 in line for free tokens (about 3 days, by Fri)",
      ].join("\n"));
    });

    it("reads an older /v1/me (no plan, offers, referral or queue) as before", () => {
      const old = normalizeDlMe({ login: "octo", allowance: { tokensPerWeek: 50e6, usedThisWeek: 0, remaining: 50e6, resetsAt: RESETS } })!;
      assert.strictEqual(old.plan, undefined);
      assert.strictEqual(old.offers, undefined);
      assert.strictEqual(old.referral, undefined);
      assert.strictEqual(old.queue, undefined);
      assert.strictEqual(normalizeDlMe({ login: "x" }), null);
      assert.strictEqual(normalizeDlMe({ login: "x", queue: null, allowance: { remaining: 1, tokensPerWeek: 1, usedThisWeek: 0, resetsAt: "" }, plan: "gold" })!.plan, undefined);
    });
  });

  describe("after a win, once", () => {
    it("counts an opened PR or a passing test run", () => {
      const t: WinTracker = { prOpened: false };
      noteToolForWin(t, "bash", JSON.stringify({ command: "npm test" }), true, "exit=1\n--- stdout ---\nfail");
      assert.strictEqual(won(t), false);
      noteToolForWin(t, "bash", JSON.stringify({ command: "cd app && npm test" }), true, "exit=0\n--- stdout ---\nok");
      assert.strictEqual(won(t), true);
      const pr: WinTracker = { prOpened: false };
      noteToolForWin(pr, "bash", JSON.stringify({ command: "gh pr create --fill" }), true, "exit=0\n--- stdout ---\nhttps://github.com/o/r/pull/7");
      assert.strictEqual(pr.prOpened, true);
      const tool: WinTracker = { prOpened: false };
      noteToolForWin(tool, "github_create_pr", "{}", true, "Created PR #7: x\nURL: https://github.com/o/r/pull/7");
      assert.strictEqual(tool.prOpened, true);
      for (const cmd of ["pytest -q", "cargo test", "go test ./...", "npx vitest run", "pnpm run test", "python -m pytest"]) assert.ok(isTestCommand(cmd), cmd);
      for (const cmd of ["npm install", "echo test", "cat test.txt", "git commit -m 'add test'"]) assert.ok(!isTestCommand(cmd), cmd);
    });

    it("tracks through the turn's callbacks", () => {
      const t: WinTracker = { prOpened: false };
      const seen: string[] = [];
      const cb = withWinTracking({ onToolResult: (r: { name: string }) => void seen.push(r.name) } as never, t);
      cb.onToolCallFinalized?.({ id: "1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "go test ./..." }) } } as never);
      cb.onToolResult?.({ tool_call_id: "1", name: "bash", ok: true, content: "exit=0\nok" });
      assert.strictEqual(t.testsPassed, true);
      assert.deepStrictEqual(seen, ["bash"]);
    });

    it("shows the line once per person, only on the free tier with the setting on", async () => {
      const dir = await mkdtemp(join(tmpdir(), "dl-tip-"));
      const statePath = join(dir, "state", "dl-invite-tip.json");
      const fetchMe = async () => me();
      assert.strictEqual(await inviteTipAfterWin({ providerId: "openrouter", enabled: true, fetchMe, statePath }), undefined);
      assert.strictEqual(await inviteTipAfterWin({ providerId: "directionally-local", enabled: false, fetchMe, statePath }), undefined);
      assert.strictEqual(await inviteTipAfterWin({ providerId: "directionally-local", enabled: true, fetchMe: async () => me({ plan: "pro" }), statePath }), undefined);
      assert.strictEqual(await inviteTipAfterWin({ providerId: "directionally-local", enabled: true, fetchMe: async () => me({ referral: undefined }), statePath }), undefined);
      assert.strictEqual(
        await inviteTipAfterWin({ providerId: "directionally-local", enabled: true, fetchMe, statePath }),
        `Nice. Know someone who'd like this? Share your invite link: ${LINK}`,
      );
      assert.match(await readFile(statePath, "utf8"), /shownAt/);
      assert.strictEqual(await inviteTipAfterWin({ providerId: "directionally-local", enabled: true, fetchMe, statePath }), undefined, "never again");
    });
  });

  describe("referral at sign-in", () => {
    function fakeService(o: { rejectReferral?: boolean } = {}) {
      const calls: { path: string; body: string }[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        const body = String(init?.body ?? "");
        calls.push({ path, body });
        const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
        if (path === "/v1/device/code") {
          if (o.rejectReferral && body.includes("referral_code")) return json(400, { error: { code: "invalid_referral", message: "Unknown code" } });
          return json(200, { device_code: "d", user_code: "U-1", verification_uri: "https://x/device", interval: 1, expires_in: 60 });
        }
        if (path === "/v1/device/token") return json(200, { access_token: "a", refresh_token: "r", expires_in: 3600 });
        return json(404, {});
      }) as typeof fetch;
      return { calls, fetchImpl };
    }
    const env = { AUTOPILOT_DL_FREE_URL: "https://free.test" } as NodeJS.ProcessEnv;

    it("sends referral_code with the device-code request, and nothing without one", async () => {
      const s = fakeService();
      await startDlDeviceFlow({ fetchImpl: s.fetchImpl, env, referralCode: "octo42" });
      await startDlDeviceFlow({ fetchImpl: s.fetchImpl, env });
      assert.deepStrictEqual(s.calls.map((c) => c.body), [JSON.stringify({ referral_code: "octo42" }), "{}"]);
    });

    it("signs in without the code when the server refuses it", async () => {
      const s = fakeService({ rejectReferral: true });
      const code = await startDlDeviceFlow({ fetchImpl: s.fetchImpl, env, referralCode: "nope" });
      assert.strictEqual(code.userCode, "U-1");
      assert.deepStrictEqual(s.calls.map((c) => c.body), [JSON.stringify({ referral_code: "nope" }), "{}"]);
    });

    it("takes --referral, then DL_REFERRAL, then the config's pending referral, and clears the config one once signed in", async () => {
      const sleep = async () => {};
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath(), JSON.stringify({ pendingReferral: "fromconfig", model: "m" }));
      const viaConfig = fakeService();
      await dlSignIn(() => {}, { fetchImpl: viaConfig.fetchImpl, env, sleep });
      assert.strictEqual(viaConfig.calls[0]!.body, JSON.stringify({ referral_code: "fromconfig" }));
      const saved = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
      assert.strictEqual(saved.pendingReferral, undefined, "cleared once signed in");
      assert.strictEqual(saved.model, "m", "the rest of the config is kept");

      const viaEnv = fakeService();
      await dlSignIn(() => {}, { fetchImpl: viaEnv.fetchImpl, env: { ...env, DL_REFERRAL: "https://dl.new/r/fromenv" }, sleep });
      assert.strictEqual(viaEnv.calls[0]!.body, JSON.stringify({ referral_code: "fromenv" }));

      const viaFlag = fakeService();
      await dlSignIn(() => {}, { fetchImpl: viaFlag.fetchImpl, env: { ...env, DL_REFERRAL: "fromenv" }, sleep, referralCode: "fromflag" });
      assert.strictEqual(viaFlag.calls[0]!.body, JSON.stringify({ referral_code: "fromflag" }));
    });

    it("accepts a code or a dl.new/r/<code> link, nothing else", () => {
      assert.strictEqual(cleanReferralCode(" octo_42 "), "octo_42");
      assert.strictEqual(cleanReferralCode("https://dl.new/r/abc-1/"), "abc-1");
      assert.strictEqual(cleanReferralCode("rm -rf /"), undefined);
      assert.strictEqual(cleanReferralCode(""), undefined);
    });
  });

  describe("billing calls", () => {
    it("POSTs checkout and portal with the access token and returns the link", async () => {
      const calls: { path: string; auth: string | null; body: string }[] = [];
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        calls.push({ path, auth: new Headers(init?.headers).get("authorization"), body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ url: `https://pay.example${path}` }), { status: 200 });
      }) as typeof fetch;
      const env = { AUTOPILOT_DL_FREE_URL: "https://free.test", AUTOPILOT_DL_FREE_TOKEN: "tok" } as NodeJS.ProcessEnv;
      assert.strictEqual(await dlCheckout("topup", { fetchImpl, env }), "https://pay.example/v1/billing/checkout");
      assert.strictEqual(await dlBillingPortal({ fetchImpl, env }), "https://pay.example/v1/billing/portal");
      assert.deepStrictEqual(calls, [
        { path: "/v1/billing/checkout", auth: "Bearer tok", body: JSON.stringify({ product: "topup" }) },
        { path: "/v1/billing/portal", auth: "Bearer tok", body: "{}" },
      ]);
    });

    it("says paid plans aren't there yet on an older server (404)", async () => {
      const fetchImpl = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
      const env = { AUTOPILOT_DL_FREE_URL: "https://free.test", AUTOPILOT_DL_FREE_TOKEN: "tok" } as NodeJS.ProcessEnv;
      await assert.rejects(dlCheckout("pro", { fetchImpl, env }), /Paid plans aren't available from this Directionally Local server yet\./);
    });
  });
});

describe("free tier slash commands", () => {
  /** A session on the free tier whose /v1/me is `body`, through a fake fetch. */
  async function session(body: unknown, cfgOver: Record<string, unknown> = {}) {
    const infos: string[] = [];
    const screens: unknown[] = [];
    let cfg: Record<string, unknown> = { provider: "directionally-local", model: "deepseek/deepseek-v4.1-flash-1017", ...cfgOver };
    const ctx = {
      get cfg() {
        return cfg;
      },
      busy: false,
      mkKey: () => "k",
      setEvents: (f: (e: Array<{ text: string }>) => Array<{ text: string }>) => infos.push(...f([]).map((e) => e.text)),
      setCfg: (f: (c: Record<string, unknown>) => Record<string, unknown>) => void (cfg = f(cfg)),
      openDlScreen: (screen: unknown) => void screens.push(screen),
    } as unknown as SlashContext;
    const original = globalThis.fetch;
    const env = { url: process.env.AUTOPILOT_DL_FREE_URL, token: process.env.AUTOPILOT_DL_FREE_TOKEN, clip: process.env.AUTOPILOT_NO_CLIPBOARD };
    process.env.AUTOPILOT_DL_FREE_URL = "https://free.test";
    process.env.AUTOPILOT_DL_FREE_TOKEN = "tok";
    process.env.AUTOPILOT_NO_CLIPBOARD = "1";
    globalThis.fetch = (async (url: string) => {
      assert.strictEqual(new URL(url).pathname, "/v1/me");
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const restore = () => {
      globalThis.fetch = original;
      for (const [k, v] of [["AUTOPILOT_DL_FREE_URL", env.url], ["AUTOPILOT_DL_FREE_TOKEN", env.token], ["AUTOPILOT_NO_CLIPBOARD", env.clip]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    return { ctx, infos, screens, restore, cfg: () => cfg };
  }

  it("/invite shows the link and counts; /upgrade opens the Pro and top-up screen", async () => {
    const s = await session(me());
    try {
      await dispatchSlashCommand(s.ctx, "/invite");
      assert.strictEqual(s.infos[0], [`Your invite link: ${LINK}`, "  joined            3", "  active this week  2", "  bonus             +30M a week of +50M", "Each friend who starts using dl gives you both +10M a week."].join("\n"));
      await dispatchSlashCommand(s.ctx, "/upgrade");
      assert.deepStrictEqual(s.screens, [{ kind: "upgrade", offers: OFFERS }]);
    } finally {
      s.restore();
    }
  });

  it("/settings pr-footer, invite-tip and star-tip turn off and show as on by default", async () => {
    const s = await session(me());
    try {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath(), "{}");
      await dispatchSlashCommand(s.ctx, "/settings");
      assert.match(s.infos[0]!, /\n {2}pr-footer {2}on {3}end pull requests the agent opens with "Opened with dl, a free coding agent\."/);
      assert.match(s.infos[0]!, /\n {2}invite-tip on {3}free tier: one line with your invite link/);
      assert.match(s.infos[0]!, /\n {2}star-tip {3}on {3}one line asking for a GitHub star/);
      // Each change is saved in the background: let one land before the next.
      await dispatchSlashCommand(s.ctx, "/settings pr-footer off");
      await new Promise((r) => setTimeout(r, 50));
      await dispatchSlashCommand(s.ctx, "/settings invite-tip off");
      await new Promise((r) => setTimeout(r, 50));
      await dispatchSlashCommand(s.ctx, "/settings star-tip off");
      assert.strictEqual(s.cfg().prFooter, false);
      assert.strictEqual(s.cfg().inviteTip, false);
      assert.strictEqual(s.cfg().starTip, false);
      // Persisted for the PR tools (read from disk) and the next session.
      await new Promise((r) => setTimeout(r, 50));
      const saved = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
      assert.strictEqual(saved.prFooter, false);
      assert.strictEqual(saved.inviteTip, false);
      assert.strictEqual(saved.starTip, false);
      await writeFile(configPath(), "{}");
    } finally {
      s.restore();
    }
  });

  it("/invite and /upgrade are listed in the slash menu and /help", () => {
    assert.ok(BUILTIN_COMMAND_NAMES.has("invite"));
    assert.ok(BUILTIN_COMMAND_NAMES.has("upgrade"));
    const help = CATEGORIES.flatMap((c) => c.commands.map((x) => x.command));
    for (const c of ["/invite", "/upgrade", "/settings pr-footer off", "/settings invite-tip off", "/settings star-tip off"]) assert.ok(help.includes(c), c);
  });
});

/** `autopilot invite` / `upgrade` with fakes. */
function cliDeps(printed: string[]): DlCommandDeps {
  let clock = NOW;
  return {
    providerId: "directionally-local",
    providerName: "Directionally Local, free",
    print: (l) => void printed.push(l),
    fetchMe: async () => me(),
    copy: () => true,
    checkout: async (p) => `https://pay.example/${p}`,
    portal: async () => "https://billing.example/portal",
    openBrowser: () => true,
    ask: null,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}
