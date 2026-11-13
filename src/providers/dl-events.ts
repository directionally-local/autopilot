/**
 * Usage events for the Directionally Local free tier: the condition for free
 * tokens, disclosed at sign-in. Sent only while the free tier is the active
 * provider and someone is signed in; nothing at all for other providers.
 *
 * What goes out is counts and outcomes only — `props` is filtered to the
 * contract's allowlist (turns, toolCalls, durationMs, model, provider,
 * exitReason, errorCode, autopilotVersion, os, repoHash). Never prompts,
 * completions, code, file paths or file contents; the repository is a
 * SHA-256 of the canonical remote identity, not the URL.
 *
 * Delivery is batched and fire-and-forget: events queue in memory, a short
 * unref'd timer (or session end, or shutdown) posts them to /v1/events, one
 * retry after a failure, then they are dropped. Nothing here can throw into
 * a session or hold it up beyond the shutdown deadline.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { observeSessionEnd } from "../hooks/session-lifecycle.js";
import { onShutdown, SHUTDOWN_PHASE, withDeadline } from "../util/exit.js";
import { getAppVersion, getUserAgent } from "../util/version.js";
import type { AgentCallbacks } from "../agent/loop.js";
import { DL_PROVIDER_ID, dlAccessToken } from "./directionally-local.js";
import { dlOrigin } from "./dl-endpoint.js";

export type DlEventType = "session.start" | "session.end" | "turn.end" | "pr.opened" | "error";

export const DL_EVENT_PROPS = [
  "turns",
  "toolCalls",
  "durationMs",
  "model",
  "provider",
  "exitReason",
  "errorCode",
  "autopilotVersion",
  "os",
  "repoHash",
] as const;
export type DlEventProps = Partial<{
  turns: number;
  toolCalls: Record<string, number>;
  durationMs: number;
  model: string;
  provider: string;
  exitReason: string;
  errorCode: string;
  autopilotVersion: string;
  os: string;
  repoHash: string;
}>;

export interface DlEvent {
  id: string;
  type: DlEventType;
  sessionId: string;
  at: string;
  props: DlEventProps;
}

const MAX_BATCH = 100;
const MAX_QUEUE = 1000;
const FLUSH_DELAY_MS = 5_000;
const RETRY_DELAY_MS = 1_000;

/** Keep only allowlisted keys with the right shapes; short strings only. */
export function sanitizeProps(props: Record<string, unknown>): DlEventProps {
  const out: Record<string, unknown> = {};
  for (const key of DL_EVENT_PROPS) {
    const v = props[key];
    if (v === undefined || v === null) continue;
    if (key === "toolCalls") {
      if (typeof v !== "object" || Array.isArray(v)) continue;
      const counts: Record<string, number> = {};
      for (const [name, n] of Object.entries(v as Record<string, unknown>)) {
        // Tool names only (e.g. "bash", "mcp_github_create_pr"), never arguments.
        if (typeof n === "number" && Number.isFinite(n) && /^[A-Za-z0-9_.:-]{1,64}$/.test(name)) counts[name] = n;
      }
      out[key] = counts;
    } else if (key === "turns" || key === "durationMs") {
      if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.max(0, Math.round(v));
    } else if (typeof v === "string") {
      out[key] = v.slice(0, 128);
    }
  }
  return out as DlEventProps;
}

/**
 * Canonicalize a Git remote to its repository identity before hashing. This
 * makes SSH/HTTPS and credential-bearing URLs for the same repo correlate,
 * without sending the URL or its embedded credentials.
 */
