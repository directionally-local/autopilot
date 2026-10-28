import { appendFile, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../util/logger.js";

/**
 * Local, append-only record of subagent usage, so "how often do subagents
 * actually get used?" has an answer. Stores no prompts or code: only
 * session ids, the policy decision, outcomes, durations, and costs.
 */

export type SubagentEvent =
  /** One user turn: was the subagent tool offered, and what did policy say? */
  | { kind: "turn"; ts: number; sessionId: string; offered: boolean; guidance: string }
  /** One subagent finished (in any state). */
  | {
      kind: "subagent";
      ts: number;
      sessionId: string;
      status: string;
      durationMs: number;
      costUsd: number;
      /** Short failure category, never raw output. */
      reason?: string;
      localChanges?: number;
    };

export function subagentStatsPath(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "kimiflare", "subagents.jsonl");
}

/** Best effort: stats must never break a turn. */
export async function recordSubagentEvent(event: SubagentEvent): Promise<void> {
  // Resolve once, at call time: the write completes asynchronously.
  const path = subagentStatsPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n");
  } catch (error) {
    logger.debug("subagents:stats_write_failed", { error: String(error) });
  }
}

/** Map an error message to a short, content-free category. */
export function failureReason(error: string | undefined): string | undefined {
  if (!error) return undefined;
  const e = error.toLowerCase();
  if (/cancel/.test(e)) return "cancelled";
  if (/timed out|timeout/.test(e)) return "timeout";
  if (/egress spend cap exceeded|budget/.test(e)) return "budget";
  if (/origin|push|clone|credential-free/.test(e)) return "repository";
  if (/openrouter|gateway|provider|custom model endpoint/.test(e)) return "provider";
  if (/hotcell|daemon|sandbox|setup|install|econnrefused|enoent/.test(e)) return "hotcell";
  return "other";
}

export interface SubagentStats {
  days: number;
  sessions: number;
  sessionsOffered: number;
  sessionsUsed: number;
  turns: number;
  turnsOffered: number;
  subagents: number;
  completed: number;
  failuresByReason: Record<string, number>;
  medianSeconds: number | null;
  costUsd: number;
}

export async function readSubagentStats(days = 7, now = Date.now()): Promise<SubagentStats> {
  let raw = "";
  try {
    raw = await readFile(subagentStatsPath(), "utf8");
  } catch {
    // No events yet.
  }
  const since = now - days * 24 * 60 * 60 * 1000;
  const sessions = new Set<string>();
  const offered = new Set<string>();
  const used = new Set<string>();
  let turns = 0;
  let turnsOffered = 0;
  const durations: number[] = [];
  let subagents = 0;
  let completed = 0;
  let costUsd = 0;
  const failuresByReason: Record<string, number> = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev: SubagentEvent;
    try {
      ev = JSON.parse(line) as SubagentEvent;
    } catch {
      continue;
    }
    if (typeof ev.ts !== "number" || ev.ts < since) continue;
    sessions.add(ev.sessionId);
    if (ev.kind === "turn") {
      turns++;
      if (ev.offered) {
        turnsOffered++;
        offered.add(ev.sessionId);
      }
    } else if (ev.kind === "subagent") {
      subagents++;
      used.add(ev.sessionId);
      costUsd += ev.costUsd || 0;
      durations.push(ev.durationMs);
      if (ev.status === "completed" || ev.status === "budget_exhausted") completed++;
      else {
        const reason = ev.reason ?? ev.status;
        failuresByReason[reason] = (failuresByReason[reason] ?? 0) + 1;
      }
    }
  }
  durations.sort((a, b) => a - b);
  const median = durations.length ? durations[Math.floor((durations.length - 1) / 2)]! : null;
  return {
    days,
    sessions: sessions.size,
    sessionsOffered: offered.size,
    sessionsUsed: used.size,
    turns,
    turnsOffered,
    subagents,
    completed,
    failuresByReason,
    medianSeconds: median === null ? null : Math.round(median / 1000),
    costUsd,
  };
}

export function formatSubagentStats(s: SubagentStats): string {
  if (s.sessions === 0) return `subagent stats (last ${s.days} days): no sessions recorded yet`;
  const pct = (n: number, d: number) => (d === 0 ? "0%" : `${Math.round((n / d) * 100)}%`);
  const failures = Object.entries(s.failuresByReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ");
  return [
    `subagent stats (last ${s.days} days, this machine):`,
    `  sessions: ${s.sessions} · offered subagents in ${s.sessionsOffered} · used them in ${s.sessionsUsed} (${pct(s.sessionsUsed, s.sessions)})`,
    `  turns: ${s.turns} · subagent tool offered in ${s.turnsOffered} (${pct(s.turnsOffered, s.turns)})`,
    `  subagents: ${s.subagents} · completed ${s.completed} (${pct(s.completed, s.subagents)})${failures ? ` · failed: ${failures}` : ""}`,
    `  median duration: ${s.medianSeconds === null ? "—" : `${s.medianSeconds}s`} · total cost: $${s.costUsd.toFixed(2)}`,
  ].join("\n");
}
