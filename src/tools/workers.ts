/**
 * Tools for background subagents (`subagent` with `background: true`):
 * list them and fetch a finished one's findings. Finished results are also
 * delivered to the session automatically at the next tool boundary or turn,
 * so these are for checking early or waiting on one explicitly.
 */

import type { ToolOutput, ToolSpec } from "./registry.js";
import { workerRegistry, type FinishedWorker } from "./worker-registry.js";

function text(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

function elapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

/** The coordinator-facing report for a finished worker (and mark it delivered). */
export function finishedReport(w: FinishedWorker): string {
  workerRegistry.markDelivered(w.id);
  return [`Background subagent #${w.index} (${w.id}) ${w.status} after ${elapsed(w.finishedAt - w.startedAt)}.`, w.output].join("\n");
}

export const workerStatusTool: ToolSpec<Record<string, never>> = {
  name: "worker_status",
  description: "List this session's background subagents: running ones with elapsed time, and finished ones with their status and whether their findings were already delivered.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  needsPermission: false,
  isReadOnly: true,
  render: () => ({ title: "worker_status" }),
  async run(_args, ctx) {
    const running = workerRegistry.list().filter((w) => w.background && (!ctx.sessionId || w.sessionId === ctx.sessionId));
    const finished = workerRegistry.listFinished(ctx.sessionId);
    if (running.length === 0 && finished.length === 0) return text("No background subagents in this session.");
    const now = Date.now();
    const lines = [
      ...running.map((w) => `#${w.index} ${w.id} ${w.status} ${elapsed(now - w.startedAt)} — ${w.task.slice(0, 120)}`),
      ...finished.map(
        (w) =>
          `#${w.index} ${w.id} ${w.status}${w.costUsd ? ` $${w.costUsd.toFixed(4)}` : ""} ${w.delivered ? "(findings delivered)" : "(findings not yet seen — worker_result)"} — ${w.task.slice(0, 120)}`,
      ),
    ];
    return text(lines.join("\n"));
  },
};

interface ResultArgs {
  worker_id: string;
  wait?: boolean;
}

export const workerResultTool: ToolSpec<ResultArgs> = {
  name: "worker_result",
  description:
    "Get a background subagent's findings by worker id or number. If it is still running, say so — or, with wait=true, wait for it to finish (the turn's interrupt still applies).",
  parameters: {
    type: "object",
    properties: {
      worker_id: { type: "string", description: "Worker id (worker-3) or number (#3)." },
      wait: { type: "boolean", description: "Wait until it finishes instead of returning its current status." },
    },
    required: ["worker_id"],
    additionalProperties: false,
  },
  needsPermission: false,
  isReadOnly: true,
  render: (args) => ({ title: `worker_result ${args.worker_id ?? ""}` }),
  async run(args, ctx) {
    const found = workerRegistry.find(args.worker_id);
    if (!found) return text(`No background subagent ${args.worker_id}. worker_status lists them.`);
    if (found.finished) return text(finishedReport(found.finished));
    if (!args.wait) {
      return text(`Subagent #${found.running!.index} is still ${found.running!.status} (${elapsed(Date.now() - found.running!.startedAt)}). Keep working; its findings will arrive automatically, or call worker_result with wait=true.`);
    }
    return text(finishedReport(await workerRegistry.waitFor(args.worker_id, ctx.signal)));
  },
};
