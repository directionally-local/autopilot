import { describe, it } from "node:test";
import assert from "node:assert";
import {
  HANDOFF_HEADINGS,
  hasHandoffHeadings,
  inTurnHandoffFrom,
  planHandoffTurn,
  runHandoff,
  sessionCitation,
  withSessionCitation,
  type HandoffDeps,
} from "./handoff.js";
import type { ChatMessage } from "./messages.js";
import { handoffTrigger } from "./context-budget.js";
import { HANDOFF_HEADINGS as FRESH_HEADINGS, HANDOFF_SYSTEM } from "./continuation-summary.js";

const HANDOFF = `Goal: ship the context handoff
Completed: trigger, authoring, session link
Remaining: tests
Current state: green
Context: src/agent/handoff.ts`;

const FALLBACK = `Goal: fallback goal
Completed: fallback completed
Remaining: fallback remaining
Current state: fallback state
Context: fallback context`;

interface Recorder extends HandoffDeps {
  calls: string[];
}

function deps(over: Partial<HandoffDeps> = {}): Recorder {
  const calls: string[] = [];
  return {
    calls,
    oldSessionId: "old-1",
    transition: true,
    inTurnSummary: HANDOFF,
    checkpoint: async () => {
      calls.push("checkpoint");
    },
    fallbackSummary: async () => {
      calls.push("fallback");
      return FALLBACK;
    },
    compact: async () => {
      calls.push("compact");
    },
    startFresh: (summary) => {
      calls.push(`start:${summary}`);
      return "new-1";
    },
    notify: (kind, text) => {
      calls.push(`notify:${kind}:${text}`);
    },
    ...over,
  };
}

describe("handoff shape", () => {
  it("criterion 1: validates the same five headings /fresh's summarizer asks for", () => {
    assert.equal(HANDOFF_HEADINGS, FRESH_HEADINGS, "one source of truth, not a second copy");
    assert.equal(HANDOFF_HEADINGS.length, 5);
    for (const heading of HANDOFF_HEADINGS) {
      assert.ok(HANDOFF_SYSTEM.includes(heading), `the /fresh prompt asks for ${heading}`);
    }
    assert.equal(hasHandoffHeadings(HANDOFF), true);
    assert.equal(hasHandoffHeadings(HANDOFF.replace("Remaining:", "Todo:")), false);
    assert.equal(hasHandoffHeadings("just prose"), false);
  });

  it("cites the old session id once, as the first line", () => {
    const cited = withSessionCitation(HANDOFF, "old-1");
    assert.ok(cited.startsWith(sessionCitation("old-1")));
    assert.equal(withSessionCitation(cited, "old-1"), cited, "idempotent");
  });

  it("criterion 5: an empty old session id cites nothing", () => {
    assert.equal(withSessionCitation(HANDOFF, ""), HANDOFF);
  });

  it("finds the handoff the model authored in its own turn", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      { role: "assistant", content: HANDOFF },
    ];
    assert.equal(inTurnHandoffFrom(messages), HANDOFF);
    assert.equal(inTurnHandoffFrom([...messages.slice(0, 2), { role: "assistant", content: "no headings" }]), null);
    assert.equal(inTurnHandoffFrom([{ role: "user", content: HANDOFF }]), null);
  });
});

