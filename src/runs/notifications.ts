/**
 * Outbound run notifications (#671, 1.5): an email when an unattended run
 * completes, fails, is cancelled, is interrupted, or needs input.
 *
 * Delivery is decoupled from run state. The store writes a notification
 * row in the same transaction as the state change; this dispatcher sends
 * pending rows through a transport:
 *
 *   pending → sending → sent (provider message id recorded)
 *   provider rejected it → retry (429/5xx, bounded) or failed (4xx)
 *   outcome unknown (network error or timeout after submitting) → uncertain
 *
 * Every attempt for a notification uses the same idempotency key (its id),
 * so retrying an uncertain send can't deliver it twice. A provider outage
 * never blocks a run, and a restart resumes delivery instead of losing or
 * duplicating messages. Emails carry status, stop reason, cost and how to
 * inspect the run — never transcript content or secrets.
 */

import type { RunNotification, RunRecord, RunStore } from "./store.js";
import { logger } from "../util/logger.js";

export interface EmailMessage {
  to: string[];
  from: string;
  /** Where replies go (the decisions mailbox), when email decisions are on. */
  replyTo?: string;
  subject: string;
  text: string;
  /** Same for every attempt of one notification. */
  idempotencyKey: string;
}

/** The provider answered and did not accept the message. */
export class NotificationRejected extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NotificationRejected";
  }
}

export interface EmailTransport {
  /** Resolves with the provider's message id once accepted. Throws NotificationRejected, or anything else when the outcome is unknown. */
  send(message: EmailMessage, signal?: AbortSignal): Promise<{ messageId: string }>;
}

