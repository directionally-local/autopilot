/**
 * `autopilot eval run` and `autopilot eval compare` (plan §4.3, §4.4).
 */

import type { Command } from "commander";
import { writeFile } from "node:fs/promises";

export function registerEvalCommand(program: Command): void {
  const evalCommand = program.command("eval").description("Run Autopilot headlessly on a task set and compare harness configurations");

  evalCommand
    .command("run")
    .description("Run every task under one harness configuration; writes <out>/results.jsonl and one trace per run")
    .requiredOption("--tasks <dir>", "task set directory (evals/tasks/<set>)")
    .requiredOption("--config <file>", "harness config (evals/configs/<name>.json)")
    .requiredOption("--out <dir>", "output directory")
    .option("--model <id>", "model id (overrides the config file)")
    .option("--samples <n>", "runs per task", "1")
    .option("--concurrency <k>", "parallel runs", "1")
    .option("--filter <globs>", "only task ids matching these comma-separated globs (e.g. \"bash-*,queue-batch-grouping\")")
    .option("--max-cost-usd <usd>", "stop scheduling runs once cumulative cost reaches this")
    .option("--keep", "keep worktrees after each run")
    .action(async (cmdOpts: { tasks: string; config: string; out: string; model?: string; samples: string; concurrency: string; filter?: string; maxCostUsd?: string; keep?: boolean }, command: Command) => {
      const { runEval } = await import("./run.js");
      // The root command also declares `--model`; Commander may attach the
      // flag there, so read it from the merged globals.
      const model = cmdOpts.model ?? (command.optsWithGlobals() as { model?: string }).model;
      const maxCostUsd = cmdOpts.maxCostUsd === undefined ? undefined : Number.parseFloat(cmdOpts.maxCostUsd);
      if (maxCostUsd !== undefined && !Number.isFinite(maxCostUsd)) {
        console.error("autopilot eval run: --max-cost-usd must be a number");
        process.exitCode = 2;
        return;
      }
      try {
        const summary = await runEval({
          tasksDir: cmdOpts.tasks,
          configFile: cmdOpts.config,
          out: cmdOpts.out,
          model,
          samples: Number.parseInt(cmdOpts.samples, 10),
          concurrency: Number.parseInt(cmdOpts.concurrency, 10),
          filter: cmdOpts.filter,
          maxCostUsd,
          keep: cmdOpts.keep,
        });
        const failed = summary.results.filter((r) => !r.passed).length;
        process.exitCode = failed > 0 ? 1 : 0;
      } catch (err) {
        console.error(`autopilot eval run: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  evalCommand
    .command("summarize <results>")
    .description("Summarize a results.jsonl into a committable JSON file (no local paths)")
    .option("--out <file>", "write the summary here instead of stdout")
    .action(async (results: string, cmdOpts: { out?: string }) => {
      const { loadResults } = await import("./compare.js");
      const { summarizeResults } = await import("./summarize.js");
      try {
        const summary = summarizeResults(await loadResults(results));
        const text = `${JSON.stringify(summary, null, 2)}\n`;
        if (cmdOpts.out) {
          await writeFile(cmdOpts.out, text, "utf8");
          console.log(`wrote ${cmdOpts.out}`);
        } else {
          process.stdout.write(text);
        }
      } catch (err) {
        console.error(`autopilot eval summarize: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  evalCommand
    .command("compare <results-a> <results-b>")
    .description("Compare two results.jsonl files: success rates, paired McNemar test, cost, turns, overflows, flips")
    .option("--json", "machine-readable output")
    .action(async (a: string, b: string, cmdOpts: { json?: boolean }) => {
      const { loadResults, compareResults, formatComparison } = await import("./compare.js");
      try {
        const comparison = compareResults(await loadResults(a), await loadResults(b));
        console.log(cmdOpts.json ? JSON.stringify(comparison, null, 2) : formatComparison(comparison));
      } catch (err) {
        console.error(`autopilot eval compare: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
