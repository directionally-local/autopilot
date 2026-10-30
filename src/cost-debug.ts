import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatMessage, Usage } from "./agent/messages.js";
import type { ToolResult } from "./tools/executor.js";
import { rotateJsonl, RETENTION } from "./storage-limits.js";
import { logger } from "./util/logger.js";
import { dataPath } from "./util/app-dirs.js";

const LOG_VERSION = 1;

export interface PromptSection {
  role: string;
  chars: number;
  approxTokens: number;
  detail?: string;
}

export interface ToolByteStats {
  name: string;
  rawBytes: number;
  reducedBytes: number;
  savingsPct: number;
}

export interface CacheDiagnostics {
  staticPrefixChars: number;
  sessionPrefixChars: number;
  dynamicSuffixChars: number;
  firstDiffByte: number | null;
  changedSegment: "static" | "session" | "dynamic" | "none" | null;
  cacheHitRatio: number;
}

export interface CompactionMetrics {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  archivedArtifacts: number;
  recalledArtifacts: number;
  rawTurnsRemoved: number;
  rawTurnsKept: number;
  memoriesExtracted?: number;
  memoriesStored?: number;
}

export interface IntentClassification {
  intent: string;
  tier: "light" | "medium" | "heavy";
  rawScore: number;
  confidence: number;
}

