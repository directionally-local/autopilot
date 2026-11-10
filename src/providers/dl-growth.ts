/**
 * The free tier's ways on when it runs out: invite a friend, Pro, a top-up,
 * or your own key. What each screen and command says, the checkout (open the
 * payment page, then watch /v1/me until the plan or top-up shows), and the
 * one-time invite tip after a first win. Renderer-free so it can be tested:
 * the Camouflage view and the CLI supply the prompts, the browser and the
 * clock.
 *
 * Every field the service adds for this is optional: an older server sends
 * no offers (Pro and top-up are hidden) and no referral (invites are hidden).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentCallbacks } from "../agent/loop.js";
import { statePath } from "../util/app-dirs.js";
import { createsGhPr } from "../util/pr-footer.js";
import {
  DL_INVITE_BONUS_TOKENS,
  DL_REQUEST_HINT,
  DL_SWITCH_HINT,
  dlCheckout,
  dlQueuePlace,
  fetchDlMe,
  formatLocalTime,
  formatTokens,
  formatUsd,
  nextWeekStart,
  referralBonusText,
  type DlErrorDetail,
  type DlMe,
  type DlOffers,
  type DlProduct,
  type DlProOffer,
  type DlTimeOpts,
  type DlTopupOffer,
  type DlWhere,
} from "./directionally-local.js";

/** What each friend who starts using dl adds a week, for both of you. */
export const DL_REFERRAL_BONUS_TOKENS = DL_INVITE_BONUS_TOKENS;
export const DL_UPGRADE_COMMAND = "autopilot upgrade";
export const DL_INVITE_COMMAND = "autopilot invite";
/** How often and how long the checkout watches /v1/me for the payment. */
export const DL_CHECKOUT_POLL_MS = 5_000;
export const DL_CHECKOUT_TIMEOUT_MS = 10 * 60_000;

// ── Copy ─────────────────────────────────────────────────────────────────

/** "You've used this week's free tokens. They're back Mon 09:00." */
export function dlLimitTitle(resetsAt: string | undefined, o: DlTimeOpts = {}): string {
  return `You've used this week's free tokens. They're back ${formatLocalTime(resetsAt ?? nextWeekStart(o.now), o)}.`;
}

/** "You're #214 in line for free tokens (about 3 days, by Fri). Each friend who starts using dl moves you up." */
export function dlQueueTitle(position: number | undefined, etaAt: string | undefined, o: DlTimeOpts = {}): string {
  return `${dlQueuePlace(position, etaAt, o)} Each friend who starts using dl moves you up.`;
}

export function inviteLabel(bonus = DL_REFERRAL_BONUS_TOKENS): string {
  return `Invite a friend — you both get +${formatTokens(bonus)} a week`;
}

export function proLabel(pro: DlProOffer, lead = "Keep going with Pro"): string {
  return `${lead} — ${formatUsd(pro.priceUsdMonthly)}/month, ${formatTokens(pro.tokensPerWeek)} a week`;
}

export function topupLabel(t: DlTopupOffer): string {
  return `Top up ${formatTokens(t.tokens)} tokens — ${formatUsd(t.priceUsd)}, one time`;
}

export type DlChoice = "invite" | "pro" | "topup" | "own-key";
export interface DlChoiceOption {
  value: DlChoice;
  label: string;
  description?: string;
}

/**
 * The choices on a screen, in order: invite (with a link), Pro and top-up
 * (with offers; the queue offers no top-up), and your own key. `upgrade` is
 * /upgrade: Pro and top-up only.
 */
export function dlScreenChoices(kind: DlScreen["kind"], o: { offers?: DlOffers; referralLink?: string }): DlChoiceOption[] {
  const out: DlChoiceOption[] = [];
  if (kind !== "upgrade" && o.referralLink) out.push({ value: "invite", label: inviteLabel() });
  if (o.offers?.pro) out.push({ value: "pro", label: proLabel(o.offers.pro, kind === "upgrade" ? "Pro" : "Keep going with Pro") });
  if (o.offers?.topup && kind !== "queued") {
    const days = o.offers.topup.validDays;
    out.push({ value: "topup", label: topupLabel(o.offers.topup), ...(days ? { description: `lasts ${days} days` } : {}) });
  }
  if (kind !== "upgrade") out.push({ value: "own-key", label: kind === "queued" ? "Use my own API key now" : "Use my own API key" });
  return out;
}

