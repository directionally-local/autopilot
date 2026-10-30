/**
 * Structured logger for KimiFlare turn lifecycle events.
 *
 * Three sinks, all independent:
 *   1. **stderr** (gated by `KIMIFLARE_LOG_LEVEL`, default `off`) — for
 *      interactive debugging. Tail with `2>&1 | jq` from a dev shell.
 *   2. **file** (`~/.config/autopilot/logs/<date>.jsonl`, default ON;
 *      disable with `KIMIFLARE_LOG_SINK=off`) — for post-hoc analysis,
 *      shipped in M5.1. Always-on so the data exists even when the TUI
 *      is silent.
 *   3. **OTLP/HTTP** (gated by `KIMIFLARE_OTEL_ENDPOINT`, default
 *      unset) — ship to any OpenTelemetry collector / SaaS backend
 *      (Datadog, Honeycomb, Grafana, …), shipped in M5.2. Batched,
 *      best-effort; never blocks the agent loop.
 *
 * Tail in a second terminal:
 *   KIMIFLARE_LOG_LEVEL=info npm run dev          # stderr live tail
 *   tail -f $(kimiflare logs path) | jq           # file tail
 */

import { writeLogLine, getLogSessionId, getLogTurnId } from "./log-sink.js";
import { enqueueOtelLog } from "./otel-sink.js";
import { onLegacyEnvVar, readEnv } from "./env.js";

export type LogLevel = "debug" | "info" | "warn" | "error" | "off";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  session_id?: string;
  turn_id?: string;
  request_id?: string;
  data?: Record<string, unknown>;
}

let globalMinLevel: LogLevel = (readEnv("LOG_LEVEL") as LogLevel) ?? "off";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  off: 4,
};

/** In-memory circular buffer of recent log entries for error reporting.
 *  Captures all entries regardless of KIMIFLARE_LOG_LEVEL so that
 *  diagnostic context is available even when stderr logging is off. */
const RECENT_LOGS_MAX = 100;
const recentLogs: LogEntry[] = [];

export function getRecentLogs(limit = 50): LogEntry[] {
  return recentLogs.slice(-limit);
}

export function clearRecentLogs(): void {
  recentLogs.length = 0;
}

export function setLogLevel(level: LogLevel): void {
  globalMinLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalMinLevel;
}

export function log(
  level: LogLevel,
  event: string,
  data?: Record<string, unknown>,
): void {
  const sessionId = getLogSessionId();
  const turnId = getLogTurnId();
  // Accept either snake_case `request_id` (preferred, matches Gateway
  // log schema) or legacy camelCase `requestId` for backward compat
  // with existing call sites in src/agent/client.ts.
  const requestId =
    typeof data?.request_id === "string"
      ? (data.request_id as string)
      : typeof data?.requestId === "string"
        ? (data.requestId as string)
        : undefined;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(requestId ? { request_id: requestId } : {}),
    data,
  };

  // Always buffer for diagnostic reporting
  recentLogs.push(entry);
  if (recentLogs.length > RECENT_LOGS_MAX) {
    recentLogs.shift();
  }

  // Stderr sink (gated by KIMIFLARE_LOG_LEVEL).
  if (LEVEL_ORDER[level] >= LEVEL_ORDER[globalMinLevel]) {
    console.error(JSON.stringify(entry));
  }

  // File sink (always-on unless disabled via KIMIFLARE_LOG_SINK=off).
  writeLogLine(entry);

  // OTLP/HTTP sink (no-op unless KIMIFLARE_OTEL_ENDPOINT is set and
  // initOtelSink() has been called).
  enqueueOtelLog(entry);
}

/** Convenience wrappers */
export const logger = {
  debug: (event: string, data?: Record<string, unknown>) => log("debug", event, data),
  info: (event: string, data?: Record<string, unknown>) => log("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => log("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => log("error", event, data),
};

// #911: note each legacy KIMIFLARE_* variable once per process (file sink and
// OTLP only unless KIMIFLARE_LOG_LEVEL/AUTOPILOT_LOG_LEVEL is info or lower —
// never the TUI). Registered last so early reads (LOG_LEVEL above) replay here.
onLegacyEnvVar((legacy, current) => {
  logger.info("env.legacy_name", { name: legacy, use: current });
});
