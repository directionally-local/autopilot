/**
 * `/feedback`: a typed message to the team, sent by email through the free
 * tier service (the same origin as the directionally-local provider,
 * AUTOPILOT_DL_FREE_URL). Works signed in or not:
 *
 * - signed in to the free tier: GET /v1/feedback/reply-address suggests the
 *   person's public GitHub email, and the POST carries the access token
 * - not signed in (own key): the POST goes out anonymously, with an optional
 *   reply address the person types
 *
 * Only what the person typed is sent, plus the client's versions, OS, CPU
 * and whether the free tier is in use. Never the conversation, file paths or
 * code.
 */

import { dlOrigin } from "./providers/dl-endpoint.js";
import { BUG_REPORT_EMAIL, BUG_REPORT_URL } from "./ui/bug-report.js";

export const FEEDBACK_MAX_CHARS = 5000;
export const FEEDBACK_EMAIL = BUG_REPORT_EMAIL;
export const FEEDBACK_ISSUES_URL = BUG_REPORT_URL;
/** The renderer's multi-line input takes Enter as a new line; Tab submits the form. */
export const FEEDBACK_MESSAGE_PROMPT = "What's on your mind? (Tab to send, Esc to cancel)";
export const FEEDBACK_FALLBACK_LINE = `Couldn't send. Email ${FEEDBACK_EMAIL} or open ${FEEDBACK_ISSUES_URL}`;
export const FEEDBACK_NOT_SENT_LINE = "Feedback not sent.";
const TIMEOUT_MS = 10_000;

export interface FeedbackClient {
  dl?: string;
  autopilot?: string;
  os?: string;
  arch?: string;
  provider?: "free" | "own-key";
}

export interface FeedbackBody {
  message: string;
  email?: string;
  client: FeedbackClient;
}

export type FeedbackSendResult =
  | { kind: "sent"; replyTo: string | null }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "invalid"; message?: string }
  | { kind: "failed" };

/** What /feedback hands the view: text typed after the command, and the active provider. */
export interface FeedbackRequest {
  inline?: string;
  providerId: string;
}

export interface FeedbackLine {
  text: string;
  severity: "info" | "error";
}

/** What the client says about itself: dl's version (DL_VERSION), Autopilot's, OS, CPU, free or own key. */
export function feedbackClient(o: {
  providerId: string;
  autopilotVersion: string;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
}): FeedbackClient {
  const dl = (o.env ?? process.env).DL_VERSION?.trim();
  return {
    ...(dl ? { dl } : {}),
    autopilot: o.autopilotVersion,
    os: o.platform ?? process.platform,
    arch: o.arch ?? process.arch,
    provider: o.providerId === "directionally-local" ? "free" : "own-key",
  };
}

