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
import { configPath, patchPersistedConfig, setSessionModelFallback, type AutopilotConfig } from "../config.js";
import { getUserAgent } from "../util/version.js";
import type { ProviderSettings } from "./resolve.js";
import type { ModelEntry } from "../models/registry.js";
import { DL_FREE_DEFAULT_MODEL, dlOrigin } from "./dl-endpoint.js";
import { launchedByDl, type EnvLike } from "../util/env.js";

export { DL_FREE_DEFAULT_URL, dlApiBase, dlOrigin } from "./dl-endpoint.js";

export const DL_PROVIDER_ID = "directionally-local" as const;

/** A model the free tier serves, and the weekly token pool it draws from. */
export interface DlFreeModel {
  id: string;
  name: string;
  /** GPT-6 Luna and DeepSeek shared one pool on older servers; Sol and Astra have their own. */
  pool: "luna" | "sol" | "astra";
  /** The weekly dollar budget it spends: every GPT-6 model shares one, DeepSeek has its own. */
  family: DlFamily;
  contextWindow: number;
  maxOutputTokens: number;
  vision: boolean;
  reasoning: boolean;
}

/** Every model the free tier serves. GPT-6 Luna is the default; DeepSeek is its fallback. */
export const DL_FREE_MODELS: readonly DlFreeModel[] = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", pool: "luna", family: "gpt6", contextWindow: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", pool: "sol", family: "gpt6", contextWindow: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true },
  { id: "gpt-6-astra", name: "GPT-6 Astra", pool: "astra", family: "gpt6", contextWindow: 1_050_000, maxOutputTokens: 128_000, vision: true, reasoning: true },
  { id: "deepseek/deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash", pool: "luna", family: "deepseek", contextWindow: 1_048_576, maxOutputTokens: 65_536, vision: false, reasoning: true },
];

/** The default free model: GPT-6 Luna. */
export const DL_FREE_MODEL = DL_FREE_DEFAULT_MODEL;
/** The weekly grant per person, for picker copy and as a fallback before /v1/me has been read. */
export const DL_FREE_WEEKLY_TOKENS = 50_000_000;
/** What each invited friend who becomes weekly active adds a week, for both people. */
export const DL_INVITE_BONUS_TOKENS = 10_000_000;
/** The most invites add a week, when the service didn't say. */
export const DL_INVITE_BONUS_CAP_TOKENS = 50_000_000;
/** Env var holding an access token (no refresh): sandboxes and short headless runs. */
export const DL_TOKEN_ENV = "AUTOPILOT_DL_FREE_TOKEN";
export const DL_SIGN_IN_COMMAND = "autopilot auth directionally-local";
/** Under dl there is no `autopilot` command: the free tier is signed into from /provider. */
export const DL_FREE_SIGN_IN_AGAIN = "Run /provider and choose Free to sign in again.";
/** The sentence for a dead sign-in: dl names /provider, standalone the `autopilot auth` command. */
export function dlSignInExpiredLine(env: EnvLike = process.env): string {
  return launchedByDl(env) ? `Your free-tier sign-in expired. ${DL_FREE_SIGN_IN_AGAIN}` : `Your Directionally Local sign-in has expired; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
}
/** Not signed in at all. */
export function dlSignedOutLine(env: EnvLike = process.env): string {
  return launchedByDl(env) ? "You're not signed in to the free tier. Run /provider and choose Free to sign in." : `You're not signed in to Directionally Local; sign in with \`${DL_SIGN_IN_COMMAND}\`.`;
}
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

/** One free model as a catalog entry, priced at $0 (it comes out of the weekly allowance). */
export function dlFreeModelEntry(id: string = DL_FREE_MODEL): ModelEntry {
  const model = DL_FREE_MODELS.find((entry) => entry.id === id) ?? DL_FREE_MODELS[0]!;
  return {
    id: model.id,
    name: `${model.name} (free)`,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: model.reasoning, streaming: true, vision: model.vision },
  };
}