/** Said after choosing to invite: the link, and whether it was copied. */
export function dlInviteShareLine(link: string, copied: boolean): string {
  return `Your invite link${copied ? " (copied)" : ""}: ${link} — when a friend starts using dl, you both get +${formatTokens(DL_REFERRAL_BONUS_TOKENS)} a week.`;
}

/** `/invite` and `autopilot invite`: the link, who joined, and the bonus earned. */
export function dlInviteText(me: DlMe, copied: boolean): string {
  const r = me.referral!;
  return [
    `Your invite link${copied ? " (copied)" : ""}: ${r.link}`,
    `  joined            ${r.joined}`,
    `  active this week  ${r.activeThisWeek}`,
    `  bonus             ${referralBonusText(r)}`,
    me.queue
      ? `Each friend who starts using dl moves you up the line and gives you both +${formatTokens(DL_REFERRAL_BONUS_TOKENS)} a week.`
      : `Each friend who starts using dl gives you both +${formatTokens(DL_REFERRAL_BONUS_TOKENS)} a week.`,
  ].join("\n");
}

/** Why `/invite` can't show a link. Undefined when it can. */
export function dlInviteUnavailable(o: { providerId: string; providerName: string; me?: DlMe | null; where?: DlWhere }): string | undefined {
  const cli = o.where === "cli";
  if (o.providerId !== "directionally-local") {
    return `${cli ? "`autopilot invite`" : "/invite"} is for the Directionally Local free tier; you're on ${o.providerName}. ${cli ? "`autopilot auth directionally-local`" : DL_SWITCH_HINT} switches to it.`;
  }
  if (o.me?.plan === "pro") return `You're on Pro, so invites don't add tokens. ${cli ? `\`${DL_UPGRADE_COMMAND}\`` : "/upgrade"} manages your plan.`;
  if (o.me && !o.me.referral) return "Invites aren't available from this Directionally Local server yet.";
  return undefined;
}

/** The one-time line after a first win on the free tier. */
export function dlWinLine(link: string): string {
  return `Nice. Know someone who'd like this? ${link} gives you both +${formatTokens(DL_REFERRAL_BONUS_TOKENS)} a week.`;
}

/**
 * `-p` and other headless runs: one plain line for running out or being
 * queued, with the invite link and `autopilot upgrade`.
 */
export function dlHeadlessLine(code: string, d: DlErrorDetail, o: DlTimeOpts = {}): string | undefined {
  const link = d.referralLink;
  const ways = `Keep going now: \`${DL_UPGRADE_COMMAND}\`, or your own key: \`autopilot connect\`.`;
  if (code === "quota_exceeded" || code === "basic_limit") {
    const invite = link ? `Invite a friend and you both get +${formatTokens(DL_REFERRAL_BONUS_TOKENS)} a week: ${link} · ` : "";
    return `${dlLimitTitle(d.resetsAt, o)} ${invite}${ways}`;
  }
  if (code === "free_tier_queued") {
    return `${dlQueuePlace(d.position, d.etaAt, o)} Each friend who starts using dl moves you up${link ? `: ${link}` : ""}. Start now: \`${DL_UPGRADE_COMMAND}\`, or your own key: \`autopilot connect\`.`;
  }
  return undefined;
}

/** The headless line for an error from a request, when it is the free tier running out or queueing. */
export function dlHeadlessMessage(err: unknown, o: DlTimeOpts = {}): string | undefined {
  const e = err as { providerCode?: unknown; providerDetail?: unknown } | null;
  if (typeof e?.providerCode !== "string") return undefined;
  return dlHeadlessLine(e.providerCode, (e.providerDetail ?? {}) as DlErrorDetail, o);
}