/** Loose on purpose: the service checks it; this only catches typos like a missing @. */
export function looksLikeEmail(s: string): boolean {
  return s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** The person's public GitHub email from the service; null when there is none or the lookup failed. */
export async function fetchReplyAddress(token: string, o: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<string | null> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${dlOrigin(o.env)}/v1/feedback/reply-address`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { email?: unknown } | null;
    return typeof body?.email === "string" && body.email.trim() ? body.email.trim() : null;
  } catch {
    return null;
  }
}

/** POST /v1/feedback. A rejected token (401) is retried once without it, so the message still goes out. */
export async function sendFeedback(
  body: FeedbackBody,
  o: { token?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<FeedbackSendResult> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const post = (token: string | undefined) =>
    fetchImpl(`${dlOrigin(o.env)}/v1/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  let res: Response;
  try {
    res = await post(o.token);
    if (res.status === 401 && o.token) res = await post(undefined);
  } catch {
    return { kind: "failed" };
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok) {
    if (json?.ok !== true) return { kind: "failed" };
    return { kind: "sent", replyTo: typeof json.replyTo === "string" && json.replyTo ? json.replyTo : null };
  }
  const err = json && typeof json.error === "object" && json.error ? (json.error as Record<string, unknown>) : null;
  if (res.status === 429) {
    const fromBody = Number(err?.retryAfter);
    const fromHeader = Number(res.headers.get("retry-after"));
    const secs = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : undefined;
    return { kind: "rate_limited", ...(secs !== undefined ? { retryAfterSeconds: secs } : {}) };
  }
  if (res.status === 400) return { kind: "invalid", ...(typeof err?.message === "string" ? { message: err.message } : {}) };
  return { kind: "failed" };
}

/** The line shown once the send is over. */
export function feedbackResultLine(r: FeedbackSendResult, typedEmail?: string): FeedbackLine {
  switch (r.kind) {
    case "sent": {
      const to = r.replyTo ?? typedEmail;
      return { text: to ? `✓ Sent. Thanks — replies go to ${to}.` : "✓ Sent. Thanks — (no reply address, so we can't answer by email)", severity: "info" };
    }
    case "rate_limited": {
      if (r.retryAfterSeconds === undefined) return { text: "You've sent a lot of feedback recently; try again later.", severity: "error" };
      const mins = Math.max(1, Math.ceil(r.retryAfterSeconds / 60));
      return { text: `You've sent a lot of feedback recently; try again in ${mins} minute${mins === 1 ? "" : "s"}.`, severity: "error" };
    }
    case "invalid":
      return { text: `Couldn't send: ${r.message ?? "the service didn't accept the message"}. Email ${FEEDBACK_EMAIL} or open ${FEEDBACK_ISSUES_URL}`, severity: "error" };
    default:
      return { text: FEEDBACK_FALLBACK_LINE, severity: "error" };
  }
}

export interface FeedbackDeps {
  /** The multi-line message input; null on Esc. `problem` explains why it is asked again. */
  askMessage: (o: { problem?: string; draft?: string }) => Promise<string | null>;
  /** The single-line reply address, prefilled with `suggested`; null on Esc, "" for no reply address. */
  askEmail: (o: { suggested: string | null; problem?: string }) => Promise<string | null>;
  /** The free tier access token, or undefined when not signed in. */
  token: () => Promise<string | undefined>;
  providerId: string;
  autopilotVersion: string;
  /** Shown while the lookup or the send is in flight. */
  status?: (text: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
}

/** The whole flow: message (unless given inline), reply address, send. Returns the line to show. */
export async function runFeedback(o: { inline?: string }, deps: FeedbackDeps): Promise<FeedbackLine> {
  let message = o.inline?.trim() ?? "";
  if (message.length > FEEDBACK_MAX_CHARS) {
    return { text: `That's ${message.length} characters; feedback fits in ${FEEDBACK_MAX_CHARS}. Shorten it and try again.`, severity: "error" };
  }
  if (!message) {
    let problem: string | undefined;
    let draft: string | undefined;
    for (;;) {
      const typed = await deps.askMessage({ ...(problem ? { problem } : {}), ...(draft ? { draft } : {}) });
      if (typed === null) return { text: FEEDBACK_NOT_SENT_LINE, severity: "info" };
      message = typed.trim();
      if (!message) return { text: FEEDBACK_NOT_SENT_LINE, severity: "info" };
      if (message.length <= FEEDBACK_MAX_CHARS) break;
      problem = `${message.length} characters; shorten it to ${FEEDBACK_MAX_CHARS}`;
      draft = typed;
    }
  }

  const token = await deps.token().catch(() => undefined);
  let suggested: string | null = null;
  if (token) {
    deps.status?.("Looking up your reply address…");
    suggested = await fetchReplyAddress(token, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.env ? { env: deps.env } : {}) });
  }

  let email = "";
  let emailProblem: string | undefined;
  for (;;) {
    const typed = await deps.askEmail({ suggested, ...(emailProblem ? { problem: emailProblem } : {}) });
    if (typed === null) return { text: FEEDBACK_NOT_SENT_LINE, severity: "info" };
    email = typed.trim();
    if (!email || looksLikeEmail(email)) break;
    emailProblem = `${email} doesn't look like an email address`;
  }

  const body: FeedbackBody = {
    message,
    ...(email ? { email } : {}),
    client: feedbackClient({
      providerId: deps.providerId,
      autopilotVersion: deps.autopilotVersion,
      ...(deps.env ? { env: deps.env } : {}),
      ...(deps.platform ? { platform: deps.platform } : {}),
      ...(deps.arch ? { arch: deps.arch } : {}),
    }),
  };
  deps.status?.("Sending your feedback…");
  const r = await sendFeedback(body, { ...(token ? { token } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.env ? { env: deps.env } : {}) });
  return feedbackResultLine(r, email || undefined);
}
