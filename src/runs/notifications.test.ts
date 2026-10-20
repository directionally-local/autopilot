import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./store.js";
import {
  dispatchNotifications,
  notificationSettingsFromConfig,
  NotificationRejected,
  redactForEmail,
  resendTransport,
  type EmailMessage,
  type EmailTransport,
  type NotificationSettings,
} from "./notifications.js";

function store(): RunStore {
  return new RunStore(join(mkdtempSync(join(tmpdir(), "run-notify-")), "runs.db"));
}

/** A transport that replays scripted outcomes and records what it was asked to send. */
function fakeTransport(outcomes: Array<"ok" | "timeout" | 429 | 400>) {
  const sent: EmailMessage[] = [];
  const transport: EmailTransport = {
    async send(message) {
      sent.push(message);
      const outcome = outcomes.shift() ?? "ok";
      if (outcome === "timeout") throw new Error("The operation was aborted due to timeout");
      if (outcome === 429) throw new NotificationRejected("Resend 429: rate limited", true);
      if (outcome === 400) throw new NotificationRejected("Resend 400: invalid from", false);
      return { messageId: `msg_${sent.length}` };
    },
  };
  return { transport, sent };
}

const settings = (transport: EmailTransport, extra: Partial<NotificationSettings> = {}): NotificationSettings => ({
  to: ["me@example.com"],
  from: "Autopilot <bot@example.com>",
  transport,
  ...extra,
});

function finishedRun(s: RunStore, task = "Train the model and fix the flaky test", to: "completed" | "needs_input" | "failed" = "completed") {
  const run = s.createRun({ task, cwd: "/tmp" });
  s.transition(run.id, "running");
  s.transition(run.id, to, to === "needs_input" ? "context_budget_exceeded: too big" : undefined);
  return run.id;
}

describe("run notifications", () => {
  it("records the intent with the state change, only for states the operator cares about", () => {
    const s = store();
    const id = finishedRun(s);
    const list = s.listNotifications(id);
    assert.deepStrictEqual(list.map((n) => [n.kind, n.status]), [["completed", "pending"]]);
    s.close();
  });

  it("sends once, records the provider message id, and keeps transcripts and secrets out", async () => {
    const s = store();
    const id = finishedRun(s, "Deploy with token=sk-live-abcdefghijklmnopqrstuvwxyz and report", "needs_input");
    const { transport, sent } = fakeTransport(["ok"]);
    assert.strictEqual(await dispatchNotifications(s, settings(transport)), 1);
    assert.strictEqual(await dispatchNotifications(s, settings(transport)), 0, "nothing left to send");
    const [n] = s.listNotifications(id);
    assert.strictEqual(n!.status, "sent");
    assert.strictEqual(n!.providerMessageId, "msg_1");
    const email = sent[0]!;
    assert.strictEqual(email.idempotencyKey, n!.id);
    assert.match(email.subject, /needs your input$/);
    assert.match(email.text, /Reason: context_budget_exceeded: too big/);
    assert.match(email.text, /\/resume/);
    assert.doesNotMatch(email.text, /sk-live/);
    s.close();
  });

  it("an unknown outcome is retried with the same idempotency key; rejections retry (429) or fail (400)", async () => {
    const s = store();
    const a = finishedRun(s);
    const { transport, sent } = fakeTransport(["timeout", "ok"]);
    await dispatchNotifications(s, settings(transport));
    assert.strictEqual(s.listNotifications(a)[0]!.status, "uncertain");
    await dispatchNotifications(s, settings(transport));
    assert.strictEqual(s.listNotifications(a)[0]!.status, "sent");
    assert.strictEqual(sent[0]!.idempotencyKey, sent[1]!.idempotencyKey, "provider dedupes the retry");

    const b = finishedRun(s, "second", "failed");
    const c = finishedRun(s, "third");
    const second = fakeTransport([429, 400]);
    await dispatchNotifications(s, settings(second.transport));
    assert.strictEqual(s.listNotifications(b)[0]!.status, "retry");
    assert.strictEqual(s.listNotifications(c)[0]!.status, "failed");
    s.close();
  });

  it("a send in flight when the server died becomes uncertain on restart", () => {
    const s = store();
    const id = finishedRun(s);
    const [n] = s.listNotifications(id);
    s.updateNotification(n!.id, { status: "sending" });
    assert.strictEqual(s.recoverInFlightNotifications(), 1);
    assert.strictEqual(s.listNotifications(id)[0]!.status, "uncertain");
    s.close();
  });

  it("skips events the operator filtered out, and everything when email isn't configured", async () => {
    const s = store();
    const done = finishedRun(s);
    const needs = finishedRun(s, "x", "needs_input");
    const { transport, sent } = fakeTransport([]);
    await dispatchNotifications(s, settings(transport, { events: ["needs_input"] }));
    assert.strictEqual(s.listNotifications(done)[0]!.status, "skipped");
    assert.strictEqual(s.listNotifications(needs)[0]!.status, "sent");
    assert.strictEqual(sent.length, 1);
    const other = finishedRun(s);
    await dispatchNotifications(s, null);
    assert.strictEqual(s.listNotifications(other)[0]!.status, "skipped");
    s.close();
  });

  it("settings come from config and env; off without a key or recipient", () => {
    assert.strictEqual(notificationSettingsFromConfig({ runNotifications: { email: { to: "a@b.c" } } }, {}), null);
    assert.strictEqual(notificationSettingsFromConfig({}, { RESEND_API_KEY: "re_x" }), null);
    const s = notificationSettingsFromConfig({ runNotifications: { email: { to: ["a@b.c"], events: ["failed"] } } }, { RESEND_API_KEY: "re_x", AUTOPILOT_NOTIFY_EMAIL_FROM: "Ops <ops@x.dev>" });
    assert.deepStrictEqual([s?.to, s?.from, s?.events], [["a@b.c"], "Ops <ops@x.dev>", ["failed"]]);
    assert.deepStrictEqual(notificationSettingsFromConfig(null, { RESEND_API_KEY: "re_x", AUTOPILOT_NOTIFY_EMAIL_TO: "a@b.c, d@e.f" })?.to, ["a@b.c", "d@e.f"]);
  });

  it("the Resend transport sends the idempotency key and classifies rejections", async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const ok = resendTransport("re_test", {
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
        return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const msg: EmailMessage = { to: ["a@b.c"], from: "x@y.z", subject: "s", text: "t", idempotencyKey: "ntf_1" };
    assert.deepStrictEqual(await ok.send(msg), { messageId: "email_123" });
    assert.strictEqual(seen!.url, "https://api.resend.com/emails");
    assert.strictEqual(seen!.headers["Idempotency-Key"], "ntf_1");
    assert.strictEqual(seen!.headers.Authorization, "Bearer re_test");
    const limited = resendTransport("re_test", { fetchImpl: (async () => new Response(JSON.stringify({ message: "slow down" }), { status: 429 })) as unknown as typeof fetch });
    await assert.rejects(limited.send(msg), (e: unknown) => e instanceof NotificationRejected && e.retryable);
    const bad = resendTransport("re_test", { fetchImpl: (async () => new Response(JSON.stringify({ message: "bad from" }), { status: 422 })) as unknown as typeof fetch });
    await assert.rejects(bad.send(msg), (e: unknown) => e instanceof NotificationRejected && !e.retryable);
  });

  it("redacts credential-looking strings", () => {
    assert.strictEqual(redactForEmail("use ghp_abcdefghijklmnopqrstu1234 now"), "use [redacted] now");
    assert.strictEqual(redactForEmail("password: hunter2"), "password=[redacted]");
  });
});
