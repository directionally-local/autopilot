import type { ChatMessage, ToolCall } from "./messages.js";
import {
  type SessionState,
  type Artifact,
  type ArtifactType,
  emptySessionState,
  buildSessionStateMessage,
  ArtifactStore,
} from "./session-state.js";
import type { CompactionMetrics } from "../cost-debug.js";

export interface CompactionOpts {
  messages: ChatMessage[];
  state: SessionState;
  store: ArtifactStore;
  /** Number of recent raw turns to preserve in working memory. */
  keepLastTurns?: number;
  /** Estimated token threshold to trigger compaction. */
  tokenThreshold?: number;
  /** Raw turn count threshold to trigger compaction. */
  turnThreshold?: number;
}

export interface CompactionResult {
  newMessages: ChatMessage[];
  newState: SessionState;
  metrics: CompactionMetrics;
}

export interface Turn {
  user: ChatMessage;
  assistants: ChatMessage[];
  tools: ChatMessage[];
  /** Preserve every message in the turn, including interstitial system messages. */
  messages: ChatMessage[];
}

// Approximate tokens from a character count. Char-per-token of 4 is the
// usual back-of-envelope figure for English prose, but coding-agent
// content (source code, JSON tool results, file paths) tokenizes denser
// than that — typically 3 to 3.5 chars/token. We use 3.5 so budget and
// compaction decisions bias toward over-estimating, which is the safer
// direction when the alternative is a hard API context-overflow error.
export function approxTokens(n: number): number {
  return Math.round(n / 3.5);
}

export function estimateMessageTokens(m: ChatMessage): number {
  let chars = 0;
  if (typeof m.content === "string") {
    chars = m.content.length;
  } else if (Array.isArray(m.content)) {
    chars = m.content.map((p) => (p.type === "text" ? p.text.length : 0)).reduce((a, b) => a + b, 0);
  }
  if (m.reasoning_content) chars += m.reasoning_content.length;
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      chars += tc.function.name.length + tc.function.arguments.length;
    }
  }
  return approxTokens(chars);
}

export function estimatePromptTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/** Group each user message with all following messages up to the next user.
 *  Turns can contain interstitial system context and multiple assistant/tool
 *  cycles, so grouping by a fixed user → assistant → tool pattern loses data. */
export function groupIntoTurns(messages: ChatMessage[]): { prefix: ChatMessage[]; turns: Turn[] } {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) return { prefix: messages, turns: [] };

  const prefix = messages.slice(0, firstUserIndex);
  const turns: Turn[] = [];
  let start = firstUserIndex;

  while (start < messages.length) {
    const user = messages[start]!;
    let end = start + 1;
    while (end < messages.length && messages[end]!.role !== "user") end++;
    const turnMessages = messages.slice(start, end);
    turns.push({
      user,
      assistants: turnMessages.filter((message) => message.role === "assistant"),
      tools: turnMessages.filter((message) => message.role === "tool"),
      messages: turnMessages,
    });
    start = end;
  }

  return { prefix, turns };
}

function makeArtifactId(type: ArtifactType, index: number): string {
  return `${type}_${Date.now()}_${index}`;
}

