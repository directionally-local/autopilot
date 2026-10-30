/**
 * CLI handler for `kimiflare cost`.
 */

import { readFile } from "node:fs/promises";
import type { KimiConfig } from "../config.js";
import type { SessionUsage, UsageLog } from "../usage-tracker.js";
import { buildReport } from "./report.js";
import { renderTerminal, renderJson } from "./renderer.js";
import { reconcileWithOpenRouter } from "./reconcile.js";
import { activeOpenRouterKey } from "../agent/llm-auth.js";
import { classifyFromSessionFile } from "./classify-from-session.js";
import type { TaskCategory } from "./types.js";
import { dataPath } from "../util/app-dirs.js";

interface CostCommandOptions {
  week?: boolean;
  month?: boolean;
  day?: boolean;
  session?: string;
  category?: string;
  json?: boolean;
  reclassify?: boolean;
  localOnly?: boolean;
  config: KimiConfig;
}

function usagePath(): string {
  return dataPath("usage.json");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function loadLog(): Promise<UsageLog> {
  try {
    const raw = await readFile(usagePath(), "utf8");
    return JSON.parse(raw) as UsageLog;
  } catch {
    return { version: 1, days: [], sessions: [] };
  }
}

function filterSessions(sessions: SessionUsage[], start: string, end: string): SessionUsage[] {
  return sessions.filter((s) => s.date >= start && s.date <= end);
}

export async function runCostCommand(opts: CostCommandOptions): Promise<void> {
  const log = await loadLog();

  let startDate: string;
  let endDate: string;
  let prevStart: string;
  let prevEnd: string;

  if (opts.month) {
    startDate = daysAgo(30);
    endDate = today();
    prevStart = daysAgo(60);
    prevEnd = daysAgo(31);
  } else if (opts.day) {
    startDate = today();
    endDate = today();
    prevStart = daysAgo(1);
    prevEnd = daysAgo(1);
  } else {
    // default week
    startDate = daysAgo(7);
    endDate = today();
    prevStart = daysAgo(14);
    prevEnd = daysAgo(8);
  }

  // Single session mode
  if (opts.session) {
    const session = log.sessions.find((s) => s.id === opts.session);
    if (!session) {
      console.error(`Session ${opts.session} not found.`);
      process.exit(1);
    }
    console.log(JSON.stringify(session, null, 2));
    return;
  }

  // Lazy classification: assign categories to unclassified sessions
  const sessions = filterSessions(log.sessions, startDate, endDate);
  const prevSessions = filterSessions(log.sessions, prevStart, prevEnd);

  for (const s of sessions) {
    if (!s.category || opts.reclassify) {
      const result = await classifyFromSessionFile(s.id);
      s.category = result.category;
      s.confidence = result.confidence;
      s.classifiedBy = result.classifiedBy;
      s.summary = result.summary;
      s.classifiedAt = new Date().toISOString();
    }
  }

  const categoryFilter = opts.category as TaskCategory | undefined;

  const localCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  const reconciliation = opts.localOnly
    ? { status: "local-only" as const, localCost }
    : await reconcileWithOpenRouter({
        localCost,
        sessions,
        apiKey: activeOpenRouterKey(opts.config),
      });

  const report = buildReport({
    startDate,
    endDate,
    sessions,
    previousSessions: prevSessions,
    reconciliation,
    categoryFilter,
  });

  if (opts.json) {
    console.log(renderJson(report));
  } else {
    console.log(renderTerminal(report));
  }
}