function canonicalRemote(url: string): string {
  const raw = url.trim();
  let host: string;
  let path: string;

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:", "ssh:", "git+ssh:", "git:"].includes(parsed.protocol)) return raw;
    host = parsed.hostname.toLowerCase();
    // Default ports and transport are not part of a repository's identity.
    const port = parsed.port && !((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80") || ((parsed.protocol === "ssh:" || parsed.protocol === "git+ssh:") && parsed.port === "22"))
      ? `:${parsed.port}`
      : "";
    host += port;
    path = parsed.pathname;
  } catch {
    // Git's scp-like form (git@host:owner/repo.git) is not a URL. Don't
    // reinterpret a malformed URI's scheme colon as an scp-style separator.
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return raw;
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(raw);
    if (!scp) return raw;
    host = scp[1]!.toLowerCase();
    path = scp[2]!;
  }

  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${host}/${path}`;
}

/** SHA-256 of the canonical repository identity (never the remote URL). */
export function hashRemote(url: string): string {
  return createHash("sha256").update(canonicalRemote(url)).digest("hex");
}

/** The repo hash for `cwd`'s origin remote, or undefined outside a git repo. Never throws. */
export function repoHashFor(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["remote", "get-url", "origin"], { cwd, timeout: 2_000 }, (err, stdout) => {
        const url = String(stdout ?? "").trim();
        resolve(err || !url ? undefined : hashRemote(url));
      });
    } catch {
      resolve(undefined);
    }
  });
}

// ── Queue and delivery ───────────────────────────────────────────────────

let queue: DlEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let sleepImpl = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
let shutdownRegistered = false;
let endObserverOff: (() => void) | null = null;

interface SessionStats {
  startedAt: number;
  turns: number;
  toolCalls: Record<string, number>;
  model: string;
  prs: Set<string>;
  repoHash?: string;
}
const sessions = new Map<string, SessionStats>();
/**
 * Local session ids can carry a slug of the first prompt; the service only
 * ever sees a random UUID per session.
 */
const wireIds = new Map<string, string>();
function wireSessionId(sessionId: string): string {
  let id = wireIds.get(sessionId);
  if (!id) {
    id = randomUUID();
    wireIds.set(sessionId, id);
  }
  return id;
}

/** Queue one event (allowlisted props) and schedule delivery. Never throws. */
export function recordDlEvent(type: DlEventType, sessionId: string, props: Record<string, unknown> = {}): void {
  try {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push({ id: randomUUID(), type, sessionId: wireSessionId(sessionId), at: new Date().toISOString(), props: sanitizeProps(props) });
    ensureShutdownFlush();
    if (queue.length >= MAX_BATCH) void flushDlEvents();
    else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushDlEvents();
      }, FLUSH_DELAY_MS);
      timer.unref?.();
    }
  } catch {
    /* never break a session */
  }
}

async function post(batch: DlEvent[]): Promise<boolean> {
  try {
    const token = await dlAccessToken({ fetchImpl });
    if (!token) return true; // signed out: drop, nothing to send as
    const res = await fetchImpl(`${dlOrigin()}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": getUserAgent() },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(5_000),
    });
    // 4xx won't get better on retry (bad token, malformed): drop.
    return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
  } catch {
    return false;
  }
}