/** Extract artifacts from a turn's tool messages and assistant message. */
function extractArtifactsFromTurn(turn: Turn, startIndex: number, store: ArtifactStore): { artifacts: Artifact[]; stateDelta: Partial<SessionState> } {
  const artifacts: Artifact[] = [];
  const stateDelta: Partial<SessionState> = {
    files_touched: [],
    files_modified: [],
    confirmed_findings: [],
    recent_failures: [],
    decisions: [],
    next_actions: [],
  };

  // Match tool results against calls across every assistant cycle in the turn.
  const toolCallsById = new Map<string, ToolCall>(
    turn.assistants.flatMap((assistant) => assistant.tool_calls ?? []).map((call) => [call.id, call]),
  );

  for (let ti = 0; ti < turn.tools.length; ti++) {
    const tm = turn.tools[ti]!;
    const tc = tm.tool_call_id ? toolCallsById.get(tm.tool_call_id) : undefined;
    const name = tm.name ?? tc?.function.name ?? "unknown";
    const content = typeof tm.content === "string" ? tm.content : "";

    let type: ArtifactType = "tool_result";
    let summary = `${name} result`;
    let path: string | undefined;

    // Determine artifact type and summary based on tool name
    if (name === "read") {
      type = "read_slice";
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        path = args.path;
        summary = `read ${path ?? "file"}`;
        if (path && !stateDelta.files_touched!.includes(path)) stateDelta.files_touched!.push(path);
      } catch {
        summary = "read file";
      }
    } else if (name === "bash") {
      type = "bash_log";
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        const cmd = args.command ?? "";
        summary = `bash: ${cmd.slice(0, 60)}`;
        if (content.includes("Error") || content.includes("error") || content.includes("FAIL")) {
          stateDelta.recent_failures!.push(`bash failed: ${cmd.slice(0, 80)}`);
        }
      } catch {
        summary = "bash command";
      }
    } else if (name === "grep") {
      type = "grep_result";
      summary = `grep results (${content.split("\n").length} lines)`;
    } else if (name === "web_fetch") {
      type = "web_fetch";
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        summary = `web_fetch: ${args.url ?? "url"}`;
      } catch {
        summary = "web_fetch";
      }
    } else if (name === "write" || name === "edit") {
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        path = args.path;
        if (path && !stateDelta.files_modified!.includes(path)) stateDelta.files_modified!.push(path);
        if (path && !stateDelta.files_touched!.includes(path)) stateDelta.files_touched!.push(path);
      } catch {
        /* ignore */
      }
      // Don't archive write/edit tool results — they're usually just confirmations
      continue;
    } else if (name === "glob") {
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        summary = `glob: ${args.pattern ?? ""}`;
      } catch {
        summary = "glob";
      }
    } else if (name === "tasks_set") {
      try {
        const args = tc ? JSON.parse(tc.function.arguments) : {};
        const tasks = args.tasks ?? [];
        const inProgress = tasks.filter((t: { status?: string }) => t.status === "in_progress").map((t: { title?: string }) => t.title);
        const pending = tasks.filter((t: { status?: string }) => t.status === "pending").map((t: { title?: string }) => t.title);
        if (inProgress.length) stateDelta.next_actions!.push(...inProgress);
        if (pending.length) stateDelta.next_actions!.push(...pending);
        summary = `tasks_set: ${tasks.length} tasks`;
      } catch {
        summary = "tasks_set";
      }
    }

    // Truncate very large tool outputs for artifact storage
    const maxRaw = 50_000;
    const raw = content.length > maxRaw ? content.slice(0, maxRaw) + `\n...[${content.length - maxRaw} chars truncated]` : content;

    const artifact: Artifact = {
      id: makeArtifactId(type, startIndex + ti),
      type,
      summary,
      raw,
      source: name,
      path,
      ts: new Date().toISOString(),
    };
    artifacts.push(artifact);

    // Extract findings from successful tool outputs
    if (!content.includes("Error") && !content.includes("error") && content.length > 0 && content.length < 2000) {
      stateDelta.confirmed_findings!.push(`${name}: ${content.slice(0, 200)}`);
    }
  }

  // Extract decisions from all assistant messages in the turn.
  const assistantText = turn.assistants
    .map((assistant) => (typeof assistant.content === "string" ? assistant.content : ""))
    .filter(Boolean)
    .join("\n");
  if (assistantText.length > 0) {
    // Look for decision-like sentences
    const decisionPatterns = [
      /(?:decided?|will|plan to|going to|should|need to)\s+(.{10,200})/gi,
      /(?:let's|let us)\s+(.{10,200})/gi,
    ];
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(assistantText)) !== null) {
        const decision = match[1]!.trim().replace(/\.$/, "");
        if (decision.length > 10 && !stateDelta.decisions!.includes(decision)) {
          stateDelta.decisions!.push(decision);
        }
      }
    }
  }

  return { artifacts, stateDelta };
}

/** Merge stateDelta into existing SessionState, deduplicating arrays. */
function mergeState(state: SessionState, delta: Partial<SessionState>): SessionState {
  const mergeArr = (a: string[], b: string[] | undefined) => {
    if (!b) return a;
    const set = new Set(a);
    for (const item of b) set.add(item);
    return [...set];
  };

  return {
    ...state,
    task: state.task || delta.task || "",
    user_constraints: mergeArr(state.user_constraints, delta.user_constraints),
    repo_facts: mergeArr(state.repo_facts, delta.repo_facts),
    files_touched: mergeArr(state.files_touched, delta.files_touched),
    files_modified: mergeArr(state.files_modified, delta.files_modified),
    confirmed_findings: mergeArr(state.confirmed_findings, delta.confirmed_findings),
    open_questions: mergeArr(state.open_questions, delta.open_questions),
    recent_failures: mergeArr(state.recent_failures, delta.recent_failures),
    decisions: mergeArr(state.decisions, delta.decisions),
    next_actions: mergeArr(state.next_actions, delta.next_actions),
    artifact_index: { ...state.artifact_index, ...delta.artifact_index },
  };
}

/** Check if compaction should trigger based on thresholds.
 *
 *  Budget-relative hosts pass `tokenThreshold` from
 *  {@link softCompactionThreshold}. The turn-count trigger is opt-in: a fixed
 *  turn count fires long before any pressure on large-context models. */
