/**
 * Per-model metrics from session traces (#999 / #910).
 *
 * The profile layer (#1008) can only be tuned against measurements. This
 * module turns `trace.jsonl` events into the numbers the issue asks for:
 * requests per user message, parallel-call share, bash share and bash-as-read
 * share, tool failure rate by error, guardrail hits, cache hit rate and
 * redundant reads.
 */
import type { TraceEvent } from "../trace/types.js";
import { isFileReadCommand } from "../tools/bash.js";

export interface ModelInsights {
  model: string;
  /** Active model profile id (#999), absent for the default behavior. */
  model_profile?: string;
  sessions: number;
  user_messages: number;
  requests: number;
  requests_per_user_message: number;
  /** Responses that contained at least one tool call. */
  responses_with_tools: number;
  /** Responses that contained more than one tool call. */
  responses_with_parallel_tools: number;
  parallel_call_share: number;
  tool_calls: number;
  bash_calls: number;
  bash_share: number;
  bash_read_calls: number;
  bash_as_read_share: number;
  tool_results: number;
  tool_failures: number;
  tool_failure_rate: number;
  failures_by_code: Record<string, number>;
  guardrail_hits: Record<string, number>;
  prompt_tokens: number;
  cached_tokens: number;
  cache_hit_rate: number;
  /** Reads of a path already read earlier in the same session. */
  redundant_reads: number;
  cost_usd: number;
}

interface Accumulator {
  model: string;
  model_profile?: string;
  sessions: number;
  user_messages: number;
  requests: number;
  responses_with_tools: number;
  responses_with_parallel_tools: number;
  tool_calls: number;
  bash_calls: number;
  bash_read_calls: number;
  tool_results: number;
  tool_failures: number;
  failures_by_code: Map<string, number>;
  guardrail_hits: Map<string, number>;
  prompt_tokens: number;
  cached_tokens: number;
  redundant_reads: number;
  cost_usd: number;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function argsOf(event: TraceEvent<"tool_call">): Record<string, unknown> {
  return event.payload.args_inline ?? {};
}

/** Aggregate one session's events into `acc`. Sessions without a start event are skipped. */
function accumulateSession(acc: Accumulator, events: TraceEvent[]): void {
  const start = events.find((event) => event.type === "session_start");
  if (!start || start.type !== "session_start") return;

  acc.sessions++;
  if (start.payload.model_profile) acc.model_profile = start.payload.model_profile;

  const readPaths = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        acc.user_messages++;
        break;
      case "llm_request":
        acc.requests++;
        break;
      case "llm_response": {
        const calls = event.payload.tool_calls.length;
        if (calls > 0) acc.responses_with_tools++;
        if (calls > 1) acc.responses_with_parallel_tools++;
        const usage = event.payload.usage;
        if (usage) {
          acc.prompt_tokens += usage.prompt_tokens;
          acc.cached_tokens += usage.cached_tokens ?? 0;
          acc.cost_usd += usage.cost ?? 0;
        }
        break;
      }
      case "tool_call": {
        acc.tool_calls++;
        const name = event.payload.name;
        if (name === "bash") {
          acc.bash_calls++;
          const command = argsOf(event).command;
          if (typeof command === "string" && isFileReadCommand(command)) acc.bash_read_calls++;
        } else if (name === "read") {
          const path = argsOf(event).path;
          if (typeof path === "string") {
            if (readPaths.has(path)) acc.redundant_reads++;
            else readPaths.add(path);
          }
        }
        break;
      }
      case "tool_result":
        acc.tool_results++;
        if (!event.payload.ok) {
          acc.tool_failures++;
          bump(acc.failures_by_code, event.payload.error_code ?? "unknown");
        }
        break;
      case "guardrail":
        bump(acc.guardrail_hits, event.payload.kind);
        break;
      default:
        break;
    }
  }
}

