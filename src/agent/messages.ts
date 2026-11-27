export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /**
   * Provider-specific data attached to the call that must be sent back with
   * it — Gemini's `{ google: { thought_signature } }`. Kept only for the
   * provider that produced it (see stripReasoningEcho).
   */
  extra_content?: Record<string, unknown>;
}

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageContentPart;

/**
 * One structured reasoning block as OpenRouter reports it
 * (`reasoning.text` / `reasoning.summary` / `reasoning.encrypted` / …).
 * Opaque to us: stored as received and echoed back unchanged.
 */
export interface ReasoningDetail {
  type: string;
  index?: number;
  id?: string | null;
  format?: string;
  text?: string | null;
  summary?: string;
  data?: string;
  signature?: string | null;
  [key: string]: unknown;
}

/**
 * Fold one streamed `reasoning_details` delta into the accumulated array.
 * Items with the same `index` are fragments of one block: text and summary
 * fragments concatenate, other fields (signature, encrypted data, id) take
 * the latest non-empty value. Items without an index are appended.
 */
export function mergeReasoningDetails(acc: ReasoningDetail[], delta: ReasoningDetail[]): ReasoningDetail[] {
  const out = acc.slice();
  for (const item of delta) {
    const idx = typeof item.index === "number" ? out.findIndex((d) => d.index === item.index) : -1;
    if (idx < 0) {
      out.push({ ...item });
      continue;
    }
    const cur = { ...out[idx]! };
    for (const [k, v] of Object.entries(item)) {
      if (v === null || v === undefined || v === "") continue;
      if ((k === "text" || k === "summary") && typeof v === "string" && typeof cur[k] === "string") {
        cur[k] = (cur[k] as string) + v;
      } else {
        cur[k] = v;
      }
    }
    out[idx] = cur;
  }
  return out;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[] | null;
  reasoning_content?: string | null;
  /** Structured reasoning to echo back to OpenRouter (Claude, GPT-5, Gemini). */
  reasoning_details?: ReasoningDetail[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** `cache_write_tokens`: prompt tokens written to the cache (OpenRouter reports it for Anthropic; the Anthropic adapter fills it). */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  /** Authoritative USD cost of this generation, reported by OpenRouter's
   *  usage accounting in the final stream chunk. Absent on custom endpoints. */
  cost?: number;
}

/** Structured finding from a standalone worker. */
export interface WorkerFinding {
  topic: string;
  summary: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
  relevance: "critical" | "high" | "medium" | "low";
}

/** Which tool profile an isolated worker runs with: `research` only reads,
 *  `build` may edit files and run commands in its sandbox. */
export type WorkerProfile = "research" | "build";

/** Result returned by a standalone research/executor worker. */
export interface WorkerResultMessage {
  workerId: string;
  status: "completed" | "failed" | "cancelled" | "budget_exhausted" | "spend_exhausted" | "timed_out";
  task: string;
  findings: WorkerFinding[];
  recommendations: string[];
  filesRead: string[];
  webSources: string[];
  costUsd: number;
  tokensUsed: number;
  reasoning: string;
  /** Execute-mode workers populate this with the URL of the opened PR. */
  prUrl?: string;
  /** Execute-mode workers populate this with the branch they pushed. */
  branchName?: string;
  /** Raw stdout from the in-sandbox autopilot run (for debugging). */
  rawOutput?: string;
  error?: string;
  /** Phase timing breakdown from the worker (for debugging cold-start). */
  phases?: Array<{ name: string; ms: number }>;
  /** True when the worker was killed because it exceeded its budget ceiling. */
  budgetExceeded?: boolean;
  /** True when the result contains partial findings produced before budget exhaustion. */
  partialResult?: boolean;
  /** Exact model selected for this worker. */
  model?: string;
  /** Local child-process exit status, when applicable. */
  exitCode?: number;
  /** Bounded local artifacts (paths/content) awaiting coordinator review. */
  artifacts?: Array<{ path: string; content: string }>;
  /** Questions the worker could not resolve, for the coordinator to follow up. */
  openQuestions?: string[];
  /** True when findings came from the worker's validated JSON report rather than raw text. */
  structured?: boolean;
  /** What code the subagent saw (local changes included, or why not). */
  snapshotNote?: string;
  /** Which worker profile produced this result. */
  profile?: WorkerProfile;
  /** Build workers: base64 `git diff --binary` of everything the worker
   *  changed, relative to the state it was handed. */
  patch?: string;
  /** Build workers: `git diff --stat` summary of `patch`. */
  patchStat?: string;
  /** Build workers: repository-relative paths `patch` touches. */
  changedFiles?: string[];
  /** Build workers: why no patch came back (no changes, too large, unreadable). */
  patchNote?: string;
}

/** Replace lone UTF-16 surrogates with the replacement character (U+FFFD).
 *  JSON.stringify preserves lone surrogates as \uD800..\uDFFF escapes, which
 *  JavaScript accepts but many strict parsers (Cloudflare AI Gateway, Python,
 *  Rust serde_json) reject. Stripping them at the boundary prevents a single
 *  bad model token from permanently poisoning the conversation history. */
export function sanitizeString(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

/** Recursively sanitize every string value in an object/array. */
export function sanitizeForJson<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeForJson) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeForJson(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** JSON.stringify replacer that sanitizes strings in-place without a deep copy. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  return value;
}

/** Deterministic JSON.stringify that sorts object keys recursively.
 *  Guarantees byte-for-byte identical output for semantically identical objects,
 *  eliminating V8 insertion-order jitter and conditional-key non-determinism. */
export function stableStringify(value: unknown, replacer?: (key: string, val: unknown) => unknown, space?: string | number): string {
  function sortKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    for (const k of keys) {
      sorted[k] = sortKeys((obj as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  const sorted = sortKeys(value);
  return JSON.stringify(sorted, replacer, space);
}

/** Remove image_url content parts from user messages older than `keepLastTurns`.
 *  Returns a new array; input is not mutated. */
export function stripOldImages(messages: ChatMessage[], keepLastTurns: number): ChatMessage[] {
  if (keepLastTurns < 0) return messages;

  // Count user messages from the end to find the cutoff index.
  let userCount = 0;
  let cutoffIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      userCount++;
      if (userCount === keepLastTurns) {
        cutoffIndex = i;
        break;
      }
    }
  }

  return messages.map((m, idx) => {
    if (m.role !== "user" || idx >= cutoffIndex) return m;
    if (!Array.isArray(m.content)) return m;

    const stripped = m.content.filter((p): p is ContentPart => p.type !== "image_url");
    if (stripped.length === m.content.length) return m;

    return {
      ...m,
      content: stripped.length > 0 ? stripped : "[image omitted]",
    };
  });
}

/** Placeholder result for a tool call the user interrupted before it finished. */
export const STOPPED_TOOL_RESULT = "(stopped)";

/**
 * Append a `(stopped)` tool result for each of `calls` that has no result in
 * `messages` yet. Idempotent: the interrupt handler and the abort handler can
 * both call it. Returns the number of results appended.
 */
export function appendStoppedToolResults(messages: ChatMessage[], calls: Iterable<[id: string, name: string]>): number {
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  let added = 0;
  for (const [id, name] of calls) {
    if (answered.has(id)) continue;
    messages.push({ role: "tool", tool_call_id: id, content: STOPPED_TOOL_RESULT, name });
    answered.add(id);
    added++;
  }
  return added;
}

/**
 * Put one tool result into history, keeping exactly one result per call.
 *
 * An interrupt answers in-flight calls with `(stopped)` straight away so the
 * saved history stays valid. The tool itself may still finish a moment later
 * (it ignored the abort, or was already done) and come back here. Policy: the
 * real result **replaces** the placeholder in place, because it is what
 * actually happened (a write that completed did change the file) and the
 * model should not be told otherwise. A second real result for a call that
 * already has one is ignored. Results are looked up only after the newest
 * assistant message that made the call, so providers that reuse ids across
 * turns ("call_0") don't collide.
 */
export function recordToolResult(messages: ChatMessage[], result: ChatMessage): "appended" | "replaced" | "ignored" {
  const id = result.tool_call_id;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "tool" && m.tool_call_id === id) {
      if (m.content !== STOPPED_TOOL_RESULT) return "ignored";
      messages[i] = result;
      return "replaced";
    }
    if (m.role === "assistant" && m.tool_calls?.some((tc) => tc.id === id)) break;
  }
  messages.push(result);
  return "appended";
}

