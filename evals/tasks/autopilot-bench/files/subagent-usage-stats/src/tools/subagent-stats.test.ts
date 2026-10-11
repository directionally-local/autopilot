import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureReason, formatSubagentStats, readSubagentStats, recordSubagentEvent, subagentStatsPath } from "./subagent-stats.js";

let home = "";
let saved: string | undefined;
before(async () => {
  saved = process.env.XDG_DATA_HOME;
  home = await mkdtemp(join(tmpdir(), "autopilot-subagent-stats-"));
  process.env.XDG_DATA_HOME = home;
});
after(async () => {
  if (saved === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = saved;
  await rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await rm(subagentStatsPath(), { force: true });
});

describe("subagent stats", () => {
  it("reports nothing before any session", async () => {
    assert.match(formatSubagentStats(await readSubagentStats()), /no sessions recorded yet/);
  });

  it("aggregates sessions, offers, usage, outcomes, duration and cost within the window", async () => {
    const now = Date.now();
    const turn = (sessionId: string, offered: boolean, ts = now) => recordSubagentEvent({ kind: "turn", ts, sessionId, offered, guidance: offered ? "auto-delegate" : "none" });
    const sub = (sessionId: string, status: string, durationMs: number, costUsd: number, reason?: string) =>
      recordSubagentEvent({ kind: "subagent", ts: now, sessionId, status, durationMs, costUsd, ...(reason ? { reason } : {}) });
    await turn("s1", true);
    await turn("s1", false);
    await turn("s2", true);
    await turn("s3", false);
    await turn("old", true, now - 30 * 24 * 60 * 60 * 1000); // outside the window
    await sub("s1", "completed", 40_000, 0.01);
    await sub("s1", "completed", 60_000, 0.02);
    await sub("s2", "failed", 5_000, 0, "repository");
    await writeFile(subagentStatsPath(), "not json\n", { flag: "a" });

    const stats = await readSubagentStats(7, now);
    assert.equal(stats.sessions, 3);
    assert.equal(stats.sessionsOffered, 2);
    assert.equal(stats.sessionsUsed, 2);
    assert.equal(stats.turns, 4);
    assert.equal(stats.turnsOffered, 2);
    assert.equal(stats.subagents, 3);
    assert.equal(stats.completed, 2);
    assert.deepEqual(stats.failuresByReason, { repository: 1 });
    assert.equal(stats.medianSeconds, 40);
    assert.ok(Math.abs(stats.costUsd - 0.03) < 1e-9);
    const text = formatSubagentStats(stats);
    assert.match(text, /sessions: 3 · offered subagents in 2 · used them in 2 \(67%\)/);
    assert.match(text, /completed 2 \(67%\) · failed: repository 1/);
  });

  it("maps errors to content-free reasons", () => {
    assert.equal(failureReason("Subagent could not start: Push a branch (git push -u origin HEAD)"), "repository");
    assert.equal(failureReason("Hotcell setup failed (exit 1)"), "hotcell");
    assert.equal(failureReason("Hotcell per-cell spend cap was reached."), "budget");
    assert.equal(failureReason("Worker timed out."), "timeout");
    assert.equal(failureReason("cancelled by user"), "cancelled");
    assert.equal(failureReason(undefined), undefined);
  });
});
