import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeResults } from "./summarize.js";
import type { EvalResultLine } from "./run.js";

function line(overrides: Partial<EvalResultLine> & Pick<EvalResultLine, "task_id" | "sample" | "passed">): EvalResultLine {
  return {
    config: "baseline",
    model: "openai/gpt-6-luna",
    exit_code: 0,
    cost_usd: 0.1,
    prompt_tokens: 1000,
    completion_tokens: 100,
    turns: 10,
    tool_calls: 5,
    overflow: false,
    duration_ms: 1000,
    trace_dir: "/Users/someone/.local/share/kimiflare/traces/abc",
    session_id: "abc",
    ...overrides,
  };
}

describe("summarizeResults", () => {
  it("collapses samples to a majority outcome and aggregates cost, turns and overflows", () => {
    const summary = summarizeResults(
      [
        line({ task_id: "b-task", sample: 0, passed: true, cost_usd: 0.2, turns: 12 }),
        line({ task_id: "b-task", sample: 1, passed: false, cost_usd: 0.4, turns: 20, overflow: true }),
        line({ task_id: "a-task", sample: 0, passed: true, cost_usd: 0.1, turns: 8 }),
        line({ task_id: "a-task", sample: 1, passed: true, cost_usd: 0.3, turns: 10 }),
      ],
      { generatedAt: "2026-10-29T00:00:00.000Z" },
    );

    assert.equal(summary.schema_version, 1);
    assert.equal(summary.generated_at, "2026-10-29T00:00:00.000Z");
    assert.equal(summary.config, "baseline");
    assert.equal(summary.model, "openai/gpt-6-luna");
    assert.equal(summary.tasks, 2);
    assert.equal(summary.samples, 2);
    assert.equal(summary.passed, 1);
    assert.equal(summary.success_rate, 0.5);
    assert.equal(summary.overflows, 1);
    assert.equal(summary.total_cost_usd, 1);
    assert.deepEqual(
      summary.per_task.map((task) => task.task_id),
      ["a-task", "b-task"],
      "sorted for stable diffs",
    );
    assert.equal(summary.per_task[1]!.pass_count, 1);
    assert.equal(summary.per_task[1]!.passed, false, "1 of 2 is not a majority");
    assert.equal(summary.per_task[1]!.mean_cost_usd, 0.3);
    assert.equal(summary.per_task[1]!.median_turns, 16);
  });

  it("does not leak local trace paths or session ids", () => {
    const summary = summarizeResults([line({ task_id: "a", sample: 0, passed: true })]);
    const text = JSON.stringify(summary);
    assert.ok(!text.includes("trace_dir"));
    assert.ok(!text.includes("session_id"));
    assert.ok(!text.includes("/Users/"));
  });

  it("throws on an empty result set", () => {
    assert.throws(() => summarizeResults([]), /no result lines/);
  });
});
