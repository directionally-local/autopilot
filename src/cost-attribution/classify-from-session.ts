/**
 * Read a session file from disk and classify it using the heuristic.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage, ToolCall } from "../agent/messages.js";
import { classifySession } from "./heuristic.js";
import { dataPath } from "../util/app-dirs.js";

function sessionsDir(): string {
  return dataPath("sessions");
}

interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

function parseToolCalls(calls: ToolCall[]): ParsedToolCall[] {
  return calls.map((c) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(c.function.arguments) as Record<string, unknown>;
    } catch {
      // ignore parse errors
    }
    return { name: c.function.name, arguments: args };
  });
}

export async function classifyFromSessionFile(
  sessionId: string
): Promise<{
  category: string;
  confidence: number;
  classifiedBy: "heuristic" | "llm" | "user";
  summary?: string;
}> {
  try {
    const raw = await readFile(join(sessionsDir(), `${sessionId}.json`), "utf8");
    const session = JSON.parse(raw) as { messages?: ChatMessage[] };
    const messages = session.messages ?? [];

    // Group tool calls by assistant turn
    const turns: { toolCalls: ParsedToolCall[]; tokens: number }[] = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
        turns.push({ toolCalls: parseToolCalls(m.tool_calls), tokens: 100 });
      }
    }

    const totalToolCalls = turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
    const result = classifySession(turns, { totalTurns: turns.length, totalToolCalls });
    return {
      category: result.category,
      confidence: result.confidence,
      classifiedBy: result.classifiedBy,
      summary: result.summary,
    };
  } catch {
    // Fallback if session file is missing or corrupted
    return { category: "other", confidence: 0.5, classifiedBy: "heuristic", summary: "Session file unavailable" };
  }
}
