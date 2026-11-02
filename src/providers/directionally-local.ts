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
const SWITCH_HINT = "switch provider with /model or `autopilot connect`";

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
  "Free tokens come with usage collection: token counts and session events (turns, tool counts, errors) are sent to Directionally Local. No prompts, code or file contents are ever sent.";

/** Said before leaving the free tier for a model or provider that needs the person's own key. */
export function dlNotFreeLine(what: string): string {
  return `${what} isn't part of the Directionally Local free tier; it needs your own API key.`;
}

/** The picker's one-line hint. */
export function dlPickerHint(): string {
  return `free — ${formatTokens(DL_FREE_WEEKLY_TOKENS)} tokens/week, sign in with GitHub`;
}

/** "Mon, Nov 9, 00:00 UTC (in 3 days)". */
export function formatReset(iso: string | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "at the start of next week (Monday 00:00 UTC)";
  const d = new Date(t);
  const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC", hour12: false });
  const ms = t - now;
  let rel = "";
  if (ms > 0) {
    const hours = Math.round(ms / 3_600_000);
    rel = hours >= 48 ? ` (in ${Math.round(hours / 24)} days)` : hours >= 1 ? ` (in ${hours} hour${hours === 1 ? "" : "s"})` : " (in under an hour)";
  }
  return `${day}, ${time} UTC${rel}`;
}

/** A free-tier error with the service's code and a sentence for the person. */
export class DlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DlError";
  }
}

interface DlErrorBody {
  error?: { code?: string; message?: string; resetsAt?: string; retryAfter?: number; reason?: string };
}

/** What the service adds as `reason`, for errors where it changes what to say. */
export interface DlErrorExtra {
  resetsAt?: string;
  retryAfter?: number;
  /**
   * access_denied: "account_too_new" | "device_taken"; quota_exceeded:
   * "tokens" | "spend"; service_paused: "paused" | "ended" | "weekly_budget".
   */
  reason?: string;
  now?: number;
}

/** The service's `{error:{code,…}}`, if the body is one. */
export function parseDlError(body: unknown): { code: string; message?: string; resetsAt?: string; retryAfter?: number; reason?: string } | null {
  const e = (body as DlErrorBody | null)?.error;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return null;
  return {
    code: e.code,
    ...(typeof e.message === "string" ? { message: e.message } : {}),
    ...(typeof e.resetsAt === "string" ? { resetsAt: e.resetsAt } : {}),
    ...(typeof e.retryAfter === "number" ? { retryAfter: e.retryAfter } : {}),
    ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
  };
}

/**
 * The plain sentence for a service error code. `extra` carries resetsAt /
 * retryAfter from the error body or headers. Undefined for codes this
 * client doesn't know (the caller shows the service's own message).
 */
export function describeDlError(code: string, extra: DlErrorExtra = {}): string | undefined {
  switch (code) {
    case "authorization_pending":
      return "Still waiting for you to approve the sign-in in your browser.";
    case "expired_token":
      return "The sign-in code expired before it was approved. Run the sign-in again to get a new code.";
    case "access_denied":
      if (extra.reason === "account_too_new") return "Your GitHub account needs to be at least 30 days old for the free tier.";
      if (extra.reason === "device_taken") return "This device already has a free allowance under another GitHub account; sign in with that account instead.";
      return "The sign-in was declined in the browser, so nothing was saved.";
    case "not_invited":
      return `This GitHub account isn't on the Directionally Local free tier yet. Enter an invite code on the sign-in page, or ${SWITCH_HINT}.`;
    case "invalid_grant":
      return `Your Directionally Local sign-in has expired; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
    case "invalid_token":
      return `Directionally Local didn't accept your sign-in; sign in again with \`${DL_SIGN_IN_COMMAND}\`.`;
    case "quota_exceeded":
      return `${quotaLimitLine(extra.reason)} It resets ${formatReset(extra.resetsAt, extra.now)}. To keep going now, ${SWITCH_HINT}.`;
    case "suspended":
      return `This Directionally Local account is suspended, so its requests are refused. To keep going, ${SWITCH_HINT}.`;
    case "rate_limited": {
      const s = extra.retryAfter && extra.retryAfter > 0 ? Math.ceil(extra.retryAfter) : undefined;
      return `Directionally Local is limiting how fast you send requests; try again${s ? ` in ${s} second${s === 1 ? "" : "s"}` : " shortly"}.`;
    }
    case "service_paused":
      if (extra.reason === "ended") return `The Directionally Local free tier has ended. To keep going, ${SWITCH_HINT}.`;
      if (extra.reason === "weekly_budget") {
        return `The Directionally Local free tier's budget for this week is used up; it resumes ${formatReset(extra.resetsAt, extra.now)}. To keep going now, ${SWITCH_HINT}.`;
      }
      return `The Directionally Local free tier is paused right now. Try again later, or ${SWITCH_HINT}.`;
    case "model_not_allowed":
      return `The free tier only serves ${DL_FREE_MODEL}; pick it with /model.`;
    default:
      return undefined;
  }
}

