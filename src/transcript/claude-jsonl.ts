/**
 * Claude Code-compatible JSONL session transcript (#892).
 *
 * Hook payloads carry `transcript_path`, and tools built for Claude Code
 * hooks (Agent Beacon's `--platform claude`, and Claude Code hook scripts in
 * general) read that file as Claude Code's transcript: one JSON object per
 * line, each with `type` ("user" / "assistant"), `message` ({role, content,
 * model?, usage?}), `uuid`, `parentUuid`, `timestamp`, `sessionId` and `cwd`.
 * Autopilot's own session file is a single pretty-printed JSON document in a
 * different shape, so it writes this transcript beside it:
 *
 *   <sessionsDir>/<session id>.json    Autopilot's session (unchanged)
 *   <sessionsDir>/<session id>.jsonl   this transcript
 *
 * Entries are appended as the turn runs (the prompt when the turn starts,
 * each assistant response when it is complete, each tool result when it is
 * recorded), so the file is readable mid-session and every line on disk is
 * complete JSON.
 *
 *  - user prompt:  `{type:"user", message:{role:"user", content:"…"}, promptId}`
 *  - assistant:    `{type:"assistant", message:{id, type:"message", role:"assistant",
 *                   model, content:[thinking?, text?, tool_use…], stop_reason, usage}}`
 *                  with Claude Code's tool names and `input` shapes (claude-compat.ts)
 *  - tool result:  `{type:"user", message:{role:"user", content:[{type:"tool_result",
 *                   tool_use_id, content, is_error}]}, sourceToolAssistantUUID, promptId}`
 *
 * `usage` uses Anthropic's field names: `input_tokens` (uncached prompt
 * tokens), `output_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`.
 *
 * Every string goes through the session trace's write-time redaction
 * (`redactDeep` → `redactLight`), long blocks are cut the way the trace's
 * blob store cuts them (`truncateUtf8` + `[truncated: N bytes total]`), and
 * the file stops growing (one warning) at the trace's per-session cap.
 * Writing never throws: the first disk error is logged once and that
 * session's transcript stops. `KIMIFLARE_TRANSCRIPT=0` turns it off.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChatMessage, ContentPart, Usage } from "../agent/messages.js";
import { claudeToolInput, claudeToolName } from "../hooks/claude-compat.js";
import { sessionsDir } from "../sessions.js";
import { RETENTION } from "../storage-limits.js";
import { truncateUtf8 } from "../trace/blobs.js";
import { redactDeep } from "../trace/redact.js";
import { logger } from "../util/logger.js";

/** `transcript_format` in hook payloads when `transcript_path` is this transcript. */
export const CLAUDE_TRANSCRIPT_FORMAT = "claude-jsonl";
/** `transcript_format` when transcripts are off and `transcript_path` is Autopilot's session JSON. */
export const AUTOPILOT_SESSION_FORMAT = "autopilot-json";

/**
 * Largest text block (prompt, reply, reasoning, tool result, tool input
 * string) kept whole. Tool output in history is already reduced by the
 * loop; this bounds the rare giant one so a single line stays well inside
 * the 1 MiB tail Beacon reads for the newest `promptId`.
 */
export const TRANSCRIPT_MAX_BLOCK_BYTES = 256 * 1024;

/** Per-session size cap: the same as the session trace's. */
export const TRANSCRIPT_MAX_SESSION_BYTES = RETENTION.traceMaxSessionBytes;

/** False when `KIMIFLARE_TRANSCRIPT` is `0`, `false` or `off`. On by default. */
export function transcriptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.KIMIFLARE_TRANSCRIPT?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

/** Where a session's transcript lives: next to its session file. */
export function claudeTranscriptPath(sessionId: string, dir: string = sessionsDir()): string {
  return join(dir, `${sessionId}.jsonl`);
}

/** `transcript_path` and `transcript_format` for a hook payload. */
export function hookTranscriptFields(sessionId: string): { transcript_path: string; transcript_format: string } {
  if (transcriptEnabled()) {
    return { transcript_path: claudeTranscriptPath(sessionId), transcript_format: CLAUDE_TRANSCRIPT_FORMAT };
  }
  return { transcript_path: join(sessionsDir(), `${sessionId}.json`), transcript_format: AUTOPILOT_SESSION_FORMAT };
}

