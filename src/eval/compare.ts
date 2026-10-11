/**
 * Paired comparison of two eval arms (plan §4.4): success rate per arm, an
 * exact McNemar test on task-level success (majority over samples), cost and
 * turn statistics, overflow counts, and the per-task flips.
 */

import { readFile } from "node:fs/promises";
import type { EvalResultLine } from "./run.js";

export interface TaskOutcome {
  task_id: string;
  passed: boolean;
  samples: number;
  pass_count: number;
  mean_cost_usd: number;
  median_turns: number;
  overflows: number;
}

export interface ArmSummary {
  name: string;
  model: string;
  tasks: number;
  passed: number;
  success_rate: number;
  mean_cost_usd: number;
  median_cost_usd: number;
  median_turns: number;
  overflows: number;
}

export interface Comparison {
  a: ArmSummary;
  b: ArmSummary;
  /** Tasks present in both arms. */
  paired: number;
  /** a passed, b failed. */
  a_only: number;
  /** b passed, a failed. */
  b_only: number;
  both_pass: number;
  both_fail: number;
  mcnemar_p: number;
  flips: Array<{ task_id: string; a: boolean; b: boolean }>;
}

export async function loadResults(file: string): Promise<EvalResultLine[]> {
  const raw = await readFile(file, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EvalResultLine);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

/** Collapse samples to one outcome per task: pass when a strict majority of samples passed. */
export function perTask(results: EvalResultLine[]): Map<string, TaskOutcome> {
  const byTask = new Map<string, EvalResultLine[]>();
  for (const r of results) {
    const list = byTask.get(r.task_id) ?? [];
    list.push(r);
    byTask.set(r.task_id, list);
  }
  const out = new Map<string, TaskOutcome>();
  for (const [task_id, runs] of byTask) {
    const pass_count = runs.filter((r) => r.passed).length;
    out.set(task_id, {
      task_id,
      passed: pass_count * 2 > runs.length,
      samples: runs.length,
      pass_count,
      mean_cost_usd: mean(runs.map((r) => r.cost_usd)),
      median_turns: median(runs.map((r) => r.turns)),
      overflows: runs.filter((r) => r.overflow).length,
    });
  }
  return out;
}

export function summarizeArm(results: EvalResultLine[]): ArmSummary {
  const tasks = perTask(results);
  const outcomes = [...tasks.values()];
  const passed = outcomes.filter((t) => t.passed).length;
  return {
    name: results[0]?.config ?? "?",
    model: results[0]?.model ?? "?",
    tasks: outcomes.length,
    passed,
    success_rate: outcomes.length ? passed / outcomes.length : 0,
    mean_cost_usd: mean(results.map((r) => r.cost_usd)),
    median_cost_usd: median(results.map((r) => r.cost_usd)),
    median_turns: median(results.map((r) => r.turns)),
    overflows: results.filter((r) => r.overflow).length,
  };
}

function binomialCoefficient(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/**
 * Exact two-sided McNemar test on the discordant pairs: `b` tasks where only
 * A passed and `c` where only B passed. Under H0 each discordant pair is a
 * fair coin, so p = 2 · P(X ≤ min(b, c)) for X ~ Binomial(b + c, ½), capped at 1.
 * With no discordant pairs there is nothing to test and p = 1.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += binomialCoefficient(n, i);
  const p = (2 * tail) / 2 ** n;
  return Math.min(1, p);
}

export function compareResults(resultsA: EvalResultLine[], resultsB: EvalResultLine[]): Comparison {
  const a = perTask(resultsA);
  const b = perTask(resultsB);
  const flips: Comparison["flips"] = [];
  let a_only = 0;
  let b_only = 0;
  let both_pass = 0;
  let both_fail = 0;
  let paired = 0;
  for (const [task_id, ta] of a) {
    const tb = b.get(task_id);
    if (!tb) continue;
    paired++;
    if (ta.passed && tb.passed) both_pass++;
    else if (!ta.passed && !tb.passed) both_fail++;
    else {
      if (ta.passed) a_only++;
      else b_only++;
      flips.push({ task_id, a: ta.passed, b: tb.passed });
    }
  }
  flips.sort((x, y) => x.task_id.localeCompare(y.task_id));
  return {
    a: summarizeArm(resultsA),
    b: summarizeArm(resultsB),
    paired,
    a_only,
    b_only,
    both_pass,
    both_fail,
    mcnemar_p: mcnemarExact(a_only, b_only),
    flips,
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const usd = (x: number) => `$${x.toFixed(4)}`;

export function formatComparison(c: Comparison): string {
  const lines: string[] = [];
  const arm = (s: ArmSummary) =>
    `${s.name} (${s.model}): ${s.passed}/${s.tasks} tasks passed (${pct(s.success_rate)}), mean cost ${usd(s.mean_cost_usd)}, median cost ${usd(s.median_cost_usd)}, median turns ${s.median_turns}, overflows ${s.overflows}`;
  lines.push(`A: ${arm(c.a)}`);
  lines.push(`B: ${arm(c.b)}`);
  lines.push("");
  lines.push(`Paired tasks: ${c.paired}  both pass: ${c.both_pass}  both fail: ${c.both_fail}  A only: ${c.a_only}  B only: ${c.b_only}`);
  lines.push(`McNemar exact p = ${c.mcnemar_p.toFixed(4)}${c.a_only + c.b_only === 0 ? " (no discordant pairs: no difference)" : ""}`);
  if (c.flips.length) {
    lines.push("");
    lines.push("Flips:");
    lines.push("  task                                  A      B");
    for (const f of c.flips) lines.push(`  ${f.task_id.padEnd(36)}  ${f.a ? "pass" : "FAIL"}   ${f.b ? "pass" : "FAIL"}`);
  }
  return lines.join("\n");
}