/**
 * Make a message history valid for the API: each assistant `tool_calls`
 * entry gets exactly one tool result, placed right after that assistant
 * message (in call order) and before anything else.
 *
 * - a missing result (a turn interrupted mid tool call) becomes `(stopped)`;
 * - duplicate results for one call collapse to one: a real result wins over
 *   the `(stopped)` placeholder (see recordToolResult), otherwise the first;
 * - results that ended up later in history (after a user message) move back;
 * - results with no matching earlier call (orphans) are dropped.
 *
 * A result belongs to the newest assistant message before it that made the
 * call, so ids reused across turns stay separate. Runs before every model
 * request and on session load. Mutates in place; returns the number of
 * changes (0 means the history was already valid and is untouched).
 */
export function normalizeToolResults(messages: ChatMessage[]): number {
  const isPlaceholder = (m: ChatMessage) => m.content === STOPPED_TOOL_RESULT;
  const ownerOf = new Map<string, number>(); // call id -> newest assistant index so far
  const chosen = new Map<string, ChatMessage>(); // `${owner}:${id}` -> result
  let dropped = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) ownerOf.set(tc.id, i);
    } else if (m.role === "tool") {
      const owner = m.tool_call_id === undefined ? undefined : ownerOf.get(m.tool_call_id);
      if (owner === undefined) {
        dropped++;
        continue;
      }
      const key = `${owner}:${m.tool_call_id}`;
      const prev = chosen.get(key);
      if (!prev) chosen.set(key, m);
      else {
        dropped++;
        if (isPlaceholder(prev) && !isPlaceholder(m)) chosen.set(key, m);
      }
    }
  }
  const out: ChatMessage[] = [];
  let inserted = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") continue;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const seen = new Set<string>();
    for (const tc of m.tool_calls) {
      if (seen.has(tc.id)) continue;
      seen.add(tc.id);
      const r = chosen.get(`${i}:${tc.id}`);
      if (r) out.push(r);
      else {
        out.push({ role: "tool", tool_call_id: tc.id, content: STOPPED_TOOL_RESULT, name: tc.function.name });
        inserted++;
      }
    }
  }
  const same = out.length === messages.length && out.every((m, k) => m === messages[k]);
  if (same) return 0;
  messages.splice(0, messages.length, ...out);
  return Math.max(1, inserted + dropped);
}

/**
 * Repair a loaded or about-to-be-sent history. Kept as the historical name;
 * see normalizeToolResults.
 */
export function repairDanglingToolCalls(messages: ChatMessage[]): number {
  return normalizeToolResults(messages);
}
