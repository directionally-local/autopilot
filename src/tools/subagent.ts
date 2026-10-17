import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { loadConfig, resolveWorkerBudgetUsd } from "../config.js";
import { runHotcellWorker } from "./hotcell-worker.js";
import { workerRegistry } from "./worker-registry.js";
import { failureReason, recordSubagentEvent } from "./subagent-stats.js";
import type { WorkerResultMessage } from "../agent/messages.js";

export interface SubagentArgs {
  mission: string;
  context?: string;
  maxCostUsd?: number;
}

/** Arguments accepted from sessions recorded before the rename. */
interface LegacySpawnWorkerArgs {
  mode?: string;
  task?: string;
  context?: string;
  budget?: { maxCostUsd?: number };
}

const DEFAULT_WORKER_TIMEOUT_MS = 600_000;

/** Map legacy `spawn_worker` arguments onto the `subagent` shape. */
export function fromLegacySpawnWorkerArgs(args: LegacySpawnWorkerArgs): SubagentArgs {
  return {
    mission: String(args.task ?? ""),
    ...(args.context ? { context: args.context } : {}),
    ...(args.budget?.maxCostUsd !== undefined ? { maxCostUsd: args.budget.maxCostUsd } : {}),
  };
}

/** Delegate a self-contained investigation to a subagent: a separate
 *  Autopilot instance running in its own local Hotcell sandbox. */
export const subagentTool: ToolSpec<SubagentArgs> = {
  name: "subagent",
  description: [
    "Delegate a self-contained investigation to a subagent: a separate Autopilot instance that explores this repository in its own sandbox and reports back cited findings (files, line numbers, open questions).",
    "Use it to work in parallel. When a task touches several independent areas — e.g. how auth works, where billing is computed, which tests cover a module, how two subsystems interact — launch one subagent per area IN THE SAME RESPONSE; they run at the same time, behind a single approval, while their results come back to you together.",
    "Also use it for broad searches you would otherwise do with many read/grep calls, and to get an independent second look at a plan or a bug.",
    "Subagents see your current working tree (including uncommitted changes) and can read and search code, but cannot edit files or run commands; do the edits yourself after reading their findings.",
    "Give each subagent a specific mission: what to find, where to start if you know, and what to report. Do not use it for a lookup you can do in one or two tool calls, or for steps that depend on each other.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      mission: {
        type: "string",
        description: "What the subagent should investigate and report back. Be specific and self-contained: it cannot see this conversation.",
      },
      context: {
        type: "string",
        description: "Relevant facts from this conversation the subagent needs (goals, constraints, file paths already known).",
      },
      maxCostUsd: { type: "number", description: "Spend cap for this subagent in USD. Defaults to the configured subagent budget." },
    },
    required: ["mission"],
    additionalProperties: false,
  },
  needsPermission: true,
  // Subagents run in isolated Hotcell cells and never touch the workspace, so
  // several can run at once; the Hotcell slot semaphore bounds concurrency.
  concurrent: true,
  // Minutes-long and parallel: always a direct tool, never inside Code Mode's
  // synchronous, 30-second sandbox.
  codeModeDirect: true,
  render: (args) => {
    const batch = (args as SubagentArgs & { batch?: SubagentArgs[] }).batch;
    if (Array.isArray(batch) && batch.length > 1) {
      return {
        title: `${batch.length} subagents (run in parallel, read-only)`,
        body: batch.map((item, i) => `${i + 1}. ${String(item.mission ?? "").slice(0, 160)}`).join("\n"),
      };
    }
    return {
      title: "subagent (read-only)",
      body: String(args.mission ?? "").slice(0, 200),
    };
  },
  async run(rawArgs, ctx): Promise<ToolOutput> {
    // Sessions recorded before the rename may replay `spawn_worker` arguments.
    const args: SubagentArgs = typeof rawArgs.mission === "string"
      ? rawArgs
      : fromLegacySpawnWorkerArgs(rawArgs as unknown as LegacySpawnWorkerArgs);
    if (!args.mission.trim()) throw new Error("subagent needs a mission describing what to investigate.");
    const cfg = await loadConfig().catch(() => null);
    if (!cfg?.openrouterApiKey) {
      throw new Error("Subagents need an OpenRouter-backed session (they run through Hotcell's OpenRouter gateway). Configure OpenRouter, then retry.");
    }
    if (cfg.baseUrl) {
      throw new Error("Subagents do not support custom model endpoints yet.");
    }

    // Subagents always use the session's own model (no silent fallback).
    const model = ctx.model;
    if (!model) {
      throw new Error("Subagent requires the session's active model ID; refusing to choose a different model.");
    }
    const timeoutMs = cfg.workerTimeoutMs
      ?? readNumberEnv("KIMIFLARE_WORKER_TIMEOUT_MS")
      ?? DEFAULT_WORKER_TIMEOUT_MS;
    const budgetCeiling = resolveWorkerBudgetUsd(cfg);
    const budgetUsd = Math.min(args.maxCostUsd ?? budgetCeiling, budgetCeiling);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      throw new Error("Subagent spend cap must be a positive number.");
    }

    // Each subagent gets its own cancel handle (see /subagents cancel), linked
    // to the turn: cancelling one never interrupts the turn or other subagents.
    const handle = workerRegistry.start(args.mission, model, ctx.signal);
    const startedAt = Date.now();
    const record = (status: string, extra: { costUsd?: number; error?: string; localChanges?: number } = {}) => {
      void recordSubagentEvent({
        kind: "subagent",
        ts: Date.now(),
        sessionId: ctx.sessionId ?? "unknown",
        status,
        durationMs: Date.now() - startedAt,
        costUsd: extra.costUsd ?? 0,
        ...(failureReason(extra.error) ? { reason: failureReason(extra.error) } : {}),
        ...(extra.localChanges ? { localChanges: extra.localChanges } : {}),
      });
      ctx.trace?.emit(
        "subagent",
        {
          worker_id: handle.id,
          mode: "hotcell",
          status,
          ...(extra.costUsd !== undefined ? { cost_usd: extra.costUsd } : {}),
          duration_ms: Date.now() - startedAt,
        },
        ctx.turnId ?? null,
      );
    };
    let result;
    try {
      result = await runHotcellWorker({
        task: args.mission,
        context: args.context,
        model,
        budgetUsd,
        timeoutMs,
        setupTimeoutMs: readNumberEnv("KIMIFLARE_WORKER_SETUP_TIMEOUT_MS"),
        maxParallel: cfg.workerMaxParallel,
        cwd: ctx.cwd,
        signal: handle.signal,
      });
    } catch (error) {
      if (handle.cancelledByUser) {
        record("cancelled", { error: "cancelled by user" });
        return textOutput(userCancelledMessage(handle.index, args.mission));
      }
      record("failed", { error: error instanceof Error ? error.message : String(error) });
      throw new Error("Subagent could not start: " + (error instanceof Error ? error.message : String(error)), { cause: error });
    } finally {
      handle.finish();
    }
    record(handle.cancelledByUser ? "cancelled" : result.status, {
      costUsd: result.costUsd,
      error: handle.cancelledByUser ? "cancelled by user" : result.error,
      localChanges: Number(/applied your (\d+)/.exec(result.snapshotNote ?? "")?.[1] ?? 0),
    });
    if (handle.cancelledByUser && !ctx.signal?.aborted) {
      return textOutput(userCancelledMessage(handle.index, args.mission));
    }
    if (result.status !== "completed" && result.status !== "budget_exhausted" &&
      !(result.status === "spend_exhausted" && result.partialResult && result.findings.length > 0)) {
      throw new Error("Subagent " + result.status + ": " + (result.error ?? "unknown error"));
    }

    return textOutput(formatWorkerResult(result, model));
  },
};

