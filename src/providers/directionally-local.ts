/**
 * "Directionally Local, free": the managed free tier. People sign in with
 * GitHub through a device code (RFC 8628 shape; the service generates the
 * codes) instead of pasting a key, and get a weekly token allowance on one
 * model. The service is OpenAI-compatible under `<origin>/v1`.
 *
 * - sign-in: POST /v1/device/code, then poll POST /v1/device/token
 * - tokens: a 1-hour access token and a 30-day rotating refresh token, kept
 *   under providers.directionally-local in config.json (mode 0600), refreshed
 *   a minute before expiry and once after a 401 `invalid_token`
 * - account: GET /v1/me → the allowance used and left this week (`/usage`)
 * - every inference response carries X-DL-Tokens-Remaining and
 *   X-DL-Quota-Resets-At; a one-line notice is shown once 80% is used
 * - free only: the one model, deepseek/deepseek-v4.1-flash-1017; anything
 *   else needs the person's own key (see dl-events.ts for usage events,
 *   the condition for free tokens)
 *
 * The origin comes from AUTOPILOT_DL_FREE_URL (default below).
 */

import { readFile } from "node:fs/promises";
import { configPath, patchPersistedConfig, type AutopilotConfig } from "../config.js";
import { getUserAgent } from "../util/version.js";
import type { ProviderSettings } from "./resolve.js";
import type { ModelEntry } from "../models/registry.js";
import { dlOrigin } from "./dl-endpoint.js";

export { DL_FREE_DEFAULT_URL, dlApiBase, dlOrigin } from "./dl-endpoint.js";

export const DL_PROVIDER_ID = "directionally-local" as const;
/** The only model the free tier serves (through OpenRouter, via the service). */
export const DL_FREE_MODEL = "deepseek/deepseek-v4.1-flash-1017";
/** The weekly grant per person, for picker copy and as a fallback before /v1/me has been read. */
export const DL_FREE_WEEKLY_TOKENS = 50_000_000;
/** Env var holding an access token (no refresh): sandboxes and short headless runs. */
export const DL_TOKEN_ENV = "AUTOPILOT_DL_FREE_TOKEN";
export const DL_SIGN_IN_COMMAND = "autopilot auth directionally-local";
/** How to leave the free tier from inside a session: the provider picker. */
export const DL_SWITCH_HINT = "/provider";
/** The weekly allowance's reset when the service didn't say: Monday 00:00 UTC, like its weeks. */
const WEEK_MS = 7 * 86_400_000;
/** "15M", "1.2M", "800k", "950". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

/** The free tier's only model, priced at $0 (it comes out of the weekly allowance). */
export function dlFreeModelEntry(): ModelEntry {
  return {
    id: DL_FREE_MODEL,
    name: "DeepSeek V4.1 Flash (free)",
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: true, streaming: true, vision: false },
  };
}

/** Shown on the sign-in screen: what is collected in exchange for free tokens. */
export const DL_DISCLOSURE =
  "Free tokens come with usage counts: tokens, cost, sessions, turns, tool counts, errors, model, Autopilot version and OS. Never your prompts, code or file contents.";

/** Said before leaving the free tier for a model or provider that needs the person's own key. */
export function dlNotFreeLine(what: string): string {
  return `${what} isn't part of the Directionally Local free tier; it needs your own API key.`;
}

/** The picker's one-line hint. */
export function dlPickerHint(): string {
  return `free — ${formatTokens(DL_FREE_WEEKLY_TOKENS)} tokens/week, sign in with GitHub`;
}

/** The next Monday 00:00 UTC after `now`: when the service's weeks end. */
export function nextWeekStart(now = Date.now()): number {
  const d = new Date(now);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday) + WEEK_MS;
}

/** Where and when a time is shown: the person's own time zone unless a test pins one. */
export interface DlTimeOpts {
  now?: number;
  /** An IANA zone; undefined is the machine's local time zone. */
  timeZone?: string;
}

/**
 * A reset or pause end in the person's local time: "Mon 09:00" within the
 * coming week, "Mon, Nov 16, 09:00" further out. Undefined for a missing or
 * unparseable time.
 */
export function formatLocalTime(at: string | number | undefined, o: DlTimeOpts = {}): string | undefined {
  const t = typeof at === "number" ? at : at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const d = new Date(t);
  const tz = o.timeZone ? { timeZone: o.timeZone } : {};
  const weekday = d.toLocaleDateString("en-US", { weekday: "short", ...tz });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...tz });
  const now = o.now ?? Date.now();
  if (t - now < WEEK_MS) return `${weekday} ${time}`;
  return `${weekday}, ${d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...tz })}, ${time}`;
}

/** The weekday a weekly allowance comes back on, in local time ("Monday"; "Sunday" west of UTC). */
export function localResetWeekday(at: string | undefined, o: DlTimeOpts = {}): string {
  const t = at ? Date.parse(at) : NaN;
  const when = Number.isFinite(t) ? t : nextWeekStart(o.now);
  return new Date(when).toLocaleDateString("en-US", { weekday: "long", ...(o.timeZone ? { timeZone: o.timeZone } : {}) });
}

/** The short name of the time zone a time is shown in: "UTC", "PST", "GMT+9". */
export function timeZoneLabel(at: number, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZoneName: "short", ...(timeZone ? { timeZone } : {}) }).formatToParts(new Date(at));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** "in 5 days 15 h", "in 1 day", "in 3 hours", "in under an hour": to the nearest hour. */
export function formatCountdown(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "in under an hour";
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `in ${days} day${days === 1 ? "" : "s"}${rest ? ` ${rest} h` : ""}`;
}

/** "Mon 09:00 GMT+9 (in 5 days 15 h)" in local time, zone named; the service's week end when `iso` is missing. */
export function formatReset(iso: string | undefined, now = Date.now(), timeZone?: string): string {
  const parsed = iso ? Date.parse(iso) : NaN;
  const t = Number.isFinite(parsed) ? parsed : nextWeekStart(now);
  const at = formatLocalTime(t, { now, ...(timeZone ? { timeZone } : {}) })!;
  const zone = timeZoneLabel(t, timeZone);
  const ms = t - now;
  return `${at}${zone ? ` ${zone}` : ""}${ms > 0 ? ` (${formatCountdown(ms)})` : ""}`;
}

