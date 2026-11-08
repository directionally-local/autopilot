import type { DlConversation } from "./dl-store.js";

export const DEFAULT_CELL_RETENTION_DAYS = 7;
export const CLOSED_PULL_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface RetentionCell {
  id: string;
  conversationId: string;
  status: string;
  lastActivityAt: string;
}

export interface RetentionPullRequest {
  state: "open" | "closed";
  merged: boolean;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface RetentionCandidate {
  conversation: DlConversation;
  cell: RetentionCell;
  pendingApprovals: number;
  pullRequest?: RetentionPullRequest;
}

export type RetentionReason = "pull_request_closed" | "inactive" | "disk_pressure";

/**
 * Return why an idle, paused cell is eligible for deletion. The conversation's event log
 * and session record are deliberately not part of this decision: cleanup removes only the
 * Hotcell volume, never its history.
 */
export function cellRetentionReason(
  candidate: RetentionCandidate,
  options: { now: number; retentionDays: number; diskPressure: boolean },
): RetentionReason | undefined {
  const { conversation, cell } = candidate;
  if (conversation.activeRunId || candidate.pendingApprovals > 0) return undefined;
  if (["running", "waiting_approval", "provisioning", "destroying"].includes(conversation.status)) return undefined;
  // Never delete a live cell. Hotcell's idle pause leaves its durable workspace volume intact.
  if (cell.status !== "paused" && cell.status !== "stopped") return undefined;

  const closedAt = candidate.pullRequest?.mergedAt ?? candidate.pullRequest?.closedAt;
  if (closedAt && Date.parse(closedAt) <= options.now - CLOSED_PULL_REQUEST_RETENTION_MS) {
    return "pull_request_closed";
  }

  const lastActivity = Date.parse(cell.lastActivityAt);
  const inactiveBefore = options.now - options.retentionDays * 24 * 60 * 60 * 1000;
  if (Number.isFinite(lastActivity) && lastActivity <= inactiveBefore) return "inactive";
  if (options.diskPressure && Number.isFinite(lastActivity)) return "disk_pressure";
  return undefined;
}

export function orderRetentionCandidates<T extends { cell: RetentionCell }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => Date.parse(a.cell.lastActivityAt) - Date.parse(b.cell.lastActivityAt));
}