export function shouldCompact(opts: {
  messages: ChatMessage[];
  tokenThreshold?: number;
  /** Opt-in turn-count trigger. Omit to rely on the token budget alone. */
  turnThreshold?: number;
}): boolean {
  const tokens = estimatePromptTokens(opts.messages);
  if (opts.tokenThreshold !== undefined && tokens > opts.tokenThreshold) return true;
  if (opts.turnThreshold !== undefined) {
    const { turns } = groupIntoTurns(opts.messages);
    if (turns.length > opts.turnThreshold) return true;
  }
  return false;
}

function isCompiledStateMessage(m: ChatMessage): boolean {
  return m.role === "system" && typeof m.content === "string" && m.content.startsWith("[compiled session state]");
}

/** Run compaction: collapse older turns into SessionState, keep recent raw turns. */
/**
 * Use when you want to extract structured artifacts and state deltas from turns instead of raw text.
 */
export function compactMessagesViaArtifacts(opts: CompactionOpts): CompactionResult {
  const keepLastTurns = opts.keepLastTurns ?? 4;
  const grouped = groupIntoTurns(opts.messages);
  const turns = grouped.turns;
  // A previous compaction's state message sits in the prefix; the new state
  // already merges it (opts.state), so drop it instead of stacking copies.
  const prefix = grouped.prefix.filter((m) => !isCompiledStateMessage(m));

  const tokensBefore = estimatePromptTokens(opts.messages);

  if (turns.length <= keepLastTurns) {
    return {
      newMessages: opts.messages,
      newState: opts.state,
      metrics: {
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
        archivedArtifacts: 0,
        recalledArtifacts: 0,
        rawTurnsRemoved: 0,
        rawTurnsKept: turns.length,
      },
    };
  }

  const toCompact = turns.slice(0, turns.length - keepLastTurns);
  const toKeep = turns.slice(turns.length - keepLastTurns);

  let newState = { ...opts.state };
  let archivedCount = 0;

  for (let i = 0; i < toCompact.length; i++) {
    const turn = toCompact[i]!;
    const { artifacts, stateDelta } = extractArtifactsFromTurn(turn, i, opts.store);

    for (const artifact of artifacts) {
      opts.store.add(artifact);
      archivedCount++;
      newState.artifact_index[artifact.id] = {
        type: artifact.type,
        summary: artifact.summary,
        source: artifact.source,
        path: artifact.path,
      };
    }

    newState = mergeState(newState, stateDelta);

    // Update task from first user message if not set
    if (!newState.task && typeof turn.user.content === "string") {
      newState.task = turn.user.content.slice(0, 200);
    }
  }

  // Build new message array
  const workingMemory: ChatMessage[] = [];
  for (const turn of toKeep) {
    workingMemory.push(...turn.messages);
  }

  const stateMsg = buildSessionStateMessage(newState);
  const newMessages: ChatMessage[] = [...prefix, stateMsg, ...workingMemory];
  const tokensAfter = estimatePromptTokens(newMessages);

  const metrics: CompactionMetrics = {
    estimatedTokensBefore: tokensBefore,
    estimatedTokensAfter: tokensAfter,
    archivedArtifacts: archivedCount,
    recalledArtifacts: 0,
    rawTurnsRemoved: toCompact.length,
    rawTurnsKept: toKeep.length,
  };

  return { newMessages, newState, metrics };
}

/** Heuristic recall: if messages reference files or artifacts in the index, return matching artifacts. */
export function recallArtifacts(
  messages: ChatMessage[],
  store: ArtifactStore,
  state: SessionState,
): { ids: string[]; recalled: { id: string; artifact: Artifact }[] } {
  const text = messages
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");

  const ids: string[] = [];

  // Recall by file path reference
  for (const [id, meta] of Object.entries(state.artifact_index)) {
    if (meta.path && text.includes(meta.path)) {
      ids.push(id);
    }
  }

  // Recall by failure reference (if current text mentions a prior failure).
  // Require the artifact summary itself to mention the keyword — otherwise
  // a single matching keyword would pull every bash artifact in the index.
  for (const failure of state.recent_failures) {
    const keyword = failure.split(":")[0];
    if (!keyword) continue;
    const lowerKeyword = keyword.toLowerCase();
    if (!text.toLowerCase().includes(lowerKeyword)) continue;
    for (const [id, meta] of Object.entries(state.artifact_index)) {
      if (
        meta.source === "bash" &&
        !ids.includes(id) &&
        meta.summary.toLowerCase().includes(lowerKeyword)
      ) {
        ids.push(id);
      }
    }
  }

  // Deduplicate and limit
  const uniqueIds = [...new Set(ids)].slice(0, 5);
  const recalled = store.recall(uniqueIds);
  return { ids: uniqueIds, recalled };
}
