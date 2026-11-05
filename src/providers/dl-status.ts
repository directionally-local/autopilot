/**
 * Whether the free tier is taking people right now: the service's public
 * GET /v1/status, read before the first-run question and the `/provider`
 * picker so a waitlist or a pause is said before anyone signs in.
 *
 * Best effort only: a 1.5 s timeout, and anything other than a well-formed
 * "waitlist" or "paused" answer (an error, a timeout, an unknown value) is
 * treated as open, which is how the pickers behaved before the endpoint
 * existed. The URL comes from the provider's base (AUTOPILOT_DL_FREE_URL).
 */

import { getUserAgent } from "../util/version.js";
import { dlApiBase } from "./dl-endpoint.js";

export type DlFreeState = "open" | "waitlist" | "paused";

export interface DlFreeStatus {
  free: DlFreeState;
  reason: string | null;
  message: string;
  opensAt: string | null;
}

export const DL_STATUS_TIMEOUT_MS = 1_500;

/** The open answer, used whenever the status can't be read. */
export const DL_STATUS_OPEN: DlFreeStatus = { free: "open", reason: null, message: "", opensAt: null };

/** A status body, or open for anything unexpected. */
export function parseDlStatus(raw: unknown): DlFreeStatus {
  if (!raw || typeof raw !== "object") return DL_STATUS_OPEN;
  const r = raw as Record<string, unknown>;
  if (r.free !== "waitlist" && r.free !== "paused") return DL_STATUS_OPEN;
  const message = typeof r.message === "string" ? r.message.replace(/\s+/g, " ").trim() : "";
  const opensAt = typeof r.opensAt === "string" && Number.isFinite(Date.parse(r.opensAt)) ? r.opensAt : null;
  return { free: r.free, reason: typeof r.reason === "string" ? r.reason : null, message, opensAt };
}

/** Read the status: open on any error, a non-2xx answer or after `timeoutMs`. */
export async function fetchDlStatus(o: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<DlFreeStatus> {
  try {
    const signal = AbortSignal.timeout(o.timeoutMs ?? DL_STATUS_TIMEOUT_MS);
    const res = await (o.fetchImpl ?? fetch)(`${dlApiBase(o.env)}/status`, {
      headers: { Accept: "application/json", "User-Agent": getUserAgent() },
      signal,
    });
    if (!res.ok) return DL_STATUS_OPEN;
    return parseDlStatus(await res.json());
  } catch {
    return DL_STATUS_OPEN;
  }
}

/** How long one reading is reused (startup's prefetch, then the pickers). */
const STATUS_REUSE_MS = 60_000;
let cached: { at: number; status: Promise<DlFreeStatus> } | null = null;

/** Start reading the status (or reuse a recent reading); never rejects. */
export function dlFreeStatus(now = Date.now()): Promise<DlFreeStatus> {
  if (!cached || now - cached.at > STATUS_REUSE_MS) cached = { at: now, status: fetchDlStatus() };
  return cached.status;
}

/** Forget the cached reading (tests). */
export function resetDlFreeStatus(): void {
  cached = null;
}

/** "Mon 9 Nov" in local time (or `timeZone`); undefined for a missing or bad time. */
export function formatOpensAt(at: string | null | undefined, timeZone?: string): string | undefined {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return undefined;
  return new Date(t).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", ...(timeZone ? { timeZone } : {}) });
}

/** What a picker says for Free on a waitlist: "waitlist, opens Mon 9 Nov" (or just "waitlist"). */
export function dlWaitlistText(status: Pick<DlFreeStatus, "opensAt">, timeZone?: string): string {
  const when = formatOpensAt(status.opensAt, timeZone);
  return when ? `waitlist, opens ${when}` : "waitlist";
}

/** What choosing a paused Free says before the picker comes back. */
export function dlPausedLine(status: Pick<DlFreeStatus, "message">): string {
  return status.message || "The Directionally Local free tier is paused right now; use your own API key in the meantime.";
}