function finalize(acc: Accumulator): ModelInsights {
  return {
    model: acc.model,
    ...(acc.model_profile ? { model_profile: acc.model_profile } : {}),
    sessions: acc.sessions,
    user_messages: acc.user_messages,
    requests: acc.requests,
    requests_per_user_message: ratio(acc.requests, acc.user_messages),
    responses_with_tools: acc.responses_with_tools,
    responses_with_parallel_tools: acc.responses_with_parallel_tools,
    parallel_call_share: ratio(acc.responses_with_parallel_tools, acc.responses_with_tools),
    tool_calls: acc.tool_calls,
    bash_calls: acc.bash_calls,
    bash_share: ratio(acc.bash_calls, acc.tool_calls),
    bash_read_calls: acc.bash_read_calls,
    bash_as_read_share: ratio(acc.bash_read_calls, acc.bash_calls),
    tool_results: acc.tool_results,
    tool_failures: acc.tool_failures,
    tool_failure_rate: ratio(acc.tool_failures, acc.tool_results),
    failures_by_code: toRecord(acc.failures_by_code),
    guardrail_hits: toRecord(acc.guardrail_hits),
    prompt_tokens: acc.prompt_tokens,
    cached_tokens: acc.cached_tokens,
    cache_hit_rate: ratio(acc.cached_tokens, acc.prompt_tokens),
    redundant_reads: acc.redundant_reads,
    cost_usd: Math.round(acc.cost_usd * 1_000_000) / 1_000_000,
  };
}

/**
 * Aggregate sessions (each an ordered list of trace events) into one row per
 * model. Sessions without a `session_start` event are ignored.
 */
export function computeInsights(sessions: TraceEvent[][]): ModelInsights[] {
  const byModel = new Map<string, Accumulator>();

  for (const events of sessions) {
    const start = events.find((event) => event.type === "session_start");
    if (!start || start.type !== "session_start") continue;
    const model = start.payload.model;
    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        model,
        sessions: 0,
        user_messages: 0,
        requests: 0,
        responses_with_tools: 0,
        responses_with_parallel_tools: 0,
        tool_calls: 0,
        bash_calls: 0,
        bash_read_calls: 0,
        tool_results: 0,
        tool_failures: 0,
        failures_by_code: new Map(),
        guardrail_hits: new Map(),
        prompt_tokens: 0,
        cached_tokens: 0,
        redundant_reads: 0,
        cost_usd: 0,
      };
      byModel.set(model, acc);
    }
    accumulateSession(acc, events);
  }

  return [...byModel.values()]
    .map(finalize)
    .sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model));
}

/** One-line summary for the text view. */
export function formatInsights(rows: ModelInsights[]): string {
  if (rows.length === 0) return "no traced sessions found";
  const lines: string[] = [];
  for (const row of rows) {
    const profile = row.model_profile ? ` · profile ${row.model_profile}` : "";
    lines.push(`${row.model}${profile}`);
    lines.push(
      `  sessions ${row.sessions} · user msgs ${row.user_messages} · requests/msg ${row.requests_per_user_message}`,
    );
    lines.push(
      `  parallel-call share ${pct(row.parallel_call_share)} · bash share ${pct(row.bash_share)} · bash-as-read ${pct(row.bash_as_read_share)}`,
    );
    lines.push(
      `  tool failures ${pct(row.tool_failure_rate)} (${row.tool_failures}/${row.tool_results}) · guardrails ${sum(row.guardrail_hits)} · cache hit ${pct(row.cache_hit_rate)}`,
    );
    lines.push(`  redundant reads ${row.redundant_reads} · cost $${row.cost_usd.toFixed(4)}`);
    const codes = Object.entries(row.failures_by_code);
    if (codes.length > 0) lines.push(`  failures by code: ${codes.map(([code, n]) => `${code}=${n}`).join(", ")}`);
    const guardrails = Object.entries(row.guardrail_hits);
    if (guardrails.length > 0) lines.push(`  guardrails: ${guardrails.map(([kind, n]) => `${kind}=${n}`).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}
