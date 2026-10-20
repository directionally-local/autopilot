/**
 * Anthropic Messages API adapter (https://docs.anthropic.com/en/api/messages).
 *
 * The agent loop speaks OpenAI Chat Completions shapes internally
 * (ChatMessage, ToolDef, KimiEvent). This module converts a request into a
 * Messages request and the Messages SSE stream back into KimiEvents, so the
 * loop, tools and history stay provider-agnostic:
 *
 * - system messages → top-level `system` blocks
 * - assistant tool_calls → `tool_use` blocks; tool messages → `tool_result`
 *   blocks in a user turn (consecutive ones merged)
 * - extended thinking: `thinking` / `redacted_thinking` blocks come back as
 *   reasoning_details entries (`anthropic.thinking` with its signature,
 *   `anthropic.redacted_thinking` with its data) and are replayed verbatim on
 *   later turns — Anthropic rejects a tool loop whose thinking signatures
 *   are missing or altered
 * - prompt caching: explicit `cache_control` breakpoints on the last tool,
 *   the last system block and the conversation tail (Anthropic only caches
 *   with breakpoints; at most 4 are allowed)
 * - usage: cache reads/writes reported separately are folded into the
 *   OpenAI-shaped Usage (prompt_tokens includes them; cached_tokens and
 *   cache_write_tokens break them out)
 */

import { readSSE } from "../../util/sse.js";
import { KimiApiError } from "../../util/errors.js";
import { effortFor, type KimiEvent } from "../client.js";
import type { ChatMessage, ContentPart, ReasoningDetail, ToolDef, Usage } from "../messages.js";

export const ANTHROPIC_VERSION = "2023-06-01";
/** Thinking between tool calls (interleaved) on models that need the beta flag. */
const ANTHROPIC_BETAS = "interleaved-thinking-2025-05-14";

export function anthropicHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": ANTHROPIC_BETAS,
  };
}

/** Anthropic tool_use ids must match ^[a-zA-Z0-9_-]+$ ; map ids from other providers deterministically. */
export function sanitizeToolId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.length > 0 ? clean : "toolu_0";
}

/** Thinking budgets for /reasoning levels (tokens). */
const THINKING_BUDGET = { low: 4_096, medium: 16_000, high: 32_000 } as const;

type Block = Record<string, unknown>;
interface AnthropicMessage {
  role: "user" | "assistant";
  content: Block[];
}

function partsToBlocks(content: ChatMessage["content"]): Block[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.flatMap((p: ContentPart): Block[] => {
    if (p.type === "text") return p.text ? [{ type: "text", text: p.text }] : [];
    const url = p.image_url.url;
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    return [m ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } }];
  });
}

/** Replay the thinking blocks an earlier Anthropic response produced (verbatim, signatures included). */
function thinkingBlocks(details: ReasoningDetail[] | undefined): Block[] {
  return (details ?? []).flatMap((d): Block[] => {
    if (d.type === "anthropic.thinking" && typeof d.signature === "string") {
      return [{ type: "thinking", thinking: typeof d.text === "string" ? d.text : "", signature: d.signature }];
    }
    if (d.type === "anthropic.redacted_thinking" && typeof d.data === "string") return [{ type: "redacted_thinking", data: d.data }];
    return [];
  });
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolResultContent(content: ChatMessage["content"]): string | Block[] {
  if (typeof content === "string" || content === null) return content ?? "";
  return partsToBlocks(content);
}

/** Convert the conversation; consecutive same-role turns are merged (tool results into one user turn). */
export function toAnthropicMessages(messages: ChatMessage[]): { system: Block[]; messages: AnthropicMessage[] } {
  const system: Block[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage["role"], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : partsToBlocks(m.content).map((b) => String(b.text ?? "")).join("\n");
      if (text) system.push({ type: "text", text });
    } else if (m.role === "user") {
      push("user", partsToBlocks(m.content));
    } else if (m.role === "assistant") {
      push("assistant", [
        ...thinkingBlocks(m.reasoning_details),
        ...partsToBlocks(m.content),
        ...(m.tool_calls ?? []).map((tc) => ({
          type: "tool_use",
          id: sanitizeToolId(tc.id),
          name: tc.function.name,
          input: parseArgs(tc.function.arguments),
        })),
      ]);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: sanitizeToolId(m.tool_call_id ?? ""), content: toolResultContent(m.content) }]);
    }
  }
  return { system, messages: out };
}

export interface AnthropicRequestInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  supportsReasoning: boolean;
  /**
   * Effort levels the model accepts (models.dev). Models that list efforts
   * but no token budget (newer Claude) use adaptive thinking with
   * `output_config.effort`; the rest get `budget_tokens`.
   */
  reasoningEfforts?: string[];
  reasoningBudget?: boolean;
  supportsTemperature: boolean;
  /** Place prompt-cache breakpoints (default true). */
  cache?: boolean;
}