/** The free tier's weekly spending limit per person, when the service didn't say. */
export const DL_FREE_WEEKLY_USD = 5;

/** "$5", "$0.01"; under a cent reads "under $0.01". */
export function formatUsd(n: number): string {
  if (n <= 0) return "$0";
  if (n < 0.01) return "under $0.01";
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** A free-tier error with the service's code and a sentence for the person. */
export class DlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    /** What the service sent with it (reason, resetsAt, minimum account age), for re-wording elsewhere. */
    readonly detail: DlErrorDetail = {},
  ) {
    super(message);
    this.name = "DlError";
  }

  /** The sign-in denial this is, if it is one (see DL_DENIALS). */
  get denial(): DlDenial | undefined {
    return dlDenialOf(this.code, this.detail.reason, this.detail.pausedForEveryone);
  }
}

/** The fields of the service's `{error:{…}}` this client reads. */
export interface DlErrorDetail {
  message?: string;
  resetsAt?: string;
  retryAfter?: number;
  reason?: string;
  /** The minimum GitHub account age for the free tier without an invite (a field, or read from the message). */
  minAccountAgeDays?: number;
  /** The service paused free tokens for everyone (its global budget), not just for this account. */
  pausedForEveryone?: boolean;
  /** What can be bought instead of waiting (quota_exceeded, free_tier_queued); older servers send none. */
  offers?: DlOffers;
  /** The person's invite link, when the service sent it with the error. */
  referralLink?: string;
  /** free_tier_queued: the place in line (1 is next). */
  position?: number;
  /** free_tier_queued: when free tokens are expected to start. */
  etaAt?: string;
}

// ── Plans, offers, invites and the queue (all optional: older servers send none) ──

/** Pro: a monthly plan with a bigger weekly allowance. */
export interface DlProOffer {
  priceUsdMonthly: number;
  tokensPerWeek: number;
}

/** A one-time top-up of tokens. */
export interface DlTopupOffer {
  priceUsd: number;
  tokens: number;
  /** How long bought tokens last, when the service says. */
  validDays?: number;
}

export interface DlOffers {
  pro?: DlProOffer;
  topup?: DlTopupOffer;
}

/** The person's invite link and what it has earned. */
export interface DlReferral {
  code?: string;
  link: string;
  joined: number;
  activeThisWeek: number;
  /** Bonus tokens a week earned so far. */
  bonusTokensPerWeek: number;
  /** The most bonus tokens a week invites can earn. */
  bonusCapPerWeek?: number;
}

/** A place in line for free tokens. */
export interface DlQueue {
  position: number;
  etaAt?: string;
}

export type DlPlan = "free" | "pro";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const numOf = (o: Rec, ...keys: string[]) => keys.map((k) => o[k]).find((v): v is number => typeof v === "number" && Number.isFinite(v));
const strOf = (o: Rec, ...keys: string[]) => keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.trim() !== "");

/** Offers as the service sent them, keeping only complete ones. Undefined when there are none. */
export function parseDlOffers(raw: unknown): DlOffers | undefined {
  if (!isRec(raw)) return undefined;
  const out: DlOffers = {};
  if (isRec(raw.pro)) {
    const price = numOf(raw.pro, "priceUsdMonthly", "price_usd_monthly");
    const tokens = numOf(raw.pro, "tokensPerWeek", "tokens_per_week");
    if (price !== undefined && price > 0 && tokens !== undefined && tokens > 0) out.pro = { priceUsdMonthly: price, tokensPerWeek: tokens };
  }
  if (isRec(raw.topup)) {
    const price = numOf(raw.topup, "priceUsd", "price_usd");
    const tokens = numOf(raw.topup, "tokens");
    const days = numOf(raw.topup, "validDays", "valid_days");
    if (price !== undefined && price > 0 && tokens !== undefined && tokens > 0) {
      out.topup = { priceUsd: price, tokens, ...(days !== undefined && days > 0 ? { validDays: days } : {}) };
    }
  }
  return out.pro || out.topup ? out : undefined;
}

/** The referral block of /v1/me, when it has a link. */
export function parseDlReferral(raw: unknown): DlReferral | undefined {
  if (!isRec(raw)) return undefined;
  const link = strOf(raw, "link", "url");
  if (!link) return undefined;
  const code = strOf(raw, "code");
  const cap = numOf(raw, "bonusCapPerWeek", "bonus_cap_per_week");
  return {
    ...(code ? { code } : {}),
    link,
    joined: Math.max(0, numOf(raw, "joined") ?? 0),
    activeThisWeek: Math.max(0, numOf(raw, "activeThisWeek", "active_this_week") ?? 0),
    bonusTokensPerWeek: Math.max(0, numOf(raw, "bonusTokensPerWeek", "bonus_tokens_per_week") ?? 0),
    ...(cap !== undefined && cap > 0 ? { bonusCapPerWeek: cap } : {}),
  };
}

/** The queue block of /v1/me: null or missing means not queued. */
export function parseDlQueue(raw: unknown): DlQueue | undefined {
  if (!isRec(raw)) return undefined;
  const position = numOf(raw, "position");
  if (position === undefined || position < 1) return undefined;
  const etaAt = strOf(raw, "etaAt", "eta_at");
  return { position: Math.round(position), ...(etaAt ? { etaAt } : {}) };
}

interface DlErrorBody {
  error?: Record<string, unknown>;
}

/** Where a message is shown: the sign-in (first run, /provider), `autopilot auth`, or a running session. */
export type DlWhere = "signin" | "cli" | "session";

/** What the service adds, for errors where it changes what to say. */
export interface DlErrorExtra extends DlErrorDetail, DlTimeOpts {
  /** Default "session". */
  where?: DlWhere;
}

