import type { RunningWorker } from "../tools/worker-registry.js";
import type { JobRecord } from "../jobs/manager.js";

/** Activity payload understood by camouflage-tui's inline protocol. */
export interface ActivityItem {
  id: string;
  kind: "job" | "agent";
  title: string;
  status: "running" | "waiting" | "needs_attention" | "done" | "failed" | "stopped";
  stoppable: boolean;
  summary?: string;
  progress?: number;
  started_at_ms?: number;
  updated_at_ms?: number;
  steps?: { title: string; status: "pending" | "running" | "done" | "failed" }[];
}

export function activityFromJob(job: JobRecord): ActivityItem {
  const active = job.status === "starting" || job.status === "running" || job.status === "cancelling";
  const status: ActivityItem["status"] = active
    ? "running"
    : job.status === "completed"
      ? "done"
      : job.status === "cancelled"
        ? "stopped"
        : "failed";
  const summary = job.status === "cancelling"
    ? "Stopping…"
    : job.status === "timed_out"
      ? "Timed out"
      : job.status === "unknown"
        ? "Process state could not be verified"
        : job.exitCode !== null && job.exitCode !== 0
          ? `Exited with code ${job.exitCode}`
          : undefined;
  return {
    id: job.id,
    kind: "job",
    title: job.command,
    status,
    stoppable: job.status === "starting" || job.status === "running",
    ...(summary ? { summary } : {}),
    started_at_ms: job.createdAt,
    ...(job.finishedAt !== null ? { updated_at_ms: job.finishedAt } : {}),
  };
}

/** A running subagent as an activity row; each one can be stopped on its own. */
export function activityFromSubagent(worker: RunningWorker): ActivityItem {
  return {
    id: `agent:${worker.id}`,
    kind: "agent",
    title: `subagent #${worker.index}: ${activityTaskPreview(worker.task)}`,
    status: "running",
    stoppable: worker.status === "running",
    ...(worker.status === "cancelling" ? { summary: "Stopping…" } : {}),
    started_at_ms: worker.startedAt,
  };
}

export function activityTaskPreview(task: string): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 71)}…` : oneLine;
}

export type ActivityEvent =
  | { type: "ActivitySnapshot"; payload: { items: ActivityItem[] } }
  | { type: "ActivityUpdate"; payload: ActivityItem }
  | { type: "ActivityRemoved"; payload: { id: string } };

/** Build the renderer events needed to synchronize the full host-owned list. */
export function diffActivityItems(
  previous: ReadonlyMap<string, string>,
  current: readonly ActivityItem[],
  snapshotSent: boolean,
): ActivityEvent[] {
  if (!snapshotSent) return [{ type: "ActivitySnapshot", payload: { items: [...current] } }];

  const next = new Map(current.map((item) => [item.id, item]));
  const events: ActivityEvent[] = [];
  for (const [id, item] of next) {
    if (previous.get(id) !== JSON.stringify(item)) events.push({ type: "ActivityUpdate", payload: item });
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) events.push({ type: "ActivityRemoved", payload: { id } });
  }
  return events;
}

export function isActiveJob(job: JobRecord): boolean {
  return job.status === "starting" || job.status === "running" || job.status === "cancelling";
}
