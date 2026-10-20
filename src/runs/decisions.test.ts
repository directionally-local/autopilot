import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, type RunRecord } from "./store.js";
import {
  addressOf,
  budgetRaiseFor,
  extractDecisionToken,
  handleDecisionMail,
  isAuthenticated,
  parseDecisionReply,
  type DecisionHost,
  type InboundMail,
} from "./decisions.js";
import { toInboundMail } from "./decisions-imap.js";
import { dispatchNotifications, type EmailMessage } from "./notifications.js";

const OPERATOR = "me@example.com";
const AUTH = "mx.example.com; dkim=pass header.d=example.com; spf=pass; dmarc=pass header.from=example.com";

function pausedRun(reason = "max_runtime_exceeded", budgets: { maxRuntimeMs?: number } = { maxRuntimeMs: 3_600_000 }) {
  const store = new RunStore(join(mkdtempSync(join(tmpdir(), "run-decide-")), "runs.db"));
  const run = store.createRun({ task: "Long training run", cwd: "/tmp", ...budgets });
  store.transition(run.id, "running");
  store.transition(run.id, "needs_input", reason);
  const token = store.openDecisionToken(run.id);
  return { store, runId: run.id, token };
}

function fakeHost(models: string[] = ["google/gemini-3.8-flash"]) {
  const calls: Array<{ kind: string; budgets?: unknown; model?: string; answer?: string }> = [];
  const host: DecisionHost = {
    async resume(_run, opts) {
      calls.push({ kind: "resume", budgets: opts.budgets, ...(opts.model ? { model: opts.model } : {}), ...(opts.answer ? { answer: opts.answer } : {}) });
      return { ok: true };
    },
    cancel: () => calls.push({ kind: "cancel" }),
    modelExists: (id) => models.includes(id),
  };
  return { host, calls };
}

const reply = (token: string, text: string, over: Partial<InboundMail> = {}): InboundMail => ({
  messageId: `<${Math.random()}@example.com>`,
  from: `Me <${OPERATOR}>`,
  subject: `Re: [autopilot] Long training run — needs your input [ref:${token}]`,
  text,
  authenticationResults: AUTH,
  ...over,
});
const policy = { allowedSenders: [OPERATOR] };

describe("parsing replies", () => {
  it("reads the first line the operator wrote, ignoring the quote", () => {
    assert.deepStrictEqual(parseDecisionReply("resume\n\nOn Tue, Oct 20, Autopilot wrote:\n> Reply to this email…"), { action: "resume" });
    assert.deepStrictEqual(parseDecisionReply("  Cancel  "), { action: "cancel" });
    assert.deepStrictEqual(parseDecisionReply("resume model google/gemini-3.8-flash"), { action: "resume", model: "google/gemini-3.8-flash" });
    assert.deepStrictEqual(parseDecisionReply("answer: use the staging bucket\nand skip the GPU check\n> quoted"), {
      action: "answer",
      text: "use the staging bucket\nand skip the GPU check",
    });
    assert.ok("error" in parseDecisionReply("please delete the repo"));
    assert.ok("error" in parseDecisionReply("> only quoted text"));
  });

  it("finds the reference, normalizes senders, and checks authentication", () => {
    assert.strictEqual(extractDecisionToken("Re: x [ref:abcdefghjkmnpqrs]"), "ABCDEFGHJKMNPQRS");
    assert.strictEqual(extractDecisionToken("Re: nothing"), null);
    assert.strictEqual(addressOf("Me <ME@Example.com>"), "me@example.com");
    assert.ok(isAuthenticated(AUTH, OPERATOR));
    assert.ok(isAuthenticated("mx; dkim=pass header.d=example.com; dmarc=fail", OPERATOR));
    assert.ok(!isAuthenticated("mx; dkim=pass header.d=evil.com; dmarc=fail", OPERATOR));
    assert.ok(!isAuthenticated(undefined, OPERATOR));
  });

  it("doubles only the budget that ran out", () => {
    const base = { maxRuntimeMs: 1000, maxToolIterations: 50, maxTotalTokens: 1e6, maxCostUsd: 2.5 } as RunRecord;
    assert.deepStrictEqual(budgetRaiseFor({ ...base, stopReason: "max_runtime_exceeded" }), { maxRuntimeMs: 2000 });
    assert.deepStrictEqual(budgetRaiseFor({ ...base, stopReason: "max_cost_usd_exceeded" }), { maxCostUsd: 5 });
    assert.strictEqual(budgetRaiseFor({ ...base, stopReason: "context_budget_exceeded: …" }), null);
  });
});