/** What the checkout says while it waits for the payment. */
export function dlCheckoutWaitingText(url: string, opened: boolean, product: DlProduct, where: DlWhere = "session"): string {
  const what = product === "pro" ? "start Pro" : "buy the top-up";
  const open = opened ? `Opened your browser at ${url} to ${what}.` : `Open ${url} in a browser on any device to ${what}.`;
  return `${open}\nWaiting for the payment (up to 10 minutes)… ${where === "cli" ? "Ctrl+C to stop" : "Esc to cancel"}`;
}

/** "✓ Pro active. Continuing." / "✓ Top-up added: 50M tokens." */
export function dlPurchasedLine(product: DlProduct, me: DlMe, continuing: boolean): string {
  const then = continuing ? " Continuing." : "";
  if (product === "pro") return `✓ Pro active.${then}`;
  return `✓ Top-up added: ${formatTokens(me.topupTokensLeft ?? 0)} tokens to use.${then}`;
}

export const DL_CHECKOUT_TIMEOUT_LINE = "No payment showed up within 10 minutes. If you paid, /usage shows your plan once it's through.";
export const DL_CHECKOUT_CANCELLED_LINE = "Stopped waiting for the payment. If you paid, /usage shows your plan once it's through.";
export const DL_PORTAL_LINE = "Manage or cancel your plan";

// ── Checkout ─────────────────────────────────────────────────────────────

/** True once /v1/me shows what was bought: Pro, or more top-up tokens than before. */
export function purchaseShows(product: DlProduct, before: DlMe | null, me: DlMe): boolean {
  if (product === "pro") return me.plan === "pro";
  return (me.topupTokensLeft ?? 0) > (before?.topupTokensLeft ?? 0);
}

export type PurchaseWait = { kind: "done"; me: DlMe } | { kind: "timeout" } | { kind: "cancelled" };

/**
 * Poll /v1/me every 5 s for up to 10 minutes until the purchase shows. A
 * failed read is retried at the next interval. Esc (the signal) stops it.
 */
export async function waitForPurchase(
  product: DlProduct,
  before: DlMe | null,
  deps: {
    fetchMe: () => Promise<DlMe>;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    now: () => number;
    signal?: AbortSignal;
    intervalMs?: number;
    timeoutMs?: number;
  },
): Promise<PurchaseWait> {
  const deadline = deps.now() + (deps.timeoutMs ?? DL_CHECKOUT_TIMEOUT_MS);
  const interval = deps.intervalMs ?? DL_CHECKOUT_POLL_MS;
  while (deps.now() < deadline) {
    try {
      await deps.sleep(interval, deps.signal);
    } catch {
      return { kind: "cancelled" };
    }
    if (deps.signal?.aborted) return { kind: "cancelled" };
    const me = await deps.fetchMe().catch(() => null);
    if (deps.signal?.aborted) return { kind: "cancelled" };
    if (me && purchaseShows(product, before, me)) return { kind: "done", me };
  }
  return { kind: "timeout" };
}

export interface PurchaseDeps {
  say: (message: string, severity?: "info" | "error") => void;
  checkout: (product: DlProduct) => Promise<string>;
  fetchMe: () => Promise<DlMe>;
  /** Open the URL in a browser here; false when none can (the link is then printed for another device). */
  openBrowser: (url: string) => boolean;
  /** Show the waiting text until the returned function is called (null: it was said instead). `cancel` is Esc. */
  wait: (text: string, cancel: () => void) => Promise<(() => void) | null>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  where?: DlWhere;
  intervalMs?: number;
  timeoutMs?: number;
}

/**
 * Buy Pro or a top-up: start the checkout, open the payment page (or print
 * it), and wait for /v1/me to show it. True once it does (the line saying so
 * is said); false when it failed, timed out or was cancelled (said too).
 */