/** The service's `{error:{code,…}}`, if the body is one. Reads both camelCase and snake_case extras. */
export function parseDlError(body: unknown): ({ code: string } & DlErrorDetail) | null {
  const e = (body as DlErrorBody | null)?.error;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return null;
  const str = (...keys: string[]) => keys.map((k) => e[k]).find((v): v is string => typeof v === "string" && v !== "");
  const num = (...keys: string[]) => keys.map((k) => e[k]).find((v): v is number => typeof v === "number" && Number.isFinite(v));
  const message = str("message");
  const resetsAt = str("resetsAt", "resets_at", "pausedUntil", "paused_until");
  const retryAfter = num("retryAfter", "retry_after");
  const reason = str("reason");
  // The service's own number wins: a field, else "… under 30 days …" in its sentence.
  const fromMessage = message ? /\b(\d{1,4})\s*days?\b/i.exec(message)?.[1] : undefined;
  const minAccountAgeDays = num("minAccountAgeDays", "min_account_age_days", "minGithubAccountAgeDays") ?? (fromMessage ? Number(fromMessage) : undefined);
  const pausedForEveryone = e.pausedForEveryone === true || e.paused_for_everyone === true;
  const offers = parseDlOffers(e.offers);
  const referralLink = str("referralLink", "referral_link");
  const position = num("position");
  const etaAt = str("etaAt", "eta_at");
  return {
    code: e.code,
    ...(message ? { message } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
    ...(reason ? { reason } : {}),
    ...(minAccountAgeDays !== undefined && minAccountAgeDays > 0 ? { minAccountAgeDays } : {}),
    ...(pausedForEveryone ? { pausedForEveryone } : {}),
    ...(offers ? { offers } : {}),
    ...(referralLink ? { referralLink } : {}),
    ...(position !== undefined && position >= 1 ? { position: Math.round(position) } : {}),
    ...(etaAt ? { etaAt } : {}),
  };
}

/**
 * Why the free tier said no to a sign-in (or to a request), whatever the
 * service called it. Keys are service codes or `reason`s, old and new; add a
 * line here when the service grows a new one.
 */
export type DlDenial = "account_too_new" | "not_invited" | "cohort_full" | "too_many_signups" | "paused" | "ended";
export const DL_DENIALS: Readonly<Record<string, DlDenial>> = {
  // Sign-in (POST /v1/device/token, 400, reason = code).
  account_too_new: "account_too_new",
  invite_required: "not_invited",
  cohort_full: "cohort_full",
  too_many_signups: "too_many_signups",
  // Older service responses.
  not_invited: "not_invited",
  needs_invite: "not_invited",
  invalid_invite: "not_invited",
  // Paused for everyone: the kill switch, or the global budget (503, also during sign-in).
  service_paused: "paused",
  paused: "paused",
  global_weekly_budget_reached: "paused",
  weekly_budget: "paused",
  global_total_budget_reached: "paused",
  total_budget: "paused",
  // An older service's "the free tier has ended".
  ended: "ended",
};

/**
 * The denial for a code and reason: the reason is the more specific one, so
 * it wins. A response marked `pausedForEveryone` is a pause whatever its code.
 */
export function dlDenialOf(code: string, reason?: string, pausedForEveryone?: boolean): DlDenial | undefined {
  // access_denied without a known reason is the person declining in the browser.
  return (reason ? DL_DENIALS[reason] : undefined) ?? DL_DENIALS[code] ?? (pausedForEveryone ? "paused" : undefined);
}

/** The free tier's minimum account age, when the service didn't say. */
export const DL_MIN_ACCOUNT_AGE_DAYS = 30;

/** The one next step after leaving the free tier, worded for where it's read. */
function ownKeyNow(where: DlWhere): string {
  if (where === "session") return `Your own key works now: ${DL_SWITCH_HINT}`;
  if (where === "cli") return "Your own key still works: `autopilot connect`.";
  return "Your own key still works.";
}

/** The sentence for a sign-in denial (or the same refusal mid-session), with one next step. */
export function dlDenialLine(denial: DlDenial, extra: DlErrorExtra = {}): string {
  const where = extra.where ?? "signin";
  const again = where === "cli" ? `Run \`${DL_SIGN_IN_COMMAND}\` again and enter it in the browser.` : "Choose Free again and enter it in the browser.";
  const ownKey = where === "cli" ? "Or use your own API key: `autopilot connect`." : "Or use your own API key.";
  switch (denial) {
    case "account_too_new": {
      const days = extra.minAccountAgeDays && extra.minAccountAgeDays > 0 ? Math.round(extra.minAccountAgeDays) : DL_MIN_ACCOUNT_AGE_DAYS;
      if (where === "session") return `New GitHub accounts (under ${days} days) need an invite code for the free tier. ${ownKeyNow(where)}`;
      return `New GitHub accounts (under ${days} days) need an invite code for the free tier. Have one? ${again} ${ownKey}`;
    }
    case "not_invited":
      if (where === "session") return `The free tier is invite-only right now, and this GitHub account isn't on it. ${ownKeyNow(where)}`;
      return `The free tier is invite-only right now. Have a code? ${again} ${ownKey}`;
    case "cohort_full":
      if (where === "session") return `The free tier is full right now. ${ownKeyNow(where)}`;
      return `The free tier is full right now. Use your own API key meanwhile.${where === "cli" ? " `autopilot connect` sets one up." : ""}`;
    case "too_many_signups":
      if (where === "session") return `Too many new free-tier accounts from this network today. ${ownKeyNow(where)}`;
      return `Too many new free-tier accounts from this network today. Try again tomorrow, or use your own API key.${where === "cli" ? " `autopilot connect` sets one up." : ""}`;
    case "paused": {
      const until = formatLocalTime(extra.resetsAt, extra);
      return `Free tokens are paused for everyone${until ? ` until ${until}` : ""}. ${ownKeyNow(where)}`;
    }
    case "ended":
      return `The free tier has ended. ${ownKeyNow(where)}`;
  }
}

/** "You've used this week's free tokens. They're back Mon 09:00. To keep going now: /provider to use your own key." */
export function dlQuotaLine(resetsAt: string | undefined, o: DlTimeOpts & { where?: DlWhere } = {}): string {
  const back = formatLocalTime(resetsAt ?? nextWeekStart(o.now), o);
  const next = o.where === "cli" ? "To keep going now, use your own key: `autopilot connect`." : `To keep going now: ${DL_SWITCH_HINT} to use your own key.`;
  return `You've used this week's free tokens. They're back ${back}. ${next}`;
}

/**
 * "about 3 days, by Fri": how long until free tokens start, in local time.
 * Undefined for a missing or unparseable time.
 */
export function formatEta(etaAt: string | undefined, o: DlTimeOpts = {}): string | undefined {
  const t = etaAt ? Date.parse(etaAt) : NaN;
  if (!Number.isFinite(t)) return undefined;
  const now = o.now ?? Date.now();
  const tz = o.timeZone ? { timeZone: o.timeZone } : {};
  const ms = t - now;
  if (ms <= 0) return "any time now";
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 24) {
    const at = new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...tz });
    return `about ${hours} hour${hours === 1 ? "" : "s"}, by ${at}`;
  }
  const days = Math.round(hours / 24);
  const by =
    ms < WEEK_MS
      ? new Date(t).toLocaleDateString("en-US", { weekday: "short", ...tz })
      : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...tz });
  return `about ${days} day${days === 1 ? "" : "s"}, by ${by}`;
}