export interface TranscriptOptions {
  /** Directory override (default: sessionsDir()). */
  dir?: string;
  maxBlockBytes?: number;
  maxSessionBytes?: number;
}

/** What an assistant entry records beside the message itself. */
export interface AssistantInfo {
  model?: string;
  usage?: Usage | null;
  /** The provider's response id (OpenRouter generation id), when reported. */
  responseId?: string;
}

/** The parts of a tool result the transcript records. */
export interface TranscriptToolResult {
  tool_call_id: string;
  content: string;
  ok: boolean;
}

type Entry = Record<string, unknown>;

/** Anthropic-style usage from an OpenAI-style one. `prompt_tokens` includes cached and cache-written tokens. */
export function claudeUsage(usage: Usage): Record<string, number> {
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached - written),
    output_tokens: usage.completion_tokens ?? 0,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
  };
}

export class ClaudeTranscript {
  readonly path: string;
  private readonly maxBlockBytes: number;
  private readonly maxSessionBytes: number;
  private enabled = true;
  private opened = false;
  private bytes = 0;
  private lastUuid: string | null = null;
  private promptId: string | null = null;
  /** tool_use id → uuid of the assistant entry that issued it. */
  private readonly toolUseOwner = new Map<string, string>();
  /** History messages already written (a host may hand the same object to two turns). */
  private readonly written = new WeakSet<ChatMessage>();

  constructor(
    readonly sessionId: string,
    private cwd: string,
    opts: TranscriptOptions = {},
  ) {
    this.path = claudeTranscriptPath(sessionId, opts.dir);
    this.maxBlockBytes = opts.maxBlockBytes ?? TRANSCRIPT_MAX_BLOCK_BYTES;
    this.maxSessionBytes = opts.maxSessionBytes ?? TRANSCRIPT_MAX_SESSION_BYTES;
  }