export function toAnthropicRequest(input: AnthropicRequestInput): Record<string, unknown> {
  const { system, messages } = toAnthropicMessages(input.messages);
  const cache = input.cache !== false;
  const ephemeral = { type: "ephemeral" };
  const tools = (input.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
  // Breakpoints: last tool definition, last system block, conversation tail.
  if (cache) {
    if (tools.length > 0) (tools[tools.length - 1] as Block).cache_control = ephemeral;
    if (system.length > 0) system[system.length - 1]!.cache_control = ephemeral;
    const tail = messages[messages.length - 1]?.content;
    const lastBlock = tail?.[tail.length - 1];
    if (lastBlock && lastBlock.type !== "thinking" && lastBlock.type !== "redacted_thinking") lastBlock.cache_control = ephemeral;
  }
  const wantsThinking = !!input.reasoningEffort && input.supportsReasoning;
  const adaptive = wantsThinking && !input.reasoningBudget && (input.reasoningEfforts?.length ?? 0) > 0;
  const thinking = wantsThinking && !adaptive ? THINKING_BUDGET[input.reasoningEffort!] : 0;
  const body: Record<string, unknown> = {
    model: input.model,
    // max_tokens must exceed the thinking budget.
    max_tokens: thinking ? Math.max(input.maxTokens, thinking + 8_192) : input.maxTokens,
    messages,
    stream: true,
  };
  if (system.length > 0) body.system = system;
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = { type: "auto" };
  }
  if (adaptive) {
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: effortFor(input.reasoningEffort!, input.reasoningEfforts) };
  } else if (thinking) body.thinking = { type: "enabled", budget_tokens: thinking };
  // Temperature must stay at its default while thinking is on.
  else if (input.supportsTemperature) body.temperature = input.temperature ?? 0.2;
  return body;
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "content_filter",
};

interface StreamBlock {
  type: string;
  id?: string;
  name?: string;
  args: string;
  thinking: string;
  signature?: string;
  data?: string;
}

/** Translate a Messages SSE stream into the loop's KimiEvents. */
export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  postFirstByteIdleTimeoutMs: number,
): AsyncGenerator<KimiEvent, void, void> {
  const blocks = new Map<number, StreamBlock>();
  const toolOrder: number[] = [];
  let finishReason: string | null = null;
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let output = 0;
  let usage: Usage | null = null;

  for await (const data of readSSE(body, signal, idleTimeoutMs, postFirstByteIdleTimeoutMs)) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data) as Record<string, any>;
    } catch {
      continue;
    }
    switch (ev.type) {
      case "message_start": {
        const m = ev.message ?? {};
        if (typeof m.id === "string") yield { type: "response_meta", meta: { model: m.model } };
        input = m.usage?.input_tokens ?? 0;
        cacheRead = m.usage?.cache_read_input_tokens ?? 0;
        cacheWrite = m.usage?.cache_creation_input_tokens ?? 0;
        output = m.usage?.output_tokens ?? 0;
        break;
      }
      case "content_block_start": {
        const cb = ev.content_block ?? {};
        const b: StreamBlock = { type: cb.type, args: "", thinking: "" };
        if (cb.type === "tool_use") {
          b.id = cb.id;
          b.name = cb.name;
          toolOrder.push(ev.index);
          yield { type: "tool_call_start", index: ev.index, id: cb.id, name: cb.name };
        } else if (cb.type === "redacted_thinking") {
          b.data = cb.data;
        } else if (cb.type === "text" && typeof cb.text === "string" && cb.text) {
          yield { type: "text", delta: cb.text };
        }
        blocks.set(ev.index, b);
        break;
      }
      case "content_block_delta": {
        const b = blocks.get(ev.index);
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && d.text) yield { type: "text", delta: d.text };
        else if (d.type === "thinking_delta" && d.thinking) {
          if (b) b.thinking += d.thinking;
          yield { type: "reasoning", delta: d.thinking };
        } else if (d.type === "signature_delta" && b) b.signature = (b.signature ?? "") + d.signature;
        else if (d.type === "input_json_delta" && b && d.partial_json) {
          b.args += d.partial_json;
          yield { type: "tool_call_args", index: ev.index, argsDelta: d.partial_json };
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks.get(ev.index);
        if (b?.type === "thinking" && b.signature) {
          yield { type: "reasoning_details", details: [{ type: "anthropic.thinking", index: ev.index, text: b.thinking, signature: b.signature }] };
        } else if (b?.type === "redacted_thinking" && b.data) {
          yield { type: "reasoning_details", details: [{ type: "anthropic.redacted_thinking", index: ev.index, data: b.data }] };
        }
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) finishReason = STOP_REASONS[ev.delta.stop_reason] ?? ev.delta.stop_reason;
        if (typeof ev.usage?.output_tokens === "number") output = ev.usage.output_tokens;
        // Some responses report final input/cache figures here too.
        if (typeof ev.usage?.input_tokens === "number") input = ev.usage.input_tokens;
        if (typeof ev.usage?.cache_read_input_tokens === "number") cacheRead = ev.usage.cache_read_input_tokens;
        if (typeof ev.usage?.cache_creation_input_tokens === "number") cacheWrite = ev.usage.cache_creation_input_tokens;
        usage = {
          prompt_tokens: input + cacheRead + cacheWrite,
          completion_tokens: output,
          total_tokens: input + cacheRead + cacheWrite + output,
          prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
        };
        yield { type: "usage", usage };
        break;
      }
      case "error": {
        const err = ev.error ?? {};
        throw new KimiApiError(`kimiflare: ${err.message ?? "Anthropic reported an error mid-response"}`, undefined, err.type === "overloaded_error" ? 529 : undefined);
      }
      default:
        break; // message_stop, ping
    }
  }

  for (const index of toolOrder) {
    const b = blocks.get(index)!;
    yield { type: "tool_call_complete", index, id: b.id!, name: b.name!, arguments: b.args || "{}", finishReason };
  }
  yield { type: "done", finishReason, usage };
}
