/**
 * Turn a `results.jsonl` into a small, committable summary.
 *
 * Raw result lines carry absolute `trace_dir` / `session_id` paths, so they
 * must not be committed. This summary keeps only the numbers a harness change
 * is judged on (success, cost, turns, overflows) plus per-task outcomes.
 */
import type { EvalResultLine } from "./run.js";

export const EVAL_SUMMARY_SCHEMA_VERSION = 1;

export interface EvalTaskSummary {
  task_id: string;
  /** Majority outcome across samples. */
  passed: boolean;
  pass_count: number;
  samples: number;
  mean_cost_usd: number;
  median_turns: number;
  overflows: number;
}

export interface EvalSummary {
  schema_version: number;
  generated_at: string;
  config: string;
  model: string;
  tasks: number;
  samples: number;
  passed: number;
  success_rate: number;
  mean_cost_usd: number;
  median_cost_usd: number;
  median_turns: number;
  overflows: number;
  total_cost_usd: number;
  per_task: EvalTaskSummary[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Money is rounded so repeated runs produce stable, reviewable diffs. */
function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface SummarizeOpts {
  /** Override the config name recorded in the results. */
  config?: string;
  /** Override the model recorded in the results. */
  model?: string;
  /** Fixed timestamp for reproducible output. */
  generatedAt?: string;
}

export function summarizeResults(lines: EvalResultLine[], opts: SummarizeOpts = {}): EvalSummary {
  if (lines.length === 0) throw new Error("no result lines to summarize");

  const byTask = new Map<string, EvalResultLine[]>();
  for (const line of lines) {
    const bucket = byTask.get(line.task_id);
    if (bucket) bucket.push(line);
    else byTask.set(line.task_id, [line]);
  }

  const perTask: EvalTaskSummary[] = [...byTask.entries()]
    .map(([taskId, taskLines]) => {
      const passCount = taskLines.filter((line) => line.passed).length;
      return {
        task_id: taskId,
        passed: passCount > taskLines.length / 2,
        pass_count: passCount,
        samples: taskLines.length,
        mean_cost_usd: money(mean(taskLines.map((line) => line.cost_usd))),
        median_turns: median(taskLines.map((line) => line.turns)),
        overflows: taskLines.filter((line) => line.overflow).length,
      };
    })
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  const passed = perTask.filter((task) => task.passed).length;
  const first = lines[0]!;

  return {
    schema_version: EVAL_SUMMARY_SCHEMA_VERSION,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    config: opts.config ?? first.config,
    model: opts.model ?? first.model,
    tasks: perTask.length,
    samples: Math.max(...perTask.map((task) => task.samples)),
    passed,
    success_rate: money(passed / perTask.length),
    mean_cost_usd: money(mean(perTask.map((task) => task.mean_cost_usd))),
    median_cost_usd: money(median(perTask.map((task) => task.mean_cost_usd))),
    median_turns: median(perTask.map((task) => task.median_turns)),
    overflows: perTask.reduce((sum, task) => sum + task.overflows, 0),
    total_cost_usd: money(lines.reduce((sum, line) => sum + line.cost_usd, 0)),
    per_task: perTask,
  };
}