describe("handoff trigger plan", () => {
  it("criterion 1: the 50% ping is delivered at the turn start and the checkpoint waits for the natural break", async () => {
    // Drive the trigger from the fill fraction, not a hand-built trigger.
    const trigger = handoffTrigger(0.55);
    assert.equal(trigger, "ping");
    if (trigger === "none") throw new Error("expected a ping at 55% fill");
    const plan = planHandoffTurn({ trigger, fill: 0.55, autoFreshEnabled: true, mode: "edit", oldSessionId: "old-1" });
    assert.match(plan.notice, /55% of the input budget/);
    assert.equal(plan.checkpointAtBreak, true);
    assert.equal(plan.transitionAtBreak, false, "a ping never transitions");

    // Planning is pure: nothing is written while the iteration is running.
    const d = deps({ transition: false, inTurnSummary: null });
    assert.deepEqual(d.calls, []);
    // The iteration ends; only now does the checkpoint run.
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "checkpoint");
    assert.deepEqual(d.calls, ["checkpoint"]);
  });

  it("criterion 2: the 80% warning transitions at the break, after the checkpoint", async () => {
    const trigger = handoffTrigger(0.82);
    assert.equal(trigger, "warning");
    if (trigger === "none") throw new Error("expected a warning at 82% fill");
    const plan = planHandoffTurn({ trigger, fill: 0.82, autoFreshEnabled: true, mode: "edit", oldSessionId: "old-1" });
    assert.equal(plan.transitionAtBreak, true);
    const d = deps();
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "handoff");
    assert.deepEqual(d.calls.slice(0, 2), ["checkpoint", `start:${withSessionCitation(HANDOFF, "old-1")}`]);
    if (outcome.kind === "handoff") {
      assert.equal(outcome.source, "in-turn");
      assert.equal(outcome.newSessionId, "new-1");
      assert.ok(outcome.summary.startsWith(sessionCitation("old-1")));
    }
  });

  it("criterion 11: 79% plans a ping with no transition; 49% is not a trigger at all", () => {
    const trigger = handoffTrigger(0.79);
    assert.equal(trigger, "ping");
    if (trigger === "none") throw new Error("expected a ping at 79% fill");
    const ping = planHandoffTurn({ trigger, fill: 0.79, mode: "edit", oldSessionId: "old-1" });
    assert.equal(ping.transitionAtBreak, false);
    assert.equal(ping.checkpointAtBreak, true);
    assert.equal(handoffTrigger(0.49), "none");
  });

  it("criterion 3: the handoff is the default at the warning; an explicit opt-out keeps the checkpoint only", () => {
    const byDefault = planHandoffTurn({ trigger: "warning", fill: 0.82, mode: "edit", oldSessionId: "old-1" });
    assert.equal(byDefault.transitionAtBreak, true, "unset autoFreshEnabled means the handoff is the default");
    const optedOut = planHandoffTurn({ trigger: "warning", fill: 0.82, autoFreshEnabled: false, mode: "edit", oldSessionId: "old-1" });
    assert.equal(optedOut.transitionAtBreak, false);
    assert.equal(optedOut.checkpointAtBreak, true);
  });
});

describe("runHandoff ordering", () => {
  it("criterion 3: the in-turn handoff is used and the fallback summarizer is not called", async () => {
    const d = deps();
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "handoff");
    assert.equal(d.calls.includes("fallback"), false, "generateContinuationSummary is not called on the in-turn path");
    assert.equal(d.calls.includes("compact"), false);
  });

  it("criterion 4: without an in-turn handoff the fallback summary is used", async () => {
    const d = deps({ inTurnSummary: null });
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "handoff");
    if (outcome.kind === "handoff") assert.equal(outcome.source, "fallback");
    assert.ok(d.calls.includes("fallback"));
    assert.equal(d.calls.includes("compact"), false);
  });

  it("criterion 4/6: a failing fallback surfaces the failure and falls back to compaction", async () => {
    const d = deps({
      inTurnSummary: null,
      fallbackSummary: async () => {
        throw new Error("model unavailable");
      },
    });
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "compaction");
    assert.ok(d.calls.includes("compact"), "compaction runs");
    const notice = d.calls.find((c) => c.startsWith("notify:error:"));
    assert.ok(notice, "the failure is surfaced");
    assert.match(notice!, /Handoff failed: model unavailable/);
    assert.match(notice!, /compaction/);
  });

  it("criterion 6: an empty summary also falls back to compaction with a notice", async () => {
    const d = deps({ inTurnSummary: null, fallbackSummary: async () => null });
    const outcome = await runHandoff(d);
    assert.equal(outcome.kind, "compaction");
    assert.ok(d.calls.includes("compact"));
    assert.ok(d.calls.some((c) => c.startsWith("notify:error:") && /Handoff failed/.test(c)));
  });

  it("criterion 6: a successful handoff never runs compaction", async () => {
    const d = deps();
    await runHandoff(d);
    assert.equal(d.calls.includes("compact"), false);
  });

  it("criterion 8: the handoff produces a one-line notice and the summary is stored for review", async () => {
    const d = deps();
    const outcome = await runHandoff(d);
    const notice = d.calls.find((c) => c.startsWith("notify:info:"));
    assert.ok(notice);
    const text = notice!.slice("notify:info:".length);
    assert.equal(text.split("\n").length, 1, "one line");
    assert.match(text, /Handoff complete: session new-1 continues from old-1/);
    // The summary is handed to the new session (seeded as its first message).
    assert.ok(d.calls.some((c) => c.startsWith("start:") && c.includes("Goal: ship the context handoff")));
    if (outcome.kind === "handoff") assert.ok(outcome.summary.includes("Goal: ship the context handoff"));
  });
});
