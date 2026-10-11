/**
 * `autopilot eval run` and `autopilot eval compare` (plan §4.3, §4.4).
 */

import type { Command } from "commander";

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
    .option("--filter <glob>", "only task ids matching this glob")
    .option("--keep", "keep worktrees after each run")
    .action(async (cmdOpts: { tasks: string; config: string; out: string; model?: string; samples: string; concurrency: string; filter?: string; keep?: boolean }, command: Command) => {
      const { runEval } = await import("./run.js");
      // The root command also declares `--model`; Commander may attach the
      // flag there, so read it from the merged globals.
      const model = cmdOpts.model ?? (command.optsWithGlobals() as { model?: string }).model;
      try {
        const summary = await runEval({
          tasksDir: cmdOpts.tasks,
          configFile: cmdOpts.config,
          out: cmdOpts.out,
          model,
          samples: Number.parseInt(cmdOpts.samples, 10),
          concurrency: Number.parseInt(cmdOpts.concurrency, 10),
          filter: cmdOpts.filter,
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
