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
  sendarTransport,
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

// Sendar tests never use the network or a real API key.
describe("Sendar adapter", () => {
  const message: EmailMessage = { from: "bot@example.com", to: ["operator@example.net"], subject: "Run finished", text: "Status: completed", idempotencyKey: "ntf_1234567890123456" };
  it("maps explicit recipients and records only a provider-accepted id", async () => {
    let calls = 0;
    const transport = sendarTransport("synthetic", { fetchImpl: (async (url, init) => {
      calls++;
      assert.strictEqual(url, "https://sendar.app/api/emails");
      assert.strictEqual((init!.headers as Record<string, string>)["Idempotency-Key"], message.idempotencyKey);
      assert.deepStrictEqual(JSON.parse(init!.body as string), {from: message.from, to: message.to, subject: message.subject, text: message.text, trackOpens: false, trackClicks: false});
      return Response.json({id: 42, status: "sent", providerEmailId: "provider-42"}, {status: 201});
    }) as typeof fetch });
    assert.deepStrictEqual(await transport.send(message), {messageId: "provider-42"});
    assert.strictEqual(calls, 1);
  });
  it("requires opt-in provider, recipient, key and verified sender; preserves Resend default", () => {
    assert.strictEqual(notificationSettingsFromConfig(null, {SENDAR_API_KEY: "synthetic", AUTOPILOT_NOTIFY_EMAIL_TO: "operator@example.net"}), null);
    const env = {SENDAR_API_KEY: "synthetic", AUTOPILOT_NOTIFY_EMAIL_PROVIDER: "sendar", AUTOPILOT_NOTIFY_EMAIL_TO: "operator@example.net"};
    assert.strictEqual(notificationSettingsFromConfig(null, env), null);
    assert.ok(notificationSettingsFromConfig(null, {...env, AUTOPILOT_NOTIFY_EMAIL_FROM: "bot@example.com"}));
    assert.strictEqual(notificationSettingsFromConfig(null, {...env, AUTOPILOT_NOTIFY_EMAIL_FROM: "bot@example.com", AUTOPILOT_NOTIFY_EMAIL_TO: ""}), null);
    assert.ok(notificationSettingsFromConfig(null, {RESEND_API_KEY: "synthetic", AUTOPILOT_NOTIFY_EMAIL_TO: "operator@example.net"}));
  });
  it("refuses unsupported reply-to before sending", async () => {
    let calls = 0;
    const transport = sendarTransport("synthetic", { fetchImpl: (async () => { calls++; throw Error("unexpected network"); }) as typeof fetch });
    await assert.rejects(() => transport.send({...message, replyTo: "decisions@example.net"}), NotificationRejected);
    await assert.rejects(() => transport.send({...message, idempotencyKey: "short"}), NotificationRejected);
    assert.strictEqual(calls, 0);
  });
  it("keeps uncertain outcomes uncertain and refusals terminal without raw error leakage", async () => {
    for (const status of [400, 401, 403, 429, 409, 500, 503]) {
      let calls = 0;
      const transport = sendarTransport("synthetic", {fetchImpl: (async () => {calls++; return new Response("SECRET", {status});}) as typeof fetch});
      await assert.rejects(() => transport.send(message), (err: Error) => {
        assert.doesNotMatch(err.message, /SECRET/);
        assert.strictEqual(err instanceof NotificationRejected, status < 500 && status !== 409);
        if (err instanceof NotificationRejected) assert.strictEqual(err.retryable, false);
        return true;
      });
      assert.strictEqual(calls, 1);
    }
    for (const response of [Response.json({id: 42, status: "queued"}), Response.json({status: "sent"}), new Response("not-json")]) {
      await assert.rejects(() => sendarTransport("synthetic", {fetchImpl: (async () => response) as typeof fetch}).send(message));
    }
  });
  it("preserves signal and stable key across timeout recovery with fake transport", async () => {
    const s = store();
    const id = finishedRun(s);
    const keys: string[] = [];
    const transport = sendarTransport("synthetic", {fetchImpl: (async (_url, init) => {
      keys.push((init!.headers as Record<string, string>)["Idempotency-Key"]!);
      if (keys.length === 1) throw new Error("timeout");
      return Response.json({status: "sent", providerEmailId: "provider-recovered"});
    }) as typeof fetch});
    await dispatchNotifications(s, settings(transport));
    assert.strictEqual(s.listNotifications(id)[0]!.status, "uncertain");
    await dispatchNotifications(s, settings(transport));
    assert.strictEqual(s.listNotifications(id)[0]!.providerMessageId, "provider-recovered");
    assert.strictEqual(keys[0], keys[1]);
    s.close();
    const signal = new AbortController().signal;
    await sendarTransport("synthetic", {fetchImpl: (async (_url, init) => {assert.strictEqual(init!.signal, signal); return Response.json({status: "sent", providerEmailId: "p"});}) as typeof fetch}).send(message, signal);
  });
});