/** Resend (https://resend.com): POST /emails with an Idempotency-Key. */
export function resendTransport(apiKey: string, opts: { fetchImpl?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {}): EmailTransport {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    async send(message, signal) {
      const res = await fetchImpl(`${opts.baseUrl ?? "https://api.resend.com"}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
        signal: signal ?? AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok) {
        throw new NotificationRejected(`Resend ${res.status}: ${body.message ?? body.name ?? "rejected"}`, res.status === 429 || res.status >= 500);
      }
      if (!body.id) throw new Error("Resend accepted the request but returned no message id");
      return { messageId: body.id };
    },
  };
}

export interface NotificationSettings {
  to: string[];
  from: string;
  /** Run states to send; defaults to all notifiable states. */
  events?: string[];
  transport: EmailTransport;
  /** Email decisions (#671 1.6): replies to "needs input" emails go to this mailbox. */
  decisionsReplyTo?: string;
}

/** Notification settings from config + env (RESEND_API_KEY, AUTOPILOT_NOTIFY_EMAIL_TO / _FROM), or null when off. */
export function notificationSettingsFromConfig(
  cfg: { runNotifications?: { email?: { to?: string | string[]; from?: string; events?: string[] } } } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NotificationSettings | null {
  const email = cfg?.runNotifications?.email;
  const toRaw = env.AUTOPILOT_NOTIFY_EMAIL_TO ?? email?.to;
  const to = (Array.isArray(toRaw) ? toRaw : (toRaw ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
  const apiKey = env.RESEND_API_KEY?.trim();
  if (to.length === 0 || !apiKey) return null;
  return {
    to,
    from: env.AUTOPILOT_NOTIFY_EMAIL_FROM ?? email?.from ?? "Autopilot <onboarding@resend.dev>",
    ...(email?.events ? { events: email.events } : {}),
    transport: resendTransport(apiKey),
    ...(env.AUTOPILOT_DECISIONS_REPLY_TO?.trim() ? { decisionsReplyTo: env.AUTOPILOT_DECISIONS_REPLY_TO.trim() } : {}),
  };
}

const MAX_ATTEMPTS = 5;
/** Resend keeps idempotency keys for 24 hours; never send anything older. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Drop anything that looks like a credential before it leaves the host. */
export function redactForEmail(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|github_pat|xox[abp]|AKIA)[-_A-Za-z0-9]{12,}/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, "[redacted]")
    .replace(/(password|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

const HEADLINE: Record<string, string> = {
  completed: "finished",
  failed: "failed",
  needs_input: "needs your input",
  cancelled: "was cancelled",
  interrupted_unknown: "was interrupted (needs a check before resuming)",
};

/** The email for one notification. */
export function notificationEmail(
  n: RunNotification,
  run: RunRecord,
  opts: { from: string; to: string[]; host?: string; decision?: { token: string; replyTo: string } },
): EmailMessage {
  const task = redactForEmail(run.task.replace(/\s+/g, " ").trim());
  const short = task.length > 60 ? `${task.slice(0, 57)}…` : task;
  const lines = [
    `Run ${run.id} ${HEADLINE[n.kind] ?? n.kind}.`,
    "",
    `Task: ${task.length > 400 ? `${task.slice(0, 397)}…` : task}`,
    `Status: ${n.kind}`,
    ...(n.reason ? [`Reason: ${redactForEmail(n.reason).slice(0, 600)}`] : []),
    ...(run.branch ? [`Branch: ${run.branch}`] : []),
    `Cost so far: $${run.totalCostUsd.toFixed(2)}${run.costUnknownResponses > 0 ? " (some responses had no cost)" : ""}`,
    `Tokens: ${(run.totalPromptTokens + run.totalCompletionTokens).toLocaleString("en-US")}`,
    "",
    ...(n.kind === "needs_input" && opts.decision
      ? [
          "Reply to this email with one line to decide:",
          "  resume                 continue (a budget that ran out is doubled once)",
          "  resume model <id>      continue on another model (e.g. a larger context window)",
          "  cancel                 stop the run",
          "  answer: <text>         tell the agent something, then continue",
          "The reply must come from your address and works once, for 72 hours.",
          "",
        ]
      : []),
    n.kind === "needs_input"
      ? "Inspect it over SSH, then resume or cancel:"
      : "Inspect it over SSH:",
    `  curl -u "kimiflare:$KIMIFLARE_SERVER_PASSWORD" http://127.0.0.1:4096/runs/${run.id}`,
    ...(n.kind === "needs_input" ? [`  curl -u … -X POST http://127.0.0.1:4096/runs/${run.id}/resume -d '{…}'`] : []),
    "",
    `— Autopilot${opts.host ? ` on ${opts.host}` : ""}`,
  ];
  return {
    to: opts.to,
    from: opts.from,
    subject: `[autopilot] ${short} — ${HEADLINE[n.kind] ?? n.kind}${opts.decision ? ` [ref:${opts.decision.token}]` : ""}`,
    text: lines.join("\n"),
    idempotencyKey: n.id,
    ...(opts.decision ? { replyTo: opts.decision.replyTo } : {}),
  };
}

/** Send pending notifications once. Returns how many were sent. */
export async function dispatchNotifications(store: RunStore, settings: NotificationSettings | null, opts: { host?: string } = {}): Promise<number> {
  const pending = store.pendingNotifications();
  if (!settings) {
    for (const n of pending) store.updateNotification(n.id, { status: "skipped" });
    return 0;
  }
  let sent = 0;
  for (const n of pending) {
    // Older than the provider's idempotency window, or queued before email was configured.
    if (Date.now() - n.createdAt > STALE_AFTER_MS) {
      store.updateNotification(n.id, { status: "skipped", error: "stale" });
      continue;
    }
    if (settings.events && !settings.events.includes(n.kind)) {
      store.updateNotification(n.id, { status: "skipped" });
      continue;
    }
    const run = store.getRun(n.runId);
    if (!run) {
      store.updateNotification(n.id, { status: "failed", error: "run no longer exists" });
      continue;
    }
    store.updateNotification(n.id, { status: "sending" });
    try {
      const decision =
        n.kind === "needs_input" && settings.decisionsReplyTo ? { token: store.openDecisionToken(run.id), replyTo: settings.decisionsReplyTo } : undefined;
      const { messageId } = await settings.transport.send(
        notificationEmail(n, run, { from: settings.from, to: settings.to, ...(opts.host ? { host: opts.host } : {}), ...(decision ? { decision } : {}) }),
      );
      store.updateNotification(n.id, { status: "sent", providerMessageId: messageId, countAttempt: true });
      sent++;
    } catch (err) {
      const message = (err as Error).message.slice(0, 300);
      const exhausted = n.attempts + 1 >= MAX_ATTEMPTS;
      if (err instanceof NotificationRejected) {
        store.updateNotification(n.id, { status: err.retryable && !exhausted ? "retry" : "failed", error: message, countAttempt: true });
      } else {
        // Unknown outcome: retried with the same idempotency key, so the provider dedupes it.
        store.updateNotification(n.id, { status: exhausted ? "failed" : "uncertain", error: message, countAttempt: true });
      }
      logger.warn("runs:notification_failed", { notificationId: n.id, runId: n.runId, error: message });
    }
  }
  return sent;
}

/** Keep dispatching in the background (the server's run daemon). Returns a stop function. */
export function startNotificationDispatcher(
  openStore: () => RunStore,
  settings: NotificationSettings | null,
  opts: { intervalMs?: number; host?: string } = {},
): () => void {
  {
    const store = openStore();
    try {
      store.recoverInFlightNotifications();
    } finally {
      store.close();
    }
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    const store = openStore();
    try {
      await dispatchNotifications(store, settings, opts);
    } catch (err) {
      logger.warn("runs:notification_dispatch_failed", { error: String(err) });
    } finally {
      store.close();
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), opts.intervalMs ?? 10_000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
