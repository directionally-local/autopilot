/**
 * Polls the decisions mailbox over IMAP (#671, 1.6): unread replies are
 * parsed and handed to handleDecisionMail, then marked read. Polling needs
 * no inbound network access, so `autopilot serve` stays on localhost.
 *
 * Configure with AUTOPILOT_DECISIONS_IMAP_HOST / _PORT (993) / _USER /
 * _PASSWORD / _MAILBOX (INBOX), plus AUTOPILOT_DECISIONS_REPLY_TO (that
 * mailbox's address, set as Reply-To on "needs input" emails). Use a
 * mailbox dedicated to Autopilot.
 */

import type { InboundMail } from "./decisions.js";
import { logger } from "../util/logger.js";

export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  mailbox: string;
}

export function imapSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ImapSettings | null {
  const host = env.AUTOPILOT_DECISIONS_IMAP_HOST?.trim();
  const user = env.AUTOPILOT_DECISIONS_IMAP_USER?.trim();
  const password = env.AUTOPILOT_DECISIONS_IMAP_PASSWORD;
  if (!host || !user || !password) return null;
  const port = Number(env.AUTOPILOT_DECISIONS_IMAP_PORT ?? 993);
  return { host, port: Number.isInteger(port) && port > 0 ? port : 993, user, password, mailbox: env.AUTOPILOT_DECISIONS_IMAP_MAILBOX?.trim() || "INBOX" };
}

/** A raw RFC 822 message as the decision handler sees it. */
export async function toInboundMail(source: Buffer | string, fallbackId: string): Promise<InboundMail> {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(source);
  const auth = parsed.headers.get("authentication-results");
  return {
    messageId: parsed.messageId ?? fallbackId,
    from: parsed.from?.text ?? "",
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    ...(auth ? { authenticationResults: Array.isArray(auth) ? auth.join("; ") : String(auth) } : {}),
  };
}

/** Fetch unread messages, hand each to `handle`, mark it read. Returns how many were handled. */
export async function pollDecisionMailbox(settings: ImapSettings, handle: (mail: InboundMail) => Promise<void>): Promise<number> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.port === 993,
    auth: { user: settings.user, pass: settings.password },
    logger: false,
  });
  await client.connect();
  let handled = 0;
  try {
    const lock = await client.getMailboxLock(settings.mailbox);
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) {
          await handle(await toInboundMail(msg.source, `uid:${uid}`));
          handled++;
        }
        // Read either way: a message is considered once (the token makes decisions single-use too).
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return handled;
}

/** Poll in the background (the server). Returns a stop function. */
export function startDecisionPoller(settings: ImapSettings, handle: (mail: InboundMail) => Promise<void>, intervalMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollDecisionMailbox(settings, handle);
    } catch (err) {
      logger.warn("runs:decision_poll_failed", { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
