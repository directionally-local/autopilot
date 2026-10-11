import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allowsSubagentDispatch, resolveSubagentGuidance, SUBAGENT_JEV_OPTIONS } from "./subagent-policy.js";
import type { JevAnswer, JevQuestion } from "../agent/jev.js";

const apiKey = "sk-or-test";
const choose = (probability: number): JevAnswer => ({
  type: "choice",
  probabilities: { delegate: probability, sequential: 1 - probability },
});

function mockAsk(answer: JevAnswer, capture?: (question: JevQuestion) => void) {
  return async (_key: string, question: JevQuestion): Promise<JevAnswer> => {
    capture?.(question);
    return answer;
  };
}

describe("resolveSubagentGuidance", () => {
  it("exposes worker dispatch only for explicit, suggested, or auto-assessed tasks", () => {
    assert.equal(allowsSubagentDispatch("none"), false);
    assert.equal(allowsSubagentDispatch("explicit-sequential"), false);
    assert.equal(allowsSubagentDispatch("explicit-delegate"), true);
    assert.equal(allowsSubagentDispatch("suggest"), true);
    assert.equal(allowsSubagentDispatch("auto-delegate"), true);
  });

  it("keeps routine questions and one-file fixes local without calling Jev", async () => {
    let calls = 0;
    const ask = async () => {
      calls++;
      return choose(0.99);
    };
    for (const prompt of ["What does this function do?", "Fix the typo in src/one-file.ts"]) {
      const result = await resolveSubagentGuidance({ prompt, tier: "light", policy: "auto", apiKey, ask });
      assert.equal(result.kind, "none", prompt);
    }
    assert.equal(calls, 0);
  });

  it("does not delegate a broad but sequential migration", async () => {
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Migrate the entire repository sequentially, one module at a time, keeping each step in dependency order.",
      tier: "heavy",
      policy: "auto",
      apiKey,
      ask: async () => { calls++; return choose(0.99); },
    });
    assert.equal(result.kind, "none");
    assert.equal(calls, 0);
  });

  it("honors explicit numeric spin-up requests even on light turns and with auto policy", async () => {
    for (const prompt of [
      "Spin 3 subagents that say hello world.",
      "Spin up 3 subagents that say hello world.",
      "Run 3 workers that say hello world.",
    ]) {
      const result = await resolveSubagentGuidance({ prompt, tier: "light", policy: "auto" });
      assert.equal(result.kind, "explicit-delegate", prompt);
      assert.equal(allowsSubagentDispatch(result.kind), true);
    }
  });

  it("honors an explicit request for workers even when automatic policy is off", async () => {
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Use subagents to research the independent migration risks.",
      tier: "heavy",
      policy: "off",
      ask: async () => { calls++; return choose(0); },
    });
    assert.equal(result.kind, "explicit-delegate");
    assert.match(result.directive ?? "", /permission prompt/);
    assert.equal(calls, 0);
  });

  it("lets an explicit no-delegation instruction override a positive mention", async () => {
    for (const prompt of [
      "Use subagents if helpful, but do not use any agents; work sequentially.",
      "Do not delegate this task; handle the steps in order.",
      "Never use workers for this change.",
      "Do not delegate this; finish it without agents.",
      "Don't spin up 3 subagents; do the work here.",
    ]) {
      const result = await resolveSubagentGuidance({
        prompt,
        tier: "heavy",
        policy: "auto",
        apiKey,
        ask: async () => choose(0.99),
      });
      assert.equal(result.kind, "explicit-sequential", prompt);
      assert.match(result.directive ?? "", /Do not call the subagent tool/);
    }
  });

  it("uses a Jev advisory only for ambiguous substantial candidates", async () => {
    let question: JevQuestion | undefined;
    const result = await resolveSubagentGuidance({
      prompt: "Audit the codebase for vulnerabilities and report independent areas worth deeper review.",
      tier: "heavy",
      policy: "suggest",
      apiKey,
      ask: mockAsk(choose(0.7), (value) => { question = value; }),
    });
    assert.equal(result.kind, "suggest");
    assert.equal(result.probability, 0.7);
    assert.deepEqual(question?.kind === "choose" ? question.options : [], [...SUBAGENT_JEV_OPTIONS]);
    assert.match(result.directive ?? "", /permission prompt is the user's confirmation/);
  });

  it("lets the coordinator assess substantial task structure without magic words or Jev", async () => {
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Review the startup flow, configuration, and test coverage, then propose a coherent improvement plan.",
      tier: "heavy",
      policy: "auto",
      customEndpoint: true,
      ask: async () => { calls++; return choose(0); },
    });
    assert.equal(result.kind, "auto-delegate");
    assert.equal(result.reason, "substantial task; coordinator assesses independence");
    assert.match(result.directive ?? "", /decide whether parts of the investigation are independent/);
    assert.match(result.directive ?? "", /subagent tool in the same response/);
    assert.match(result.directive ?? "", /Skip delegation for small, tightly coupled/);
    assert.equal(calls, 0);
  });

  it("short-circuits clear independent research without spending a Jev call", async () => {
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Research these independent questions in parallel: compare package A and package B.",
      tier: "medium",
      policy: "suggest",
      apiKey,
      ask: async () => { calls++; return choose(0); },
    });
    assert.equal(result.kind, "suggest");
    assert.equal(calls, 0);

    const shortExplicit = await resolveSubagentGuidance({
      prompt: "Check these independent areas in parallel.",
      tier: "light",
      policy: "suggest",
      apiKey,
      ask: async () => { calls++; return choose(0); },
    });
    assert.equal(shortExplicit.kind, "suggest");
    assert.equal(calls, 0);
  });

  it("redacts and bounds the only task text sent to Jev", async () => {
    let question: JevQuestion | undefined;
    const prompt = `Audit the repository for API-key leaks. Secret: sk-or-v1-12345678 ${"x".repeat(2_000)}`;
    await resolveSubagentGuidance({
      prompt,
      tier: "heavy",
      policy: "suggest",
      apiKey,
      ask: mockAsk(choose(0.4), (value) => { question = value; }),
    });
    const sent = question?.prompt ?? "";
    assert.ok(sent.length < 1_600);
    assert.doesNotMatch(sent, /sk-or-v1-12345678/);
    assert.match(sent, /\[REDACTED\]/);
  });

  it("falls back to local work when Jev fails or is unavailable", async () => {
    const unavailable = await resolveSubagentGuidance({
      prompt: "Audit this repository for security issues.",
      tier: "heavy",
      policy: "suggest",
      apiKey,
      ask: async () => { throw new Error("offline"); },
    });
    assert.equal(unavailable.kind, "none");
    assert.match(unavailable.reason, /Jev unavailable/);

    const noKey = await resolveSubagentGuidance({
      prompt: "Audit this repository for security issues.",
      tier: "heavy",
      policy: "suggest",
    });
    assert.equal(noKey.kind, "none");
  });

  it("skips Jev when the turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Audit this repository for security issues.",
      tier: "heavy",
      policy: "suggest",
      apiKey,
      signal: controller.signal,
      ask: async () => { calls++; return choose(0.99); },
    });
    assert.equal(result.kind, "none");
    assert.equal(calls, 0);
  });

  it("does not use Jev for custom endpoints", async () => {
    let calls = 0;
    const result = await resolveSubagentGuidance({
      prompt: "Audit this repository for security issues.",
      tier: "heavy",
      policy: "suggest",
      apiKey,
      customEndpoint: true,
      ask: async () => { calls++; return choose(0.99); },
    });
    assert.equal(result.kind, "none");
    assert.equal(calls, 0);
  });

  it("sharpens the auto directive with a Jev yes/no check, never blocking on it", async () => {
    const base = { prompt: "Review the startup flow, configuration, and test coverage, then propose a plan.", tier: "heavy" as const, policy: "auto" as const, apiKey };
    const yes = (noul: number) => async () => ({ type: "noul" as const, noul });
    const strong = await resolveSubagentGuidance({ ...base, ask: yes(0.93) });
    assert.equal(strong.kind, "auto-delegate");
    assert.match((await strong.refinedDirective) ?? "", /launch one subagent per part/);
    const unsure = await resolveSubagentGuidance({ ...base, ask: yes(0.63) });
    assert.equal(await unsure.refinedDirective, unsure.directive, "below 0.8 keeps the softer directive");
    const failing = await resolveSubagentGuidance({ ...base, ask: async () => { throw new Error("down"); } });
    assert.equal(await failing.refinedDirective, failing.directive);
    const noKey = await resolveSubagentGuidance({ ...base, apiKey: undefined });
    assert.equal(noKey.refinedDirective, undefined);
  });
});