export async function purchase(product: DlProduct, deps: PurchaseDeps, o: { continuing: boolean }): Promise<boolean> {
  const before = await deps.fetchMe().catch(() => null);
  let url: string;
  try {
    url = await deps.checkout(product);
  } catch (e) {
    deps.say((e as Error).message || "Couldn't start the checkout; try again.", "error");
    return false;
  }
  const opened = deps.openBrowser(url);
  const ctrl = new AbortController();
  const end = await deps.wait(dlCheckoutWaitingText(url, opened, product, deps.where), () => ctrl.abort());
  let result: PurchaseWait;
  try {
    result = await waitForPurchase(product, before, {
      fetchMe: deps.fetchMe,
      sleep: deps.sleep,
      now: deps.now,
      signal: ctrl.signal,
      ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    });
  } finally {
    end?.();
  }
  if (result.kind === "done") {
    deps.say(dlPurchasedLine(product, result.me, o.continuing));
    return true;
  }
  deps.say(result.kind === "timeout" ? DL_CHECKOUT_TIMEOUT_LINE : DL_CHECKOUT_CANCELLED_LINE);
  return false;
}

// ── Screens ──────────────────────────────────────────────────────────────

/** A screen the session shows: out of tokens, queued, or /upgrade. */
export type DlScreen =
  | { kind: "quota"; resetsAt?: string; offers?: DlOffers; referralLink?: string; request?: string }
  | { kind: "queued"; position?: number; etaAt?: string; offers?: DlOffers; referralLink?: string }
  | { kind: "upgrade"; offers: DlOffers };

/**
 * How a screen ended: `retry` the blocked request (bought), open the
 * provider picker (`own-key`), `dismissed` with Esc (the session then says
 * what it always said), or `handled` (nothing more to do).
 */
export type DlScreenOutcome = "retry" | "own-key" | "dismissed" | "handled";

export interface DlScreenDeps extends PurchaseDeps {
  select: (title: string, options: DlChoiceOption[], subtitle?: string) => Promise<string | null>;
  /** Copy to the clipboard (OSC 52); true when sent. */
  copy: (text: string) => boolean;
  timeZone?: string;
}

/** The screen for a free-tier error, when it has one (quota_exceeded or basic_limit, free_tier_queued). */
export function dlScreenFor(code: string | undefined, d: DlErrorDetail, fallbackLink?: string): DlScreen | undefined {
  const referralLink = d.referralLink ?? fallbackLink;
  const common = { ...(d.offers ? { offers: d.offers } : {}), ...(referralLink ? { referralLink } : {}) };
  if (code === "quota_exceeded" || code === "basic_limit") {
    return { kind: "quota", ...(d.resetsAt ? { resetsAt: d.resetsAt } : {}), ...(d.request ? { request: d.request } : {}), ...common };
  }
  if (code === "free_tier_queued") return { kind: "queued", ...(d.position ? { position: d.position } : {}), ...(d.etaAt ? { etaAt: d.etaAt } : {}), ...common };
  return undefined;
}

/** Show a screen and act on the choice. */
export async function runDlScreen(screen: DlScreen, deps: DlScreenDeps): Promise<DlScreenOutcome> {
  const t: DlTimeOpts = { now: deps.now(), ...(deps.timeZone ? { timeZone: deps.timeZone } : {}) };
  const link = screen.kind === "upgrade" ? undefined : screen.referralLink;
  const choices = dlScreenChoices(screen.kind, screen);
  const title =
    screen.kind === "quota"
      ? dlLimitTitle(screen.resetsAt, t)
      : screen.kind === "queued"
        ? dlQueueTitle(screen.position, screen.etaAt, t)
        : "Upgrade Directionally Local";
  const hint = "Enter to choose · Esc to close";
  const subtitle =
    screen.kind === "queued" && link
      ? `Your invite link: ${link} · ${hint}`
      : screen.kind === "quota" && screen.request
        ? `${DL_REQUEST_HINT} · ${hint}`
        : hint;
  const choice = (await deps.select(title, choices, subtitle)) as DlChoice | null;
  if (choice === null) return "dismissed";
  if (choice === "own-key") return "own-key";
  if (choice === "invite") {
    if (link) deps.say(dlInviteShareLine(link, deps.copy(link)));
    return "handled";
  }
  const bought = await purchase(choice, deps, { continuing: screen.kind !== "upgrade" });
  return bought && screen.kind !== "upgrade" ? "retry" : "handled";
}

