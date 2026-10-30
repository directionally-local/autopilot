import { join } from "node:path";
import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import type { ChatMessage, ReasoningDetail, ToolDef, Usage } from "../agent/messages.js";
import { approxTokens } from "../agent/artifact-compaction.js";
import { readEnv } from "./env.js";
import { configPath } from "./app-dirs.js";

/**
 * Debug-only recorder for the *complete* payload KimiFlare sends to the LLM,
 * plus the response it gets back. This is a research/instrumentation toggle —
 * NOT a user-facing feature, NOT documented, default OFF.
 *
 * It exists to study what fraction of the outbound context is unhelpful
 * (inspired by the "Headroom" experiment). Gate it with `KIMIFLARE_DUMP_LLM=1`,
 * take KimiFlare for a test drive, then fan analysis agents at the dumps.
 *
 * Design (mirrors src/util/log-sink.ts):
 *   - Best-effort, silent on every failure. The agent loop must never crash
 *     because a dump file is unwritable.
 *   - This is deliberately SEPARATE from the structured logger, which by
 *     design does not log LLM bodies (see log-sink.ts header comment).
 *   - One pretty-printed JSON file per LLM call, plus an append-only
 *     `index.jsonl` summarizing every call (sizes only, no bodies) for a
 *     quick per-turn growth curve.
 *
 * Capture point is a pure post-assembly observer in runKimi(): it reads the
 * already-finalized request body immediately before fetch(), so it cannot
 * alter what is sent.
 */

/** True when payload dumping is enabled via env. Default off. */
export function isLlmDumpEnabled(): boolean {
  const raw = readEnv("DUMP_LLM");
  if (raw === undefined) return false;
  const v = raw.toLowerCase();
  return v === "1" || v === "true";
}

function defaultDumpRoot(): string {
  const override = readEnv("DUMP_LLM_DIR");
  if (override && override.trim()) return override;
  return configPath("llm-dumps");
}

/** Per-session output directory, e.g. ~/.config/autopilot/llm-dumps/<session>/. */
export function dumpDir(sessionId?: string | null): string {
  return join(defaultDumpRoot(), sessionId && sessionId.trim() ? sessionId : "nosession");
}

// ── Record shapes ────────────────────────────────────────────────────────

export interface LlmDumpMeta {
  requestId: string;
  sessionId?: string | null;
  turnId?: string | null;
  model: string;
  url: string;
  ts: string;
  attempt?: number;
}

export interface PerMessageBreakdown {
  index: number;
  role: string;
  name?: string;
  chars: number;
  estTokens: number;
  toolName?: string;
}

export interface LlmDumpBreakdown {
  totalChars: number;
  estTokens: number;
  messageCount: number;
  toolCount: number;
  systemChars: number;
  toolsChars: number;
  historyChars: number;
  perMessage: PerMessageBreakdown[];
}

export interface LlmDumpResponse {
  text: string;
  reasoning: string;
  /** Structured reasoning blocks merged from streamed `reasoning_details` deltas. */
  reasoningDetails: ReasoningDetail[];
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  usage: Usage | null;
  /** OpenRouter generation id from the stream, when present. */
  generationId?: string;
}

export interface LlmDumpRecord {
  meta: LlmDumpMeta;
  request: {
    system: ChatMessage[];
    messages: ChatMessage[];
    tools: ToolDef[];
    params: Record<string, unknown>;
    rawSerialized: string;
  };
  breakdown: LlmDumpBreakdown;
  response: LlmDumpResponse;
}

// ── Breakdown computation ────────────────────────────────────────────────

/** Count the serialized-ish character weight of a single message. Mirrors
 *  estimateMessageTokens() in artifact-compaction.ts (content + reasoning +
 *  tool-call name/args) so the numbers line up with budget accounting. */
function messageChars(m: ChatMessage): number {
  let chars = 0;
  if (typeof m.content === "string") {
    chars = m.content.length;
  } else if (Array.isArray(m.content)) {
    chars = m.content.reduce((a, p) => a + (p.type === "text" ? p.text.length : 0), 0);
  }
  if (m.reasoning_content) chars += m.reasoning_content.length;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return chars;
}

export function computeBreakdown(messages: ChatMessage[], tools: ToolDef[]): LlmDumpBreakdown {
  const perMessage: PerMessageBreakdown[] = [];
  let systemChars = 0;
  let historyChars = 0;

  messages.forEach((m, index) => {
    const chars = messageChars(m);
    if (m.role === "system") systemChars += chars;
    else historyChars += chars;
    perMessage.push({
      index,
      role: m.role,
      ...(m.name ? { name: m.name } : {}),
      chars,
      estTokens: approxTokens(chars),
      ...(m.tool_calls && m.tool_calls.length
        ? { toolName: m.tool_calls.map((t) => t.function.name).join(",") }
        : {}),
    });
  });

  const toolsChars = tools.reduce(
    (a, t) => a + t.function.name.length + t.function.description.length + JSON.stringify(t.function.parameters).length,
    0,
  );
  const totalChars = systemChars + historyChars + toolsChars;

  return {
    totalChars,
    estTokens: approxTokens(totalChars),
    messageCount: messages.length,
    toolCount: tools.length,
    systemChars,
    toolsChars,
    historyChars,
    perMessage,
  };
}

// ── Writing ──────────────────────────────────────────────────────────────

/** Sanitize a value for use in a filename. */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/**
 * Write one dump record: a pretty-printed JSON file plus an `index.jsonl`
 * summary line. Best-effort and silent — never throws.
 */
export function writeLlmDump(record: LlmDumpRecord): void {
  if (!isLlmDumpEnabled()) return;
  try {
    const dir = dumpDir(record.meta.sessionId);
    mkdirSync(dir, { recursive: true });

    const tsPart = safeSegment(record.meta.ts);
    const turnPart = safeSegment(record.meta.turnId ?? "noturn");
    const reqPart = safeSegment(record.meta.requestId);
    const file = join(dir, `${tsPart}-${turnPart}-${reqPart}.json`);
    writeFileSync(file, JSON.stringify(record, null, 2));

    const summary = {
      ...record.meta,
      ...record.breakdown,
      perMessage: undefined, // keep the index line thin
      finishReason: record.response.finishReason,
      usage: record.response.usage,
      file,
    };
    appendFileSync(join(dir, "index.jsonl"), JSON.stringify(summary) + "\n");
  } catch {
    // best-effort: never disrupt the agent loop
  }
}