/** Send everything queued now: batches of 100, one retry each, then drop. Never throws. */
export function flushDlEvents(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (inflight) return inflight.then(() => (queue.length ? flushDlEvents() : undefined));
  if (queue.length === 0) return Promise.resolve();
  inflight = (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, MAX_BATCH);
        if (!(await post(batch))) {
          await sleepImpl(RETRY_DELAY_MS);
          await post(batch); // second failure: dropped
        }
      }
    } catch {
      /* dropped */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function ensureShutdownFlush(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  onShutdown("dl-events", () => withDeadline(flushDlEvents(), 1_500), SHUTDOWN_PHASE.flush);
}

// ── Session tracking ─────────────────────────────────────────────────────

/** The session's start, once per session per process (free tier only). */
export async function noteDlSessionStart(sessionId: string, info: { model: string; cwd: string }): Promise<void> {
  if (sessions.has(sessionId)) return;
  const stats: SessionStats = { startedAt: Date.now(), turns: 0, toolCalls: {}, model: info.model, prs: new Set() };
  sessions.set(sessionId, stats);
  if (!endObserverOff) {
    endObserverOff = observeSessionEnd(async (id, reason) => {
      if (!sessions.has(id)) return;
      noteDlSessionEnd(id, reason);
      await flushDlEvents();
    });
  }
  const repoHash = await repoHashFor(info.cwd).catch(() => undefined);
  if (repoHash) stats.repoHash = repoHash;
  recordDlEvent("session.start", sessionId, {
    model: info.model,
    provider: DL_PROVIDER_ID,
    autopilotVersion: getAppVersion(),
    os: process.platform,
    repoHash,
  });
}

export function noteDlSessionEnd(sessionId: string, reason: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  recordDlEvent("session.end", sessionId, {
    turns: s.turns,
    toolCalls: s.toolCalls,
    durationMs: Date.now() - s.startedAt,
    model: s.model,
    provider: DL_PROVIDER_ID,
    exitReason: reason,
    repoHash: s.repoHash,
  });
}

/** A line of tool output that is exactly a GitHub pull request URL (what `gh pr create` prints). */
const PR_URL_LINE = /^\s*https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\s*$/m;

/**
 * The turn's callbacks, counting tool calls and noticing an opened PR. Only
 * names and counts are kept; tool output is matched locally and never sent.
 */
export function withDlEvents(callbacks: AgentCallbacks, sessionId: string): { callbacks: AgentCallbacks; toolCalls: Record<string, number> } {
  const toolCalls: Record<string, number> = {};
  return {
    toolCalls,
    callbacks: {
      ...callbacks,
      onToolResult: (result) => {
        try {
          toolCalls[result.name] = (toolCalls[result.name] ?? 0) + 1;
          const s = sessions.get(sessionId);
          if (s) s.toolCalls[result.name] = (s.toolCalls[result.name] ?? 0) + 1;
          const pr = result.ok ? PR_URL_LINE.exec(result.content)?.[0]?.trim() : undefined;
          if (pr && s && !s.prs.has(pr)) {
            s.prs.add(pr);
            recordDlEvent("pr.opened", sessionId, { provider: DL_PROVIDER_ID, model: s.model, repoHash: s.repoHash });
          }
        } catch {
          /* never break a turn */
        }
        callbacks.onToolResult?.(result);
      },
    },
  };
}

/** The end of a turn: its tool counts, duration and how it ended. */
export function noteDlTurnEnd(sessionId: string, info: { toolCalls: Record<string, number>; durationMs: number; exitReason: string; model: string }): void {
  const s = sessions.get(sessionId);
  if (s) s.turns += 1;
  recordDlEvent("turn.end", sessionId, {
    turns: s?.turns ?? 1,
    toolCalls: info.toolCalls,
    durationMs: info.durationMs,
    model: info.model,
    provider: DL_PROVIDER_ID,
    exitReason: info.exitReason,
  });
}

/** A failed turn: only a short code (a provider code, an HTTP status or an error class), never the message. */
export function noteDlError(sessionId: string, err: unknown, model: string): void {
  const e = err as { providerCode?: unknown; httpStatus?: unknown; name?: unknown } | null;
  const code =
    typeof e?.providerCode === "string"
      ? e.providerCode
      : typeof e?.httpStatus === "number"
        ? `http_${e.httpStatus}`
        : typeof e?.name === "string"
          ? e.name
          : "unknown";
  recordDlEvent("error", sessionId, { errorCode: code, model, provider: DL_PROVIDER_ID });
}

/** Test hooks. */
export function setDlEventsTransportForTesting(f: typeof fetch, sleep?: (ms: number) => Promise<void>): void {
  fetchImpl = f;
  if (sleep) sleepImpl = sleep;
}
export function resetDlEventsForTesting(): void {
  queue = [];
  if (timer) clearTimeout(timer);
  timer = null;
  inflight = null;
  sessions.clear();
  wireIds.clear();
  endObserverOff?.();
  endObserverOff = null;
}
export function queuedDlEvents(): readonly DlEvent[] {
  return queue;
}
