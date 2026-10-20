/**
 * OTLP/HTTP log exporter (M5.2). Ships each log entry as one OTel
 * `LogRecord` to an external collector. Gated entirely on the
 * `KIMIFLARE_OTEL_ENDPOINT` env var — unset = no-op.
 *
 * Design notes:
 *   - Hand-rolled rather than pulled in via `@opentelemetry/exporter-…`
 *     to keep deps slim. The OTLP/HTTP JSON wire format is small enough
 *     to encode directly; see the schema reference at
 *     https://github.com/open-telemetry/opentelemetry-proto.
 *   - Batched: flush on a 5s timer OR when the queue hits 100 entries,
 *     whichever fires first. Drops are silent — observability data must
 *     never block or crash the agent loop.
 *   - Drop counter is exposed (`getOtelDropCount`) so tests + a future
 *     `kimiflare logs status` subcommand can surface it.
 *   - Auth: `KIMIFLARE_OTEL_HEADERS=Authorization=Bearer xyz,X-Foo=bar`
 *     (comma-separated key=value). Common pattern across OTel docs.
 *
 * Endpoint URL convention:
 *   The env var may be either the full path
 *     (https://otel.example.com/v1/logs)
 *   or the base URL
 *     (https://otel.example.com)
 *   We auto-append `/v1/logs` to the latter, matching the standard
 *   OTLP/HTTP signal path so configuration is friendly.
 */

import type { LogEntry } from "./logger.js";
import { BEACON_HARNESS_ATTR, HARNESS_NAME } from "./harness.js";

const BATCH_MAX = 100;
const FLUSH_INTERVAL_MS = 5_000;

// Severity numbers from the OTLP spec
// (https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/logs/data-model.md#field-severitynumber).
const SEVERITY_NUMBER: Record<LogEntry["level"], number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
  off: 0, // never actually emitted, but maps cleanly
};

const SEVERITY_TEXT: Record<LogEntry["level"], string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  off: "OFF",
};

interface OtelConfig {
  endpoint: string; // full URL
  headers: Record<string, string>;
  serviceName: string;
  serviceVersion: string;
}

