/**
 * OpenAI Responses API adapter (https://platform.openai.com/docs/api-reference/responses).
 *
 * The full-quality path for GPT-5.x / codex models: reasoning carries over
 * between turns of a tool loop as encrypted reasoning items, which Chat
 * Completions drops. Requests are stateless (`store: false`) and ask for
 * `reasoning.encrypted_content`, so nothing is kept server-side and the
 * conversation stays in Autopilot's own history:
 *
 * - system → `system` input messages; user text/images → input_text /
 *   input_image; assistant text → output_text
 * - assistant tool_calls → `function_call` items; tool messages →
 *   `function_call_output` items
 * - reasoning items come back as reasoning_details (`openai.reasoning`, with
 *   the encrypted content and summary) and are replayed in order before the
 *   assistant output they preceded
 * - stream: response.* events → text, reasoning (summary text), tool calls,
 *   usage
 */

import { readSSE } from "../../util/sse.js";
import { KimiApiError } from "../../util/errors.js";
import { effortFor, type KimiEvent } from "../client.js";
import type { ChatMessage, ContentPart, ReasoningDetail, ToolDef, Usage } from "../messages.js";

type Item = Record<string, unknown>;

function inputContent(content: ChatMessage["content"], role: "user" | "system"): Item[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  return content.flatMap((p: ContentPart): Item[] => {
    if (p.type === "text") return p.text ? [{ type: "input_text", text: p.text }] : [];
    return role === "user" ? [{ type: "input_image", image_url: p.image_url.url }] : [];
  });
}

function text(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
}

function reasoningItems(details: ReasoningDetail[] | undefined): Item[] {
  return (details ?? []).flatMap((d): Item[] =>
    d.type === "openai.reasoning" && typeof d.data === "string"
      ? [{ type: "reasoning", ...(d.id ? { id: d.id } : {}), encrypted_content: d.data, summary: Array.isArray(d.summaryParts) ? d.summaryParts : [] }]
      : [],
  );
}

export function toResponsesInput(messages: ChatMessage[]): Item[] {
  const input: Item[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const c = inputContent(m.content, "system");
      if (c.length) input.push({ role: "system", content: c });
    } else if (m.role === "user") {
      const c = inputContent(m.content, "user");
      if (c.length) input.push({ role: "user", content: c });
    } else if (m.role === "assistant") {
      input.push(...reasoningItems(m.reasoning_details));
      const t = text(m.content);
      if (t) input.push({ role: "assistant", content: [{ type: "output_text", text: t }] });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
      }
    } else if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id ?? "", output: text(m.content) });
    }
  }
  return input;
}

export interface ResponsesRequestInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  supportsReasoning: boolean;
  supportsTemperature: boolean;
  reasoningEfforts?: string[];
  parallelToolCalls?: boolean;
}

export function toResponsesRequest(input: ResponsesRequestInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: toResponsesInput(input.messages),
    stream: true,
    // Stateless: history lives in Autopilot; reasoning comes back encrypted for the next turn.
    store: false,
    max_output_tokens: input.maxTokens,
  };
  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: false,
    }));
    body.tool_choice = "auto";
    if (input.parallelToolCalls !== false) body.parallel_tool_calls = true;
  }
  if (input.supportsReasoning) {
    body.include = ["reasoning.encrypted_content"];
    body.reasoning = {
      ...(input.reasoningEffort && input.reasoningEfforts?.length !== 0 ? { effort: effortFor(input.reasoningEffort, input.reasoningEfforts) } : {}),
      summary: "auto",
    };
  }
  if (input.supportsTemperature && !input.supportsReasoning) body.temperature = input.temperature ?? 0.2;
  return body;
}

interface CallBuf {
  index: number;
  id: string;
  name: string;
  args: string;
}

/** Translate a Responses SSE stream into the loop's KimiEvents. */
export async function* parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  idleTimeoutMs: number,
  postFirstByteIdleTimeoutMs: number,
): AsyncGenerator<KimiEvent, void, void> {
  const calls = new Map<string, CallBuf>(); // by item id
  let nextIndex = 0;
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  let reasoningIndex = 0;

  for await (const data of readSSE(body, signal, idleTimeoutMs, postFirstByteIdleTimeoutMs)) {
    if (data === "[DONE]") break;
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(data) as Record<string, any>;
    } catch {
      continue;
    }
    switch (ev.type) {
      case "response.created":
        if (ev.response?.model) yield { type: "response_meta", meta: { model: ev.response.model } };
        break;
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          const buf: CallBuf = { index: nextIndex++, id: item.call_id ?? item.id, name: item.name ?? "", args: item.arguments ?? "" };
          calls.set(item.id ?? buf.id, buf);
          yield { type: "tool_call_start", index: buf.index, id: buf.id, name: buf.name };
        }
        break;
      }
      case "response.output_text.delta":
        if (ev.delta) yield { type: "text", delta: ev.delta };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (ev.delta) yield { type: "reasoning", delta: ev.delta };
        break;
      case "response.function_call_arguments.delta": {
        const buf = calls.get(ev.item_id);
        if (buf && ev.delta) {
          buf.args += ev.delta;
          yield { type: "tool_call_args", index: buf.index, argsDelta: ev.delta };
        }
        break;
      }
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (item.type === "reasoning" && typeof item.encrypted_content === "string") {
          yield {
            type: "reasoning_details",
            details: [
              {
                type: "openai.reasoning",
                index: reasoningIndex++,
                ...(item.id ? { id: item.id } : {}),
                data: item.encrypted_content,
                summaryParts: Array.isArray(item.summary) ? item.summary : [],
              },
            ],
          };
        } else if (item.type === "function_call") {
          const buf = calls.get(item.id);
          if (buf && typeof item.arguments === "string") buf.args = item.arguments;
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const r = ev.response ?? {};
        const u = r.usage;
        if (u) {
          usage = {
            prompt_tokens: u.input_tokens ?? 0,
            completion_tokens: u.output_tokens ?? 0,
            total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
          };
          yield { type: "usage", usage };
        }
        finishReason = ev.type === "response.incomplete" ? (r.incomplete_details?.reason === "content_filter" ? "content_filter" : "length") : calls.size > 0 ? "tool_calls" : "stop";
        break;
      }
      case "response.failed": {
        const e = ev.response?.error ?? {};
        throw new KimiApiError(`kimiflare: ${e.message ?? "the response failed"}`, undefined, undefined);
      }
      case "error":
        throw new KimiApiError(`kimiflare: ${ev.message ?? ev.error?.message ?? "the provider reported an error mid-response"}`, undefined, undefined);
      default:
        break;
    }
  }

  for (const buf of [...calls.values()].sort((a, b) => a.index - b.index)) {
    yield { type: "tool_call_complete", index: buf.index, id: buf.id, name: buf.name, arguments: buf.args || "{}", finishReason };
  }
  yield { type: "done", finishReason, usage };
}