/** "You're #214 in line for free tokens (about 3 days, by Fri)." */
export function dlQueuePlace(position: number | undefined, etaAt: string | undefined, o: DlTimeOpts = {}): string {
  const eta = formatEta(etaAt, o);
  const place = position && position > 0 ? `You're #${position} in line for free tokens` : "You're in line for free tokens";
  return `${place}${eta ? ` (${eta})` : ""}.`;
}

/** The queue said in a session or the CLI: the place in line, and the ways to start sooner. */
export function dlQueueLine(position: number | undefined, etaAt: string | undefined, o: DlTimeOpts & { where?: DlWhere } = {}): string {
  const next = o.where === "cli" ? "`autopilot invite` moves you up; `autopilot connect` uses your own key now." : `/invite moves you up; ${DL_SWITCH_HINT} uses your own key now.`;
  return `${dlQueuePlace(position, etaAt, o)} ${next}`;
}

/**
 * The plain sentence for a service error code. `extra` carries resetsAt /
 * retryAfter / reason from the error body or headers, and where it's shown.
 * Undefined for codes this client doesn't know (the caller shows the
 * service's own message).
 */
export function describeDlError(code: string, extra: DlErrorExtra = {}): string | undefined {
  const where = extra.where ?? "session";
  const denial = dlDenialOf(code, extra.reason, extra.pausedForEveryone);
  if (denial) return dlDenialLine(denial, { ...extra, where });
  switch (code) {
    case "authorization_pending":
      return "Still waiting for you to approve the sign-in in your browser.";
    case "expired_token":
      return `The sign-in code expired before it was approved. ${where === "cli" ? `Run \`${DL_SIGN_IN_COMMAND}\` again` : "Choose Free again"} for a new code.`;
    case "access_denied":
      if (extra.reason === "device_taken") return "This device already has a free allowance under another GitHub account; sign in with that account instead.";
      return "The sign-in was declined in the browser, so nothing was saved.";
    case "invalid_grant":
      return `Your Directionally Local sign-in has expired; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
    case "invalid_token":
      return `Directionally Local didn't accept your sign-in; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
    case "quota_exceeded":
      // The token and the spending allowance read the same: both are "this week's free tokens".
      return dlQuotaLine(extra.resetsAt, { ...extra, where });
    case "free_tier_queued":
      return dlQueueLine(extra.position, extra.etaAt, { ...extra, where });
    case "suspended":
      return `This Directionally Local account is suspended, so its requests are refused. ${ownKeyNow(where)}`;
    case "rate_limited": {
      const s = extra.retryAfter && extra.retryAfter > 0 ? Math.ceil(extra.retryAfter) : undefined;
      return `Directionally Local is limiting how fast you send requests; try again${s ? ` in ${s} second${s === 1 ? "" : "s"}` : " shortly"}.`;
    }
    case "model_not_allowed":
      return `The free tier only serves ${DL_FREE_MODEL}; pick it with /model.`;
    default:
      return undefined;
  }
}

// ── Device sign-in ───────────────────────────────────────────────────────

export interface DlDeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  intervalSec: number;
  expiresInSec: number;
}

export interface DlTokens {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  expires_in?: number;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function jsonPost(url: string, body: unknown, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": getUserAgent() },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** A DlError for a parsed service error, worded for `where`, keeping what the service sent. */
function dlErrorFrom(err: { code: string } & DlErrorDetail, status: number, where: DlWhere, fallback: string): DlError {
  const { code, ...detail } = err;
  return new DlError(code, describeDlError(code, { ...detail, where }) ?? err.message ?? fallback, status, detail);
}

/** An error for a non-2xx response: the code's sentence, else the service's message, else the status. */
async function errorFrom(res: Response, what: string, where: DlWhere = "session"): Promise<DlError> {
  const err = parseDlError(await readJson(res));
  if (err) return dlErrorFrom(err, res.status, where, `${what} failed (HTTP ${res.status}).`);
  return new DlError("http_error", `${what} failed (HTTP ${res.status}).`, res.status);
}

/** Env var with an invite (referral) code to send with the sign-in; dl sets it after installing from dl.new/r/<code>. */
export const DL_REFERRAL_ENV = "DL_REFERRAL";

/** A referral code as it may be sent: letters, digits, "-" and "_", or a dl.new/r/<code> link. Undefined otherwise. */
export function cleanReferralCode(raw: string | undefined | null): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  const fromLink = /\/r\/([A-Za-z0-9_-]{1,64})\/?$/.exec(v)?.[1];
  const code = fromLink ?? v;
  return /^[A-Za-z0-9_-]{1,64}$/.test(code) ? code : undefined;
}

/**
 * The referral code to send with the next sign-in: an explicit one, else
 * DL_REFERRAL, else the config's `pendingReferral` (written by dl), with
 * where it came from so the config one can be cleared once signed in.
 */
export async function pendingDlReferral(o: { explicit?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: string; from: "explicit" | "env" | "config" } | undefined> {
  const explicit = cleanReferralCode(o.explicit);
  if (explicit) return { code: explicit, from: "explicit" };
  const fromEnv = cleanReferralCode((o.env ?? process.env)[DL_REFERRAL_ENV]);
  if (fromEnv) return { code: fromEnv, from: "env" };
  const cfg = await readPersisted();
  const saved = cleanReferralCode(cfg?.pendingReferral ?? cfg?.providers?.[DL_PROVIDER_ID]?.pendingReferral);
  return saved ? { code: saved, from: "config" } : undefined;
}

/** Forget the config's pending referral (sent with a sign-in that went through). */
export async function clearPendingDlReferral(): Promise<void> {
  const cfg = await readPersisted();
  if (!cfg) return;
  const provider = cfg.providers?.[DL_PROVIDER_ID];
  if (cfg.pendingReferral === undefined && provider?.pendingReferral === undefined) return;
  const patch: Partial<AutopilotConfig> = { pendingReferral: undefined };
  if (provider?.pendingReferral !== undefined) {
    const { pendingReferral: _drop, ...rest } = provider;
    patch.providers = { ...cfg.providers, [DL_PROVIDER_ID]: rest };
  }
  await patchPersistedConfig(patch);
}

export async function startDlDeviceFlow(
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal; where?: DlWhere; referralCode?: string } = {},
): Promise<DlDeviceCode> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${dlOrigin(opts.env)}/v1/device/code`;
  const post = async (body: Record<string, string>): Promise<Response> => {
    try {
      return await jsonPost(url, body, fetchImpl, opts.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new DlError("network", `Couldn't reach Directionally Local at ${dlOrigin(opts.env)}: ${(e as Error).message}`);
    }
  };
  const referral = cleanReferralCode(opts.referralCode);
  let res = await post(referral ? { referral_code: referral } : {});
  // A server that doesn't take this referral code (unknown, used up): sign in without it rather than not at all.
  if (!res.ok && referral && (res.status === 400 || res.status === 422)) {
    const err = parseDlError(await readJson(res.clone()));
    if (!err || !dlDenialOf(err.code, err.reason, err.pausedForEveryone)) res = await post({});
  }
  if (!res.ok) throw await errorFrom(res, "Starting the Directionally Local sign-in", opts.where ?? "signin");
  const d = (await readJson(res)) as Partial<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  }> | null;
  if (!d?.device_code || !d.user_code || !d.verification_uri) {
    throw new DlError("bad_response", "Directionally Local returned an incomplete sign-in code; try again.");
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: d.verification_uri,
    verificationUriComplete: d.verification_uri_complete ?? d.verification_uri,
    intervalSec: d.interval && d.interval > 0 ? d.interval : 5,
    expiresInSec: d.expires_in && d.expires_in > 0 ? d.expires_in : 600,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Poll until the person approves the code. `authorization_pending` waits
 * another interval, `slow_down` adds five seconds to it (RFC 8628 §3.5);
 * every other error ends the sign-in with a DlError.
 */
export async function pollDlDeviceFlow(
  code: DlDeviceCode,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; env?: NodeJS.ProcessEnv; where?: DlWhere } = {},
): Promise<DlTokens> {
  const where = opts.where ?? "signin";
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const wait = opts.sleep ?? sleep;
  const deadline = now() + code.expiresInSec * 1000;
  let intervalMs = code.intervalSec * 1000;
  const url = `${dlOrigin(opts.env)}/v1/device/token`;
  while (now() < deadline) {
    await wait(intervalMs, opts.signal);
    let res: Response;
    try {
      res = await jsonPost(url, { device_code: code.deviceCode }, fetchImpl, opts.signal);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      continue; // a dropped poll is retried at the next interval
    }
    const body = await readJson(res);
    if (res.ok) {
      const t = body as Partial<DlTokens> | null;
      if (!t?.access_token || !t.refresh_token) throw new DlError("bad_response", "Directionally Local finished the sign-in without tokens; try again.");
      return t as DlTokens;
    }
    const err = parseDlError(body);
    if (err?.code === "authorization_pending") continue;
    if (err?.code === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    if (err) throw dlErrorFrom(err, res.status, where, `Sign-in failed (HTTP ${res.status}).`);
    if (res.status >= 500) continue;
    throw new DlError("http_error", `Directionally Local sign-in failed (HTTP ${res.status}).`, res.status);
  }
  throw new DlError("expired_token", describeDlError("expired_token", { where })!);
}

// ── Token storage and refresh ────────────────────────────────────────────

/** Settings stored under providers.directionally-local. */
export function dlSettings(tokens: DlTokens, now = Date.now()): ProviderSettings {
  return {
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
  };
}

async function readPersisted(): Promise<Partial<AutopilotConfig> | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Partial<AutopilotConfig>;
  } catch {
    return null;
  }
}