  /** Whether the transcript is still being written (false after a disk error or the size cap). */
  get active(): boolean {
    return this.enabled;
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * A user message: the turn's prompt, steering input typed mid-turn, or an
   * automatic notice (`meta`, written with `isMeta: true` like Claude Code's
   * injected messages). A prompt starts a new `promptId`. Returns the entry's
   * uuid, or null when nothing was written.
   */
  appendUser(message: ChatMessage, opts: { meta?: boolean } = {}): string | null {
    if (this.written.has(message)) return null;
    this.written.add(message);
    const content = userContent(message.content);
    if (content === null) return null;
    if (!opts.meta) this.promptId = randomUUID();
    return this.write({
      type: "user",
      message: { role: "user", content },
      ...(opts.meta ? { isMeta: true } : {}),
      ...(!opts.meta && this.promptId ? { promptId: this.promptId } : {}),
    });
  }

  /** One complete assistant response: reasoning, text and tool calls as content blocks, with model and usage. */
  appendAssistant(message: ChatMessage, info: AssistantInfo = {}): string | null {
    if (this.written.has(message)) return null;
    this.written.add(message);
    const blocks: Entry[] = [];
    if (typeof message.reasoning_content === "string" && message.reasoning_content.trim()) {
      blocks.push({ type: "thinking", thinking: message.reasoning_content });
    }
    const text = typeof message.content === "string" ? message.content : textOf(message.content);
    if (text) blocks.push({ type: "text", text });
    for (const tc of message.tool_calls ?? []) {
      const args = parseArgs(tc.function.arguments);
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: args ? claudeToolName(tc.function.name, args) : tc.function.name,
        input: args ? claudeToolInput(tc.function.name, args, this.cwd) : { arguments: tc.function.arguments },
      });
    }
    const hasTools = (message.tool_calls?.length ?? 0) > 0;
    const uuid = this.write({
      type: "assistant",
      message: {
        id: info.responseId || `msg_${randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        ...(info.model ? { model: info.model } : {}),
        content: blocks,
        stop_reason: hasTools ? "tool_use" : "end_turn",
        stop_sequence: null,
        ...(info.usage ? { usage: claudeUsage(info.usage) } : {}),
      },
      ...(info.responseId ? { requestId: info.responseId } : {}),
    });
    if (uuid) for (const tc of message.tool_calls ?? []) this.toolUseOwner.set(tc.id, uuid);
    return uuid;
  }

  /** A tool's result, as Claude Code records it: a user message holding one `tool_result` block. */
  appendToolResult(result: TranscriptToolResult): string | null {
    const source = this.toolUseOwner.get(result.tool_call_id);
    this.toolUseOwner.delete(result.tool_call_id);
    return this.write({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: result.tool_call_id, content: result.content, is_error: !result.ok }],
      },
      ...(this.promptId ? { promptId: this.promptId } : {}),
      ...(source ? { sourceToolAssistantUUID: source } : {}),
    });
  }

  private write(fields: Entry): string | null {
    if (!this.enabled) return null;
    try {
      if (!this.opened) this.open();
      const uuid = randomUUID();
      const entry: Entry = {
        parentUuid: this.lastUuid,
        isSidechain: false,
        userType: "external",
        entrypoint: "autopilot",
        cwd: this.cwd,
        sessionId: this.sessionId,
        ...fields,
        uuid,
        timestamp: new Date().toISOString(),
      };
      entry.message = redactDeep(capStrings(entry.message, this.maxBlockBytes));
      const line = JSON.stringify(entry) + "\n";
      const size = Buffer.byteLength(line, "utf8");
      if (this.bytes + size > this.maxSessionBytes) {
        this.enabled = false;
        logger.warn("transcript:session_cap", { session_id: this.sessionId, path: this.path, max_bytes: this.maxSessionBytes });
        return null;
      }
      appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
      this.bytes += size;
      this.lastUuid = uuid;
      return uuid;
    } catch (err) {
      this.enabled = false;
      logger.warn("transcript:write_failed", {
        session_id: this.sessionId,
        path: this.path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** First write: create the directory, and continue an existing file's uuid chain and size (resume). */
  private open(): void {
    this.opened = true;
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) return;
    this.bytes = statSync(this.path).size;
    this.lastUuid = lastUuidIn(this.path, this.bytes);
  }
}

/** The newest entry's uuid in an existing transcript (read from its last 64 KiB). */
function lastUuidIn(path: string, size: number): string | null {
  const window = Math.min(size, 64 * 1024);
  if (window === 0) return null;
  const buf = Buffer.alloc(window);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, window, size - window);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as { uuid?: unknown };
      if (typeof parsed.uuid === "string") return parsed.uuid;
    } catch {
      /* partial first line of the window, or a torn write */
    }
  }
  return null;
}

/** Transcripts by path, so a session's uuid chain carries across turns. */
const open = new Map<string, ClaudeTranscript>();

/**
 * The transcript for a session, or null when transcripts are off or there is
 * no session id. One instance per file, so consecutive turns of a session
 * chain their `parentUuid`s.
 */
export function sessionTranscript(sessionId: string | undefined, cwd: string, opts: TranscriptOptions = {}): ClaudeTranscript | null {
  if (!sessionId || !transcriptEnabled()) return null;
  const path = claudeTranscriptPath(sessionId, opts.dir);
  let t = open.get(path);
  if (!t) {
    t = new ClaudeTranscript(sessionId, cwd, opts);
    open.set(path, t);
  } else {
    t.setCwd(cwd);
  }
  return t;
}

/** Forget cached transcripts (tests). */
export function resetTranscripts(): void {
  open.clear();
}

function parseArgs(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function textOf(parts: ContentPart[] | null): string {
  return (parts ?? []).map((p) => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

/** A user message's content: a plain string, or text blocks with images as a placeholder (no base64 in the transcript). */
function userContent(content: ChatMessage["content"]): string | Entry[] | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (!content?.length) return null;
  return content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "text", text: "[Image]" }));
}

/** Cut every string over `max` bytes the way the trace's blob store cuts a blob. */
function capStrings(value: unknown, max: number): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes > max ? `${truncateUtf8(value, max)}\n[truncated: ${bytes} bytes total]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => capStrings(v, max));
  if (value && typeof value === "object") {
    const out: Entry = {};
    for (const [k, v] of Object.entries(value as Entry)) out[k] = capStrings(v, max);
    return out;
  }
  return value;
}
