/**
 * `/request`: ask for more free tokens on the Directionally Local free tier.
 *
 * GET {free tier}/v1/access-request says where an earlier request stands
 * (none, pending, granted, declined). With none pending, two questions are
 * asked inline (what the person is building, and an optional link) and
 * POSTed with the free tier access token. The answers go only to that
 * service: never to the log, the session trace or usage events.
 */

import { dlOrigin } from "./providers/dl-endpoint.js";
import { DL_PROVIDER_ID, DL_REQUEST_HINT, describeDlError, dlSignedOutLine, parseDlError } from "./providers/directionally-local.js";
import { getUserAgent } from "./util/version.js";

export const ACCESS_REQUEST_PATH = "/v1/access-request";
export const ACCESS_BUILDING_MIN = 10;
export const ACCESS_BUILDING_MAX = 600;
export const ACCESS_LINK_MAX = 300;
const TIMEOUT_MS = 10_000;

/** The line added to a below_bar, basic_limit or starter_limit refusal that carries `request`. */
export const ACCESS_REQUEST_HINT = DL_REQUEST_HINT;

export const ACCESS_TITLE = "Ask for more free tokens · Esc to cancel";
export const ACCESS_BUILDING_PROMPT = "what are you building with dl?";
export const ACCESS_LINK_PROMPT = "a link that shows your work (github, site, anything), optional, enter to skip";

export const ACCESS_PENDING_LINE = "your request is in, sina reviews them by hand, usually within a day";
export const ACCESS_GRANTED_LINE = "you already have the full free tier. if your limits look stale, restart the session.";
export const ACCESS_SENT_LINE = "sent. sina reviews these by hand, usually within a day. you'll get an email when it's done.";
export const ACCESS_CANCELLED_LINE = "request not sent.";
/** /request off the free tier: it's for the free tier. */
export function accessNotFreeTierLine(providerName = "another provider"): string {
  return `/request is for the Directionally Local free tier; you're on ${providerName}. /provider switches to it.`;
}
export const ACCESS_UNAVAILABLE_LINE = "asking for more free tokens isn't available on this free tier server yet.";
export const ACCESS_FAILED_LINE = "couldn't reach the free tier; nothing was sent. try /request again shortly.";
export const ACCESS_CHECK_FAILED_LINE = "couldn't check your request with the free tier; try /request again shortly.";

export type AccessStatus = "none" | "pending" | "granted" | "declined";

export type AccessStatusResult =
  | { kind: "status"; status: AccessStatus; at?: string }
  /** Any other answer: the line to show. */
  | { kind: "error"; line: string };

export type AccessSendResult =
  | { kind: "sent" }
  | { kind: "already_pending" }
  | { kind: "already_full" }
  | { kind: "rate_limited"; retryAfterSeconds?: number }
  | { kind: "invalid"; message?: string }
  /** Any other answer: the line to show. */
  | { kind: "error"; line: string };

export interface AccessRequestBody {
  building: string;
  link?: string;
}

export interface AccessRequestLine {
  text: string;
  severity: "info" | "error";
}

/** What /request hands the view: the active provider. */
export interface AccessRequestOpen {
  providerId: string;
  providerName?: string;
}

interface CallOpts {
  /** The free tier access token; `force` refreshes it (after a 401). */
  token: (force?: boolean) => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** Why the building answer can't be sent, or undefined when it can. */
export function buildingProblem(text: string): string | undefined {
  const n = text.trim().length;
  if (n < ACCESS_BUILDING_MIN) return `at least ${ACCESS_BUILDING_MIN} characters, please`;
  if (n > ACCESS_BUILDING_MAX) return `${n} characters; keep it to ${ACCESS_BUILDING_MAX}`;
  return undefined;
}

/**
 * The link as it will be sent: trimmed, with https:// added to a bare
 * "github.com/me". Undefined for an empty answer; `problem` when it isn't an
 * http(s) URL of at most 300 characters.
 */
export function cleanLink(raw: string): { link?: string; problem?: string } {
  let v = raw.trim();
  if (!v) return {};
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v) && /^[^\s/]+\.[^\s/]+/.test(v)) v = `https://${v}`;
  let ok = false;
  try {
    const u = new URL(v);
    ok = (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname && !/\s/.test(v);
  } catch {
    ok = false;
  }
  if (!ok) return { problem: "that doesn't look like a link (http or https)" };
  if (v.length > ACCESS_LINK_MAX) return { problem: `that link is ${v.length} characters; keep it to ${ACCESS_LINK_MAX}` };
  return { link: v };
}

type Rec = Record<string, unknown>;

async function readJson(res: Response): Promise<Rec | null> {
  try {
    const j = (await res.json()) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Rec) : null;
  } catch {
    return null;
  }
}