/** Save tokens under providers.directionally-local (config.json is written 0600), keeping other fields. */
export async function saveDlSettings(settings: ProviderSettings): Promise<void> {
  const cfg = await readPersisted();
  await patchPersistedConfig({
    providers: { ...cfg?.providers, [DL_PROVIDER_ID]: { ...cfg?.providers?.[DL_PROVIDER_ID], ...settings } },
  });
}

let refreshing: Promise<string> | null = null;

/** Exchange the refresh token for a new pair (the old refresh token stops working) and save it. */
export async function refreshDlTokens(refreshToken: string, opts: { fetchImpl?: typeof fetch; now?: number; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await jsonPost(`${dlOrigin(opts.env)}/v1/token/refresh`, { refresh_token: refreshToken }, fetchImpl);
  if (!res.ok) throw await errorFrom(res, "Refreshing the Directionally Local sign-in");
  const t = (await readJson(res)) as Partial<DlTokens> | null;
  if (!t?.access_token) throw new DlError("bad_response", "Directionally Local returned no access token; sign in again.");
  await saveDlSettings(dlSettings({ access_token: t.access_token, refresh_token: t.refresh_token || refreshToken, ...(t.expires_in ? { expires_in: t.expires_in } : {}) }, opts.now));
  return t.access_token;
}

/**
 * The current access token: AUTOPILOT_DL_FREE_TOKEN when set (never
 * refreshed), else the saved one, refreshed when it expires within a minute
 * or when `force` is set (after a 401 `invalid_token`). Undefined when nobody
 * has signed in. A rejected refresh (`invalid_grant`) throws a DlError asking
 * to sign in again; a network failure before expiry returns the saved token.
 */
export async function dlAccessToken(
  opts: { fetchImpl?: typeof fetch; now?: number; force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const fromEnv = env[DL_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (refreshing) return refreshing;
  const now = opts.now ?? Date.now();
  const s = (await readPersisted())?.providers?.[DL_PROVIDER_ID];
  if (!s?.apiKey) return undefined;
  const fresh = !s.expiresAt || s.expiresAt - now > 60_000;
  if (!opts.force && fresh) return s.apiKey;
  if (!s.refreshToken) {
    if (opts.force || (s.expiresAt && s.expiresAt <= now)) throw new DlError("invalid_grant", describeDlError("invalid_grant")!);
    return s.apiKey;
  }
  refreshing = (async () => {
    try {
      return await refreshDlTokens(s.refreshToken!, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), now, env });
    } catch (e) {
      if (e instanceof DlError && e.status !== undefined && e.status < 500) throw e;
      // The service is unreachable: let the request go out with what we have.
      if (!opts.force && s.expiresAt && s.expiresAt > now) return s.apiKey!;
      throw e instanceof DlError ? e : new DlError("network", `Couldn't reach Directionally Local to refresh your sign-in: ${(e as Error).message}`);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// ── Account and allowance ────────────────────────────────────────────────

export interface DlAllowance {
  tokensPerWeek: number;
  usedThisWeek: number;
  remaining: number;
  resetsAt: string;
  /** The weekly spending allowance and what's spent of it (the service limits both). Null: no spending limit. */
  usdPerWeek?: number | null;
  spentUsdThisWeek?: number;
}

export interface DlMe {
  login: string;
  githubId?: number | string;
  allowance: DlAllowance;
  models?: string[];
  /** "pro" once paid; free when the service doesn't say (older servers). */
  plan?: DlPlan;
  /** Bought top-up tokens not used yet. */
  topupTokensLeft?: number;
  /** A place in line for free tokens; undefined when not queued. */
  queue?: DlQueue;
  referral?: DlReferral;
  offers?: DlOffers;
}

/**
 * /v1/me read defensively: the newer fields are kept only when well formed.
 * A queued account may have no allowance yet: it reads as an empty one.
 * Null when the body is neither.
 */
export function normalizeDlMe(raw: unknown): DlMe | null {
  if (!isRec(raw)) return null;
  const queue = parseDlQueue(raw.queue);
  const a = isRec(raw.allowance) && typeof raw.allowance.remaining === "number" ? (raw.allowance as unknown as DlAllowance) : undefined;
  if (!a && !queue) return null;
  const allowance: DlAllowance = a ?? { tokensPerWeek: 0, usedThisWeek: 0, remaining: 0, resetsAt: "" };
  const plan = raw.plan === "pro" || raw.plan === "free" ? raw.plan : undefined;
  const topup = numOf(raw, "topupTokensLeft", "topup_tokens_left");
  const referral = parseDlReferral(raw.referral);
  const offers = parseDlOffers(raw.offers);
  return {
    ...(raw as unknown as DlMe),
    login: typeof raw.login === "string" ? raw.login : "",
    allowance,
    plan,
    topupTokensLeft: topup !== undefined ? Math.max(0, topup) : undefined,
    queue,
    referral,
    offers,
  };
}

/** The account last read from /v1/me in this process (for the invite and limit screens). */
let lastMe: DlMe | null = null;
export function lastKnownDlMe(): DlMe | null {
  return lastMe;
}

/** The weekly grant last read from /v1/me in this process (for the 80% notice). */
let knownWeeklyTokens: number | undefined;

/** GET /v1/me with the access token (refreshed once on a 401 `invalid_token`). */
export async function fetchDlMe(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; token?: string } = {}): Promise<DlMe> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const call = (token: string) =>
    fetchImpl(`${dlOrigin(opts.env)}/v1/me`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": getUserAgent() },
      signal: AbortSignal.timeout(10_000),
    });
  let token = opts.token ?? (await dlAccessToken({ fetchImpl, ...(opts.env ? { env: opts.env } : {}) }));
  if (!token) throw new DlError("signed_out", `You're not signed in to Directionally Local; sign in with \`${DL_SIGN_IN_COMMAND}\`.`);
  let res = await call(token);
  if (res.status === 401 && !opts.token) {
    const err = parseDlError(await readJson(res.clone()));
    if (err?.code === "invalid_token") {
      token = await dlAccessToken({ fetchImpl, force: true, ...(opts.env ? { env: opts.env } : {}) });
      if (token) res = await call(token);
    }
  }
  if (!res.ok) throw await errorFrom(res, "Reading your Directionally Local allowance");
  const me = normalizeDlMe(await readJson(res));
  if (!me) throw new DlError("bad_response", "Directionally Local returned an unexpected account response.");
  if (me.allowance.tokensPerWeek > 0) knownWeeklyTokens = me.allowance.tokensPerWeek;
  lastMe = me;
  return me;
}

/** The last 402 quota_exceeded this process saw, so /usage can say which limit was hit. */
let lastQuota: { reason?: string; resetsAt?: string } | null = null;
export function noteDlQuotaExceeded(info: { reason?: string; resetsAt?: string }): void {
  lastQuota = { ...(info.reason ? { reason: info.reason } : {}), ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}) };
}

