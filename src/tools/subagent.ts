import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { activeOpenRouterKey, llmAuthFromConfig, providerPresetOf } from "../agent/llm-auth.js";
import { loadConfig } from "../config.js";
import { runHotcellWorker } from "./hotcell-worker.js";
import { workerRegistry, type WorkerHandle } from "./worker-registry.js";
import { failureReason, recordSubagentEvent } from "./subagent-stats.js";
import type { WorkerProfile, WorkerResultMessage } from "../agent/messages.js";
import { readEnv } from "../util/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export interface SubagentArgs {
  mission: string;
  context?: string;
  /** Return at once and keep working; the findings arrive in the session inbox. */
  background?: boolean;
  /** "build" lets the subagent edit files and run commands in its sandbox and
   *  returns a patch; "research" (default) only reads. */
  mode?: WorkerProfile;
  /** Files or directories this mission owns. A returned patch that touches
   *  anything else is flagged and must not be applied. */
  paths?: string[];
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
    "Subagents see your current working tree (including uncommitted changes). By default they can read and search code but cannot edit files or run commands; do the edits yourself after reading their findings.",
    "With mode \"build\" a subagent may also edit files and run commands inside its sandbox, and its changes come back as a patch file you review and apply yourself. Give a build mission a narrow, self-contained scope and list the paths it owns; never run two build subagents over the same files.",
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
      background: {
        type: "boolean",
        description:
          "Run in the background: this call returns a worker id immediately and you keep working (or answer the user). The findings are delivered to you automatically when the subagent finishes; worker_status lists background subagents and worker_result (or wait_for with worker_id) fetches one. Use for long investigations you don't need right away.",
      },
      mode: {
        type: "string",
        enum: ["research", "build"],
        description:
          "research (default): read-only investigation. build: the subagent may edit files and run commands in its sandbox; its changes come back as a patch file for you to review and apply. Build missions should be narrow and self-contained.",
      },
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "With mode \"build\": the files or directories this mission owns. A returned patch that touches anything else is flagged as a scope violation and must not be applied.",
      },
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
    const label = args.mode === "build" ? "write" : "read-only";
    if (Array.isArray(batch) && batch.length > 1) {
      return {
        title: `${batch.length} subagents (run in parallel, ${label})`,
        body: batch.map((item, i) => `${i + 1}. ${String(item.mission ?? "").slice(0, 160)}`).join("\n"),
      };
    }
    return {
      title: `subagent (${label})`,
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
    const provider = providerPresetOf(llmAuthFromConfig(cfg));
    if (!cfg || !provider.capabilities.hotcellGateway || !activeOpenRouterKey(cfg)) {
      throw new Error(
        `Subagents run through Hotcell's OpenRouter gateway, so they need OpenRouter as the active provider (current: ${provider.name}). Switch with /provider openrouter, then retry.`,
      );
    }

    // Subagents always use the session's own model (no silent fallback).
    const model = ctx.model;
    if (!model) {
      throw new Error("Subagent requires the session's active model ID; refusing to choose a different model.");
    }
    const timeoutMs = cfg.workerTimeoutMs
      ?? readNumberEnv("WORKER_TIMEOUT_MS")
      ?? DEFAULT_WORKER_TIMEOUT_MS;

    // Each subagent gets its own cancel handle (see /subagents cancel), linked
    // to the turn: cancelling one never interrupts the turn or other subagents.
    // A background subagent is detached from the turn (it outlives it) and is
    // stopped only by /subagents cancel, or when the session goes away.
    const background = args.background === true;
    const handle = workerRegistry.start(args.mission, model, background ? undefined : ctx.signal, {
      background,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
    if (background) {
      void runWorker(args, ctx, handle, { cfg, model, timeoutMs })
        .then((outcome) => handle.complete(outcome))
        .catch((error: unknown) =>
          handle.complete({ status: "failed", output: `Subagent #${handle.index} failed: ${error instanceof Error ? error.message : String(error)}` }),
        )
        .finally(() => handle.finish());
      return textOutput(
        [
          `Started background subagent #${handle.index} (${handle.id}).`,
          `Mission: ${args.mission.slice(0, 200)}`,
          "Keep working; its findings will be delivered to you when it finishes. worker_status lists background subagents; worker_result or wait_for (worker_id) fetches this one.",
        ].join("\n"),
      );
    }
    try {
      const outcome = await runWorker(args, ctx, handle, { cfg, model, timeoutMs });
      handle.complete(outcome);
      return textOutput(outcome.output);
    } finally {
      handle.finish();
    }
  },
};

/**
 * Run one Hotcell worker to completion. Resolves with the coordinator-facing
 * report (or a cancellation note); throws when the worker can't start or
 * fails without usable findings.
 */
async function runWorker(
  args: SubagentArgs,
  ctx: ToolContext,
  handle: WorkerHandle,
  run: { cfg: NonNullable<Awaited<ReturnType<typeof loadConfig>>>; model: string; timeoutMs: number },
): Promise<{ status: string; output: string; costUsd?: number }> {
    const { cfg, model, timeoutMs } = run;
    const startedAt = Date.now();
    const record = (status: string, extra: { costUsd?: number; error?: string; localChanges?: number } = {}) => {
      void recordSubagentEvent({
        kind: "subagent",
        ts: Date.now(),
        sessionId: ctx.sessionId ?? "unknown",
        status,
        durationMs: Date.now() - startedAt,
        costUsd: extra.costUsd ?? 0,
        workerId: handle.id,
        taskPreview: args.mission.slice(0, 120),
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
        timeoutMs,
        setupTimeoutMs: readNumberEnv("WORKER_SETUP_TIMEOUT_MS"),
        maxParallel: cfg.workerMaxParallel,
        cwd: ctx.cwd,
        signal: handle.signal,
        profile: args.mode === "build" ? "build" : "research",
      });
    } catch (error) {
      if (handle.cancelledByUser) {
        record("cancelled", { error: "cancelled by user" });
        return { status: "cancelled", output: userCancelledMessage(handle.index, args.mission) };
      }
      record("failed", { error: error instanceof Error ? error.message : String(error) });
      throw new Error("Subagent could not start: " + (error instanceof Error ? error.message : String(error)), { cause: error });
    }
    record(handle.cancelledByUser ? "cancelled" : result.status, {
      costUsd: result.costUsd,
      error: handle.cancelledByUser ? "cancelled by user" : result.error,
      localChanges: Number(/applied your (\d+)/.exec(result.snapshotNote ?? "")?.[1] ?? 0),
    });
    // A background worker is detached from the turn, so the turn ending says nothing about it.
    if (handle.cancelledByUser && (args.background === true || !ctx.signal?.aborted)) {
      return { status: "cancelled", output: userCancelledMessage(handle.index, args.mission), costUsd: result.costUsd };
    }
    if (result.status !== "completed" && result.status !== "budget_exhausted" &&
      !(result.status === "spend_exhausted" && result.partialResult && result.findings.length > 0)) {
      throw new Error("Subagent " + result.status + ": " + (result.error ?? "unknown error"));
    }

    return { status: result.status, output: formatWorkerResult(result, model, await materializePatch(args, ctx, handle, result)), costUsd: result.costUsd };
}

/** A build worker's patch, saved next to the project so the coordinator can
 *  review and apply it. Scope is checked against the mission's owned paths. */
export interface MaterializedPatch {
  /** Project-relative path of the saved patch. */
  file: string;
  stat?: string;
  files: string[];
  /** Files the patch touches that the mission does not own. */
  outside: string[];
}

async function materializePatch(
  args: SubagentArgs,
  ctx: ToolContext,
  handle: WorkerHandle,
  result: WorkerResultMessage,
): Promise<MaterializedPatch | undefined> {
  if (!result.patch) return undefined;
  const text = Buffer.from(result.patch, "base64").toString("utf8");
  const files = patchPaths(text);
  const outside = args.paths?.length ? outOfScopePaths(files, args.paths) : [];
  const dir = join(ctx.cwd, ".autopilot", "subagent-patches");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${handle.id}.patch`);
  await writeFile(file, text, "utf8");
  return {
    file: relative(ctx.cwd, file),
    ...(result.patchStat ? { stat: result.patchStat } : {}),
    files,
    outside,
  };
}

/** Repository-relative paths a `git diff` touches. */
export function patchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  for (const line of patchText.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match) paths.add(match[2]!);
  }
  return [...paths];
}

/** Paths in `paths` that fall outside every owned path (a file or a directory prefix). */
export function outOfScopePaths(paths: string[], owned: string[]): string[] {
  const normalized = owned
    .map((path) => path.replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter(Boolean);
  return paths.filter((path) => !normalized.some((owner) => path === owner || path.startsWith(`${owner}/`)));
}

/** Render a worker result for the coordinator: status, cost, cited findings,
 *  open questions, the saved patch for a build worker, and a clear marker when
 *  the report was unstructured. */
export function formatWorkerResult(result: WorkerResultMessage, model: string, patch?: MaterializedPatch): string {
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
  if (patch) {
    lines.push([
      "",
      "## Changes",
      `Patch: ${patch.file} (${patch.files.length} file${patch.files.length === 1 ? "" : "s"})`,
      ...(patch.stat ? [patch.stat] : []),
      `Review: git apply --stat ${patch.file}`,
      `Apply:  git apply --3way ${patch.file}`,
    ].join("\n"));
    if (patch.outside.length) {
      lines.push(
        `\nScope violation: the patch touches files outside the mission's owned paths (${patch.outside.join(", ")}). ` +
          "Do not apply it; re-delegate with a narrower mission, or apply only the in-scope hunks yourself.",
      );
    }
  } else if (result.profile === "build") {
    lines.push("\n## Changes\n" + (result.patchNote ?? "The subagent returned no patch."));
  }
  if (result.openQuestions?.length) {
    lines.push("\n## Open questions\n" + result.openQuestions.map((q) => "- " + q).join("\n"));
  }
  if (result.filesRead?.length) {
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

function readNumberEnv(suffix: string): number | undefined {
  const raw = readEnv(suffix);
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