export interface CostDebugEntry {
  v: number;
  ts: string;
  sessionId: string;
  turn?: number;
  usage: Usage;
  promptSections: PromptSection[];
  promptTotalChars: number;
  promptTotalApproxTokens: number;
  toolStats: ToolByteStats[];
  toolTotalRawBytes: number;
  toolTotalReducedBytes: number;
  toolSavingsPct: number;
  cacheDiagnostics?: CacheDiagnostics;
  compaction?: CompactionMetrics;
  shadowStrip?: ShadowStripMetrics;
  signals?: string[]; // Literal categories detected this turn (cost attribution)
  durationMs?: number; // NEW: wall-clock time for this turn
  intentClassification?: IntentClassification; // NEW: what we predicted
  codeMode?: boolean; // NEW: was Code Mode enabled this turn
  selectedSkills?: string[]; // NEW: skill names injected this turn
  /** First 200 chars of the last user message in this turn — for quickly grepping logs. */
  userPromptPreview?: string;
  /** Wall-clock ms spent on pre-turn setup (memory recall + skill routing) before the first model call. */
  preTurnMs?: number;
  /** True if at least one memory was recalled and injected this turn. */
  memoryRecalled?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function approxTokens(chars: number): number {
  // Rough heuristic: ~4 chars per token for English/code
  return Math.round(chars / 4);
}

export function analyzePrompt(messages: ChatMessage[]): PromptSection[] {
  const sections: PromptSection[] = [];
  for (const m of messages) {
    let contentStr = "";
    if (typeof m.content === "string") {
      contentStr = m.content;
    } else if (Array.isArray(m.content)) {
      contentStr = m.content.map((p) => (p.type === "text" ? p.text : "[image]")).join(" ");
    }

    const chars = contentStr.length;
    const base: PromptSection = {
      role: m.role,
      chars,
      approxTokens: approxTokens(chars),
    };

    if (m.role === "assistant" && m.reasoning_content) {
      sections.push({
        ...base,
        detail: `content+reasoning (${approxTokens(m.reasoning_content.length)} reasoning tokens)`,
        chars: chars + m.reasoning_content.length,
        approxTokens: approxTokens(chars + m.reasoning_content.length),
      });
    } else if (m.role === "tool") {
      sections.push({
        ...base,
        detail: m.name ? `tool: ${m.name}` : undefined,
      });
    } else {
      sections.push(base);
    }
  }
  return sections;
}

export function buildToolStats(results: ToolResult[]): ToolByteStats[] {
  return results.map((r) => {
    const raw = r.rawBytes ?? Buffer.byteLength(r.content, "utf8");
    const reduced = r.reducedBytes ?? raw;
    const savings = raw > 0 ? Math.round(((raw - reduced) / raw) * 100) : 0;
    return {
      name: r.name,
      rawBytes: raw,
      reducedBytes: reduced,
      savingsPct: savings,
    };
  });
}

export async function logCostDebug(entry: CostDebugEntry): Promise<void> {
  // Resolve the location once, so a changed XDG_DATA_HOME mid-write can't
  // send the append to a directory that was never created.
  const path = dataPath("cost-debug.jsonl");
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await rotateJsonl(path, RETENTION.costDebugMaxBytes, RETENTION.costDebugRotations);
  await appendFile(path, JSON.stringify(entry) + "\n", "utf8");
}

export interface ShadowStripMetrics {
  originalApproxTokens: number;
  strippedApproxTokens: number;
  savingsPct: number;
}

export interface TurnDebugContext {
  sessionId: string;
  turn: number;
  messages: ChatMessage[];
  toolResults: ToolResult[];
  usage: Usage;
  previousMessages?: ChatMessage[];
  compaction?: CompactionMetrics;
  shadowStrip?: ShadowStripMetrics;
  durationMs?: number;
  intentClassification?: IntentClassification;
  codeMode?: boolean;
  /** Skills injected into this turn */
  selectedSkills?: { name: string; body: string }[];
  userPromptPreview?: string;
  preTurnMs?: number;
  memoryRecalled?: boolean;
}

/** Serialize the prompt prefix (all leading system messages) for comparison. */
function serializePrefix(messages: ChatMessage[]): string {
  let end = 0;
  while (end < messages.length && messages[end]!.role === "system") {
    end++;
  }
  return messages
    .slice(0, end)
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n---\n");
}

/** Compare current prompt prefix against prior turn to detect cache misses. */
export function comparePromptPrefixes(
  prev: ChatMessage[] | undefined,
  curr: ChatMessage[],
): CacheDiagnostics {
  const prevPrefix = prev ? serializePrefix(prev) : "";
  const currPrefix = serializePrefix(curr);
  const totalChars = curr.reduce((sum, m) => {
    if (typeof m.content === "string") return sum + m.content.length;
    if (Array.isArray(m.content)) return sum + m.content.map((p) => (p.type === "text" ? p.text.length : 0)).reduce((a, b) => a + b, 0);
    return sum;
  }, 0);

  let firstDiffByte: number | null = null;
  let changedSegment: CacheDiagnostics["changedSegment"] = null;

  if (prevPrefix !== currPrefix) {
    const minLen = Math.min(prevPrefix.length, currPrefix.length);
    for (let i = 0; i < minLen; i++) {
      if (prevPrefix[i] !== currPrefix[i]) {
        firstDiffByte = i;
        break;
      }
    }
    if (firstDiffByte === null && prevPrefix.length !== currPrefix.length) {
      firstDiffByte = minLen;
    }

    // Determine which segment changed based on message boundaries.
    // With dual system messages: msg0 = static, msg1 = session.
    if (curr.length >= 1 && curr[0]!.role === "system") {
      const staticLen = typeof curr[0]!.content === "string" ? curr[0]!.content.length : JSON.stringify(curr[0]!.content).length;
      if (firstDiffByte !== null && firstDiffByte < staticLen) {
        changedSegment = "static";
      } else if (curr.length >= 2 && curr[1]!.role === "system") {
        const sessionLen = typeof curr[1]!.content === "string" ? curr[1]!.content.length : JSON.stringify(curr[1]!.content).length;
        if (firstDiffByte !== null && firstDiffByte < staticLen + 5 + sessionLen) {
          changedSegment = "session";
        } else {
          changedSegment = "dynamic";
        }
      } else {
        changedSegment = "dynamic";
      }
    } else {
      changedSegment = "dynamic";
    }
  } else {
    changedSegment = "none";
  }

  const staticPrefixChars = curr.length > 0 && curr[0]!.role === "system" && typeof curr[0]!.content === "string" ? curr[0]!.content.length : 0;
  const sessionPrefixChars = curr.length > 1 && curr[1]!.role === "system" && typeof curr[1]!.content === "string" ? curr[1]!.content.length : 0;
  const dynamicSuffixChars = totalChars - staticPrefixChars - sessionPrefixChars;

  return {
    staticPrefixChars,
    sessionPrefixChars,
    dynamicSuffixChars,
    firstDiffByte,
    changedSegment,
    cacheHitRatio: 0, // populated by caller with actual usage data
  };
}

/**
 * Best-effort: callers fire this without awaiting, so it must never reject.
 * A failed debug write (full disk, read-only home) is logged, not thrown —
 * an unhandled rejection would end the user's session.
 */
export async function logTurnDebug(ctx: TurnDebugContext): Promise<void> {
  try {
    await writeTurnDebug(ctx);
  } catch (err) {
    logger.debug("cost_debug:write_failed", { error: (err as Error)?.message ?? String(err) });
  }
}

async function writeTurnDebug(ctx: TurnDebugContext): Promise<void> {
  const promptSections = analyzePrompt(ctx.messages);
  const promptTotalChars = promptSections.reduce((sum, s) => sum + s.chars, 0);
  const toolStats = buildToolStats(ctx.toolResults);
  const toolTotalRaw = toolStats.reduce((sum, t) => sum + t.rawBytes, 0);
  const toolTotalReduced = toolStats.reduce((sum, t) => sum + t.reducedBytes, 0);
  const cacheDiagnostics = comparePromptPrefixes(ctx.previousMessages, ctx.messages);
  const cachedTokens = ctx.usage.prompt_tokens_details?.cached_tokens ?? 0;
  cacheDiagnostics.cacheHitRatio = ctx.usage.prompt_tokens > 0 ? cachedTokens / ctx.usage.prompt_tokens : 0;

  await logCostDebug({
    v: LOG_VERSION,
    ts: now(),
    sessionId: ctx.sessionId,
    turn: ctx.turn,
    usage: ctx.usage,
    promptSections,
    promptTotalChars,
    promptTotalApproxTokens: approxTokens(promptTotalChars),
    toolStats,
    toolTotalRawBytes: toolTotalRaw,
    toolTotalReducedBytes: toolTotalReduced,
    toolSavingsPct: toolTotalRaw > 0 ? Math.round(((toolTotalRaw - toolTotalReduced) / toolTotalRaw) * 100) : 0,
    cacheDiagnostics,
    compaction: ctx.compaction,
    shadowStrip: ctx.shadowStrip,
    durationMs: ctx.durationMs,
    intentClassification: ctx.intentClassification,
    codeMode: ctx.codeMode,
    selectedSkills: ctx.selectedSkills?.map((s) => s.name),
    userPromptPreview: ctx.userPromptPreview,
    preTurnMs: ctx.preTurnMs,
    memoryRecalled: ctx.memoryRecalled,
  });
}