/** "Pro" or "Free": a missing plan (an older server) is the free tier. */
export function dlPlanName(me: Pick<DlMe, "plan">): "Pro" | "Free" {
  return me.plan === "pro" ? "Pro" : "Free";
}

/** "+30M a week of +50M" (or "+30M a week" with no cap). */
export function referralBonusText(r: Pick<DlReferral, "bonusTokensPerWeek" | "bonusCapPerWeek">): string {
  return `+${formatTokens(r.bonusTokensPerWeek)} a week${r.bonusCapPerWeek ? ` of +${formatTokens(r.bonusCapPerWeek)}` : ""}`;
}

/** `/usage`: plan, used and left this week, top-up, invite bonus, queue, and when it resets (in local time). */
export function renderDlUsage(me: DlMe, now = Date.now(), timeZone?: string): string {
  const a = me.allowance;
  const tz = timeZone ? { timeZone } : {};
  const pro = me.plan === "pro";
  const lines = [
    `Directionally Local ${pro ? "Pro" : "free tier"}${me.login ? ` · signed in as @${me.login}` : ""}`,
    `  plan            ${dlPlanName(me)}`,
  ];
  if (me.queue) {
    lines.push(`  queue           ${dlQueuePlace(me.queue.position, me.queue.etaAt, { now, ...tz }).replace(/^You're /, "").replace(/\.$/, "")}`);
    if (me.topupTokensLeft && me.topupTokensLeft > 0) lines.push(`  top-up left     ${formatTokens(me.topupTokensLeft)} tokens`);
    if (me.referral) lines.push(`  invites         ${me.referral.joined} joined · /invite moves you up`);
    return lines.join("\n");
  }
  const pct = a.tokensPerWeek > 0 ? Math.min(100, Math.round((a.usedThisWeek / a.tokensPerWeek) * 100)) : 0;
  lines.push(
    `  used this week  ${formatTokens(a.usedThisWeek)} of ${formatTokens(a.tokensPerWeek)} tokens (${pct}%)`,
    `  left            ${formatTokens(Math.max(0, a.remaining))} tokens`,
  );
  if (me.topupTokensLeft !== undefined && me.topupTokensLeft > 0) lines.push(`  top-up left     ${formatTokens(me.topupTokensLeft)} tokens`);
  if (me.referral && (me.referral.bonusTokensPerWeek > 0 || me.referral.joined > 0)) {
    lines.push(`  invite bonus    ${referralBonusText(me.referral)} (${me.referral.joined} joined, ${me.referral.activeThisWeek} active this week)`);
  }
  // The weekly spending limit counts too ($5 unless the service says otherwise; null from the service means none). Not on Pro.
  const limit = a.usdPerWeek === undefined ? (pro ? null : DL_FREE_WEEKLY_USD) : a.usdPerWeek;
  if (typeof limit === "number" && limit > 0) {
    const spent = typeof a.spentUsdThisWeek === "number" ? a.spentUsdThisWeek : undefined;
    lines.push(`  spending limit  ${spent === undefined ? `${formatUsd(limit)} a week` : `spent ${formatUsd(spent)} of ${formatUsd(limit)}`}`);
  }
  lines.push(`  resets          ${formatReset(a.resetsAt || undefined, now, timeZone)}`);
  // A 402 from this week (same reset) still counts when /v1/me rounds it differently.
  const seen = lastQuota && (!lastQuota.resetsAt || lastQuota.resetsAt === a.resetsAt) ? lastQuota : null;
  const spendHit =
    (typeof a.usdPerWeek === "number" && a.usdPerWeek > 0 && typeof a.spentUsdThisWeek === "number" && a.spentUsdThisWeek >= a.usdPerWeek) ||
    seen?.reason === "spend";
  const topupLeft = (me.topupTokensLeft ?? 0) > 0;
  // The token and the spending allowance read the same: either way this week's free tokens are used.
  if ((a.remaining <= 0 || spendHit) && !topupLeft) lines.push(`  ${dlQuotaLine(a.resetsAt || undefined, { now, ...tz })}`);
  else if (pct >= 80 && !topupLeft) lines.push(`  You've used ${pct}% of this week's tokens.`);
  return lines.join("\n");
}

