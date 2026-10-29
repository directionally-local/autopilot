/**
 * `autopilot insights` — per-model metrics from local session traces.
 *
 * This is the measurement half of #999: profiles are only changed when these
 * numbers (and an eval comparison) say the change helps.
 */
import type { Command } from "commander";
import { computeInsights, formatInsights } from "./metrics.js";
import { scanTraces } from "./scan.js";

interface InsightsOpts {
  traces?: string;
  model?: string;
  since?: string;
  limit?: string;
  json?: boolean;
}

export function registerInsightsCommand(program: Command): void {
  program
    .command("insights")
    .description("Per-model metrics from local session traces (requests, parallel calls, bash-as-read, failures, cache)")
    .option("--traces <dir>", "trace root or a single session directory (default: the configured trace root)")
    .option("--model <id>", "only this model")
    .option("--since <date>", "only sessions modified since this ISO date")
    .option("--limit <n>", "scan at most N of the most recent sessions")
    .option("--json", "machine-readable output")
    .action(async (opts: InsightsOpts) => {
      try {
        const since = opts.since ? new Date(opts.since) : undefined;
        if (since && Number.isNaN(since.getTime())) throw new Error(`invalid --since date: ${opts.since}`);
        const limit = opts.limit === undefined ? undefined : Number.parseInt(opts.limit, 10);
        if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
          throw new Error(`invalid --limit: ${opts.limit}`);
        }

        const sessions = await scanTraces({ root: opts.traces, since, limit });
        let rows = computeInsights(sessions.map((session) => session.events));
        if (opts.model) rows = rows.filter((row) => row.model === opts.model);

        if (opts.json) {
          console.log(JSON.stringify({ sessions: sessions.length, models: rows }, null, 2));
        } else {
          console.log(formatInsights(rows));
        }
      } catch (err) {
        console.error(`autopilot insights: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
