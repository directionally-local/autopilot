/**
 * One retry policy for model calls: which failures are the host's (worth
 * trying again) and which are ours or the account's (not), how long to wait,
 * and what the user sees. runKimi uses it for side calls (memory, summaries);
 * the agent loop uses it for the main turn, where a retry can also come after
 * part of the answer has streamed.
 */

import { ApiError, humanizeApiError } from "../util/errors.js";
import { NON_RETRYABLE_SHARING_CODES } from "../providers/chatgpt.js";
import { DL_SWITCH_HINT, dlRetryable } from "../providers/directionally-local.js";

/** Retries after the first attempt. AUTOPILOT_NETWORK_RETRIES overrides it (0–20). */
export const DEFAULT_MODEL_RETRIES = 2;
/** Backoff before retry 1, 2, … (the last value repeats). */
export const MODEL_RETRY_DELAYS_MS = [1_000, 3_000] as const;
/** The longest Retry-After we wait for; a longer one is not retried. */
export const MAX_RETRY_AFTER_MS = 20_000;

export function modelRetryCount(override?: number): number {
  const raw = override ?? Number(process.env.AUTOPILOT_NETWORK_RETRIES ?? DEFAULT_MODEL_RETRIES);
  return Number.isFinite(raw) ? Math.max(0, Math.min(20, Math.floor(raw))) : DEFAULT_MODEL_RETRIES;
}

/**
 * The wait before retry number `retryIndex` (0-based): the backoff ±50%, or
 * the host's Retry-After plus up to 50% when it sent one (never sooner than it
 * asked), capped at MAX_RETRY_AFTER_MS. The jitter keeps sessions that failed
 * together (one host blip, many agents on one machine) from retrying in step.
 * `random` returns [0, 1); tests inject it.
 */
export function modelRetryDelay(retryIndex: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const r = Math.min(Math.max(random(), 0), 1);
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.round(Math.min(retryAfterMs * (1 + 0.5 * r), MAX_RETRY_AFTER_MS));
  }
  const base = MODEL_RETRY_DELAYS_MS[Math.min(retryIndex, MODEL_RETRY_DELAYS_MS.length - 1)]!;
  return Math.round(base * (0.5 + r));
}

/** Retry-After as milliseconds: a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | number | null | undefined, now = Date.now()): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value).trim();
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Failures that are the caller's or the account's, by wording: quota and
 * credit, keys and permissions, malformed requests, context length, and
 * content policy. Checked before anything else, so a 429 that is really
 * "quota exceeded" or a mid-stream "context length exceeded" isn't retried.
 */
const PERMANENT =
  /\b(?:quota|insufficient[_ ]?(?:quota|funds|credits?)|out of credits?|billing|payment required|credit balance|invalid[_ ]?(?:api[_ ]?)?key|incorrect api key|unauthori[sz]ed|authentication|forbidden|permission denied|invalid[_ ]request|context[_ ]?(?:length|window)|maximum context|too many tokens|prompt is too long|tokens? exceeds?|content[_ ]?(?:policy|filter|management)|moderation|flagged|safety system|responsible ai|not allowed)/i;

/** Network-level failures by message or error code (fetch/undici/socket). */
const NETWORK =
  /\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)\b|socket hang up|fetch failed|terminated|other side closed|premature close|network error|connection (?:reset|closed|dropped|error)/i;

/** Host trouble in a message with no usable status (an error event in an otherwise good stream). */
const HOST_TROUBLE =
  /upstream|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|internal server error|server error|stream (?:failed|error)|error decoding|decoding response|try again|timed? ?out|capacity/i;

