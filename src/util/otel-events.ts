/**
 * Structured OpenTelemetry events (#871): session, prompt, model request
 * and tool events as OTLP log records with an `event.name`, shipped through
 * the same exporter as logs (KIMIFLARE_OTEL_ENDPOINT) but independent of
 * the log level. Attributes follow the OpenTelemetry GenAI semantic
 * conventions where one exists (`gen_ai.request.model`,
 * `gen_ai.provider.name`, `gen_ai.usage.input_tokens`, …), so collectors
 * such as Agent Beacon can map them without an Autopilot-specific parser.
 *
 * Never put credentials or full prompt/tool content in attributes: sizes,
 * names, ids, outcomes and usage only.
 */

import { enqueueOtelLog, isOtelEnabled } from "./otel-sink.js";
import type { AgentCallbacks } from "../agent/loop.js";

export const OTEL_EVENT_PREFIX = "autopilot.";

/** Emit one event (no-op unless an OTLP endpoint is configured). */
export function emitOtelEvent(name: string, sessionId: string | null | undefined, attributes: Record<string, string | number | boolean | undefined>): void {
  if (!isOtelEnabled()) return;
  const eventName = `${OTEL_EVENT_PREFIX}${name}`;
  const data: Record<string, unknown> = { "event.name": eventName };
  for (const [key, value] of Object.entries(attributes)) if (value !== undefined) data[key] = value;
  enqueueOtelLog({
    ts: new Date().toISOString(),
    level: "info",
    event: eventName,
    ...(sessionId ? { session_id: sessionId } : {}),
    data: { ...data, ...(sessionId ? { "session.id": sessionId } : {}) },
  });
}

/** The turn's callbacks, also reporting model usage and tool results as events. */
export function withOtelEvents(callbacks: AgentCallbacks, ctx: { sessionId?: string; model: string; provider: string }): AgentCallbacks {
  if (!isOtelEnabled()) return callbacks;
  return {
    ...callbacks,
    onUsageFinal: (usage, meta) => {
      emitOtelEvent("api_request", ctx.sessionId, {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": ctx.provider,
        "gen_ai.request.model": ctx.model,
        "gen_ai.usage.input_tokens": usage.prompt_tokens,
        "gen_ai.usage.output_tokens": usage.completion_tokens,
        "gen_ai.usage.cached_input_tokens": usage.prompt_tokens_details?.cached_tokens ?? undefined,
        "cost.usd": usage.cost,
      });
      callbacks.onUsageFinal?.(usage, meta);
    },
    onToolResult: (result) => {
      emitOtelEvent("tool_result", ctx.sessionId, {
        "gen_ai.tool.name": result.name,
        "gen_ai.tool.call.id": result.tool_call_id,
        "tool.success": result.ok,
        "tool.result_size": result.content.length,
      });
      callbacks.onToolResult?.(result);
    },
  };
}