/** Every free model as a catalog entry, for the picker and /model list. */
export function dlFreeModelEntries(): ModelEntry[] {
  return DL_FREE_MODELS.map((model) => dlFreeModelEntry(model.id));
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
  return `free — GPT-6 Luna + DeepSeek, ${formatTokens(DL_FREE_WEEKLY_TOKENS)} tokens/week, sign in with GitHub`;
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

/** The codes that mean the sign-in must be renewed (not a transient failure). */
const DL_AUTH_CODES = new Set(["invalid_grant", "invalid_token", "signed_out", "expired_token"]);

/** True when `err` is a Directionally Local auth failure that needs a new sign-in. */
export function isDlAuthError(err: unknown): err is DlError {
  return err instanceof DlError && DL_AUTH_CODES.has(err.code);
}

/** The sign-in prompt for an auth failure (the error's own sentence, or a default). */
export function dlAuthPrompt(err?: unknown): string {
  return err instanceof DlError ? err.message : "Your Directionally Local sign-in expired. Run `autopilot auth directionally-local` to sign in again.";
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
  /** The service says trying again may work (its upstream's transient trouble). */
  retryable?: boolean;
  /** below_bar, basic_limit: where to ask for more free tokens (/request); older servers send none. */
  request?: string;
  /** gpt_limit: the budget that ran out ("gpt6") and the model that still has usage this week. */
  family?: string;
  alternative?: string;
}

// ── Plans, offers, invites and the queue (all optional: older servers send none) ──

/** Pro: a monthly plan with a bigger weekly allowance. */
export interface DlProOffer {
  priceUsdMonthly: number;
  /** The price exactly as the service wants it shown ("$3.99/month"); newer servers send it. */
  price?: string;
  /** Pro's weekly tokens, when the service says. */
  tokensPerWeek?: number;
  /** Pro's weekly dollar ceiling; null: tokens only. */
  usdPerWeek?: number | null;
  /** One short sentence about what Pro gives, from the service. */
  valueLine?: string;
}

/**
 * A one-time top-up. Newer servers sell usage dollars: `quantity` units of
 * `unitPriceUsd` (from `minQuantity` to `maxQuantity`), each adding
 * `usageMultiplier` times its price. Older servers sold tokens
 * (`priceUsd` for `tokens`).
 */
export interface DlTopupOffer {
  unitPriceUsd?: number;
  minQuantity?: number;
  maxQuantity?: number;
  usageMultiplier?: number;
  priceUsd?: number;
  tokens?: number;
  /** How long a top-up lasts, when the service says. */
  validDays?: number;
}

/** A dollar top-up offer (usage dollars, a quantity of $1 units), as opposed to the old token kind. */
export type DlUsdTopupOffer = DlTopupOffer & { unitPriceUsd: number; minQuantity: number; maxQuantity: number; usageMultiplier: number };

export function isUsdTopup(t: DlTopupOffer | undefined): t is DlUsdTopupOffer {
  return !!t && t.unitPriceUsd !== undefined && t.minQuantity !== undefined && t.maxQuantity !== undefined && t.usageMultiplier !== undefined;
}

/** Pro's price as the service says to show it ("$3.99/month"), never rounded here. */
export function dlProPrice(pro: DlProOffer): string {
  return pro.price ?? `${formatUsd(pro.priceUsdMonthly)}/month`;
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
    const label = strOf(raw.pro, "price");
    const tokens = numOf(raw.pro, "tokensPerWeek", "tokens_per_week");
    const usd = numOf(raw.pro, "usdPerWeek", "usd_per_week");
    const valueLine = strOf(raw.pro, "valueLine", "value_line");
    if (price !== undefined && price > 0) {
      out.pro = {
        priceUsdMonthly: price,
        ...(label && label.length <= 40 ? { price: label.trim() } : {}),
        ...(tokens !== undefined && tokens > 0 ? { tokensPerWeek: tokens } : {}),
        ...(usd !== undefined && usd > 0 ? { usdPerWeek: usd } : raw.pro.usdPerWeek === null ? { usdPerWeek: null } : {}),
        ...(valueLine && valueLine.length <= 120 ? { valueLine: valueLine.trim() } : {}),
      };
    }
  }
  if (isRec(raw.topup)) {
    const days = numOf(raw.topup, "validDays", "valid_days");
    const valid = days !== undefined && days > 0 ? { validDays: days } : {};
    const unit = numOf(raw.topup, "unitPriceUsd", "unit_price_usd");
    const min = numOf(raw.topup, "minQuantity", "min_quantity");
    const max = numOf(raw.topup, "maxQuantity", "max_quantity");
    const multiplier = numOf(raw.topup, "usageMultiplier", "usage_multiplier");
    const price = numOf(raw.topup, "priceUsd", "price_usd");
    const tokens = numOf(raw.topup, "tokens");
    if (unit !== undefined && unit > 0 && min !== undefined && max !== undefined && Number.isInteger(min) && Number.isInteger(max) && min >= 1 && max >= min && multiplier !== undefined && multiplier > 0) {
      out.topup = { unitPriceUsd: unit, minQuantity: min, maxQuantity: max, usageMultiplier: multiplier, ...valid };
    } else if (price !== undefined && price > 0 && tokens !== undefined && tokens > 0) {
      out.topup = { priceUsd: price, tokens, ...valid };
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

/** The pools block of /v1/me, keeping only well-formed entries. Undefined when there are none. */
export function parseDlPools(raw: unknown): Record<string, DlPool> | undefined {
  if (!isRec(raw)) return undefined;
  const out: Record<string, DlPool> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!isRec(value)) continue;
    const tokensPerWeek = numOf(value, "tokensPerWeek", "tokens_per_week");
    const remaining = numOf(value, "remaining");
    if (tokensPerWeek === undefined || remaining === undefined) continue;
    const used = numOf(value, "usedThisWeek", "used_this_week") ?? Math.max(0, tokensPerWeek - remaining);
    const resetsAt = strOf(value, "resetsAt", "resets_at");
    const models = Array.isArray(value.models) ? value.models.filter((id): id is string => typeof id === "string") : [];
    out[name] = {
      tokensPerWeek,
      usedThisWeek: used,
      remaining,
      ...(resetsAt ? { resetsAt } : {}),
      models,
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  /** Picks dl's wording when dl started this process; default process.env. */
  env?: EnvLike;
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
  const retryable = e.retryable === true;
  const request = str("request");
  const family = str("family");
  const alternative = str("alternative");
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
    ...(family ? { family } : {}),
    ...(alternative ? { alternative } : {}),
    ...(retryable ? { retryable } : {}),
    ...(request ? { request } : {}),
  };
}

/** Added to a below_bar or basic_limit refusal in a session when the service says where to ask (`request`). */
export const DL_REQUEST_HINT = "type /request to ask for more free tokens.";

/** The refusal's line, with the /request hint on its own line when the service sent `request` (sessions only). */
function withRequestHint(line: string, extra: DlErrorExtra, where: DlWhere): string {
  return extra.request && where === "session" ? `${line}\n${DL_REQUEST_HINT}` : line;
}

/** The free tier's transient codes: its own rate limit and its upstream's trouble. Retried with the shared policy. */
export const DL_RETRYABLE_CODES: ReadonlySet<string> = new Set(["rate_limited", "upstream_busy", "upstream_unavailable", "upstream_timeout"]);
/** Never retried, whatever the body says: free tokens are paused until the service tops up. */
export const DL_CREDIT_EXHAUSTED = "upstream_credit_exhausted";
/** upstream_busy without a Retry-After: wait this long. */
export const DL_BUSY_RETRY_AFTER_MS = 5_000;

/** Whether a free-tier error is worth trying again: a transient code, or any the service marks `retryable: true`. */
export function dlRetryable(code: string, retryable?: boolean): boolean {
  if (code === DL_CREDIT_EXHAUSTED) return false;
  return DL_RETRYABLE_CODES.has(code) || retryable === true;
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
      if (where === "session") return `This GitHub account isn't on the free tier. ${ownKeyNow(where)}`;
      return `This GitHub account needs an invite code for the free tier. Have one? ${again} ${ownKey}`;
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

/**
 * "Get dl Pro for $3.99/month: /upgrade" when the service offers Pro and the
 * account isn't on it (`autopilot upgrade` outside a session). Undefined otherwise.
 */
export function dlProLine(offers: DlOffers | undefined, o: { where?: DlWhere; plan?: DlPlan } = {}): string | undefined {
  if (!offers?.pro || o.plan === "pro") return undefined;
  return `Get dl Pro for ${dlProPrice(offers.pro)}: ${o.where === "cli" ? "`autopilot upgrade`" : "/upgrade"}`;
}

/**
 * "You've used this week's free usage. It's back Mon 09:00. To keep going now: /provider to use
 * your own key. Get dl Pro for $3.99/month: /upgrade" (the last sentence only when the service
 * offers Pro and the account isn't on it). On Pro, "this week's Pro usage".
 */
export function dlQuotaLine(resetsAt: string | undefined, o: DlTimeOpts & { where?: DlWhere; offers?: DlOffers; plan?: DlPlan } = {}): string {
  const back = formatLocalTime(resetsAt ?? nextWeekStart(o.now), o);
  const next = o.where === "cli" ? "To keep going now, use your own key: `autopilot connect`." : `To keep going now: ${DL_SWITCH_HINT} to use your own key.`;
  const pro = dlProLine(o.offers, { ...(o.where ? { where: o.where } : {}), ...(o.plan ? { plan: o.plan } : {}) });
  return `You've used this week's ${o.plan === "pro" ? "Pro" : "free"} usage. It's back ${back}. ${next}${pro ? ` ${pro}` : ""}`;
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
  // Paused until the service tops up its credit: like the global pause, with the own-key way on.
  if (code === DL_CREDIT_EXHAUSTED) {
    const next = where === "session" ? `Your own key still works: ${DL_SWITCH_HINT}` : where === "cli" ? "Your own key still works: `autopilot connect`." : "Your own key still works.";
    return `Free tokens are paused while we top up. ${next}`;
  }
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
      return dlSignInExpiredLine(extra.env);
    case "invalid_token":
      return launchedByDl(extra.env ?? process.env)
        ? `The free tier didn't accept your sign-in. ${DL_FREE_SIGN_IN_AGAIN}`
        : `Directionally Local didn't accept your sign-in; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
    case "quota_exceeded":
      // The token and the spending allowance read the same: both are "this week's free usage".
      return dlQuotaLine(extra.resetsAt, { ...extra, where, ...planOf(lastMe) });
    case "basic_limit":
    case "starter_limit":
      // A basic or starter account used its smaller weekly allowance: the same line, and where to ask for more.
      return withRequestHint(dlQuotaLine(extra.resetsAt, { ...extra, where, ...planOf(lastMe) }), extra, where);
    case "upstream_busy":
      return "The free tier is busy right now; try again shortly.";
    case "upstream_unavailable":
      return "The free tier's model host is unavailable right now; try again shortly.";
    case "upstream_timeout":
      return "The free tier's model host took too long to answer; try again shortly.";
    case "free_tier_queued":
      return dlQueueLine(extra.position, extra.etaAt, { ...extra, where });
    case "suspended":
      return `This Directionally Local account is suspended, so its requests are refused. ${ownKeyNow(where)}`;
    case "below_bar":
      // The account is below the free tier's bar; the service's sentence says who free tokens
      // are for and how to ask for credits anyway.
      return withRequestHint(
        extra.message ??
          "Free tokens are for established GitHub accounts. Email contact@directionallylocal.com and tell us what you want to build with dl, and we'll give you free credits. Or use your own API key with /provider.",
        extra,
        where,
      );
    case "dl_only":
      // Free tokens were used from another tool; the service's sentence says what to do.
      return extra.message ?? "Free tokens work inside dl only. Run dl to keep using them, or use your own API key in any tool.";
    case "rate_limited": {
      const s = extra.retryAfter && extra.retryAfter > 0 ? Math.ceil(extra.retryAfter) : undefined;
      return `Directionally Local is limiting how fast you send requests; try again${s ? ` in ${s} second${s === 1 ? "" : "s"}` : " shortly"}.`;
    }
    case "model_not_allowed":
      return `The free tier serves ${DL_FREE_MODELS.map((model) => model.id).join(", ")}; pick one with /model.`;
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

/** How long to wait before re-reading config.json once more after a lost refresh race. */
const ROTATED_RECHECK_MS = 750;

/**
 * The pair another process saved after rotating `usedRefreshToken`, if any.
 * Refresh tokens rotate, so with several sessions on one machine the loser of
 * a concurrent refresh gets `invalid_grant` for a token the winner already
 * swapped and saved. Re-read config.json (twice: the winner may still be
 * writing) and take its pair instead of asking to sign in again.
 */
async function rotatedElsewhere(usedRefreshToken: string, sleep: (ms: number) => Promise<void>): Promise<string | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(ROTATED_RECHECK_MS + Math.floor(Math.random() * ROTATED_RECHECK_MS));
    const s = (await readPersisted())?.providers?.[DL_PROVIDER_ID];
    if (s?.apiKey && s.refreshToken && s.refreshToken !== usedRefreshToken) return s.apiKey;
  }
  return undefined;
}

/** Exchange the refresh token for a new pair (the old refresh token stops working) and save it. */
export async function refreshDlTokens(
  refreshToken: string,
  opts: { fetchImpl?: typeof fetch; now?: number; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await jsonPost(`${dlOrigin(opts.env)}/v1/token/refresh`, { refresh_token: refreshToken }, fetchImpl);
  if (!res.ok) {
    const err = await errorFrom(res, "Refreshing the Directionally Local sign-in");
    if (err.code === "invalid_grant") {
      const rotated = await rotatedElsewhere(refreshToken, opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))));
      if (rotated) return rotated;
    }
    throw err;
  }
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
  opts: { fetchImpl?: typeof fetch; now?: number; force?: boolean; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void> } = {},
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
    if (opts.force || (s.expiresAt && s.expiresAt <= now)) throw new DlError("invalid_grant", describeDlError("invalid_grant", { env })!);
    return s.apiKey;
  }
  refreshing = (async () => {
    try {
      return await refreshDlTokens(s.refreshToken!, { ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}), ...(opts.sleep ? { sleep: opts.sleep } : {}), now, env });
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

/** A weekly dollar budget: every GPT-6 model shares "gpt6"; DeepSeek has "deepseek". */
export type DlFamily = "gpt6" | "deepseek";

/** The DeepSeek model: where a GPT-6 limit points. */
export const DL_DEEPSEEK_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/**
 * One weekly dollar budget, from /v1/me's `budgets`. `tokensThisWeek` counts every token
 * processed (prompt tokens with cached ones, plus completion tokens), when the server says.
 */
export interface DlBudget {
  /** Null: no dollar cap. */
  usdPerWeek: number | null;
  spentUsd: number;
  tokensThisWeek?: number;
}

/** One weekly token pool: what a model tier has left this week. */
export interface DlPool {
  tokensPerWeek: number;
  usedThisWeek: number;
  remaining: number;
  resetsAt?: string;
  /** The model ids that draw from this pool. */
  models: string[];
}

/** The thresholds a Full account must clear, as the service reports them. */
export interface DlThresholds {
  minAccountAgeDays: number;
  minPublicRepos: number;
  minContributions: number;
}

export interface DlMe {
  login: string;
  githubId?: number | string;
  allowance: DlAllowance;
  /** "full" or "starter": what this account may use (older servers don't say). */
  level?: "full" | "starter";
  /** Why the level is what it is, when the service says. */
  levelReason?: string | null;
  /** The thresholds a Full account must clear, when the service says. */
  thresholds?: DlThresholds;
  /** Each model tier's weekly allowance, when the service sends it (older servers don't). */
  pools?: Record<string, DlPool>;
  /** The two weekly dollar budgets, GPT-6 and DeepSeek, when the service sends them (older servers have one). */
  budgets?: Partial<Record<DlFamily, DlBudget>>;
  models?: string[];
  /** "pro" once paid; free when the service doesn't say (older servers). */
  plan?: DlPlan;
  /** Bought top-up tokens not used yet (the old token top-ups). */
  topupTokensLeft?: number;
  /** Dollar top-ups: usage dollars left, and when the soonest-expiring one with usage left ends. */
  topupUsdLeft?: number;
  topupUsdExpiresAt?: string;
  /** A place in line for free tokens; undefined when not queued. */
  queue?: DlQueue;
  referral?: DlReferral;
  offers?: DlOffers;
}

/** One budget of /v1/me's `budgets`, kept only when well formed. */
function parseDlBudget(raw: unknown): DlBudget | undefined {
  if (!isRec(raw)) return undefined;
  const usd = raw.usdPerWeek;
  const spent = raw.spentUsd;
  if (!(usd === null || (typeof usd === "number" && Number.isFinite(usd) && usd >= 0)) || typeof spent !== "number" || !Number.isFinite(spent)) return undefined;
  const tokens = raw.tokensThisWeek;
  return { usdPerWeek: usd, spentUsd: Math.max(0, spent), ...(typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? { tokensThisWeek: tokens } : {}) };
}

/** /v1/me's `budgets` (or `allowance.budgets`): both kept when well formed; undefined with neither. */
export function parseDlBudgets(raw: unknown): Partial<Record<DlFamily, DlBudget>> | undefined {
  if (!isRec(raw)) return undefined;
  const gpt6 = parseDlBudget(raw.gpt6);
  const deepseek = parseDlBudget(raw.deepseek);
  if (!gpt6 && !deepseek) return undefined;
  return { ...(gpt6 ? { gpt6 } : {}), ...(deepseek ? { deepseek } : {}) };
}

/** The thresholds block of /v1/me, keeping only well-formed numbers. */
function parseDlThresholds(raw: unknown): DlThresholds | undefined {
  if (!isRec(raw)) return undefined;
  const age = raw.minAccountAgeDays;
  const repos = raw.minPublicRepos;
  const contributions = raw.minContributions;
  if (typeof age !== "number" || typeof repos !== "number" || typeof contributions !== "number") return undefined;
  return { minAccountAgeDays: age, minPublicRepos: repos, minContributions: contributions };
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
  const topupUsd = numOf(raw, "topupUsdLeft", "topup_usd_left");
  const topupUsdExpiresAt = strOf(raw, "topupUsdExpiresAt", "topup_usd_expires_at");
  const referral = parseDlReferral(raw.referral);
  const offers = parseDlOffers(raw.offers);
  const pools = parseDlPools(raw.pools);
  const level = raw.level === "full" || raw.level === "starter" ? raw.level : undefined;
  const levelReason = typeof raw.levelReason === "string" ? raw.levelReason : undefined;
  const thresholds = parseDlThresholds(raw.thresholds);
  const budgets = parseDlBudgets(raw.budgets) ?? (a ? parseDlBudgets((a as unknown as Record<string, unknown>).budgets) : undefined);
  return {
    ...(raw as unknown as DlMe),
    login: typeof raw.login === "string" ? raw.login : "",
    allowance,
    ...(level ? { level } : {}),
    ...(levelReason !== undefined ? { levelReason } : {}),
    ...(thresholds ? { thresholds } : {}),
    ...(pools ? { pools } : {}),
    ...(budgets ? { budgets } : {}),
    plan,
    topupTokensLeft: topup !== undefined ? Math.max(0, topup) : undefined,
    topupUsdLeft: topupUsd !== undefined ? Math.max(0, topupUsd) : undefined,
    topupUsdExpiresAt: topupUsdExpiresAt && Number.isFinite(Date.parse(topupUsdExpiresAt)) ? topupUsdExpiresAt : undefined,
    queue,
    referral,
    offers,
  };
}

/** The account last read from /v1/me in this process (for the invite and limit screens). */
let lastMe: DlMe | null = null;

/** `{plan}` from an account read, for the limit lines (nothing when unknown). */
function planOf(me: Pick<DlMe, "plan"> | null | undefined): { plan?: DlPlan } {
  return me?.plan ? { plan: me.plan } : {};
}
export function lastKnownDlMe(): DlMe | null {
  return lastMe;
}

/** Test hook: pretend /v1/me said this. */
export function setLastKnownDlMe(me: DlMe | null): void {
  lastMe = me;
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
  if (!token) throw new DlError("signed_out", dlSignedOutLine(opts.env));
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

/**
 * True when inviting still adds tokens: the free tier (not Pro), an invite
 * link, and the invite bonus below its cap.
 */
export function dlInviteCanAdd(me: DlMe | null | undefined): me is DlMe & { referral: DlReferral } {
  if (!me || me.plan === "pro" || !me.referral?.link) return false;
  return me.referral.bonusTokensPerWeek < (me.referral.bonusCapPerWeek ?? DL_INVITE_BONUS_CAP_TOKENS);
}

/** The weekly dollar cap when the service sends one (a positive number); undefined otherwise. */
function dollarCap(a: DlAllowance | undefined): number | undefined {
  return a && typeof a.usdPerWeek === "number" && a.usdPerWeek > 0 ? a.usdPerWeek : undefined;
}

/**
 * True when this week's allowance is used up: its dollar cap is spent, its tokens are gone, or
 * a 402 this week (same reset) said so.
 */
function weekUsedUp(a: DlAllowance): boolean {
  const cap = dollarCap(a);
  const seen = lastQuota && (!lastQuota.resetsAt || lastQuota.resetsAt === a.resetsAt) ? lastQuota : null;
  return a.remaining <= 0 || (cap !== undefined && (a.spentUsdThisWeek ?? 0) >= cap) || seen?.reason === "spend";
}

/** "this week: $1.20 of $3 free usage", or "limit reached, resets Mon 09:00" once it is used up. */
export function dlWeekUsageText(me: Pick<DlMe, "allowance" | "plan">, o: DlTimeOpts = {}): string | undefined {
  const a = me.allowance;
  const cap = dollarCap(a);
  if (weekUsedUp(a)) return `limit reached, resets ${formatLocalTime(a.resetsAt || nextWeekStart(o.now), o)}`;
  if (cap === undefined) return undefined;
  return `this week: ${formatUsd(a.spentUsdThisWeek ?? 0)} of ${formatUsd(cap)} ${me.plan === "pro" ? "Pro" : "free"} usage`;
}

/** /usage's hint while GPT-6's week is used up and DeepSeek's isn't. */
export const DL_GPT_LIMIT_HINT = "GPT-6 is used up this week; DeepSeek V4.1 Flash still has free usage: switch with /model.";

/** The budget's name as /usage and the header show it. */
export function dlFamilyLabel(family: DlFamily): string {
  return family === "gpt6" ? "gpt-6" : "deepseek";
}

/** True when a budget's dollars are spent this week. */
export function dlBudgetUsedUp(b: DlBudget): boolean {
  return typeof b.usdPerWeek === "number" && b.spentUsd >= b.usdPerWeek;
}

/**
 * One budget's week: "$1.20 of $8 this week · 58M tokens" (dollars first: they are the limit
 * that binds; tokens counted the normal way, cached included), or "limit reached, resets Mon
 * 09:00" once its dollars are spent.
 */
export function dlBudgetText(b: DlBudget, resetsAt: string | undefined, o: DlTimeOpts = {}): string {
  if (dlBudgetUsedUp(b)) return `limit reached, resets ${formatLocalTime(resetsAt || nextWeekStart(o.now), o)}`;
  const dollars = b.usdPerWeek === null ? `${formatUsd(b.spentUsd)} this week, no cap` : `${formatUsd(b.spentUsd)} of ${formatUsd(b.usdPerWeek)} this week`;
  return b.tokensThisWeek === undefined ? dollars : `${dollars} · ${formatTokens(b.tokensThisWeek)} tokens`;
}

/** Both budgets, GPT-6 first, when the service sent both (newer servers); undefined otherwise. */
function bothBudgets(me: Pick<DlMe, "budgets">): { gpt6: DlBudget; deepseek: DlBudget } | undefined {
  const b = me.budgets;
  return b?.gpt6 && b.deepseek ? { gpt6: b.gpt6, deepseek: b.deepseek } : undefined;
}

/** "$6.25 left · until Feb 10" for dollar top-ups; undefined with none left. */
export function dlTopupUsdText(me: Pick<DlMe, "topupUsdLeft" | "topupUsdExpiresAt">, o: DlTimeOpts = {}): string | undefined {
  const left = me.topupUsdLeft ?? 0;
  if (left <= 0) return undefined;
  const t = me.topupUsdExpiresAt ? Date.parse(me.topupUsdExpiresAt) : NaN;
  const until = Number.isFinite(t) ? ` · until ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(o.timeZone ? { timeZone: o.timeZone } : {}) })}` : "";
  return `${formatUsd(left)} left${until}`;
}

/** `/usage`: plan, this week's usage against the limit that binds, top-ups, invite bonus, queue, and when it resets (in local time). */
export function renderDlUsage(me: DlMe, now = Date.now(), timeZone?: string): string {
  const a = me.allowance;
  const tz = timeZone ? { timeZone } : {};
  const t: DlTimeOpts = { now, ...tz };
  const pro = me.plan === "pro";
  const lines = [
    `Directionally Local ${pro ? "Pro" : "free tier"}${me.login ? ` · signed in as @${me.login}` : ""}`,
    `  plan            ${dlPlanName(me)}`,
  ];
  const topupUsd = dlTopupUsdText(me, t);
  if (me.queue) {
    lines.push(`  queue           ${dlQueuePlace(me.queue.position, me.queue.etaAt, t).replace(/^You're /, "").replace(/\.$/, "")}`);
    if (topupUsd) lines.push(`  top-up          ${topupUsd}`);
    if (me.topupTokensLeft && me.topupTokensLeft > 0) lines.push(`  top-up left     ${formatTokens(me.topupTokensLeft)} tokens`);
    if (me.referral) lines.push(`  invites         ${me.referral.joined} joined · /invite moves you up`);
    return lines.join("\n");
  }
  const budgets = bothBudgets(me);
  const cap = dollarCap(a);
  // With two budgets the week is over only when both are; the percentage is DeepSeek's (the larger one).
  const usedUp = budgets ? dlBudgetUsedUp(budgets.gpt6) && dlBudgetUsedUp(budgets.deepseek) : weekUsedUp(a);
  const share = (b: DlBudget) => (typeof b.usdPerWeek === "number" && b.usdPerWeek > 0 ? Math.min(100, Math.round((b.spentUsd / b.usdPerWeek) * 100)) : 0);
  const pct = budgets
    ? share(budgets.deepseek)
    : cap !== undefined
      ? Math.min(100, Math.round(((a.spentUsdThisWeek ?? 0) / cap) * 100))
      : a.tokensPerWeek > 0
        ? Math.min(100, Math.round((a.usedThisWeek / a.tokensPerWeek) * 100))
        : 0;
  if (budgets) {
    // Two weekly budgets: dollars are the limit, tokens counted the normal way (cached included).
    const resets = a.resetsAt || undefined;
    lines.push(`  gpt-6           ${dlBudgetText(budgets.gpt6, resets, t)}`, `  deepseek        ${dlBudgetText(budgets.deepseek, resets, t)}`);
    if (dlBudgetUsedUp(budgets.gpt6) && !dlBudgetUsedUp(budgets.deepseek)) lines.push(`  ${DL_GPT_LIMIT_HINT}`);
  } else if (cap !== undefined) {
    // The dollar cap is what binds: show it first, and tokens only as what was used.
    lines.push(
      usedUp
        ? `  this week       ${dlWeekUsageText(me, t)}`
        : `  this week       ${formatUsd(a.spentUsdThisWeek ?? 0)} of ${formatUsd(cap)} ${pro ? "Pro" : "free"} usage (${pct}%)`,
      `  tokens          ${formatTokens(a.usedThisWeek)} used`,
    );
  } else {
    lines.push(`  used this week  ${formatTokens(a.usedThisWeek)} of ${formatTokens(a.tokensPerWeek)} tokens (${pct}%)`);
    lines.push(usedUp ? `  left            limit reached, resets ${formatLocalTime(a.resetsAt || nextWeekStart(now), t)}` : `  left            ${formatTokens(Math.max(0, a.remaining))} tokens`);
    // An older server that doesn't send the dollar cap: the free tier's usual one ($5); null means none.
    const limit = a.usdPerWeek === undefined && !pro ? DL_FREE_WEEKLY_USD : undefined;
    if (limit !== undefined) {
      const spent = typeof a.spentUsdThisWeek === "number" ? a.spentUsdThisWeek : undefined;
      lines.push(`  spending limit  ${spent === undefined ? `${formatUsd(limit)} a week` : `spent ${formatUsd(spent)} of ${formatUsd(limit)}`}`);
    }
  }
  if (topupUsd) lines.push(`  top-up          ${topupUsd}`);
  if (me.topupTokensLeft !== undefined && me.topupTokensLeft > 0) lines.push(`  top-up left     ${formatTokens(me.topupTokensLeft)} tokens`);
  if (me.referral && (me.referral.bonusTokensPerWeek > 0 || me.referral.joined > 0)) {
    lines.push(`  invite bonus    ${referralBonusText(me.referral)} (${me.referral.joined} joined, ${me.referral.activeThisWeek} active this week)`);
  }
  lines.push(`  resets          ${formatReset(a.resetsAt || undefined, now, timeZone)}`);
  const topupLeft = (me.topupTokensLeft ?? 0) > 0 || (me.topupUsdLeft ?? 0) > 0;
  if (usedUp && !topupLeft) lines.push(`  ${dlQuotaLine(a.resetsAt || undefined, { ...t, ...(me.offers ? { offers: me.offers } : {}), ...planOf(me) })}`);
  else if (pct >= 80 && !usedUp && !topupLeft) lines.push(`  You've used ${pct}% of this week's ${pro ? "Pro" : "free"} usage.`);
  else if (!usedUp && !pro) {
    const proLine = dlProLine(me.offers, planOf(me));
    if (proLine && pct >= 50) lines.push(`  ${proLine}`);
  }
  return lines.join("\n");
}

/** "✓ Signed in as @octo · 50M free tokens this week · back every Monday", from /v1/me. */
export function dlSignedInLine(me: DlMe | null, o: DlTimeOpts = {}): string {
  const tokens = me && me.allowance.tokensPerWeek > 0 ? me.allowance.tokensPerWeek : DL_FREE_WEEKLY_TOKENS;
  return `✓ Signed in${me?.login ? ` as @${me.login}` : ""} · ${formatTokens(tokens)} free tokens this week · back every ${localResetWeekday(me?.allowance.resetsAt, o)}`;
}

/**
 * Under the sign-in line on the free tier: "Your invite link: <link>
 * (/invite)". Undefined on Pro, without a link, or once invites can't add more.
 */
export function dlSignedInInviteLine(me: DlMe | null, where: DlWhere = "signin"): string | undefined {
  if (!dlInviteCanAdd(me)) return undefined;
  return `Your invite link: ${me.referral.link} (${where === "cli" ? "`autopilot invite`" : "/invite"})`;
}

/**
 * The session header's free-tier line: "free · 49.9M left · /invite for
 * more" (the hint only while invites can add more). Undefined without an
 * account read, on Pro, or in the queue.
 */
export function dlHeaderLine(me: DlMe | null): string | undefined {
  if (!me || me.plan === "pro" || me.queue) return undefined;
  const a = me.allowance;
  const budgets = bothBudgets(me);
  if (budgets) {
    const part = (family: DlFamily, b: DlBudget) =>
      `${dlFamilyLabel(family)} ${dlBudgetUsedUp(b) ? "limit reached" : b.usdPerWeek === null ? "no cap" : `${formatUsd(Math.max(0, b.usdPerWeek - b.spentUsd))} left`}`;
    if (dlBudgetUsedUp(budgets.gpt6) && dlBudgetUsedUp(budgets.deepseek)) return `free · limit reached`;
    return `free · ${part("gpt6", budgets.gpt6)} · ${part("deepseek", budgets.deepseek)}`;
  }
  const cap = dollarCap(a);
  if (weekUsedUp(a)) return `free · limit reached`;
  if (cap !== undefined) return `free · ${formatUsd(Math.max(0, cap - (a.spentUsdThisWeek ?? 0)))} of ${formatUsd(cap)} left`;
  return `free · ${formatTokens(Math.max(0, a.remaining))} left`;
}

/**
 * "49.9M of 50M left this week" for one free model, from /v1/me's pools. Undefined when the
 * service didn't send pools (an older server) or the model isn't one the free tier serves.
 */
export function dlModelAllowanceLine(modelId: string, me: DlMe | null = lastKnownDlMe()): string | undefined {
  const model = DL_FREE_MODELS.find((entry) => entry.id === modelId);
  // Two budgets (newer servers): the model's own budget, dollars and tokens counted the normal way.
  const budget = model && me?.budgets?.[model.family];
  if (me && budget && bothBudgets(me)) return dlBudgetText(budget, me.allowance.resetsAt || undefined);
  const pool = model && me?.pools?.[model.pool];
  if (!me || !pool) return undefined;
  // The limit that binds: the week's dollar cap when there is one, never "36M of 50M left" once it is spent.
  if (weekUsedUp(me.allowance) || pool.remaining <= 0) return `limit reached, resets ${formatLocalTime(pool.resetsAt || me.allowance.resetsAt || nextWeekStart())}`;
  const dollars = dlWeekUsageText(me);
  if (dollars) return dollars;
  return `${formatTokens(Math.max(0, pool.remaining))} of ${formatTokens(pool.tokensPerWeek)} left this week`;
}

/**
 * The free model to run this session on when the saved one has nothing left:
 * its pool is empty this week (or the service no longer offers it) while
 * GPT-6 Luna's isn't. Returns the config for this session and a one-line
 * notice, and records the fallback so saving the config keeps the saved
 * model for later sessions. Null when the saved model is fine, isn't a free
 * model, or /v1/me didn't say enough to tell.
 */
export function freeModelFallback<T extends { model?: string }>(
  cfg: T,
  me: Pick<DlMe, "pools" | "models" | "topupTokensLeft"> | null,
): { cfg: T; notice: string } | null {
  const saved = cfg.model;
  const model = DL_FREE_MODELS.find((entry) => entry.id === saved);
  const luna = DL_FREE_MODELS.find((entry) => entry.id === DL_FREE_MODEL)!;
  if (!me || !saved || !model || model.pool === luna.pool) return null;
  // Bought tokens cover an empty pool.
  if ((me.topupTokensLeft ?? 0) > 0) return null;
  const pool = me.pools?.[model.pool];
  const notOffered = Array.isArray(me.models) && me.models.length > 0 && !me.models.includes(saved);
  const empty = !!pool && pool.remaining <= 0;
  if (!notOffered && !empty) return null;
  // Nothing gained when Luna has nothing left either: the service's own limit message says why.
  const lunaPool = me.pools?.[luna.pool];
  if (lunaPool && lunaPool.remaining <= 0) return null;
  setSessionModelFallback({ provider: DL_PROVIDER_ID, saved, used: luna.id });
  const why = empty ? `has no free tokens left this week` : `isn't available on your account`;
  return {
    cfg: { ...cfg, model: luna.id },
    notice: `${model.name} ${why}, so this session runs on ${luna.name}. ${model.name} stays your saved model for later sessions.`,
  };
}

/**
 * The notice when an OpenAI model failed over to DeepSeek: short and honest, from the response's
 * `x-dl-fallback` header. Undefined when nothing fell back.
 */
let fallbackShown = false;
export function dlFallbackNotice(fallback: string | null | undefined, me: DlMe | null = lastKnownDlMe()): string | undefined {
  if (!fallback || fallbackShown) return undefined;
  fallbackShown = true;
  // A Starter account asked for GPT-6 and DeepSeek served it: say why, once, honestly.
  if (fallback === "starter") return dlStarterNotice(me);
  const model = DL_FREE_MODELS.find((entry) => entry.id === fallback);
  return `OpenAI didn't answer, so this turn ran on ${model?.name ?? fallback}.`;
}

/**
 * The honest Starter line, once per process: what it gets, why, and the ways up. The thresholds
 * and the allowance come from /v1/me, so the numbers are the service's, not hard-coded.
 */
export function dlStarterNotice(me: DlMe | null = lastKnownDlMe()): string {
  const t = me?.thresholds;
  const age = t?.minAccountAgeDays ?? 90;
  const repos = t?.minPublicRepos ?? 3;
  const contributions = t?.minContributions ?? 50;
  const tokens = me?.pools?.luna?.tokensPerWeek;
  const allowance = tokens ? `${formatTokens(tokens)} tokens a week` : "a small weekly allowance";
  return `Your account is on Starter: DeepSeek only, ${allowance}. GPT-6 unlocks when your GitHub account is ${age}+ days old with ${repos} public repos or ${contributions} contributions this year (turn on "show private contributions" on GitHub to count private work). Got an invite code? Run /logout, sign in to Free again and enter it on the sign-in page. Or bring your own key.`;
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
  const pro = dlProLine(lastMe?.offers, planOf(lastMe));
  return `You've used ${used}% of this week's free Directionally Local tokens (${formatTokens(Math.max(0, remaining))} left, resets ${formatReset(resetsAt || undefined, opts.now, opts.timeZone)}); /usage has details.${pro ? ` ${pro}` : ""}`;
}

/** Test hook: forget the shown notice and the cached weekly grant. */
export function resetDlNoticeState(): void {
  noticeShownFor = null;
  fallbackShown = false;
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
  if (!token) throw new DlError("signed_out", dlSignedOutLine(opts.env));
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

/** POST /v1/billing/checkout: the payment page for Pro or a top-up (`quantity`: a dollar top-up's $1 units). */
export async function dlCheckout(
  product: DlProduct,
  opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; quantity?: number } = {},
): Promise<string> {
  const body = product === "topup" && opts.quantity !== undefined ? { product, quantity: opts.quantity } : { product };
  return urlFrom(await dlAuthedPost("/v1/billing/checkout", body, opts, "Starting the checkout"), "the checkout");
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