function hasAbortName(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

function causeText(err: unknown): string {
  const cause = (err as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  if (!cause || typeof cause !== "object") return "";
  return `${typeof cause.code === "string" ? cause.code : ""} ${typeof cause.message === "string" ? cause.message : ""}`;
}

/**
 * Whether a failed model call is the host's transient trouble: 408/425/429,
 * 5xx (incl. 529 overloaded), connection resets and drops, stalled streams,
 * stream decode errors and "upstream error" bodies. Never an abort, and never
 * quota, auth, invalid-request, context-length or content-policy errors.
 * The client marks HTTP errors it has already judged with `transient`.
 */
export function isTransientModelError(err: unknown): boolean {
  if (hasAbortName(err)) return false;
  if (err instanceof ApiError) {
    if (err.transient !== undefined) return err.transient;
    if (err.providerCode !== undefined) return dlRetryable(err.providerCode, (err.providerDetail as { retryable?: unknown } | undefined)?.retryable === true);
    if (NON_RETRYABLE_SHARING_CODES.some((c) => err.message.includes(c))) return false;
    if (PERMANENT.test(err.message)) return false;
    const status = err.httpStatus;
    if (status !== undefined) return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
    return NETWORK.test(err.message) || HOST_TROUBLE.test(err.message);
  }
  if (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError") return true;
  if (!(err instanceof Error)) return false;
  if (PERMANENT.test(err.message)) return false;
  return NETWORK.test(`${err.message} ${causeText(err)}`) || HOST_TROUBLE.test(err.message);
}

/** How long the host asked us to wait, when it said. */
export function retryAfterOf(err: unknown): number | undefined {
  return err instanceof ApiError ? err.retryAfterMs : undefined;
}

/** Whether to retry `err` after `retriesSoFar` retries out of `maxRetries`. */
export function shouldRetryModelCall(err: unknown, retriesSoFar: number, maxRetries: number): boolean {
  if (retriesSoFar >= maxRetries || !isTransientModelError(err)) return false;
  // A host that wants us gone for longer than we'd wait: say so instead of hammering it.
  const after = retryAfterOf(err);
  return after === undefined || after <= MAX_RETRY_AFTER_MS;
}

/**
 * The dim line shown before a retry: the provider's own words when it sent
 * them for a transient failure ("↻ The free tier is busy right now; retrying
 * (1/2)…"), else the generic one.
 */
export function modelRetryLine(retry: number, maxRetries: number, err?: unknown): string {
  const said = err instanceof ApiError ? err.retryMessage?.trim() : undefined;
  // The service may already end its sentence with "retrying…": say it once, with the count.
  const base = said?.replace(/\bretrying\s*(?:\.\.\.|…)?\s*$/i, "").replace(/[\s;,.…]+$/, "");
  if (base) return `↻ ${base}; retrying (${retry}/${maxRetries})…`;
  return `↻ The model's host had a hiccup; retrying (${retry}/${maxRetries})…`;
}

/** What the user reads after the last attempt failed, with a next step: on the free tier their own key, else /bug. */
export function modelHostFailedText(attempts: number, o: { freeTier?: boolean } = {}): string {
  const failed = attempts > 1 ? `The model's host failed ${attempts} times.` : "The model's host failed.";
  const next = o.freeTier ? ` or use your own key: ${DL_SWITCH_HINT}` : ". Still stuck? /bug";
  return `${failed} Type "continue" to try again${next}`;
}

/**
 * The turn's model call failed on the host every time it was tried. An
 * ApiError carrying the last failure's status and codes, so callers that sort
 * ApiErrors keep working; its message is the plain text (humanizeApiError
 * strips the prefix) and `detail` is the host's own error, for debugging.
 */
export class ModelHostError extends ApiError {
  readonly detail: string;
  constructor(
    public readonly attempts: number,
    public override readonly cause: unknown,
    o: { freeTier?: boolean } = {},
  ) {
    super(
      `autopilot: ${modelHostFailedText(attempts, o)}`,
      cause instanceof ApiError ? cause.code : undefined,
      cause instanceof ApiError ? cause.httpStatus : undefined,
    );
    this.name = "ModelHostError";
    this.transient = true;
    if (cause instanceof ApiError && cause.providerCode !== undefined) this.providerCode = cause.providerCode;
    this.detail = cause instanceof ApiError ? humanizeApiError(cause) : cause instanceof Error ? cause.message : String(cause);
  }
}

/** What a host gets told before a retry of the turn's model call. */
export interface ModelRetryInfo {
  /** 1-based retry number. */
  retry: number;
  maxRetries: number;
  delayMs: number;
  /** The dim line to show (modelRetryLine). */
  line: string;
  /** Answer text that had streamed in the failed attempt and is now discarded. */
  discardedText: string;
  error: unknown;
}
