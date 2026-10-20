/**
 * Email decisions for paused runs (#671, 1.6).
 *
 * A "needs input" email carries a single-use, expiring token in its subject
 * (`[ref:…]`) and a Reply-To pointing at a dedicated mailbox. The server
 * polls that mailbox over IMAP — no public endpoint, the server stays bound
 * to localhost — and acts on a reply only when all of these hold:
 *
 *  - the sender is one of the operator addresses notifications go to
 *  - the receiving mail server authenticated it (DKIM or DMARC pass)
 *  - the token exists, is unexpired and unused, and its run is still
 *    waiting for input
 *  - the first line is one of a few commands: resume, resume model <id>,
 *    cancel, answer: <text>
 *
 * Replies can't widen permissions: a plain "resume" at most doubles the one
 * budget that ran out, a model must be in the catalog, and an answer is
 * bounded text handed to the agent as a message. Every reply — accepted or
 * rejected — is recorded on the run (the audit trail), and the token is
 * consumed atomically, so a replayed or duplicate reply does nothing.
 */

import type { RunBudgetUpdate, RunRecord, RunStore } from "./store.js";
import { logger } from "../util/logger.js";

export type Decision = { action: "resume"; model?: string } | { action: "cancel" } | { action: "answer"; text: string };

const MAX_ANSWER_CHARS = 2000;