/** The weekly limit someone hit: tokens (the default) or the spending allowance. */
export function quotaLimitLine(reason?: string): string {
  return reason === "spend" ? "You've reached this week's free usage limit." : "You've used this week's free tokens.";
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

/** An error for a non-2xx response: the code's sentence, else the service's message, else the status. */
async function errorFrom(res: Response, what: string): Promise<DlError> {
  const err = parseDlError(await readJson(res));
  if (err) return new DlError(err.code, describeDlError(err.code, err) ?? err.message ?? `${what} failed (HTTP ${res.status}).`, res.status);
  return new DlError("http_error", `${what} failed (HTTP ${res.status}).`, res.status);
}

export async function startDlDeviceFlow(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<DlDeviceCode> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await jsonPost(`${dlOrigin(opts.env)}/v1/device/code`, {}, fetchImpl, opts.signal);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new DlError("network", `Couldn't reach Directionally Local at ${dlOrigin(opts.env)}: ${(e as Error).message}`);
  }
  if (!res.ok) throw await errorFrom(res, "Starting the Directionally Local sign-in");
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
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; env?: NodeJS.ProcessEnv } = {},
): Promise<DlTokens> {
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
    if (err) throw new DlError(err.code, describeDlError(err.code, err) ?? err.message ?? `Sign-in failed (HTTP ${res.status}).`, res.status);
    if (res.status >= 500) continue;
    throw new DlError("http_error", `Directionally Local sign-in failed (HTTP ${res.status}).`, res.status);
  }
  throw new DlError("expired_token", describeDlError("expired_token")!);
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
  /** The weekly spending allowance and what's spent of it (the service limits both). */
  usdPerWeek?: number;
  spentUsdThisWeek?: number;
}

export interface DlMe {
  login: string;
  githubId?: number | string;
  allowance: DlAllowance;
  models?: string[];
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
  const me = (await readJson(res)) as DlMe | null;
  if (!me?.allowance || typeof me.allowance.remaining !== "number") throw new DlError("bad_response", "Directionally Local returned an unexpected account response.");
  if (me.allowance.tokensPerWeek > 0) knownWeeklyTokens = me.allowance.tokensPerWeek;
  return me;
}

/** The last 402 quota_exceeded this process saw, so /usage can say which limit was hit. */
let lastQuota: { reason?: string; resetsAt?: string } | null = null;
export function noteDlQuotaExceeded(info: { reason?: string; resetsAt?: string }): void {
  lastQuota = { ...(info.reason ? { reason: info.reason } : {}), ...(info.resetsAt ? { resetsAt: info.resetsAt } : {}) };
}

/** `/usage`: used and left this week, and when it resets. */
export function renderDlUsage(me: DlMe, now = Date.now()): string {
  const a = me.allowance;
  const pct = a.tokensPerWeek > 0 ? Math.min(100, Math.round((a.usedThisWeek / a.tokensPerWeek) * 100)) : 0;
  const lines = [
    `Directionally Local free tier${me.login ? ` · signed in as @${me.login}` : ""}`,
    `  used this week  ${formatTokens(a.usedThisWeek)} of ${formatTokens(a.tokensPerWeek)} tokens (${pct}%)`,
    `  left            ${formatTokens(Math.max(0, a.remaining))} tokens`,
    `  resets          ${formatReset(a.resetsAt, now)}`,
  ];
  // A 402 from this week (same reset) still counts when /v1/me rounds it differently.
  const seen = lastQuota && (!lastQuota.resetsAt || lastQuota.resetsAt === a.resetsAt) ? lastQuota : null;
  const spendHit =
    (typeof a.usdPerWeek === "number" && a.usdPerWeek > 0 && typeof a.spentUsdThisWeek === "number" && a.spentUsdThisWeek >= a.usdPerWeek) ||
    seen?.reason === "spend";
  if (a.remaining <= 0 || spendHit) lines.push(`  ${quotaLimitLine(a.remaining <= 0 ? "tokens" : "spend")} To keep going now, ${SWITCH_HINT}.`);
  else if (pct >= 80) lines.push(`  You've used ${pct}% of this week's tokens.`);
  return lines.join("\n");
}

let noticeShownFor: string | null = null;

/**
 * The one-line notice once 80% of the week is used, from an inference
 * response's headers; shown once per week per process. Undefined otherwise.
 */
export function quotaNoticeFromHeaders(headers: Headers, opts: { weeklyTokens?: number; now?: number } = {}): string | undefined {
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
  return `You've used ${used}% of this week's free Directionally Local tokens (${formatTokens(Math.max(0, remaining))} left, resets ${formatReset(resetsAt || undefined, opts.now)}); /usage has details.`;
}

/** Test hook: forget the shown notice and the cached weekly grant. */
export function resetDlNoticeState(): void {
  noticeShownFor = null;
  lastQuota = null;
  knownWeeklyTokens = undefined;
}

/** Device sign-in end to end: show the code, poll, save the tokens. Returns the access token. */
export async function dlSignIn(
  onCode: (code: DlDeviceCode) => void,
  opts: { signal?: AbortSignal; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> } = {},
): Promise<string> {
  const code = await startDlDeviceFlow(opts);
  onCode(code);
  const tokens = await pollDlDeviceFlow(code, opts);
  await saveDlSettings(dlSettings(tokens));
  return tokens.access_token;
}
