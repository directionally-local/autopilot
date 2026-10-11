import { describe, it } from "node:test";
import assert from "node:assert";
import { compareResults, formatComparison, mcnemarExact, perTask } from "./compare.js";
import type { EvalResultLine } from "./run.js";

function line(task_id: string, passed: boolean, extra: Partial<EvalResultLine> = {}): EvalResultLine {
  return {
    task_id,
    sample: 0,
    config: "arm",
    model: "m",
    passed,
    exit_code: passed ? 0 : 1,
    cost_usd: 0.01,
    prompt_tokens: 100,
    completion_tokens: 10,
    turns: 3,
    tool_calls: 2,
    overflow: false,
    duration_ms: 1000,
    trace_dir: "/t",
    session_id: `s-${task_id}`,
    ...extra,
  };
}

describe("mcnemarExact", () => {
  it("matches hand-computed values", () => {
    // n = 5 discordant pairs, min(b, c) = 1: p = 2 * (C(5,0) + C(5,1)) / 32 = 12/32.
    assert.ok(Math.abs(mcnemarExact(1, 4) - 0.375) < 1e-12);
    assert.ok(Math.abs(mcnemarExact(4, 1) - 0.375) < 1e-12);
    // b = c: p = 1 (2 * 0.5 * total, capped).
    assert.strictEqual(mcnemarExact(3, 3), 1);
    // One-sided extreme: 2 * (1/2^8).
    assert.ok(Math.abs(mcnemarExact(0, 8) - 2 / 256) < 1e-12);
    assert.strictEqual(mcnemarExact(0, 0), 1);
  });
});

describe("perTask", () => {
  it("passes a task only on a strict majority of samples", () => {
    const results = [
      line("t", true, { sample: 0 }),
      line("t", false, { sample: 1 }),
      line("t", true, { sample: 2 }),
      line("u", true, { sample: 0 }),
      line("u", false, { sample: 1 }),
    ];
    const tasks = perTask(results);
    assert.strictEqual(tasks.get("t")!.passed, true);
    assert.strictEqual(tasks.get("t")!.pass_count, 2);
    assert.strictEqual(tasks.get("u")!.passed, false, "1 of 2 is not a majority");
  });
});

describe("compareResults", () => {
  it("pairs tasks, counts flips, and reports the McNemar p-value", () => {
    const a = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"].map((id, i) => line(id, i < 6, { config: "A" }));
    // B passes t1..t3 and t7..t10 (gains four, loses three of A's: t4, t5, t6).
    const b = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "only-in-b"].map((id, i) =>
      line(id, i < 3 || (i >= 6 && i < 10), { config: "B", cost_usd: 0.02 }),
    );
    const c = compareResults(a, b);
    assert.strictEqual(c.paired, 10);
    assert.strictEqual(c.both_pass, 3);
    assert.strictEqual(c.both_fail, 0);
    assert.strictEqual(c.a_only, 3);
    assert.strictEqual(c.b_only, 4);
    assert.ok(Math.abs(c.mcnemar_p - mcnemarExact(3, 4)) < 1e-12);
    assert.deepStrictEqual(
      c.flips.map((f) => `${f.task_id}:${f.a ? "p" : "f"}${f.b ? "p" : "f"}`),
      ["t10:fp", "t4:pf", "t5:pf", "t6:pf", "t7:fp", "t8:fp", "t9:fp"],
    );
    assert.strictEqual(c.a.success_rate, 0.6);
    assert.strictEqual(c.b.tasks, 11);
    assert.ok(Math.abs(c.b.mean_cost_usd - 0.02) < 1e-12);
    const text = formatComparison(c);
    assert.match(text, /A: A \(m\): 6\/10 tasks passed \(60\.0%\)/);
    assert.match(text, /McNemar exact p = /);
    assert.match(text, /t4\s+pass\s+FAIL/);
  });

  it("reports no difference when an arm is compared with itself", () => {
    const a = ["t1", "t2", "t3"].map((id, i) => line(id, i !== 1));
    const c = compareResults(a, a);
    assert.strictEqual(c.a_only + c.b_only, 0);
    assert.strictEqual(c.mcnemar_p, 1);
    assert.match(formatComparison(c), /no discordant pairs/);
  });
});