let config: OtelConfig | null = null;
let queue: LogEntry[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let dropCount = 0;
let inFlightFlush: Promise<void> | null = null;

// Test seam — replaced in unit tests with a mock that captures requests.
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (url, init) => fetch(url, init);

/** Inject a fetch implementation. Test-only. */
export function setFetchForTesting(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue; // skip malformed entries
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

function normalizeEndpoint(raw: string): string {
  const stripped = raw.replace(/\/+$/, "");
  // If the user already included a /v1/<signal> path, leave it alone.
  if (/\/v1\/(logs|traces|metrics)$/.test(stripped)) return stripped;
  return `${stripped}/v1/logs`;
}

/** Read env vars and initialize the exporter. Idempotent — safe to call
 *  multiple times. Returns true if the exporter is now active. */
export function initOtelSink(opts: {
  endpoint?: string;
  headers?: string;
  serviceName?: string;
  serviceVersion?: string;
} = {}): boolean {
  const endpoint = opts.endpoint ?? process.env.KIMIFLARE_OTEL_ENDPOINT;
  if (!endpoint) {
    config = null;
    return false;
  }
  config = {
    endpoint: normalizeEndpoint(endpoint),
    headers: parseHeaders(opts.headers ?? process.env.KIMIFLARE_OTEL_HEADERS),
    serviceName: opts.serviceName ?? HARNESS_NAME,
    serviceVersion: opts.serviceVersion ?? process.env.npm_package_version ?? "0.0.0",
  };
  return true;
}

/** True when the exporter has a configured endpoint. */
export function isOtelEnabled(): boolean {
  return config !== null;
}

/** Test-only helper to clear all in-memory state (queue, timer, drop
 *  count, config). Use in `beforeEach` to isolate exporter tests. */
export function resetOtelSinkForTesting(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  queue = [];
  config = null;
  dropCount = 0;
  inFlightFlush = null;
}

/** Number of log entries that failed to ship. Useful for surfacing
 *  collector-side outages without crashing the agent. */
export function getOtelDropCount(): number {
  return dropCount;
}

/** Number of entries currently waiting in the batch. Test-only. */
export function getOtelQueueSize(): number {
  return queue.length;
}

/**
 * Enqueue a log entry for shipping. Silent no-op if the exporter is not
 * configured. Triggers a flush either when the batch fills or when the
 * timer fires.
 */
export function enqueueOtelLog(entry: LogEntry): void {
  if (!config) return;
  queue.push(entry);
  if (queue.length >= BATCH_MAX) {
    void flushOtelSink();
    return;
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flushOtelSink();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely for the flush timer; the
  // process exit hook below handles draining anything left.
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}

/** Drain the queue and POST as a single OTLP/HTTP payload. Returns
 *  once the in-flight request settles. Silent on failure (increments
 *  the drop counter). */
export async function flushOtelSink(): Promise<void> {
  if (!config) {
    queue = [];
    return;
  }
  if (queue.length === 0) return;
  if (inFlightFlush) return inFlightFlush;

  const batch = queue;
  queue = [];
  const payload = buildOtlpPayload(batch, config);

  inFlightFlush = (async () => {
    try {
      const res = await fetchImpl(config!.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...config!.headers,
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        dropCount += batch.length;
      }
    } catch {
      dropCount += batch.length;
    } finally {
      inFlightFlush = null;
    }
  })();
  return inFlightFlush;
}

/** Drain everything queued, including entries enqueued while a flush was
 *  in flight (process shutdown). Bounded by the caller's own timeout. */
export async function shutdownOtelSink(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  // A flush in flight leaves later entries queued; loop until both are empty.
  for (let i = 0; i < 5 && (queue.length > 0 || inFlightFlush); i++) {
    if (inFlightFlush) await inFlightFlush;
    else await flushOtelSink();
  }
}

// ── OTLP/HTTP JSON payload encoding ──────────────────────────────────────

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}

function attr(key: string, value: unknown): OtlpAttribute | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return { key, value: { stringValue: value } };
  if (typeof value === "boolean") return { key, value: { boolValue: value } };
  if (typeof value === "number" && Number.isFinite(value)) {
    // Costs and durations need their fractions; counts stay integers.
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  // Fallback: JSON-stringify so structured data still gets shipped.
  return { key, value: { stringValue: JSON.stringify(value) } };
}

function flattenDataAttrs(data: Record<string, unknown> | undefined): OtlpAttribute[] {
  if (!data) return [];
  const out: OtlpAttribute[] = [];
  for (const [key, value] of Object.entries(data)) {
    // Skip the request_id field — it's lifted to top-level and emitted
    // as `request_id` on the LogRecord attributes directly.
    if (key === "request_id" || key === "requestId") continue;
    const a = attr(key, value);
    if (a) out.push(a);
  }
  return out;
}

export function buildOtlpPayload(
  entries: LogEntry[],
  cfg: OtelConfig,
): unknown {
  const resourceAttrs: OtlpAttribute[] = [
    attr("service.name", cfg.serviceName)!,
    attr("service.version", cfg.serviceVersion)!,
    attr(BEACON_HARNESS_ATTR, HARNESS_NAME)!,
    ...(process.env.HOSTNAME ? [attr("host.name", process.env.HOSTNAME)!] : []),
  ];

  const logRecords = entries.map((e) => {
    const attrs: OtlpAttribute[] = [];
    if (e.session_id) attrs.push(attr("session_id", e.session_id)!);
    if (e.turn_id) attrs.push(attr("turn_id", e.turn_id)!);
    if (e.request_id) attrs.push(attr("request_id", e.request_id)!);
    attrs.push(attr("event", e.event)!);
    attrs.push(...flattenDataAttrs(e.data));

    const timeNs = String(BigInt(new Date(e.ts).getTime()) * 1_000_000n);
    return {
      timeUnixNano: timeNs,
      observedTimeUnixNano: timeNs,
      severityNumber: SEVERITY_NUMBER[e.level],
      severityText: SEVERITY_TEXT[e.level],
      body: { stringValue: e.event },
      attributes: attrs,
    };
  });

  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: HARNESS_NAME, version: cfg.serviceVersion },
            logRecords,
          },
        ],
      },
    ],
  };
}

// ── Process-exit drain ───────────────────────────────────────────────────

let exitHookInstalled = false;

/** Register a best-effort exit drain. Without this, a fast process exit
 *  (e.g. `kimiflare -p "..."` print mode) could drop the last batch
 *  before the 5s flush timer fires. */
export function installOtelExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const drain = () => {
    if (queue.length === 0 && !inFlightFlush) return;
    // Node "beforeExit" is async-friendly — we get to await the flush.
    void flushOtelSink();
  };
  process.on("beforeExit", drain);
}