/** "✓ Signed in as @octo · 50M free tokens this week · back every Monday", from /v1/me. */
export function dlSignedInLine(me: DlMe | null, o: DlTimeOpts = {}): string {
  const tokens = me && me.allowance.tokensPerWeek > 0 ? me.allowance.tokensPerWeek : DL_FREE_WEEKLY_TOKENS;
  return `✓ Signed in${me?.login ? ` as @${me.login}` : ""} · ${formatTokens(tokens)} free tokens this week · back every ${localResetWeekday(me?.allowance.resetsAt, o)}`;
}

let noticeShownFor: string | null = null;

/**
 * The one-line notice once 80% of the week is used, from an inference
 * response's headers; shown once per week per process. Undefined otherwise.
 */
export function quotaNoticeFromHeaders(headers: Headers, opts: { weeklyTokens?: number; now?: number; timeZone?: string } = {}): string | undefined {
  const raw = headers.get("x-dl-tokens-remaining");
  if (raw === null) return undefined;
  const remaining = Number(raw);
  if (!Number.isFinite(remaining)) return undefined;
  const total = opts.weeklyTokens ?? knownWeeklyTokens ?? DL_FREE_WEEKLY_TOKENS;
  if (total <= 0 || remaining > total * 0.2) return undefined;
  const resetsAt = headers.get("x-dl-quota-resets-at") ?? "";
  if (noticeShownFor === resetsAt) return undefined;
  noticeShownFor = resetsAt;
  const used = Math.min(100, Math.max(80, Math.floor(((total - remaining) / total) * 100)));
  return `You've used ${used}% of this week's free Directionally Local tokens (${formatTokens(Math.max(0, remaining))} left, resets ${formatReset(resetsAt || undefined, opts.now, opts.timeZone)}); /usage has details.`;
}

/** Test hook: forget the shown notice and the cached weekly grant. */
export function resetDlNoticeState(): void {
  noticeShownFor = null;
  lastMe = null;
  lastQuota = null;
  knownWeeklyTokens = undefined;
}

/** Device sign-in end to end: show the code, poll, save the tokens. Returns the access token. */
export async function dlSignIn(
  onCode: (code: DlDeviceCode) => void,
  opts: {
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    where?: DlWhere;
    /** `--referral <code>`: wins over DL_REFERRAL and the config's pending referral. */
    referralCode?: string;
  } = {},
): Promise<string> {
  const referral = await pendingDlReferral({ ...(opts.referralCode ? { explicit: opts.referralCode } : {}), ...(opts.env ? { env: opts.env } : {}) }).catch(() => undefined);
  const code = await startDlDeviceFlow({ ...opts, ...(referral ? { referralCode: referral.code } : {}) });
  onCode(code);
  const tokens = await pollDlDeviceFlow(code, opts);
  await saveDlSettings(dlSettings(tokens));
  // Signed in: the referral has been used (or the account already had one); don't send it again.
  if (referral) await clearPendingDlReferral().catch(() => undefined);
  // Approved in the browser: bring the terminal back (macOS; silent otherwise).
  void import("../util/refocus-terminal.js").then((m) => m.refocusTerminal(opts.env ? { env: opts.env } : {})).catch(() => {});
  return tokens.access_token;
}

