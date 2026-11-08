import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cellRetentionReason, orderRetentionCandidates, type RetentionCandidate } from "./dl-cell-retention.js";
import type { DlConversation } from "./dl-store.js";

const now = Date.parse("2026-11-08T12:00:00.000Z");
function candidate(overrides: Partial<RetentionCandidate> = {}): RetentionCandidate {
  return {
    conversation: {
      id: "conversation", workspaceId: "default", model: "test/model", sessionId: "session",
      worktreePath: "/workspace", cwd: "/workspace", branch: "dl/work", kind: "code", repository: "owner/repo",
      baseBranch: "main", pullRequestNumber: null, pullRequestURL: null, status: "completed", activeRunId: null,
      lastEventSequence: 0, oldestEventSequence: 1, createdAt: now - 10 * 86400_000, updatedAt: now - 8 * 86400_000,
    } as DlConversation,
    cell: { id: "cell", conversationId: "conversation", status: "paused", lastActivityAt: new Date(now - 8 * 86400_000).toISOString() },
    pendingApprovals: 0,
    ...overrides,
  };
}
const decide = (item: RetentionCandidate, diskPressure = false) =>
  cellRetentionReason(item, { now, retentionDays: 7, diskPressure });

describe("cell retention policy", () => {
  it("expires a paused sandbox after the configured idle period", () => {
    assert.equal(decide(candidate()), "inactive");
  });

  it("keeps recent cells unless disk pressure requires oldest-idle cleanup", () => {
    const recent = candidate({ cell: { ...candidate().cell, lastActivityAt: new Date(now - 2 * 86400_000).toISOString() } });
    assert.equal(decide(recent), undefined);
    assert.equal(decide(recent, true), "disk_pressure");
  });

  it("expires a closed or merged pull request one day after its terminal timestamp", () => {
    const item = candidate({
      cell: { ...candidate().cell, lastActivityAt: new Date(now - 60_000).toISOString() },
      pullRequest: { state: "closed", merged: false, closedAt: new Date(now - 25 * 60 * 60_000).toISOString(), mergedAt: null },
    });
    assert.equal(decide(item), "pull_request_closed");
    assert.equal(decide({ ...item, pullRequest: { ...item.pullRequest!, closedAt: new Date(now - 23 * 60 * 60_000).toISOString() } }), undefined);
  });

  it("never deletes live cells, active conversations, or conversations waiting for approval", () => {
    assert.equal(decide({ ...candidate(), cell: { ...candidate().cell, status: "running" } }), undefined);
    assert.equal(decide({ ...candidate(), conversation: { ...candidate().conversation, activeRunId: "run" } }), undefined);
    assert.equal(decide({ ...candidate(), conversation: { ...candidate().conversation, status: "waiting_approval" } }), undefined);
    assert.equal(decide({ ...candidate(), pendingApprovals: 1 }), undefined);
  });

  it("orders disk-pressure cleanup oldest first", () => {
    const values = [
      candidate({ cell: { ...candidate().cell, id: "new", lastActivityAt: new Date(now - 3_000).toISOString() } }),
      candidate({ cell: { ...candidate().cell, id: "old", lastActivityAt: new Date(now - 20_000).toISOString() } }),
    ];
    assert.deepEqual(orderRetentionCandidates(values).map((item) => item.cell.id), ["old", "new"]);
  });
});
