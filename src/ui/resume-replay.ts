/**
 * What continuing a conversation (`-c`, `autopilot resume`, `/resume`) shows:
 * the last few exchanges as they were — each request, and the start of the
 * answer — then "Continuing <title> from <time>". Built from the saved
 * messages with no model call, so it appears at once and costs nothing.
 */

import type { ChatMessage } from "../agent/messages.js";

export interface ReplayExchange {
  user: string;
  /** The start of the answer, trimmed; empty when the request got no text reply. */
  answer: string;
}

export interface ResumeReplay {
  exchanges: ReplayExchange[];
  /** How many requests the conversation had in all (more than shown when it was long). */
  totalRequests: number;
  /** "Continuing <title> from <time>". */
  line: string;
}

const USER_MAX_CHARS = 300;
const USER_MAX_LINES = 4;
const ANSWER_MAX_CHARS = 400;
const ANSWER_MAX_LINES = 6;

function textOf(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("\n")
      .trim();
  }
  return "";
}

/** The first `maxLines` lines and `maxChars` characters, with "…" when cut. */
export function trimStart(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split("\n");
  let out = lines.slice(0, maxLines).join("\n");
  let cut = lines.length > maxLines;
  if (out.length > maxChars) {
    const at = out.lastIndexOf(" ", maxChars);
    out = out.slice(0, at > maxChars * 0.6 ? at : maxChars);
    cut = true;
  }
  return cut ? `${out.trimEnd()} …` : out;
}

/** "today at 18:13", "yesterday at 09:02", "Nov 2 at 18:13", in local time. */
export function formatWhen(iso: string, now = Date.now(), timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "earlier";
  const tz = timeZone ? { timeZone } : {};
  const day = (ms: number) => new Date(ms).toLocaleDateString("en-CA", tz);
  const time = new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...tz });
  if (day(t) === day(now)) return `today at ${time}`;
  if (day(t) === day(now - 86_400_000)) return `yesterday at ${time}`;
  const date = new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(t).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}), ...tz });
  return `${date} at ${time}`;
}

/**
 * The last `count` exchanges of a saved conversation and the line that
 * follows them. The answer is the request's final text reply (after any tool
 * calls), shown from its start.
 */
export function buildResumeReplay(
  file: { messages: ChatMessage[]; title?: string; updatedAt: string },
  o: { count?: number; now?: number; timeZone?: string } = {},
): ResumeReplay {
  const exchanges: ReplayExchange[] = [];
  let current: { user: string; answer: string } | null = null;
  for (const m of file.messages) {
    if (m.role === "user") {
      const text = textOf(m);
      // Skip empty turns and notices the agent loop added on the user's behalf.
      if (!text || text.startsWith("[Automatic notice")) continue;
      if (current) exchanges.push(current);
      current = { user: text, answer: "" };
    } else if (m.role === "assistant" && current) {
      const text = textOf(m);
      if (text) current.answer = text;
    }
  }
  if (current) exchanges.push(current);
  const shown = exchanges.slice(-(o.count ?? 3)).map((e) => ({
    user: trimStart(e.user, USER_MAX_CHARS, USER_MAX_LINES),
    answer: e.answer ? trimStart(e.answer, ANSWER_MAX_CHARS, ANSWER_MAX_LINES) : "",
  }));
  const title = (file.title?.trim() || exchanges[0]?.user.split("\n")[0] || "this conversation").slice(0, 80);
  return {
    exchanges: shown,
    totalRequests: exchanges.length,
    line: `Continuing “${title}” from ${formatWhen(file.updatedAt, o.now, o.timeZone)}`,
  };
}