/** One call, with the token refreshed and the call made again once after a 401. */
async function call(method: "GET" | "POST", o: CallOpts, body?: AccessRequestBody): Promise<Response | "signed_out" | "network"> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const send = (token: string) =>
    fetchImpl(`${dlOrigin(o.env)}${ACCESS_REQUEST_PATH}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": getUserAgent(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  try {
    let token = await o.token();
    if (!token) return "signed_out";
    let res = await send(token);
    if (res.status === 401) {
      token = await o.token(true);
      if (!token) return "signed_out";
      res = await send(token);
    }
    return res;
  } catch {
    return "network";
  }
}

/** The line for an answer this flow has no special case for: the service's code, else the fallback. */
async function otherLine(res: Response, fallback: string, env?: NodeJS.ProcessEnv): Promise<string> {
  if (res.status === 404) return ACCESS_UNAVAILABLE_LINE;
  const err = parseDlError(await readJson(res));
  if (err) {
    const said = describeDlError(err.code, { ...err, where: "session", ...(env ? { env } : {}) });
    if (said) return said;
  }
  return fallback;
}

function signedOutLine(env?: NodeJS.ProcessEnv): string {
  return dlSignedOutLine(env);
}

/** GET /v1/access-request: where an earlier request stands. */
export async function fetchAccessStatus(o: CallOpts): Promise<AccessStatusResult> {
  const res = await call("GET", o);
  if (res === "signed_out") return { kind: "error", line: signedOutLine(o.env) };
  if (res === "network") return { kind: "error", line: ACCESS_CHECK_FAILED_LINE };
  if (!res.ok) return { kind: "error", line: await otherLine(res, ACCESS_CHECK_FAILED_LINE, o.env) };
  const j = await readJson(res);
  const status = j?.status;
  if (status !== "none" && status !== "pending" && status !== "granted" && status !== "declined") return { kind: "error", line: ACCESS_CHECK_FAILED_LINE };
  return { kind: "status", status, ...(typeof j?.at === "string" && j.at ? { at: j.at } : {}) };
}

/** POST /v1/access-request. */
export async function sendAccessRequest(body: AccessRequestBody, o: CallOpts): Promise<AccessSendResult> {
  const res = await call("POST", o, body);
  if (res === "signed_out") return { kind: "error", line: signedOutLine(o.env) };
  if (res === "network") return { kind: "error", line: ACCESS_FAILED_LINE };
  if (res.status === 201 || res.ok) return { kind: "sent" };
  const j = await readJson(res.clone());
  const err = j && typeof j.error === "object" && j.error ? (j.error as Rec) : null;
  const code = typeof err?.code === "string" ? err.code : undefined;
  if (res.status === 409 && code === "already_pending") return { kind: "already_pending" };
  if (res.status === 409 && code === "already_full") return { kind: "already_full" };
  if (res.status === 429) {
    const fromBody = Number(err?.retryAfter ?? err?.retry_after);
    const fromHeader = Number(res.headers.get("retry-after"));
    const secs = Number.isFinite(fromBody) && fromBody > 0 ? fromBody : Number.isFinite(fromHeader) && fromHeader > 0 ? fromHeader : undefined;
    return { kind: "rate_limited", ...(secs !== undefined ? { retryAfterSeconds: secs } : {}) };
  }
  if (res.status === 400) return { kind: "invalid", ...(typeof err?.message === "string" && err.message ? { message: err.message } : {}) };
  return { kind: "error", line: await otherLine(res, ACCESS_FAILED_LINE, o.env) };
}

/** The line shown once the send is over. */
export function accessSendLine(r: AccessSendResult): AccessRequestLine {
  switch (r.kind) {
    case "sent":
      return { text: ACCESS_SENT_LINE, severity: "info" };
    case "already_pending":
      return { text: ACCESS_PENDING_LINE, severity: "info" };
    case "already_full":
      return { text: ACCESS_GRANTED_LINE, severity: "info" };
    case "rate_limited": {
      if (r.retryAfterSeconds === undefined) return { text: "too many requests from this account; try /request again later.", severity: "error" };
      const mins = Math.max(1, Math.ceil(r.retryAfterSeconds / 60));
      return { text: `too many requests from this account; try /request again in ${mins} minute${mins === 1 ? "" : "s"}.`, severity: "error" };
    }
    case "invalid":
      return { text: `not sent: ${r.message ?? "the free tier didn't accept the request"}.`, severity: "error" };
    case "error":
      return { text: r.line, severity: "error" };
  }
}

export interface AccessRequestDeps {
  /** One single-line question; null on Esc. `problem` says why it's asked again; `draft` is what was typed. */
  ask: (field: "building" | "link", o: { problem?: string; draft?: string }) => Promise<string | null>;
  /** The free tier access token; `force` refreshes it. */
  token: (force?: boolean) => Promise<string | undefined>;
  providerId: string;
  providerName?: string;
  /** Shown while a call is in flight. */
  status?: (text: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** The whole flow: status, the two questions, the send. Returns the line to show. */
export async function runAccessRequest(deps: AccessRequestDeps): Promise<AccessRequestLine> {
  if (deps.providerId !== DL_PROVIDER_ID) return { text: accessNotFreeTierLine(deps.providerName), severity: "info" };
  const calls: CallOpts = { token: deps.token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), ...(deps.env ? { env: deps.env } : {}) };

  deps.status?.("Checking your request…");
  const st = await fetchAccessStatus(calls);
  if (st.kind === "error") return { text: st.line, severity: "error" };
  if (st.status === "pending") return { text: ACCESS_PENDING_LINE, severity: "info" };
  if (st.status === "granted") return { text: ACCESS_GRANTED_LINE, severity: "info" };

  let building = "";
  let problem: string | undefined;
  let draft: string | undefined;
  for (;;) {
    const typed = await deps.ask("building", { ...(problem ? { problem } : {}), ...(draft ? { draft } : {}) });
    if (typed === null) return { text: ACCESS_CANCELLED_LINE, severity: "info" };
    problem = buildingProblem(typed);
    if (!problem) {
      building = typed.trim();
      break;
    }
    draft = typed;
  }

  let link: string | undefined;
  problem = undefined;
  draft = undefined;
  for (;;) {
    const typed = await deps.ask("link", { ...(problem ? { problem } : {}), ...(draft ? { draft } : {}) });
    if (typed === null) return { text: ACCESS_CANCELLED_LINE, severity: "info" };
    const c = cleanLink(typed);
    if (!c.problem) {
      link = c.link;
      break;
    }
    problem = c.problem;
    draft = typed;
  }

  deps.status?.("Sending your request…");
  return accessSendLine(await sendAccessRequest({ building, ...(link ? { link } : {}) }, calls));
}