/** Render a worker result for the coordinator: status, cost, cited findings,
 *  open questions, and a clear marker when the report was unstructured. */
export function formatWorkerResult(result: WorkerResultMessage, model: string): string {
  const lines = [
    "Subagent " + result.status + ((result.status === "budget_exhausted" || result.status === "spend_exhausted") ? " (partial result)" : "") + ".",
    "Model: " + (result.model ?? model) + " · Tokens: " + result.tokensUsed.toLocaleString() + " · Cost: " + (result.costUsd > 0 ? result.costUsd.toFixed(4) + " total cost" : "unavailable") + ".",
    ...result.findings.map((finding) =>
      "\n## " + finding.topic + (result.structured ? " (" + finding.confidence + " confidence)" : "") + "\n" + finding.summary +
      (finding.sources.length ? "\nFiles: " + finding.sources.join(", ") : "")),
  ];
  if (result.snapshotNote) {
    lines.push("\n" + result.snapshotNote);
  }
  if (result.openQuestions?.length) {
    lines.push("\n## Open questions\n" + result.openQuestions.map((q) => "- " + q).join("\n"));
  }
  if (result.filesRead.length) {
    lines.push("\nFiles read: " + result.filesRead.join(", "));
  }
  if (!result.structured && result.findings.length) {
    lines.push("\n(The subagent did not return a structured report; findings above are its raw answer and are unverified.)");
  }
  if (result.status === "budget_exhausted" || result.status === "spend_exhausted") {
    lines.push("\nThe subagent ran out of budget; review partial findings before relying on them.");
  }
  return lines.join("\n");
}

/** A user-cancelled worker is a decision, not a failure: tell the coordinator
 *  plainly so it continues without relaunching the same mission. */
function userCancelledMessage(index: number, mission: string): string {
  return [
    `Subagent #${index} was cancelled by the user before it finished; no findings were returned.`,
    `Mission: ${mission.slice(0, 200)}`,
    "Do not relaunch this mission unless the user asks. Continue with the other results, or do the work yourself if it is still needed.",
  ].join("\n");
}

function textOutput(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