// ── Billing ──────────────────────────────────────────────────────────────

export type DlProduct = "pro" | "topup";

/** An authorized call to the service, refreshing the access token once after a 401 `invalid_token`. */
async function dlAuthedPost(path: string, body: unknown, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }, what: string): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ? { env: opts.env } : {};
  const call = (token: string) =>
    fetchImpl(`${dlOrigin(opts.env)}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": getUserAgent() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  let token = await dlAccessToken({ fetchImpl, ...env });
  if (!token) throw new DlError("signed_out", `You're not signed in to Directionally Local; sign in with \`${DL_SIGN_IN_COMMAND}\`.`);
  let res: Response;
  try {
    res = await call(token);
    if (res.status === 401) {
      const err = parseDlError(await readJson(res.clone()));
      if (err?.code === "invalid_token") {
        token = await dlAccessToken({ fetchImpl, force: true, ...env });
        if (token) res = await call(token);
      }
    }
  } catch (e) {
    if (e instanceof DlError) throw e;
    throw new DlError("network", `Couldn't reach Directionally Local: ${(e as Error).message}`);
  }
  if (res.status === 404 || res.status === 405) throw new DlError("unsupported", "Paid plans aren't available from this Directionally Local server yet.", res.status);
  if (!res.ok) throw await errorFrom(res, what);
  return readJson(res);
}

function urlFrom(body: unknown, what: string): string {
  const url = isRec(body) ? strOf(body, "url") : undefined;
  if (!url || !/^https:\/\//i.test(url)) throw new DlError("bad_response", `Directionally Local returned no link for ${what}; try again.`);
  return url;
}

/** POST /v1/billing/checkout: the payment page for Pro or a top-up. */
export async function dlCheckout(product: DlProduct, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return urlFrom(await dlAuthedPost("/v1/billing/checkout", { product }, opts, "Starting the checkout"), "the checkout");
}

/** POST /v1/billing/portal: where a Pro plan is managed or cancelled. */
export async function dlBillingPortal(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return urlFrom(await dlAuthedPost("/v1/billing/portal", {}, opts, "Opening the billing page"), "the billing page");
}

// ── Sign-out ─────────────────────────────────────────────────────────────

/** What signing out did on the service: revoked, not offered there yet (404), unreachable, or nothing to revoke. */
export type DlRevokeResult = "revoked" | "unsupported" | "unreachable" | "nothing";

/**
 * Ask the service to revoke a sign-in: POST /v1/token/revoke with the refresh
 * token (and the access token as Bearer). A 404 counts as already signed
 * out on the service; local tokens are cleared either way.
 */
export async function revokeDlTokens(
  tokens: { accessToken?: string; refreshToken?: string },
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<DlRevokeResult> {
  if (!tokens.accessToken && !tokens.refreshToken) return "nothing";
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${dlOrigin(opts.env)}/v1/token/revoke`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        ...(tokens.accessToken ? { Authorization: `Bearer ${tokens.accessToken}` } : {}),
      },
      body: JSON.stringify(tokens.refreshToken ? { refresh_token: tokens.refreshToken } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404 || res.status === 405) return "unsupported";
    // An already-invalid token is as good as revoked.
    if (res.ok || res.status === 400 || res.status === 401) return "revoked";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** The free-tier fields kept under providers.directionally-local that are credentials. */
export const DL_CREDENTIAL_FIELDS = ["apiKey", "refreshToken", "expiresAt"] as const;

/** Drop the free tier's credentials from its saved settings, keeping anything else (base URL, model). */
export function withoutDlCredentials(settings: ProviderSettings | undefined): ProviderSettings {
  const next: ProviderSettings = { ...settings };
  for (const k of DL_CREDENTIAL_FIELDS) delete next[k];
  return next;
}

/** One line saying exactly what signing out removed, and what the service did. */
export function dlSignOutLine(r: { removedAccess: boolean; removedRefresh: boolean; revoke: DlRevokeResult; path: string; envToken?: boolean }): string {
  const removed = [r.removedAccess ? "access token" : "", r.removedRefresh ? "refresh token" : ""].filter(Boolean);
  const parts: string[] = [];
  if (removed.length === 0) parts.push(`No Directionally Local free-tier sign-in was saved in ${r.path}; nothing was removed.`);
  else parts.push(`Removed the Directionally Local free-tier ${removed.join(" and ")} from ${r.path}.`);
  if (r.revoke === "revoked") parts.push("The service revoked the sign-in.");
  else if (r.revoke === "unsupported") parts.push("The service had nothing to revoke.");
  else if (r.revoke === "unreachable") parts.push("Couldn't reach the service to revoke it; the refresh token stops working on its own within 30 days.");
  if (r.envToken) parts.push(`${DL_TOKEN_ENV} is still set in your environment.`);
  return parts.join(" ");
}

/**
 * `autopilot auth logout directionally-local`: revoke on the service (best
 * effort), then remove the access and refresh tokens from config.json.
 */
export async function dlSignOut(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  const cfg = await readPersisted();
  const s = cfg?.providers?.[DL_PROVIDER_ID];
  const tokens = { ...(s?.apiKey ? { accessToken: s.apiKey } : {}), ...(s?.refreshToken ? { refreshToken: s.refreshToken } : {}) };
  const revoke = await revokeDlTokens(tokens, opts);
  if (s && (s.apiKey || s.refreshToken || s.expiresAt)) {
    await patchPersistedConfig({ providers: { ...cfg?.providers, [DL_PROVIDER_ID]: withoutDlCredentials(s) } });
  }
  return dlSignOutLine({
    removedAccess: !!s?.apiKey,
    removedRefresh: !!s?.refreshToken,
    revoke,
    path: configPath(),
    envToken: !!(opts.env ?? process.env)[DL_TOKEN_ENV]?.trim(),
  });
}