/** What the session does once a screen ends. */
export type DlFollowUp =
  | { kind: "show-error"; text: string }
  | { kind: "provider-picker" }
  | { kind: "retry"; text: string; display: string }
  | { kind: "none" };

/**
 * After a screen: Esc shows the line the session always showed for the
 * error; "own key" opens the provider picker; a purchase retries the blocked
 * prompt (on the history as it is, without a new user message).
 */
export function dlScreenFollowUp(
  outcome: DlScreenOutcome,
  errorLine: string | null,
  lastPrompt: { text: string; display: string } | null,
): DlFollowUp {
  if (outcome === "dismissed") return errorLine ? { kind: "show-error", text: errorLine } : { kind: "none" };
  if (outcome === "own-key") return { kind: "provider-picker" };
  if (outcome === "retry" && lastPrompt) return { kind: "retry", ...lastPrompt };
  return { kind: "none" };
}

// ── The invite tip after a first win ─────────────────────────────────────

/** Test runners whose passing run counts as a win. */
const TEST_COMMAND =
  /(^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|npx\s+(?:vitest|jest|mocha|playwright\s+test)\b|vitest\b|jest\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest)\b|cargo\s+(?:test|nextest)\b|go\s+test\b|deno\s+test\b|bun\s+test\b|make\s+(?:test|check)\b|mvn\b[^\n;&|]*\btest\b|\.?\/?gradlew?\b[^\n;&|]*\btest\b|rspec\b|mix\s+test\b|dotnet\s+test\b|(?:tsx|node)\s+--test\b|swift\s+test\b|phpunit\b)/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}

/** A line of tool output that is exactly a GitHub pull request URL (what `gh pr create` prints). */
const PR_URL_LINE = /^\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\s*$/m;

/** What a turn achieved: a PR opened, and how the last test run went. */
export interface WinTracker {
  prOpened: boolean;
  /** The last test command's outcome; undefined when none ran. */
  testsPassed?: boolean;
}

export function won(t: WinTracker): boolean {
  return t.prOpened || t.testsPassed === true;
}

/** The exit code a bash tool result starts with ("exit=0"), if any. */
function bashExit(content: string): number | undefined {
  const m = /^exit=(-?\d+)/.exec(content);
  return m ? Number(m[1]) : undefined;
}

/** Note what one tool call achieved. */
export function noteToolForWin(t: WinTracker, name: string, rawArgs: string | undefined, ok: boolean, content: string): void {
  if (name === "github_create_pr") {
    if (ok && /^Created PR #\d+/.test(content)) t.prOpened = true;
    return;
  }
  if (name !== "bash") return;
  let command = "";
  try {
    command = String((JSON.parse(rawArgs ?? "{}") as { command?: unknown }).command ?? "");
  } catch {
    return;
  }
  const exit = bashExit(content);
  if (createsGhPr(command) && exit === 0 && PR_URL_LINE.test(content)) t.prOpened = true;
  if (isTestCommand(command) && exit !== undefined) t.testsPassed = ok && exit === 0;
}

/** The turn's callbacks, noting opened PRs and test runs in `t`. */
export function withWinTracking(callbacks: AgentCallbacks, t: WinTracker): AgentCallbacks {
  const args = new Map<string, string>();
  return {
    ...callbacks,
    onToolCallFinalized: (call) => {
      args.set(call.id, call.function.arguments);
      callbacks.onToolCallFinalized?.(call);
    },
    onToolResult: (result) => {
      try {
        noteToolForWin(t, result.name, args.get(result.tool_call_id), result.ok, result.content);
      } catch {
        /* never break a turn */
      }
      callbacks.onToolResult?.(result);
    },
  };
}

/** Where "the invite tip was shown" is kept: Autopilot's state directory. */
export function inviteTipStatePath(): string {
  return statePath("dl-invite-tip.json");
}

export function inviteTipShown(path = inviteTipStatePath()): boolean {
  try {
    return !!(JSON.parse(readFileSync(path, "utf8")) as { shownAt?: unknown }).shownAt;
  } catch {
    return false;
  }
}

export function markInviteTipShown(path = inviteTipStatePath(), now = Date.now()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ shownAt: new Date(now).toISOString() }), "utf8");
  } catch {
    /* best effort: at worst the tip shows once more */
  }
}