/** The token from `[ref:XXXX]` in the subject (or, failing that, the quoted body). */
export function extractDecisionToken(subject: string, body = ""): string | null {
  const m = /\[ref:([A-Z2-9]{16})\]/i.exec(subject) ?? /\[ref:([A-Z2-9]{16})\]/i.exec(body);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * The command on the first line the operator wrote: quoted text (">"), the
 * "On … wrote:" attribution and signatures are ignored.
 */
export function parseDecisionReply(text: string): Decision | { error: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const own: string[] = [];
  for (const line of lines) {
    if (/^\s*>/.test(line) || /^On .+wrote:\s*$/.test(line.trim()) || /^-- ?$/.test(line)) break;
    own.push(line);
  }
  const first = own.map((l) => l.trim()).find(Boolean);
  if (!first) return { error: "empty reply" };
  const cmd = first.toLowerCase();
  if (cmd === "cancel" || cmd === "stop") return { action: "cancel" };
  if (cmd === "resume" || cmd === "continue" || cmd === "approve") return { action: "resume" };
  const model = /^resume\s+model\s+(\S+)$/i.exec(first);
  if (model) return { action: "resume", model: model[1]! };
  // The operator's own text starts at its first line, so an answer may span several lines.
  const answer = /^answer\s*:\s*([\s\S]+)$/i.exec(own.join("\n").trim());
  if (answer) {
    const body = answer[1]!.trim();
    if (!body) return { error: "empty answer" };
    return { action: "answer", text: body.slice(0, MAX_ANSWER_CHARS) };
  }
  return { error: `unrecognized command: ${first.slice(0, 80)}` };
}

/** Bare address from `Name <a@b.c>`, lowercased. */
export function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** The receiving server's verdict: DKIM or DMARC pass for the sender's domain. */
export function isAuthenticated(authenticationResults: string | undefined, sender: string): boolean {
  if (!authenticationResults) return false;
  const domain = sender.split("@")[1] ?? "";
  const results = authenticationResults.toLowerCase();
  if (/\bdmarc=pass\b/.test(results)) return true;
  return new RegExp(`\\bdkim=pass\\b[^;]*header\\.(?:d|i)=@?${domain.replace(/\./g, "\\.")}\\b`).test(results);
}

/** For a budget pause, the one exhausted budget doubled; null when the pause isn't a budget. */
export function budgetRaiseFor(run: RunRecord): RunBudgetUpdate | null {
  switch (run.stopReason) {
    case "max_runtime_exceeded":
      return run.maxRuntimeMs !== null ? { maxRuntimeMs: run.maxRuntimeMs * 2 } : {};
    case "max_tool_iterations_exceeded":
      return run.maxToolIterations !== null ? { maxToolIterations: run.maxToolIterations * 2 } : {};
    case "max_total_tokens_exceeded":
      return run.maxTotalTokens !== null ? { maxTotalTokens: run.maxTotalTokens * 2 } : {};
    case "max_cost_usd_exceeded":
      return run.maxCostUsd !== null ? { maxCostUsd: Math.round(run.maxCostUsd * 200) / 100 } : {};
    default:
      return null;
  }
}

export interface InboundMail {
  messageId: string;
  from: string;
  subject: string;
  text: string;
  /** The Authentication-Results header the receiving server added. */
  authenticationResults?: string;
}

/** What the server can do for a decision (routes.ts provides it). */
export interface DecisionHost {
  resume(run: RunRecord, opts: { budgets: RunBudgetUpdate; model?: string; answer?: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  cancel(run: RunRecord): void;
  modelExists(id: string): boolean;
  /** Confirmation back to the operator (best effort). */
  confirm?(to: string, subject: string, text: string): Promise<void>;
}

export interface DecisionPolicy {
  /** Operator addresses allowed to decide (the notification recipients). */
  allowedSenders: string[];
  /** Require DKIM/DMARC pass (default true; turn off only for testing). */
  requireAuthentication?: boolean;
}

export type DecisionOutcome =
  | { status: "applied"; runId: string; action: Decision["action"] }
  | { status: "rejected"; runId?: string; reason: string }
  | { status: "ignored"; reason: string };

/** Check and apply one reply. Never throws for a bad reply: it's recorded and rejected. */
export async function handleDecisionMail(mail: InboundMail, store: RunStore, host: DecisionHost, policy: DecisionPolicy): Promise<DecisionOutcome> {
  const token = extractDecisionToken(mail.subject, mail.text);
  if (!token) return { status: "ignored", reason: "no decision reference" };
  const record = store.decisionToken(token);
  if (!record) return { status: "ignored", reason: "unknown reference" };
  const runId = record.runId;
  const sender = addressOf(mail.from);
  const reject = (reason: string): DecisionOutcome => {
    store.recordDecision(runId, { outcome: "rejected", reason, sender, messageId: mail.messageId });
    logger.warn("runs:decision_rejected", { runId, reason, sender });
    return { status: "rejected", runId, reason };
  };

  if (!policy.allowedSenders.map((a) => a.toLowerCase()).includes(sender)) return reject("sender is not an operator address");
  if (policy.requireAuthentication !== false && !isAuthenticated(mail.authenticationResults, sender)) {
    return reject("sender not authenticated (no DKIM/DMARC pass)");
  }
  if (record.usedAt !== null) return reject("reference already used");
  if (record.expiresAt < Date.now()) return reject("reference expired");
  const run = store.getRun(runId);
  if (!run || run.status !== "needs_input") return reject(`run is ${run?.status ?? "gone"}, not waiting for input`);

  const decision = parseDecisionReply(mail.text);
  if ("error" in decision) return reject(decision.error);

  let opts: { budgets: RunBudgetUpdate; model?: string; answer?: string } = { budgets: {} };
  if (decision.action === "cancel") {
    if (!store.consumeDecisionToken(token, "cancel")) return reject("reference already used");
    host.cancel(run);
  } else {
    if (decision.action === "resume" && decision.model) {
      if (!host.modelExists(decision.model)) return reject(`unknown model ${decision.model}`);
      opts = { budgets: {}, model: decision.model };
    } else {
      const raise = budgetRaiseFor(run);
      if (run.stopReason?.startsWith("context_budget_exceeded") && decision.action === "resume") {
        return reject("this run needs a larger-context model: reply `resume model <id>`");
      }
      opts = { budgets: raise ?? {}, ...(decision.action === "answer" ? { answer: decision.text } : {}) };
    }
    if (!store.consumeDecisionToken(token, decision.action)) return reject("reference already used");
    const result = await host.resume(run, opts);
    if (!result.ok) {
      store.recordDecision(runId, { outcome: "failed", reason: result.error, sender, messageId: mail.messageId, action: decision.action });
      return { status: "rejected", runId, reason: result.error };
    }
  }

  store.recordDecision(runId, {
    outcome: "applied",
    action: decision.action,
    sender,
    messageId: mail.messageId,
    ...(opts.model ? { model: opts.model } : {}),
    ...(Object.keys(opts.budgets).length ? { budgets: opts.budgets } : {}),
  });
  void host
    .confirm?.(
      sender,
      `[autopilot] Run ${run.id.slice(0, 8)}: ${decision.action === "cancel" ? "cancelled" : "resumed"}`,
      `Your reply was applied: ${decision.action}${opts.model ? ` on ${opts.model}` : ""}${Object.keys(opts.budgets).length ? ` with ${JSON.stringify(opts.budgets)}` : ""}.`,
    )
    .catch(() => {});
  return { status: "applied", runId, action: decision.action };
}