describe("handleDecisionMail", () => {
  it("resume: raises the exhausted budget once, records the audit entry, and the token can't be replayed", async () => {
    const { store, runId, token } = pausedRun();
    const { host, calls } = fakeHost();
    const mail = reply(token, "resume");
    assert.deepStrictEqual(await handleDecisionMail(mail, store, host, policy), { status: "applied", runId, action: "resume" });
    assert.deepStrictEqual(calls, [{ kind: "resume", budgets: { maxRuntimeMs: 7_200_000 } }]);
    const replay = await handleDecisionMail({ ...mail, messageId: "<again>" }, store, host, policy);
    assert.strictEqual(replay.status, "rejected");
    assert.strictEqual(calls.length, 1, "nothing happened twice");
    const audit = store.listEvents(runId).filter((e) => e.type === "decision").map((e) => (e.metadata as { outcome: string }).outcome);
    assert.deepStrictEqual(audit, ["applied", "rejected"]);
    store.close();
  });

  it("rejects spoofed, unauthenticated, expired or misdirected replies without acting", async () => {
    const { store, token } = pausedRun();
    const { host, calls } = fakeHost();
    const outcomes = [
      await handleDecisionMail(reply(token, "cancel", { from: "attacker@evil.com" }), store, host, policy),
      await handleDecisionMail(reply(token, "cancel", { authenticationResults: "mx; dkim=fail; dmarc=fail" }), store, host, policy),
      await handleDecisionMail(reply(token, "delete everything"), store, host, policy),
    ];
    assert.deepStrictEqual(outcomes.map((o) => (o.status === "rejected" ? o.reason : o.status)), [
      "sender is not an operator address",
      "sender not authenticated (no DKIM/DMARC pass)",
      "unrecognized command: delete everything",
    ]);
    assert.deepStrictEqual(calls, []);
    assert.strictEqual((await handleDecisionMail(reply("ZZZZZZZZZZZZZZZZ", "cancel"), store, host, policy)).status, "ignored");
    store.close();
  });

  it("context overflow: plain resume is refused; a known model resumes; an unknown model is refused", async () => {
    const { store, token } = pausedRun("context_budget_exceeded: the current turn needs ~215,000 tokens", {});
    const { host, calls } = fakeHost();
    assert.match(String((await handleDecisionMail(reply(token, "resume"), store, host, policy) as { reason: string }).reason), /resume model <id>/);
    assert.match(String((await handleDecisionMail(reply(token, "resume model made/up"), store, host, policy) as { reason: string }).reason), /unknown model/);
    assert.strictEqual((await handleDecisionMail(reply(token, "resume model google/gemini-3.8-flash"), store, host, policy)).status, "applied");
    assert.deepStrictEqual(calls, [{ kind: "resume", budgets: {}, model: "google/gemini-3.8-flash" }]);
    store.close();
  });

  it("answer and cancel", async () => {
    const a = pausedRun("max_tool_iterations_exceeded", {});
    const ha = fakeHost();
    await handleDecisionMail(reply(a.token, "answer: the GPU quota is raised now"), a.store, ha.host, policy);
    assert.deepStrictEqual(ha.calls, [{ kind: "resume", budgets: {}, answer: "the GPU quota is raised now" }]);
    const c = pausedRun();
    const hc = fakeHost();
    assert.strictEqual((await handleDecisionMail(reply(c.token, "cancel"), c.store, hc.host, policy)).status, "applied");
    assert.deepStrictEqual(hc.calls, [{ kind: "cancel" }]);
    a.store.close();
    c.store.close();
  });

  it("a run that's no longer waiting ignores the decision", async () => {
    const { store, runId, token } = pausedRun();
    store.transition(runId, "cancelled", "by api");
    const { host, calls } = fakeHost();
    const out = await handleDecisionMail(reply(token, "resume"), store, host, policy);
    assert.match(String((out as { reason: string }).reason), /run is cancelled/);
    assert.deepStrictEqual(calls, []);
    store.close();
  });
});

describe("the email round trip", () => {
  it("a needs-input email carries the reference and Reply-To; a raw reply parses back into a decision", async () => {
    const { store, runId } = pausedRun();
    const sent: EmailMessage[] = [];
    await dispatchNotifications(store, {
      to: [OPERATOR],
      from: "Autopilot <bot@example.com>",
      transport: { send: async (m) => (sent.push(m), { messageId: "m1" }) },
      decisionsReplyTo: "autopilot-decisions@example.com",
    });
    const email = sent.find((m) => m.subject.includes("needs your input"))!;
    assert.strictEqual(email.replyTo, "autopilot-decisions@example.com");
    const token = extractDecisionToken(email.subject)!;
    assert.ok(token);
    assert.match(email.text, /resume model <id>/);

    const raw = [
      `From: Me <${OPERATOR}>`,
      "To: autopilot-decisions@example.com",
      `Subject: Re: ${email.subject}`,
      "Message-ID: <reply-1@example.com>",
      `Authentication-Results: ${AUTH}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "resume",
      "",
      "On Tue, Oct 20, 2026, Autopilot wrote:",
      "> Reply to this email with one line to decide:",
    ].join("\r\n");
    const mail = await toInboundMail(raw, "uid:1");
    const { host, calls } = fakeHost();
    assert.deepStrictEqual(await handleDecisionMail(mail, store, host, policy), { status: "applied", runId, action: "resume" });
    assert.strictEqual(calls.length, 1);
    store.close();
  });
});