/**
 * The invite tip after a win, once per person: only on the free tier (not
 * Pro), with the setting on, never shown before, and when the service has an
 * invite link. Marks it shown. Undefined otherwise.
 */
export async function inviteTipAfterWin(o: {
  providerId: string;
  enabled: boolean;
  fetchMe?: () => Promise<DlMe>;
  statePath?: string;
}): Promise<string | undefined> {
  if (o.providerId !== "directionally-local" || !o.enabled) return undefined;
  const path = o.statePath ?? inviteTipStatePath();
  if (inviteTipShown(path)) return undefined;
  const me = await (o.fetchMe ?? (() => fetchDlMe()))().catch(() => null);
  if (!me || me.plan === "pro" || !me.referral?.link) return undefined;
  markInviteTipShown(path);
  return dlWinLine(me.referral.link);
}

/** The real checkout call, for callers that don't inject one. */
export const realCheckout = (product: DlProduct): Promise<string> => dlCheckout(product);

// ── /invite and /upgrade (also `autopilot invite` / `autopilot upgrade`) ──

/** `/invite`: the link (copied when the terminal takes it), who joined and the bonus; or why not. */
export async function dlInviteReport(o: {
  providerId: string;
  providerName: string;
  fetchMe?: () => Promise<DlMe>;
  copy: (text: string) => boolean;
  where?: DlWhere;
}): Promise<string> {
  const where = o.where ? { where: o.where } : {};
  const early = dlInviteUnavailable({ providerId: o.providerId, providerName: o.providerName, ...where });
  if (early) return early;
  let me: DlMe;
  try {
    me = await (o.fetchMe ?? (() => fetchDlMe()))();
  } catch (e) {
    return (e as Error).message;
  }
  const why = dlInviteUnavailable({ providerId: o.providerId, providerName: o.providerName, me, ...where });
  if (why) return why;
  return dlInviteText(me, o.copy(me.referral!.link));
}

/** "Manage or cancel your plan: opened … in your browser." */
export function dlPortalLine(url: string, opened: boolean): string {
  return opened ? `${DL_PORTAL_LINE}: opened ${url} in your browser.` : `${DL_PORTAL_LINE}: open ${url} in a browser.`;
}

/**
 * `/upgrade`: on Pro, open the billing portal; on the free tier with offers,
 * the Pro and top-up screen; otherwise why not.
 */
export async function dlUpgradeStep(o: {
  providerId: string;
  providerName: string;
  fetchMe?: () => Promise<DlMe>;
  portal: () => Promise<string>;
  openBrowser: (url: string) => boolean;
  where?: DlWhere;
}): Promise<{ kind: "text"; text: string } | { kind: "screen"; screen: Extract<DlScreen, { kind: "upgrade" }>; me: DlMe }> {
  const cli = o.where === "cli";
  if (o.providerId !== "directionally-local") {
    return {
      kind: "text",
      text: `${cli ? `\`${DL_UPGRADE_COMMAND}\`` : "/upgrade"} is for Directionally Local; you're on ${o.providerName}, billed by that provider. ${cli ? "`autopilot auth directionally-local`" : DL_SWITCH_HINT} switches to it.`,
    };
  }
  let me: DlMe;
  try {
    me = await (o.fetchMe ?? (() => fetchDlMe()))();
  } catch (e) {
    return { kind: "text", text: (e as Error).message };
  }
  if (me.plan === "pro") {
    try {
      const url = await o.portal();
      return { kind: "text", text: dlPortalLine(url, o.openBrowser(url)) };
    } catch (e) {
      return { kind: "text", text: (e as Error).message };
    }
  }
  if (!me.offers) return { kind: "text", text: "Pro and top-ups aren't available from this Directionally Local server yet." };
  return { kind: "screen", screen: { kind: "upgrade", offers: me.offers }, me };
}
