/**
 * TUI integration: build a category report string for display in chat.
 */

import { readFile } from "node:fs/promises";
import type { UsageLog, SessionUsage } from "../usage-tracker.js";
import { buildReport } from "./report.js";
import { renderTerminal } from "./renderer.js";
import { classifyFromSessionFile } from "./classify-from-session.js";
import { dataPath } from "../util/app-dirs.js";

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

export async function getCategoryReportText(sessionId?: string): Promise<string | null> {
  const log = await loadLog();

  // Default: last 7 days (big picture, same as `kimiflare cost --week`)
  const startDate = daysAgo(7);
  const endDate = today();
  const prevStart = daysAgo(14);
  const prevEnd = daysAgo(8);

  const sessions = filterSessions(log.sessions, startDate, endDate);
  const prevSessions = filterSessions(log.sessions, prevStart, prevEnd);

  // Eagerly classify the current session so it appears correctly in the breakdown
  if (sessionId) {
    const session = log.sessions.find((s) => s.id === sessionId);
    if (session && !session.category) {
      const result = await classifyFromSessionFile(sessionId);
      session.category = result.category;
      session.confidence = result.confidence;
      session.classifiedBy = result.classifiedBy;
      session.summary = result.summary;
      session.classifiedAt = new Date().toISOString();
    }
  }

  for (const s of sessions) {
    if (!s.category) {
      const result = await classifyFromSessionFile(s.id);
      s.category = result.category;
      s.confidence = result.confidence;
      s.classifiedBy = result.classifiedBy;
      s.summary = result.summary;
      s.classifiedAt = new Date().toISOString();
    }
  }

  const report = buildReport({
    startDate,
    endDate,
    sessions,
    previousSessions: prevSessions,
    currentSessionId: sessionId,
  });

  return renderTerminal(report);
}
