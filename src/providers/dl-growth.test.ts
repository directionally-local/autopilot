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
    checkout: async (product) => {
      if (o.checkoutError) throw o.checkoutError;
      checkouts.push(product);
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

const quota: DlScreen = { kind: "quota", resetsAt: RESETS, offers: OFFERS, referralLink: LINK };

describe("free tier growth", () => {
  beforeEach(() => resetDlNoticeState());

  describe("limit screen (quota_exceeded)", () => {
    it("reads offers, the invite link and the reset from the 402 body (camelCase and snake_case)", () => {
      const parsed = parseDlError({
        error: { code: "quota_exceeded", resetsAt: RESETS, referralLink: LINK, offers: { pro: { priceUsdMonthly: 10, tokensPerWeek: 100e6 }, topup: { price_usd: 3, tokens: 50e6, valid_days: 30 } } },
      });
      assert.deepStrictEqual(parsed, { code: "quota_exceeded", resetsAt: RESETS, referralLink: LINK, offers: OFFERS });
      // Incomplete offers are dropped rather than shown with a blank price.
      assert.strictEqual(parseDlError({ error: { code: "quota_exceeded", offers: { pro: { priceUsdMonthly: 10 } } } })?.offers, undefined);
    });

    it("offers invite, Pro, top-up and your own key, priced from the service", async () => {
      const w = world({ select: [null] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "dismissed");
      assert.deepStrictEqual(w.selects[0], {
        title: "You've used this week's free tokens. They're back Mon 09:00.",
        labels: [
          "Invite a friend — you both get +10M a week",
          "Keep going with Pro — $10/month, 100M a week",
          "Top up 50M tokens — $3, one time",
          "Use my own API key",
        ],
        values: ["invite", "pro", "topup", "own-key"],
        subtitle: "Enter to choose · Esc to close",
      });
      // Other prices come straight from the service.
      const other = dlScreenChoices("quota", { offers: { pro: { priceUsdMonthly: 12.5, tokensPerWeek: 80e6 }, topup: { priceUsd: 5, tokens: 25e6 } }, referralLink: LINK });
      assert.deepStrictEqual(other.map((c) => c.label).slice(1, 3), ["Keep going with Pro — $12.50/month, 80M a week", "Top up 25M tokens — $5, one time"]);
    });

    it("hides Pro and top-up without offers (older server), and invite without a link", () => {
      assert.deepStrictEqual(dlScreenChoices("quota", { referralLink: LINK }).map((c) => c.value), ["invite", "own-key"]);
      assert.deepStrictEqual(dlScreenChoices("quota", {}).map((c) => c.value), ["own-key"]);
    });

    it("invite copies the link (OSC 52) and shows it", async () => {
      const w = world({ select: ["invite"] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "handled");
      assert.deepStrictEqual(w.copied, [LINK]);
      assert.deepStrictEqual(w.said, [`Your invite link (copied): ${LINK} — when a friend starts using dl, you both get +10M a week.`]);
      const plain = world({ select: ["invite"], copied: false });
      await runDlScreen(quota, plain.deps);
      assert.strictEqual(plain.said[0], `Your invite link: ${LINK} — when a friend starts using dl, you both get +10M a week.`);
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

    it("top-up: done once more top-up tokens show than before", async () => {
      const w = world({ select: ["topup"], meSeq: [me({ topupTokensLeft: 0 }), me({ topupTokensLeft: 0 }), me({ topupTokensLeft: 50e6 })] });
      assert.strictEqual(await runDlScreen(quota, w.deps), "retry");
      assert.deepStrictEqual(w.checkouts, ["topup"]);
      assert.deepStrictEqual(w.said, ["✓ Top-up added: 50M tokens to use. Continuing."]);
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
      assert.match(describeDlError("quota_exceeded", { resetsAt: RESETS, timeZone: TZ, now: NOW })!, /^You've used this week's free tokens\. They're back Mon 09:00\. To keep going now: \/provider/);
    });

    it("builds the screen from the error, with the last known link when the error has none", () => {
      assert.deepStrictEqual(dlScreenFor("quota_exceeded", { resetsAt: RESETS }, LINK), { kind: "quota", resetsAt: RESETS, referralLink: LINK });
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

    it("headless: one plain line with the link and `autopilot upgrade`", () => {
      const err = new ApiError("autopilot: …", undefined, 402);
      err.providerCode = "quota_exceeded";
      err.providerDetail = { resetsAt: RESETS, referralLink: LINK };
      assert.strictEqual(
        dlHeadlessMessage(err, { now: NOW, timeZone: TZ }),
        `You've used this week's free tokens. They're back Mon 09:00. Invite a friend and you both get +10M a week: ${LINK} · Keep going now: \`autopilot upgrade\`, or your own key: \`autopilot connect\`.`,
      );
      err.providerDetail = {};
      assert.doesNotMatch(dlHeadlessMessage(err, { now: NOW, timeZone: TZ })!, /\n|Invite/);
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
        labels: ["Invite a friend — you both get +10M a week", "Keep going with Pro — $10/month, 100M a week", "Use my own API key now"],
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
      assert.deepStrictEqual(w.selects[0]!.labels, ["Pro — $10/month, 100M a week", "Top up 50M tokens — $3, one time"]);
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
      assert.deepStrictEqual(printed2.slice(0, 3), ["Upgrade Directionally Local", "  1) Pro — $10/month, 100M a week", "  2) Top up 50M tokens — $3, one time (lasts 30 days)"]);
      assert.deepStrictEqual(asked, ["Choose 1-2 (Enter to cancel): "]);
      assert.strictEqual(printed2.at(-1), "✓ Top-up added: 50M tokens to use.");
      const printed3: string[] = [];
      assert.strictEqual(await runUpgradeCommand("gold", cliDeps(printed3)), 1);
      assert.deepStrictEqual(printed3, ["Choose one of: pro, topup."]);
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
        `Nice. Know someone who'd like this? ${LINK} gives you both +10M a week.`,
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

  it("/settings pr-footer and invite-tip turn off and show as on by default", async () => {
    const s = await session(me());
    try {
      await mkdir(dirname(configPath()), { recursive: true });
      await writeFile(configPath(), "{}");
      await dispatchSlashCommand(s.ctx, "/settings");
      assert.match(s.infos[0]!, /\n {2}pr-footer {2}on {3}end pull requests the agent opens with "Opened with dl, a free coding agent\."/);
      assert.match(s.infos[0]!, /\n {2}invite-tip on {3}free tier: one line with your invite link/);
      // Each change is saved in the background: let one land before the next.
      await dispatchSlashCommand(s.ctx, "/settings pr-footer off");
      await new Promise((r) => setTimeout(r, 50));
      await dispatchSlashCommand(s.ctx, "/settings invite-tip off");
      assert.strictEqual(s.cfg().prFooter, false);
      assert.strictEqual(s.cfg().inviteTip, false);
      // Persisted for the PR tools (read from disk) and the next session.
      await new Promise((r) => setTimeout(r, 50));
      const saved = JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
      assert.strictEqual(saved.prFooter, false);
      assert.strictEqual(saved.inviteTip, false);
      await writeFile(configPath(), "{}");
    } finally {
      s.restore();
    }
  });

  it("/invite and /upgrade are listed in the slash menu and /help", () => {
    assert.ok(BUILTIN_COMMAND_NAMES.has("invite"));
    assert.ok(BUILTIN_COMMAND_NAMES.has("upgrade"));
    const help = CATEGORIES.flatMap((c) => c.commands.map((x) => x.command));
    for (const c of ["/invite", "/upgrade", "/settings pr-footer off", "/settings invite-tip off"]) assert.ok(help.includes(c), c);
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
