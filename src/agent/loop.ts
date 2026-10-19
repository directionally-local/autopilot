import { runKimi } from "./client.js";
import type { ResponseMeta } from "./client.js";
import type { LlmAuth } from "./llm-auth.js";
import { toOpenAIToolDefs, type ToolSpec } from "../tools/registry.js";
import type { ToolExecutor, PermissionAsker, ToolResult } from "../tools/executor.js";
import { mergeReasoningDetails, sanitizeString, stableStringify, stripOldImages } from "./messages.js";
import type { ChatMessage, ReasoningDetail, ToolCall, Usage } from "./messages.js";
import type { Task, PlanOption, RunWaitRequest } from "../tools/registry.js";
import type { MemoryManager } from "../memory/manager.js";
import type { HybridResult } from "../memory/schema.js";
import { hasRecalledMemory, injectRecalledMemoryOnce } from "../memory/recall-inject.js";
import { logTurnDebug, analyzePrompt } from "../cost-debug.js";
import { EXTRACTORS } from "../memory/extractors.js";
import { stripHistoricalReasoning } from "./strip-reasoning.js";
import { generateTypeScriptApi, runInSandbox } from "../code-mode/index.js";
import { estimatePromptTokens } from "./artifact-compaction.js";
import { logger } from "../util/logger.js";
import { selectSkills } from "../skills/router.js";
import type { SemanticSkillRoutingResult } from "../skills/types.js";
import type Database from "better-sqlite3";
import { buildSystemPrompt, buildSessionPrefix } from "./system-prompt.js";
import { getModelOrInfer } from "../models/registry.js";
import { createPermissionGate } from "./permission-gate.js";
import { compactToFit, ContextBudgetError, effectiveInputBudget, type CompactionTarget } from "./context-budget.js";
import { withTurnDirective } from "./turn-directive.js";
import { CONTINUE_NUDGE, INCOMPLETE_THRESHOLD, shouldCheckCompletion, toolsUsedSince, type CompletionCheck } from "./completion-check.js";
import type { Mode } from "../mode.js";
import { createNoopRecorder, makeTurnId } from "../trace/recorder.js";
import { beginGitDelta } from "../trace/git-delta.js";
import type { TraceRecorder } from "../trace/recorder.js";
import type { TurnEndReason } from "../trace/types.js";

export interface AgentCallbacks {
  onAssistantStart?: () => void;
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onInfo?: (text: string) => void;
  onToolCallStart?: (index: number, id: string, name: string) => void;
  onToolCallArgs?: (index: number, delta: string) => void;
  onToolCallFinalized?: (call: ToolCall) => void;
  /** Called right before a tool call is handed to the executor for actual execution.
   *  Fires after onToolCallFinalized, one at a time, as tools are dequeued. */
  onToolWillExecute?: (toolCallId: string, name: string) => void;
  onUsage?: (usage: Usage) => void;
  onUsageFinal?: (usage: Usage, responseMeta?: ResponseMeta) => void;
  onResponseMeta?: (meta: ResponseMeta) => void;
  onAssistantFinal?: (msg: ChatMessage) => void;
  onToolResult?: (result: ToolResult) => void;
  onTasks?: (tasks: Task[]) => void;
  onPlanOptions?: (options: PlanOption[]) => void;
  /** Called once per session when the sandbox falls back to node:vm. */
  onWarning?: (message: string) => void;
  /** Called when a tool's content was truncated before being shown to the model.
   *  `artifactId`, when present, points at the full raw bytes in the artifact store. */
  onTruncation?: (info: { tool: string; toolCallId: string; rawBytes: number; reducedBytes: number; artifactId?: string }) => void;
  askPermission: PermissionAsker;
  /** Notification (never awaited) when a loop or iteration-cap guardrail
   *  acts on its own — the loop never blocks waiting for a user decision. */
  onGuardrail?: (event: GuardrailEvent) => void;
  /** Called when accumulated high-signal memories suggest KIMI.md may be stale. */
  onKimiMdStale?: () => void;
  /** Called when session-start memory recall succeeds and memories are injected. */
  onMemoryRecalled?: (count: number) => void;
  /** Called when semantic skill routing completes. */
  onSkillsSelected?: (result: SemanticSkillRoutingResult) => void;
  /** Called after pre-turn setup (memory + skills) to emit the meta banner. */
  onMetaBanner?: (info: { intentTier: string; skillsActive: number; memoryRecalled: boolean }) => void;
  /** Called when an unattended run yields on a durable timer or job condition. */
  onRunYield?: (request: RunWaitRequest) => void;
  /** Called when a durable run budget is exhausted at a tool boundary. */
  onRunBudgetExceeded?: (reason: string) => void;
  /** Called after preflight compaction archived older turns to fit the model budget. */
  onCompacted?: (info: { tokensBefore: number; tokensAfter: number; turnsRemoved: number; artifactsArchived: number; budgetTokens: number }) => void;
}

/** Credentials come in as `LlmAuth` fields — spread `llmAuthFromConfig(cfg)`. */
export interface AgentTurnOpts extends LlmAuth {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  executor: ToolExecutor;
  cwd: string;
  signal: AbortSignal;
  callbacks: AgentCallbacks;
  maxToolIterations?: number;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  coauthor?: { name: string; email: string };
  sessionId?: string;
  /** Durable unattended-run identity; enables tool boundary journaling. */
  runId?: string;
  /** Optional override for the durable run/event/timer database. */
  runsDbPath?: string;
  githubToken?: string;
  /** Drop image_url parts from user messages older than this many turns. */
  keepLastImageTurns?: number;
  memoryManager?: MemoryManager | null;
  /** Enable Code Mode: present tools as a TypeScript API and execute generated code in a sandbox. */
  codeMode?: boolean;
  /** Called after write/edit tools succeed so LSP document sync can fire. */
  onFileChange?: (path: string, content: string) => void;
  /** What happens when `maxToolIterations` is reached. "continue" resets the
   *  counter automatically (bounded by `maxTotalToolIterations`), "stop" ends
   *  the turn cleanly, "throw" raises an error. Defaults to "continue" when
   *  `continueOnLimit` is set, otherwise "throw". */
  toolLimitBehavior?: ToolLimitBehavior;
  /** Legacy alias for `toolLimitBehavior: "continue"`. */
  continueOnLimit?: boolean;
  /** Hard ceiling on tool iterations across automatic counter resets, so a
   *  runaway turn stays bounded. When reached, the model is asked for a final
   *  tool-free summary and the turn ends. Default: 5 × `maxToolIterations`. */
  maxTotalToolIterations?: number;
  /** Cumulative prompt token budget. When exceeded, a final synthesis turn is run and then BudgetExhaustedError is thrown. */
  maxInputTokens?: number;
  /** Intent classification result for this turn, for telemetry. */
  intentClassification?: { intent: string; tier: "light" | "medium" | "heavy"; rawScore: number; confidence: number };
  /** Per-turn harness recommendation about subagent dispatch. May be a
   *  promise (auto mode's Jev refinement), awaited alongside pre-turn work. */
  delegationDirective?: string | Promise<string | undefined>;
  /** End-of-turn "did the agent finish?" check (see completion-check.ts).
   *  When it reports a clearly unfinished turn, the agent is told to
   *  continue, at most once per turn. */
  completionCheck?: CompletionCheck;
  /** Skills injected into the system prompt for this turn. */
  selectedSkills?: { name: string; body: string }[];
  /**
   * M6.1: lifecycle hooks for events the loop owns (`Stop` at clean
   * turn end). PreToolUse / PostToolUse hooks live on the
   * `ToolExecutor` itself, so they fire for every executor caller
   * (standard loop, code-mode sandbox, init, SDK, print mode)
   * automatically — no need to thread `hooks` through to those.
   */
  hooks?: import("../hooks/manager.js").HooksManager;
  /** Where request preflight archives older turns when the next request
   *  would not fit the model's input budget. Without it, an oversized prompt
   *  fails with ContextBudgetError. */
  compaction?: CompactionTarget;
  /** Called after each tool-iteration cycle to allow external compaction or state management.
   *  Return the (possibly mutated) messages array; the caller's array is
   *  updated in place, so hosts holding a reference to it stay in sync. */
  onIterationEnd?: (messages: ChatMessage[], signal: AbortSignal) => Promise<ChatMessage[]>;
  /** Pull user input that arrived mid-turn (e.g. steering). Called at every
   *  tool boundary and again when the model answers without tool calls;
   *  returned messages are appended to history. If any arrive at that final
   *  point the turn continues, so the model responds to them before the turn
   *  ends instead of the input leaking into the next turn. */
  drainPendingInput?: () => ChatMessage[];
  /** Shell override for the bash tool. If omitted, the tool auto-detects based on platform. */
  shell?: string;
  /** When false (default), the bash tool blocks `git push` to the default branch. */
  allowDirectPush?: boolean;
  /** When true (default), the system prompt instructs the model to prefer PRs over direct pushes. */
  preferPullRequests?: boolean;
  /** Session-start memory recall promise. If provided, awaited at turn start and injected into messages. */
  sessionStartRecall?: Promise<HybridResult[]>;
  /** Skills DB for semantic skill routing. */
  skillsDb?: Database.Database;
  /** Config for skill routing. */
  skillRoutingConfig?: {
    embeddingModel?: string;
    maxSkillTokens?: number;
  };
  /** Current mode for system prompt. */
  mode?: Mode;
  /** Whether to use cache-stable prompt assembly (dual system messages). */
  cacheStable?: boolean;
  /** Abort the API stream if no data arrives for this many milliseconds. Default 60000.
   *  A cold upstream provider after tool use can exceed the default — bump this for
   *  long-running embeddings / image-heavy turns. */
  idleTimeoutMs?: number;
  /** Once the first byte arrives, tighten the idle timeout to this value.
   *  Default 30000 — a live stream stalling mid-flight should surface fast. */
  postFirstByteIdleTimeoutMs?: number;
  /** Session trace recorder (src/trace). Every emit point in the turn goes
   *  through it; absent or disabled means no-op and zero behaviour change. */
  trace?: TraceRecorder;
  /** Turn id for trace events. Minted here when the host does not supply one. */
  turnId?: string;
}

export type ToolLimitBehavior = "continue" | "stop" | "throw";

export type GuardrailEvent =
  /** Every tool call in an iteration was blocked; the model was told to change approach. */
  | { kind: "loop_recovery"; message: string }
  /** The model kept hitting the loop guardrail after recovery; the turn ends with a summary. */
  | { kind: "loop_stopped"; message: string }
  /** `maxToolIterations` was reached and the counter was reset automatically. */
  | { kind: "limit_reset"; message: string; totalIterations: number }
  /** `maxToolIterations` was reached with `toolLimitBehavior: "stop"`. */
  | { kind: "limit_stopped"; message: string; totalIterations: number }
  /** `maxTotalToolIterations` was reached; the turn ends with a summary. */
  | { kind: "limit_ceiling"; message: string; totalIterations: number }
  /** The turn was about to end unfinished; the agent was told to continue. */
  | { kind: "completion_nudge"; message: string; probability: number };

/** Automatic loop recoveries granted per turn before the turn is wrapped up. */
export const MAX_LOOP_RECOVERIES = 1;

export class BudgetExhaustedError extends Error {
  constructor(message = "Cumulative input token budget exhausted") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export class AgentLoopError extends Error {
  constructor(message = "Agent got stuck repeating the same tool calls and was stopped after a recovery attempt") {
    super(message);
    this.name = "AgentLoopError";
  }
}

const codeModeApiCache = new Map<string, string>();

/** Per-session sliding window of turn indices where a high-signal memory landed.
 *  We fire `onKimiMdStale` when >=DRIFT_THRESHOLD events fall inside
 *  DRIFT_WINDOW recent turns. Replaces the older count-with-decay scheme
 *  which almost never fired on long sessions (RF-2 / OP-8). */
const driftEvents = new Map<string, number[]>();
const DRIFT_WINDOW = 10;
const DRIFT_THRESHOLD = 3;

export function _resetDriftEventsForTests(): void {
  driftEvents.clear();
}

/** Per-session count of fire-and-forget memory-extraction errors. Exposed via
 *  `getMemoryExtractionErrorCount` for a future `/memory health` surface. */
const memoryExtractionErrorCounts = new Map<string, number>();

export function getMemoryExtractionErrorCount(sessionId: string | undefined): number {
  return memoryExtractionErrorCounts.get(sessionId ?? "default") ?? 0;
}

export function _resetMemoryExtractionErrorCountsForTests(): void {
  memoryExtractionErrorCounts.clear();
}

/** Per-session web-fetch history. Lifted from per-turn so a research spiral
 *  split across multiple turns still trips the guardrail. */
const sessionWebFetchHistory = new Map<string, string[]>();
/** Hard soft-cap of total web fetches per session before we nudge for synthesis. */
const SESSION_WEB_FETCH_CAP = 25;

function getSessionWebFetchHistory(sessionId: string | undefined): string[] {
  const key = sessionId ?? "default";
  let arr = sessionWebFetchHistory.get(key);
  if (!arr) {
    arr = [];
    sessionWebFetchHistory.set(key, arr);
  }
  return arr;
}

/** Test/embed hook: clears session web-fetch state. Not exported in the public API. */
export function _resetSessionWebFetchHistoryForTests(): void {
  sessionWebFetchHistory.clear();
}

function isHighSignalMemory(memory: {
  topicKey: string;
  category: string;
  importance: number;
}): boolean {
  return (
    memory.topicKey === "project_dependencies" ||
    memory.topicKey === "project_tsconfig" ||
    memory.topicKey === "project_entry_point" ||
    memory.category === "instruction" ||
    memory.category === "preference" ||
    (memory.category === "event" && memory.importance >= 3)
  );
}

/** Max characters for a single tool result message before truncation.
 *  ~10k chars ≈ 2,500 tokens — generous but prevents runaway growth. */
const MAX_TOOL_CONTENT_CHARS = 10_000;

/** When Code Mode is on, these context-heavy IO tools must be called via
 *  api.<tool>() inside execute_code (so only console.log output returns to
 *  context) rather than as direct tools (whose full output floods the prompt).
 *  web_fetch is intentionally excluded so its session anti-abuse budget still
 *  applies on the direct path. */
const CODE_MODE_REDIRECT_TOOLS = new Set(["read", "bash", "grep", "glob"]);

/** Per-turn cap on redirect nudges. After this many, direct calls execute
 *  normally — a safety valve so a stubborn model or an unrunnable sandbox
 *  degrades to plain tool calling instead of looping or bricking. */
const MAX_CODE_MODE_REDIRECTS = 4;

function codeModeRedirectMessage(tool: string): string {
  return (
    `Code Mode is on: \`${tool}\` is not available as a direct tool because its full output would flood your context. ` +
    `Call \`api.${tool}({ ... })\` INSIDE an \`execute_code\` block instead — only what you \`console.log\` is returned to you. ` +
    `You can batch several reads/greps/commands in a single execute_code call.`
  );
}

function extractLastUserText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
      } else {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    }),
  ]);
}

/** Per-turn trace bookkeeping shared by the loop body and the `turn_end` emit. */
interface TurnTrace {
  trace: TraceRecorder;
  turnId: string;
  startedAt: number;
  /** Tool names the model issued, in order (including blocked calls). */
  toolsUsed: string[];
  /** Assistant text of the in-flight response (for `turn_end{aborted}`). */
  partialText: string;
  /** Text of the last assistant message appended to history. */
  finalText: string | null;
  costUsd: number;
  /** Set by the loop body when the turn ends for a reason other than a plain completion. */
  endReason: TurnEndReason | null;
}

export async function runAgentTurn(opts: AgentTurnOpts): Promise<void> {
  const tr: TurnTrace = {
    trace: opts.trace ?? createNoopRecorder(opts.sessionId ?? ""),
    turnId: opts.turnId ?? makeTurnId(),
    startedAt: performance.now(),
    toolsUsed: [],
    partialText: "",
    finalText: null,
    costUsd: 0,
    endReason: null,
  };
  const endTurn = (reason: TurnEndReason, finalText: string | null): void => {
    if (!tr.trace.enabled) return;
    const finalBlob = finalText ? tr.trace.blob(finalText) : null;
    tr.trace.emit(
      "turn_end",
      {
        reason,
        tools_used: tr.toolsUsed,
        ...(tr.costUsd > 0 ? { cost_usd: tr.costUsd } : {}),
        duration_ms: Math.round(performance.now() - tr.startedAt),
        ...(finalBlob ? { final_text_blob: finalBlob } : {}),
      },
      tr.turnId,
    );
  };
  // Workspace delta for `outcome{git_delta}`: snapshot before, measure after.
  // No git subprocesses unless tracing is enabled.
  const gitDelta = await beginGitDelta({ trace: tr.trace, turnId: tr.turnId, sessionId: opts.sessionId, cwd: opts.cwd }).catch(
    () => null,
  );
  try {
    await runAgentTurnInner(opts, tr);
    endTurn(tr.endReason ?? "complete", tr.finalText);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      endTurn("aborted", tr.partialText || tr.finalText);
    } else if (err instanceof AgentLoopError || err instanceof BudgetExhaustedError) {
      endTurn("guardrail", tr.finalText);
    } else {
      endTurn("error", tr.partialText || tr.finalText);
    }
    throw err;
  } finally {
    await gitDelta?.finish().catch(() => undefined);
  }
}

async function runAgentTurnInner(opts: AgentTurnOpts, tr: TurnTrace): Promise<void> {
  const turnStart = tr.startedAt;
  const { trace, turnId } = tr;
  const notifyGuardrail = (ev: GuardrailEvent): void => {
    // completion_nudge is recorded as its own `completion_check` event.
    if (ev.kind !== "completion_nudge") trace.emit("guardrail", { kind: ev.kind, message: ev.message }, turnId);
    opts.callbacks.onGuardrail?.(ev);
  };
  /** Trace a tool call the loop answered itself (guardrail, redirect, unavailable). */
  const traceBlocked = (tc: ToolCall, result: ToolResult, errorCode: string, redirected = false): void => {
    if (!trace.enabled) return;
    const argsBlob = trace.blob(tc.function.arguments) ?? "";
    trace.emit(
      "tool_call",
      {
        tool_call_id: tc.id,
        name: tc.function.name,
        args_blob: argsBlob,
        ...(tc.function.arguments.length <= 2048 ? { args_inline: parseArgsObject(tc.function.arguments) } : {}),
        needs_permission: false,
        code_mode_redirected: redirected,
      },
      turnId,
    );
    const blob = trace.blob(result.content) ?? "";
    const bytes = Buffer.byteLength(result.content, "utf8");
    trace.emit(
      "tool_result",
      {
        tool_call_id: tc.id,
        name: tc.function.name,
        ok: false,
        error_code: errorCode,
        raw_blob: blob,
        raw_bytes: bytes,
        reduced_blob: blob,
        reduced_bytes: bytes,
        duration_ms: 0,
      },
      turnId,
    );
  };
  logger.info("turn:start", { sessionId: opts.sessionId, codeMode: opts.codeMode ?? false });
  const max = opts.maxToolIterations ?? 200;
  const limitBehavior: ToolLimitBehavior =
    opts.toolLimitBehavior ?? (opts.continueOnLimit ? "continue" : "throw");
  const requestedCeiling = opts.maxTotalToolIterations;
  const hardCeiling = Math.max(
    max,
    requestedCeiling !== undefined && Number.isFinite(requestedCeiling) && requestedCeiling > 0
      ? Math.floor(requestedCeiling)
      : max * 5,
  );
  const codeMode = opts.codeMode ?? false;

  // M6.1: fire the Stop hook when the agent finishes its turn (normally,
  // stopped at the iteration limit, or after a guardrail's final summary).
  // Skipped on abort and on error paths that never produced an answer.
  const fireStopHook = async (): Promise<void> => {
    if (opts.signal.aborted) return;
    if (!opts.hooks?.hasEnabledHooks("Stop")) return;
    try {
      await opts.hooks.fire(
        "Stop",
        { event: "Stop", session_id: opts.sessionId ?? null, cwd: opts.cwd },
        null,
      );
    } catch {
      // best-effort — must not crash turn cleanup
    }
  };

  // --- Pre-turn async work (memory recall + skill routing, in parallel) ---
  const preTurnStart = performance.now();
  let memoryRecalledCount = 0;
  let skillResult: SemanticSkillRoutingResult | undefined;

  const lastUserPrompt = extractLastUserText(opts.messages);
  // Anchor for the transient per-turn directive (see withTurnDirective).
  const turnUserMessage = [...opts.messages].reverse().find((m) => m.role === "user");
  const userPromptPreview = lastUserPrompt.slice(0, 200);

  // Light + trivially short prompts skip skill routing entirely. These almost
  // never benefit from injected skills and the embeddings round-trip dominates
  // their wall-clock time. Threshold is conservative — anything substantive
  // crosses 40 chars quickly.
  const skipSkillRouting =
    opts.intentClassification?.tier === "light" &&
    lastUserPrompt.length < 40;

  // Session-start recall is a ONE-SHOT: the supervisor reuses the same recall
  // promise across every runAgentTurn invocation, so without this guard we
  // re-synthesize (a byte-different paraphrase) and re-splice a recall block on
  // every turn, stacking duplicates at the front of the array and busting the
  // prompt-prefix cache. Skip entirely once a block is already present.
  const recallPromise: Promise<{ text: string; count: number } | null> =
    opts.sessionStartRecall && opts.memoryManager && !hasRecalledMemory(opts.messages)
      ? (async () => {
          const results = await opts.sessionStartRecall!;
          if (results.length === 0 || !opts.memoryManager) return null;
          const text = await opts.memoryManager.synthesizeRecalled(results, opts.signal);
          return { text, count: results.length };
        })()
      : Promise.resolve(null);

  const skillsPromise: Promise<SemanticSkillRoutingResult | undefined> =
    opts.skillsDb && opts.skillRoutingConfig && opts.intentClassification && lastUserPrompt && !skipSkillRouting
      ? selectSkills(
          {
            prompt: lastUserPrompt,
            tier: opts.intentClassification.tier,
            maxSkillTokens: opts.skillRoutingConfig.maxSkillTokens ?? 250_000 - 10_000,
          },
          {
            db: opts.skillsDb,
            ...llmAuthOf(opts),
            embeddingModel: opts.skillRoutingConfig.embeddingModel,
          },
        )
      : Promise.resolve(undefined);

  const [recallSettled, skillsSettled, directiveSettled] = await Promise.allSettled([
    raceWithSignal(recallPromise, opts.signal),
    raceWithSignal(skillsPromise, opts.signal),
    raceWithSignal(Promise.resolve(opts.delegationDirective), opts.signal),
  ]);
  const delegationDirective = directiveSettled.status === "fulfilled" ? directiveSettled.value : undefined;

  // Propagate abort; swallow other failures (all paths are non-fatal).
  for (const settled of [recallSettled, skillsSettled, directiveSettled]) {
    if (
      settled.status === "rejected" &&
      settled.reason instanceof DOMException &&
      settled.reason.name === "AbortError"
    ) {
      throw settled.reason;
    }
  }

  if (recallSettled.status === "fulfilled" && recallSettled.value) {
    const { text, count } = recallSettled.value;
    if (injectRecalledMemoryOnce(opts.messages, text)) {
      memoryRecalledCount = count;
      opts.callbacks.onMemoryRecalled?.(count);
    }
  }

  if (skillsSettled.status === "fulfilled" && skillsSettled.value) {
    skillResult = skillsSettled.value;
    opts.callbacks.onSkillsSelected?.(skillResult);

    const allTools = opts.tools;
    if (opts.cacheStable) {
      opts.messages[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
        }),
      };
    } else {
      opts.messages[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
        }),
      };
    }
  }

  if (opts.signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const preTurnMs = Math.round(performance.now() - preTurnStart);

  opts.callbacks.onMetaBanner?.({
    intentTier: opts.intentClassification?.tier ?? "medium",
    skillsActive: skillResult?.sectionCount ?? 0,
    memoryRecalled: memoryRecalledCount > 0,
  });

  let toolDefs: ReturnType<typeof toOpenAIToolDefs>;
  let codeModeApiString = "";

  // Code Mode: most tools live inside execute_code's API, but long-running or
  // parallel tools (subagents) stay direct tools — the sandbox is synchronous
  // and time-limited, so it can neither host them nor run them concurrently.
  const sandboxTools = opts.tools.filter((tool) => !tool.codeModeDirect);
  const directTools = opts.tools.filter((tool) => tool.codeModeDirect);
  if (codeMode) {
    const toolsKey = stableStringify(sandboxTools);
    const cached = codeModeApiCache.get(toolsKey);
    if (cached) {
      codeModeApiString = cached;
    } else {
      codeModeApiString = generateTypeScriptApi(sandboxTools);
      codeModeApiCache.set(toolsKey, codeModeApiString);
    }
    toolDefs = [
      {
        type: "function",
        function: {
          name: "execute_code",
          description:
            `Write and execute TypeScript code to accomplish your task.\n\n` +
            `Available APIs:\n${codeModeApiString}\n\n` +
            `Use console.log() to return results. Only console.log output is sent back to you.\n\n` +
            `IMPORTANT — explore through code, not direct tools: to read files, run shell commands, grep, or glob, ` +
            `call api.read(...), api.bash(...), api.grep(...), api.glob(...) INSIDE this code block and console.log only what you need. ` +
            `Do NOT call read/bash/grep/glob as separate tools — their full output floods your context, while here only what you log returns. ` +
            `Batch multiple reads/greps/commands into a single execute_code call.\n\n` +
            `Mutating calls (edit, write, bash, …) run one at a time in call order even inside Promise.all; ` +
            `apply edits to the same file sequentially and re-read the file before editing it again.` +
            (directTools.length > 0
              ? `\n\nNot in this API — call these as separate tools instead: ${directTools.map((t) => t.name).join(", ")}.`
              : ""),
          parameters: {
            type: "object",
            properties: {
              code: {
                type: "string",
                description: "TypeScript code to execute. Use the api object to call available tools.",
              },
              reasoning: {
                type: "string",
                description: "Brief reasoning about what the code does.",
              },
            },
            required: ["code"],
            additionalProperties: false,
          },
        },
      },
      ...toOpenAIToolDefs(directTools),
    ];
  } else {
    toolDefs = toOpenAIToolDefs(opts.tools);
  }

  let turn = 0;
  let lastUsage: Usage | null = null;

  // Anti-loop guardrail: track recent tool call signatures to detect thrashing
  const recentToolCalls: string[] = [];
  const LOOP_WINDOW = 8;
  const LOOP_THRESHOLD = 2; // 3rd identical call triggers the guardrail

  // Web-fetch volume limits span the session; individual hosts are not treated
  // as loops because research often needs several pages from the same site.
  const webFetchHistory = getSessionWebFetchHistory(opts.sessionId);
  let webFetchesThisTurn = 0;
  // Per-turn counter of Code Mode redirect nudges (capped by MAX_CODE_MODE_REDIRECTS).
  let codeModeRedirects = 0;
  const noteCodeModeRedirect = (): void => {
    if (codeModeRedirects === MAX_CODE_MODE_REDIRECTS) {
      trace.emit(
        "guardrail",
        {
          kind: "code_mode_redirect_cap",
          message: `Code Mode redirect cap (${MAX_CODE_MODE_REDIRECTS}) reached — direct tool calls now execute normally.`,
        },
        turnId,
      );
    }
  };
  const MAX_WEB_FETCH_PER_TURN = 5;

  let cumulativePromptTokens = 0;
  let iter = 0;
  let totalIter = 0;
  let budgetExhausted = false;
  let loopExhausted = false;
  let loopRecoveries = 0;
  let completionNudges = 0;
  // Set when a guardrail decides the turn must end: the next request is a
  // final, tool-free summary and the turn finishes after it.
  let finalizeReason: "loop" | "limit_ceiling" | null = null;

  // Task auto-advance heuristic: track tasks state and mutating tools since
  // the last tasks_set so we can nudge the UI forward when the model forgets.
  let currentTasks: Task[] = [];
  let mutatingToolsSinceLastTasksSet = 0;
  const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
  const AUTO_ADVANCE_THRESHOLD = 3;
  const originalOnTasks = opts.callbacks.onTasks;
  const wrappedOnTasks = (tasks: Task[]) => {
    currentTasks = tasks;
    mutatingToolsSinceLastTasksSet = 0;
    originalOnTasks?.(tasks);
  };

  const appendPendingInput = (): number => {
    const pending = opts.drainPendingInput?.() ?? [];
    for (const msg of pending) opts.messages.push(msg);
    return pending.length;
  };

  while (true) {
    // Budget enforcement: before starting a new turn, if we've already hit the
    // limit, run one final synthesis turn and then signal budget exhaustion.
    if (budgetExhausted) {
      opts.messages.push({
        role: "system",
        content:
          "You have reached the cumulative input token budget for this session. " +
          "Please synthesize your findings and provide a final summary of what was accomplished.",
      });
    }

    if (finalizeReason === null && totalIter >= hardCeiling) {
      finalizeReason = "limit_ceiling";
      opts.messages.push({
        role: "system",
        content:
          `You have reached the hard safety ceiling of ${hardCeiling} tool iterations for this turn. ` +
          "Do not call any more tools. Summarize what you accomplished, what remains unfinished, " +
          "and the concrete next steps needed to complete the task.",
      });
      notifyGuardrail({
        kind: "limit_ceiling",
        message: `Tool-iteration ceiling (${hardCeiling}) reached — wrapping up the turn with a summary.`,
        totalIterations: totalIter,
      });
    } else if (finalizeReason === null && iter >= max) {
      if (limitBehavior === "continue") {
        opts.messages.push({
          role: "system",
          content:
            "You have reached the tool-call limit for this session. " +
            "The counter has been reset so you can continue working. Please proceed with your task.",
        });
        iter = 0;
        notifyGuardrail({
          kind: "limit_reset",
          message: `Tool-call limit (${max}) reached — counter reset automatically (${totalIter}/${hardCeiling} total).`,
          totalIterations: totalIter,
        });
      } else if (limitBehavior === "stop") {
        notifyGuardrail({
          kind: "limit_stopped",
          message: `Tool-call limit (${max}) reached — turn stopped.`,
          totalIterations: totalIter,
        });
        tr.endReason = "guardrail";
        await fireStopHook();
        return;
      } else {
        throw new Error(`kimiflare: tool iteration limit reached (${max})`);
      }
    }

    iter++;
    totalIter++;
    turn++;
    const previousMessages = opts.messages.slice();
    const toolCalls: ToolCall[] = [];
    const toolResults: ToolResult[] = [];
    let content = "";
    let reasoning = "";
    let responseMeta: ResponseMeta | undefined;
    let reasoningDetails: ReasoningDetail[] = [];
    tr.partialText = "";
    opts.callbacks.onAssistantStart?.();

    const stripReasoning = process.env.KIMIFLARE_STRIP_REASONING === "1";
    const shadowStrip = process.env.KIMIFLARE_SHADOW_STRIP === "1";
    const keepLastRaw = process.env.KIMIFLARE_REASONING_KEEP_LAST;
    const keepLast = keepLastRaw ? parseInt(keepLastRaw, 10) : 1;

    let shadowStripMetrics:
      | { originalApproxTokens: number; strippedApproxTokens: number; savingsPct: number }
      | undefined;

    /** History → the exact messages sent for this request. */
    const buildApiMessages = (): ChatMessage[] => {
      let out = opts.messages;
      if (stripReasoning || shadowStrip) {
        const stripped = stripHistoricalReasoning(opts.messages, {
          keepLast: Number.isNaN(keepLast) ? 1 : keepLast,
        });
        if (shadowStrip) {
          const originalApproxTokens = analyzePrompt(opts.messages).reduce((sum, sec) => sum + sec.approxTokens, 0);
          const strippedApproxTokens = analyzePrompt(stripped).reduce((sum, sec) => sum + sec.approxTokens, 0);
          shadowStripMetrics = {
            originalApproxTokens,
            strippedApproxTokens,
            savingsPct:
              originalApproxTokens > 0
                ? Math.round(((originalApproxTokens - strippedApproxTokens) / originalApproxTokens) * 100)
                : 0,
          };
        }
        if (stripReasoning) out = stripped;
      }
      if (opts.keepLastImageTurns !== undefined) {
        out = stripOldImages(out, opts.keepLastImageTurns);
      }
      // Per-turn delegation guidance is request-only: it reaches the model on
      // every iteration of this turn, regardless of skill routing, and is never
      // persisted into history or the system prompt.
      return withTurnDirective(out, delegationDirective, turnUserMessage);
    };

    let apiMessages = buildApiMessages();
    let promptTokens = estimatePromptTokens(apiMessages);
    // The API rejects when `input + max_completion_tokens > ctxWindow`, so the
    // budget comes from those exact terms plus a margin for estimator drift.
    const maxPromptTokens = effectiveInputBudget(opts.model, opts.maxCompletionTokens);
    if (promptTokens > maxPromptTokens && opts.compaction) {
      // One bounded pass: archive older complete turns (raw content stays in
      // the artifact store), keep the active turn, then re-estimate.
      const requestOverhead = Math.max(0, promptTokens - estimatePromptTokens(opts.messages));
      const outcome = compactToFit(opts.messages, maxPromptTokens - requestOverhead, opts.compaction);
      if (outcome) {
        opts.messages.splice(0, opts.messages.length, ...outcome.messages);
        apiMessages = buildApiMessages();
        promptTokens = estimatePromptTokens(apiMessages);
        const info = {
          tokensBefore: outcome.tokensBefore,
          tokensAfter: outcome.tokensAfter,
          turnsRemoved: outcome.turnsRemoved,
          artifactsArchived: outcome.artifactsArchived,
          budgetTokens: maxPromptTokens,
        };
        logger.info("context:compacted", { sessionId: opts.sessionId, ...info });
        trace.emit(
          "compaction",
          {
            method: "preflight",
            tokens_before: info.tokensBefore,
            tokens_after: info.tokensAfter,
            turns_removed: info.turnsRemoved,
            artifacts_archived: info.artifactsArchived,
          },
          turnId,
        );
        opts.callbacks.onCompacted?.(info);
      }
    }
    if (promptTokens > maxPromptTokens) {
      logger.warn("context:irreducible", { sessionId: opts.sessionId, promptTokens, budgetTokens: maxPromptTokens });
      throw new ContextBudgetError(promptTokens, maxPromptTokens, getModelOrInfer(opts.model).contextWindow);
    }

    logger.debug("turn:api_request", { sessionId: opts.sessionId, messageCount: apiMessages.length });
    const events = runKimi({
      ...llmAuthOf(opts),
      model: opts.model,
      messages: apiMessages,
      tools: toolDefs,
      signal: opts.signal,
      temperature: opts.temperature,
      maxCompletionTokens: opts.maxCompletionTokens,
      reasoningEffort: opts.reasoningEffort,
      sessionId: opts.sessionId,
      idleTimeoutMs: opts.idleTimeoutMs ?? 60_000,
      postFirstByteIdleTimeoutMs: opts.postFirstByteIdleTimeoutMs,
      trace,
      turnId,
    });

    let gotFirstChunk = false;
    for await (const ev of events) {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        logger.debug("turn:api_first_chunk", { sessionId: opts.sessionId });
      }
      switch (ev.type) {
        case "response_meta":
          responseMeta = ev.meta;
          opts.callbacks.onResponseMeta?.(ev.meta);
          break;
        case "reasoning_details":
          reasoningDetails = mergeReasoningDetails(reasoningDetails, ev.details);
          break;
        case "reasoning":
          reasoning += ev.delta;
          opts.callbacks.onReasoningDelta?.(ev.delta);
          break;
        case "text":
          content += ev.delta;
          tr.partialText = content;
          opts.callbacks.onTextDelta?.(ev.delta);
          break;
        case "tool_call_start":
          opts.callbacks.onToolCallStart?.(ev.index, ev.id, ev.name);
          break;
        case "tool_call_args":
          opts.callbacks.onToolCallArgs?.(ev.index, ev.argsDelta);
          break;
        case "tool_call_complete": {
          const callArgs = validateToolArguments(ev.arguments, ev.name, ev.id, ev.finishReason, opts.sessionId);
          const call: ToolCall = {
            id: ev.id,
            type: "function",
            function: { name: normalizeToolName(ev.name, opts.tools), arguments: callArgs },
          };
          toolCalls.push(call);
          tr.toolsUsed.push(call.function.name);
          opts.callbacks.onToolCallFinalized?.(call);
          break;
        }
        case "usage":
          lastUsage = ev.usage;
          opts.callbacks.onUsage?.(ev.usage);
          break;
        case "done":
          break;
      }
    }

    if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");

    if (lastUsage) {
      if (typeof lastUsage.cost === "number") tr.costUsd += lastUsage.cost;
      opts.callbacks.onUsageFinal?.(lastUsage, responseMeta);
      cumulativePromptTokens += lastUsage.prompt_tokens;
      // Flip the budget flag regardless of whether this turn produced tool
      // calls — a long pure-text turn past the cap should still trip the
      // limit. The no-tools branch below short-circuits to BudgetExhaustedError
      // instead of an extra synthesis turn. (RF-5 / OP-9.)
      if (
        !budgetExhausted &&
        opts.maxInputTokens !== undefined &&
        opts.maxInputTokens > 0 &&
        cumulativePromptTokens >= opts.maxInputTokens
      ) {
        budgetExhausted = true;
      }
    }

    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: content ? sanitizeString(content) : null,
      ...(reasoning ? { reasoning_content: sanitizeString(reasoning) } : {}),
      ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((tc) => ({
              ...tc,
              function: {
                name: tc.function.name,
                arguments: sanitizeString(tc.function.arguments),
              },
            })),
          }
        : {}),
    };
    if (finalizeReason !== null) {
      // Final summary pass: never execute tools, and don't leave dangling
      // tool_calls in history (they'd have no matching tool results).
      delete assistantMsg.tool_calls;
      if (!assistantMsg.content) {
        assistantMsg.content =
          finalizeReason === "loop"
            ? "Stopped: I kept repeating blocked tool calls and could not make further progress on this task."
            : `Stopped: reached the ${hardCeiling}-iteration safety ceiling for this turn before finishing.`;
      }
    }
    opts.messages.push(assistantMsg);
    tr.finalText = typeof assistantMsg.content === "string" ? assistantMsg.content : null;
    opts.callbacks.onAssistantFinal?.(assistantMsg);

    if (finalizeReason !== null) {
      tr.endReason = "guardrail";
      logger.info("turn:finalized", { sessionId: opts.sessionId, reason: finalizeReason, totalIter });
      if (budgetExhausted) throw new BudgetExhaustedError();
      await fireStopHook();
      if (finalizeReason === "loop") throw new AgentLoopError();
      return;
    }

    if (toolCalls.length === 0) {
      if (opts.sessionId && lastUsage) {
        void logTurnDebug({
          sessionId: opts.sessionId,
          turn,
          messages: opts.messages,
          previousMessages,
          toolResults,
          usage: lastUsage,
          shadowStrip: shadowStripMetrics,
          durationMs: Math.round(performance.now() - turnStart),
          intentClassification: opts.intentClassification,
          codeMode: opts.codeMode,
          selectedSkills: opts.selectedSkills,
          userPromptPreview,
          preTurnMs,
          memoryRecalled: memoryRecalledCount > 0,
        });
      }
      if (budgetExhausted) {
        throw new BudgetExhaustedError();
      }
      // Input that arrived while the model was writing its answer must be
      // answered in this turn, not silently carried into the next one.
      if (appendPendingInput() > 0) continue;
      // Stopped after only planning or announcing next steps? Ask the agent
      // to continue instead of leaving the user to type "go on". Once per turn.
      if (opts.completionCheck && completionNudges < 1) {
        const input = {
          userRequest: lastUserPrompt,
          finalText: typeof assistantMsg.content === "string" ? assistantMsg.content : "",
          toolsUsed: toolsUsedSince(opts.messages, turnUserMessage),
        };
        if (shouldCheckCompletion(input, opts.intentClassification?.tier)) {
          const p = await opts.completionCheck(input, opts.signal).catch(() => null);
          if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
          if (p !== null) trace.emit("completion_check", { probability: p, nudged: p < INCOMPLETE_THRESHOLD }, turnId);
          if (p !== null && p < INCOMPLETE_THRESHOLD) {
            completionNudges++;
            logger.info("turn:completion_nudge", { sessionId: opts.sessionId, probability: p });
            opts.messages.push({ role: "system", content: CONTINUE_NUDGE });
            notifyGuardrail({
              kind: "completion_nudge",
              message: "The agent stopped before finishing — asked it to continue.",
              probability: p,
            });
            continue;
          }
        }
      }
      logger.info("turn:complete", { sessionId: opts.sessionId, durationMs: Math.round(performance.now() - turnStart) });
      await fireStopHook();
      return;
    }

    let blockedCount = 0;
    const availableToolNames = new Set(opts.tools.map((tool) => tool.name));
    if (codeMode) availableToolNames.add("execute_code");

    // Determine if every tool in this batch can run concurrently: read-only
    // tools, plus tools that are isolated from the workspace (`concurrent`,
    // e.g. sandboxed subagents). Such batches have no write-order
    // dependencies or mutation side-effects to sequence.
    const executorTools = opts.executor.list();
    const allConcurrent =
      toolCalls.length > 1 &&
      toolCalls.every((tc) => {
        const tool = executorTools.find((t) => t.name === tc.function.name);
        return availableToolNames.has(tc.function.name) && (tool?.isReadOnly === true || tool?.concurrent === true);
      });

    // NOTE: Extending parallel execution to *mutable* tool calls is
    // possible but requires an explicit dependency graph (e.g. a write to
    // file X must complete before a subsequent read of file X).  Without
    // such ordering guarantees, parallelising mutable calls risks race
    // conditions and non-deterministic results.  If you want to add this
    // in the future, build a DAG of tool dependencies first, then execute
    // each topological layer in parallel while respecting the sequential
    // order within a layer.
    if (allConcurrent) {
      const workerCount = toolCalls.filter((tc) => executorTools.find((t) => t.name === tc.function.name)?.concurrent === true).length;
      opts.callbacks.onInfo?.(
        workerCount > 0
          ? `${toolCalls.length} tool calls running in parallel (${workerCount} isolated worker${workerCount === 1 ? "" : "s"})`
          : `${toolCalls.length} read-only tools running in parallel`,
      );
      // Concurrent calls must not raise overlapping permission prompts: the
      // gate serializes them and approves same-tool calls as one batch.
      const batchAskPermission = createPermissionGate(
        opts.callbacks.askPermission,
        toolCalls.map((tc) => ({ name: tc.function.name, args: parseArgsObject(tc.function.arguments) })),
      );
      type ParallelItem =
        | { kind: "blocked"; tc: ToolCall; loopSignature: string; result: ToolResult; errorCode: string; redirected?: boolean }
        | { kind: "run"; tc: ToolCall; loopSignature: string };

      const items: ParallelItem[] = [];
      for (const tc of toolCalls) {
        if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
        const loopSignature = `${tc.function.name}:${stableStringify(tc.function.arguments)}`;
        const loopCount = recentToolCalls.filter((s) => s === loopSignature).length;
        if (loopCount >= LOOP_THRESHOLD) {
          items.push({
            kind: "blocked",
            tc,
            loopSignature,
            errorCode: "loop_guardrail",
            result: {
              tool_call_id: tc.id,
              name: tc.function.name,
              content: `Loop detected: you have called ${tc.function.name} with the same arguments multiple times in a row. Consider a different approach.`,
              ok: false,
              guardrail: true,
            },
          });
          continue;
        }
        if (codeMode && CODE_MODE_REDIRECT_TOOLS.has(tc.function.name) && codeModeRedirects < MAX_CODE_MODE_REDIRECTS) {
          codeModeRedirects++;
          noteCodeModeRedirect();
          items.push({
            kind: "blocked",
            tc,
            loopSignature,
            errorCode: "code_mode_redirect",
            redirected: true,
            result: { tool_call_id: tc.id, name: tc.function.name, content: codeModeRedirectMessage(tc.function.name), ok: false },
          });
          continue;
        }
        if (tc.function.name === "web_fetch") {
          const args = JSON.parse(tc.function.arguments || "{}") as { url?: string };
          const url = args.url || "";
          try {
            new URL(url);
            const totalSessionFetches = webFetchHistory.length;
            if (webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN || totalSessionFetches >= SESSION_WEB_FETCH_CAP) {
              const warning = webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN
                ? `Research budget exceeded: you have already made ${MAX_WEB_FETCH_PER_TURN} web requests this turn. Synthesize what you have learned instead of fetching more pages.`
                : `Session research budget exceeded: ${totalSessionFetches} web fetches across this session. Synthesize what you have learned from prior fetches instead of starting another page.`;
              items.push({
                kind: "blocked",
                tc,
                loopSignature,
                errorCode: "web_fetch_budget",
                result: { tool_call_id: tc.id, name: "web_fetch", content: warning, ok: false, guardrail: true },
              });
              continue;
            }
            webFetchHistory.push(url);
            webFetchesThisTurn++;
          } catch {
            // Invalid URL, let it fail normally
          }
        }
        items.push({ kind: "run", tc, loopSignature });
      }

      const runItems = items.filter((it): it is ParallelItem & { kind: "run" } => it.kind === "run");
      const executed = await Promise.all(
        runItems.map(async (it) => {
          opts.callbacks.onToolWillExecute?.(it.tc.id, it.tc.function.name);
          logger.debug("turn:tool_start", { sessionId: opts.sessionId, tool: it.tc.function.name, toolCallId: it.tc.id });
          const result = await opts.executor.run(
            { id: it.tc.id, name: it.tc.function.name, arguments: it.tc.function.arguments },
            batchAskPermission,
            {
              trace,
              turnId,
              cwd: opts.cwd,
              signal: opts.signal,
              onTasks: wrappedOnTasks,
              onPlanOptions: opts.callbacks.onPlanOptions,
              coauthor: opts.coauthor,
              memoryManager: opts.memoryManager,
              sessionId: opts.sessionId,
              githubToken: opts.githubToken,
              shell: opts.shell,
              intentTier: opts.intentClassification?.tier,
              llmAuth: llmAuthOf(opts),
              model: opts.model,
              allowDirectPush: opts.allowDirectPush,
              runId: opts.runId,
              onRunBudgetExceeded: opts.callbacks.onRunBudgetExceeded,
              runsDbPath: opts.runsDbPath,
            },
            opts.onFileChange,
          );
          let content = result.content;
          if (content.length > MAX_TOOL_CONTENT_CHARS) {
            const rawBytes = content.length;
            content = content.slice(0, MAX_TOOL_CONTENT_CHARS) + `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
            opts.callbacks.onTruncation?.({
              tool: it.tc.function.name,
              toolCallId: it.tc.id,
              rawBytes,
              reducedBytes: content.length,
              artifactId: result.artifactId,
            });
          }
          return { ...result, content } as ToolResult;
        }),
      );

      const resultMap = new Map<string, ToolResult>();
      for (let i = 0; i < runItems.length; i++) {
        resultMap.set(runItems[i]!.tc.id, executed[i]!);
      }

      for (const it of items) {
        if (it.kind === "blocked") {
          traceBlocked(it.tc, it.result, it.errorCode, it.redirected === true);
          toolResults.push(it.result);
          opts.messages.push({
            role: "tool",
            tool_call_id: it.tc.id,
            content: sanitizeString(it.result.content),
            name: it.tc.function.name,
          });
          opts.callbacks.onToolResult?.(it.result);
          recentToolCalls.push(it.loopSignature);
          if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
          blockedCount++;
          continue;
        }

        const result = resultMap.get(it.tc.id)!;
        if (!result.ok && result.errorCode === "policy_rejection") {
          logger.warn("hook:vetoed_tool_call", {
            sessionId: opts.sessionId,
            tool: it.tc.function.name,
            toolCallId: it.tc.id,
          });
        }
        logger.debug("turn:tool_end", { sessionId: opts.sessionId, tool: it.tc.function.name, toolCallId: it.tc.id, ok: result.ok });
        if (!result.ok && result.errorCode) {
          logger.warn("tool:error_classified", {
            sessionId: opts.sessionId,
            tool: it.tc.function.name,
            toolCallId: it.tc.id,
            code: result.errorCode,
            recoverable: result.recoverable,
          });
        }
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: sanitizeString(result.content),
          name: result.name,
        });
        opts.callbacks.onToolResult?.(result);

        if (opts.memoryManager) {
          let filePath: string | undefined;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(it.tc.function.arguments || "{}") as Record<string, unknown>;
            filePath = toolArgs.path as string | undefined;
          } catch {
            // ignore parse errors
          }
          const lastAssistant = [...opts.messages].reverse().find(
            (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          );
          const assistantMessage = lastAssistant?.content ?? "";
          const llmOpts = opts.memoryManager.getExtractionLlmOpts();
          const turnAtMemoryCommit = turn;
          for (const extractor of EXTRACTORS) {
            if (extractor.match(it.tc.function.name, filePath)) {
              void (async () => {
                try {
                  const memory = await extractor.extract(result.content, filePath, {
                    toolArgs: { ...toolArgs, _toolName: it.tc.function.name },
                    assistantMessage: typeof assistantMessage === "string" ? assistantMessage : "",
                    llmOpts: { ...llmOpts, signal: opts.signal },
                  });
                  if (memory) {
                    await opts.memoryManager!.remember(
                      memory.content,
                      memory.category,
                      memory.importance,
                      opts.cwd,
                      opts.sessionId ?? "unknown",
                      opts.signal,
                      undefined,
                      memory.topicKey,
                    );
                    if (isHighSignalMemory(memory)) {
                      const sid = opts.sessionId ?? "default";
                      const events = driftEvents.get(sid) ?? [];
                      events.push(turnAtMemoryCommit);
                      const cutoff = turnAtMemoryCommit - DRIFT_WINDOW + 1;
                      const recent = events.filter((t) => t >= cutoff);
                      driftEvents.set(sid, recent);
                      if (recent.length >= DRIFT_THRESHOLD) {
                        try {
                          opts.callbacks.onKimiMdStale?.();
                        } catch (cbErr) {
                          logger.debug("memory:onKimiMdStale_threw", {
                            sessionId: opts.sessionId,
                            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                          });
                        }
                        driftEvents.set(sid, []);
                      }
                    }
                  }
                } catch (err) {
                  const sid = opts.sessionId ?? "default";
                  const next = (memoryExtractionErrorCounts.get(sid) ?? 0) + 1;
                  memoryExtractionErrorCounts.set(sid, next);
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.debug("memory:extract_error", {
                    sessionId: opts.sessionId,
                    tool: it.tc.function.name,
                    count: next,
                    error: msg,
                  });
                  if (next === 1) {
                    try {
                      opts.callbacks.onWarning?.(
                        `[memory] auto-extraction failed (${msg}). Subsequent failures will be counted silently; check /memory health.`,
                      );
                    } catch (cbErr) {
                      logger.debug("memory:onWarning_threw", {
                        sessionId: opts.sessionId,
                        error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                      });
                    }
                  }
                }
              })();
            }
          }
        }

        recentToolCalls.push(it.loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      }
    } else {
      for (const [i, tc] of toolCalls.entries()) {
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");

      const loopSignature = `${tc.function.name}:${stableStringify(tc.function.arguments)}`;
      if (!availableToolNames.has(tc.function.name)) {
        const unavailableResult: ToolResult = {
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `Tool ${tc.function.name} is not available under this turn's policy. Continue without it or ask the user to enable it.`,
          ok: false,
        };
        traceBlocked(tc, unavailableResult, "unavailable");
        toolResults.push(unavailableResult);
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizeString(unavailableResult.content),
          name: tc.function.name,
        });
        opts.callbacks.onToolResult?.(unavailableResult);
        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
        blockedCount++;
        continue;
      }

      // Anti-loop guardrail
      const loopCount = recentToolCalls.filter((s) => s === loopSignature).length;
      if (loopCount >= LOOP_THRESHOLD) {
        const warning = `Loop detected: you have called ${tc.function.name} with the same arguments multiple times in a row. Consider a different approach.`;
        const loopResult: ToolResult = {
          tool_call_id: tc.id,
          name: tc.function.name,
          content: warning,
          ok: false,
          guardrail: true,
        };
        traceBlocked(tc, loopResult, "loop_guardrail");
        toolResults.push(loopResult);
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizeString(warning),
          name: tc.function.name,
        });
        opts.callbacks.onToolResult?.(loopResult);
        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
        blockedCount++;
        continue;
      }

      // Web-fetch spiral guardrail
      if (tc.function.name === "web_fetch") {
        const args = JSON.parse(tc.function.arguments || "{}") as { url?: string };
        const url = args.url || "";
        try {
          new URL(url);
          const totalSessionFetches = webFetchHistory.length;

          if (webFetchesThisTurn >= MAX_WEB_FETCH_PER_TURN) {
            const warning = `Research budget exceeded: you have already made ${MAX_WEB_FETCH_PER_TURN} web requests this turn. Synthesize what you have learned instead of fetching more pages.`;
            const budgetResult: ToolResult = {
              tool_call_id: tc.id,
              name: "web_fetch",
              content: warning,
              ok: false,
              guardrail: true,
            };
            traceBlocked(tc, budgetResult, "web_fetch_budget");
            toolResults.push(budgetResult);
            opts.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: sanitizeString(warning),
              name: "web_fetch",
            });
            opts.callbacks.onToolResult?.(budgetResult);
            recentToolCalls.push(loopSignature);
            if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
            blockedCount++;
            continue;
          }

          if (totalSessionFetches >= SESSION_WEB_FETCH_CAP) {
            const warning = `Session research budget exceeded: ${totalSessionFetches} web fetches across this session. Synthesize what you have learned from prior fetches instead of starting another page.`;
            const sessionCapResult: ToolResult = {
              tool_call_id: tc.id,
              name: "web_fetch",
              content: warning,
              ok: false,
              guardrail: true,
            };
            traceBlocked(tc, sessionCapResult, "web_fetch_budget");
            toolResults.push(sessionCapResult);
            opts.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: sanitizeString(warning),
              name: "web_fetch",
            });
            opts.callbacks.onToolResult?.(sessionCapResult);
            recentToolCalls.push(loopSignature);
            if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
            blockedCount++;
            continue;
          }


          webFetchHistory.push(url);
          webFetchesThisTurn++;
        } catch {
          // Invalid URL, let it fail normally
        }
      }

      if (codeMode && tc.function.name === "execute_code") {
        const args = JSON.parse(tc.function.arguments || "{}") as { code?: string; reasoning?: string };
        const code = args.code || "";
        const sandboxStartedAt = performance.now();
        if (trace.enabled) {
          trace.emit(
            "tool_call",
            {
              tool_call_id: tc.id,
              name: "execute_code",
              args_blob: trace.blob(tc.function.arguments) ?? "",
              ...(tc.function.arguments.length <= 2048 ? { args_inline: parseArgsObject(tc.function.arguments) } : {}),
              needs_permission: false,
              code_mode_redirected: false,
            },
            turnId,
          );
        }

        logger.debug("turn:code_mode_start", { sessionId: opts.sessionId, toolCallId: tc.id, codeChars: code.length });
        const sandboxResult = await runInSandbox({
          code,
          tools: sandboxTools,
          executor: opts.executor,
          askPermission: opts.callbacks.askPermission,
          ctx: {
            cwd: opts.cwd,
            signal: opts.signal,
            onTasks: wrappedOnTasks,
            onPlanOptions: opts.callbacks.onPlanOptions,
            coauthor: opts.coauthor,
            memoryManager: opts.memoryManager,
            sessionId: opts.sessionId,
            githubToken: opts.githubToken,
            trace,
            turnId,
            codeModeParentToolCallId: tc.id,
          },
          timeoutMs: 30000,
          memoryLimitMB: 128,
        });

        logger.debug("turn:code_mode_end", {
          sessionId: opts.sessionId,
          toolCallId: tc.id,
          durationMs: Math.round(performance.now() - sandboxStartedAt),
          error: sandboxResult.error ?? null,
          calls: sandboxResult.toolCalls.map((c) => ({
            name: c.name,
            ok: c.ok,
            path: typeof (c.args as { path?: unknown })?.path === "string" ? (c.args as { path: string }).path : undefined,
          })),
        });

        // Emit individual tool results from inside the script
        for (const stc of sandboxResult.toolCalls) {
          const toolResult: ToolResult = {
            tool_call_id: tc.id,
            name: stc.name,
            content: stc.result,
            ok: stc.ok,
          };
          toolResults.push(toolResult);
          opts.callbacks.onToolResult?.(toolResult);
        }

        // Surface sandbox warnings (e.g. isolated-vm fallback) as a separate UI notice
        if (sandboxResult.warnings && sandboxResult.warnings.length > 0) {
          for (const w of sandboxResult.warnings) {
            opts.callbacks.onWarning?.(w);
          }
        }

        let resultContent = sandboxResult.error
          ? `Error: ${sandboxResult.error}\n\nOutput:\n${sandboxResult.output}`
          : sandboxResult.output;
        const sandboxRawContent = resultContent;
        if (resultContent.length > MAX_TOOL_CONTENT_CHARS) {
          const rawBytes = resultContent.length;
          resultContent =
            resultContent.slice(0, MAX_TOOL_CONTENT_CHARS) +
            `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
          opts.callbacks.onTruncation?.({
            tool: "execute_code",
            toolCallId: tc.id,
            rawBytes,
            reducedBytes: resultContent.length,
          });
        }

        const result: ToolResult = {
          tool_call_id: tc.id,
          name: "execute_code",
          content: resultContent,
          ok: !sandboxResult.error,
        };
        if (trace.enabled) {
          const rawBlob = trace.blob(sandboxRawContent) ?? "";
          trace.emit(
            "tool_result",
            {
              tool_call_id: tc.id,
              name: "execute_code",
              ok: result.ok,
              ...(sandboxResult.error ? { error_code: "sandbox_error" } : {}),
              raw_blob: rawBlob,
              raw_bytes: Buffer.byteLength(sandboxRawContent, "utf8"),
              reduced_blob: sandboxRawContent === resultContent ? rawBlob : trace.blob(resultContent) ?? "",
              reduced_bytes: Buffer.byteLength(resultContent, "utf8"),
              duration_ms: Math.round(performance.now() - sandboxStartedAt),
            },
            turnId,
          );
        }
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: sanitizeString(resultContent),
          name: "execute_code",
        });
        opts.callbacks.onToolResult?.(result);
        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      } else if (codeMode && CODE_MODE_REDIRECT_TOOLS.has(tc.function.name) && codeModeRedirects < MAX_CODE_MODE_REDIRECTS) {
        // Redirect a direct context-heavy IO call back into execute_code.
        codeModeRedirects++;
        noteCodeModeRedirect();
        const msg = codeModeRedirectMessage(tc.function.name);
        const redirectResult: ToolResult = { tool_call_id: tc.id, name: tc.function.name, content: msg, ok: false };
        traceBlocked(tc, redirectResult, "code_mode_redirect", true);
        toolResults.push(redirectResult);
        opts.messages.push({ role: "tool", tool_call_id: tc.id, content: msg, name: tc.function.name });
        opts.callbacks.onToolResult?.(redirectResult);
      } else {
        opts.callbacks.onToolWillExecute?.(tc.id, tc.function.name);
        logger.debug("turn:tool_start", { sessionId: opts.sessionId, tool: tc.function.name, toolCallId: tc.id });

        // M6.1: PreToolUse / PostToolUse fire inside `executor.run`
        // (see src/tools/executor.ts). The executor owns them so every
        // caller — standard loop, code-mode sandbox, init turn, SDK,
        // CLI print mode — gets the same behavior automatically.
        // A vetoed PreToolUse returns a synthetic policy_rejection
        // ToolResult; the loop treats it the same as any other failed
        // call (pushes the rejection text as a tool message so the
        // model sees the reason).
        const result = await opts.executor.run(
          { id: tc.id, name: tc.function.name, arguments: tc.function.arguments },
          opts.callbacks.askPermission,
          {
            trace,
            turnId,
            cwd: opts.cwd,
            signal: opts.signal,
            onTasks: wrappedOnTasks,
            onPlanOptions: opts.callbacks.onPlanOptions,
            coauthor: opts.coauthor,
            memoryManager: opts.memoryManager,
            sessionId: opts.sessionId,
            githubToken: opts.githubToken,
            shell: opts.shell,
            intentTier: opts.intentClassification?.tier,
            llmAuth: llmAuthOf(opts),
            model: opts.model,
            allowDirectPush: opts.allowDirectPush,
            runId: opts.runId,
            onRunBudgetExceeded: opts.callbacks.onRunBudgetExceeded,
            runsDbPath: opts.runsDbPath,
          },
          opts.onFileChange,
        );
        if (!result.ok && result.errorCode === "policy_rejection") {
          logger.warn("hook:vetoed_tool_call", {
            sessionId: opts.sessionId,
            tool: tc.function.name,
            toolCallId: tc.id,
          });
        }
        let content = result.content;
        if (content.length > MAX_TOOL_CONTENT_CHARS) {
          const rawBytes = content.length;
          content =
            content.slice(0, MAX_TOOL_CONTENT_CHARS) +
            `\n\n[truncated: ${rawBytes - MAX_TOOL_CONTENT_CHARS} chars omitted]`;
          opts.callbacks.onTruncation?.({
            tool: tc.function.name,
            toolCallId: tc.id,
            rawBytes,
            reducedBytes: content.length,
            artifactId: result.artifactId,
          });
        }
        logger.debug("turn:tool_end", { sessionId: opts.sessionId, tool: tc.function.name, toolCallId: tc.id, ok: result.ok });
        if (!result.ok && result.errorCode) {
          // M2.1: surface the classified failure mode in the structured
          // log so the M5.1 + M5.2 sinks can answer "which tools fail
          // most, and how?" without parsing message strings.
          logger.warn("tool:error_classified", {
            sessionId: opts.sessionId,
            tool: tc.function.name,
            toolCallId: tc.id,
            code: result.errorCode,
            recoverable: result.recoverable,
          });
        }
        toolResults.push(result);
        opts.messages.push({
          role: "tool",
          tool_call_id: result.tool_call_id,
          content: sanitizeString(content),
          name: result.name,
        });
        opts.callbacks.onToolResult?.(result);
        if (result.waitRequest) {
          if (opts.onIterationEnd) {
            replaceMessagesInPlace(opts.messages, await opts.onIterationEnd(opts.messages, opts.signal));
          }
          logger.info("run:yielded", {
            runId: result.waitRequest.runId,
            timerId: result.waitRequest.timerId,
            condition: result.waitRequest.condition,
            wakeAt: result.waitRequest.wakeAt,
          });
          tr.endReason = "needs_input";
          try {
            opts.callbacks.onRunYield?.(result.waitRequest);
          } catch (error) {
            logger.warn("run:yield_callback_failed", {
              runId: result.waitRequest.runId,
              timerId: result.waitRequest.timerId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await fireStopHook();
          return;
        }

        // Auto-extract memories from tool results
        if (opts.memoryManager) {
          let filePath: string | undefined;
          let toolArgs: Record<string, unknown> = {};
          try {
            toolArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
            filePath = toolArgs.path as string | undefined;
          } catch {
            // ignore parse errors
          }

          // Find the preceding assistant message for intent context
          const lastAssistant = [...opts.messages].reverse().find(
            (m) => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0
          );
          const assistantMessage = lastAssistant?.content ?? "";

          const llmOpts = opts.memoryManager.getExtractionLlmOpts();

          // Capture turn at IIFE creation so the sliding-window drift
          // detector below is anchored to when the memory was extracted,
          // not whatever value `turn` has when the await chain settles.
          const turnAtMemoryCommit = turn;
          for (const extractor of EXTRACTORS) {
            if (extractor.match(tc.function.name, filePath)) {
              void (async () => {
                try {
                  const memory = await extractor.extract(result.content, filePath, {
                    toolArgs: { ...toolArgs, _toolName: tc.function.name },
                    assistantMessage: typeof assistantMessage === "string" ? assistantMessage : "",
                    llmOpts: {
                      ...llmOpts,
                      signal: opts.signal,
                    },
                  });
                  if (memory) {
                    await opts.memoryManager!.remember(
                      memory.content,
                      memory.category,
                      memory.importance,
                      opts.cwd,
                      opts.sessionId ?? "unknown",
                      opts.signal,
                      undefined,
                      memory.topicKey,
                    );

                    // Real-time drift detection — sliding window:
                    // fire `onKimiMdStale` when >=DRIFT_THRESHOLD high-signal
                    // memories land within DRIFT_WINDOW turns. Clustered
                    // changes = drift; spread-out changes = incremental work
                    // and aren't worth nagging about. (RF-2 / OP-8.)
                    if (isHighSignalMemory(memory)) {
                      const sid = opts.sessionId ?? "default";
                      const events = driftEvents.get(sid) ?? [];
                      events.push(turnAtMemoryCommit);
                      const cutoff = turnAtMemoryCommit - DRIFT_WINDOW + 1;
                      const recent = events.filter((t) => t >= cutoff);
                      driftEvents.set(sid, recent);
                      if (recent.length >= DRIFT_THRESHOLD) {
                        // Wrapped defensively: a throwing callback inside
                        // this fire-and-forget IIFE would become an
                        // unhandled rejection (process-fatal under Node's
                        // default --unhandled-rejections=throw).
                        try {
                          opts.callbacks.onKimiMdStale?.();
                        } catch (cbErr) {
                          logger.debug("memory:onKimiMdStale_threw", {
                            sessionId: opts.sessionId,
                            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                          });
                        }
                        driftEvents.set(sid, []);
                      }
                    }
                  }
                } catch (err) {
                  // Auto-extraction must never break the turn, but a silent
                  // swallow hides systemic failures (bad embedding endpoint,
                  // DB lock, schema mismatch). Track per session and surface
                  // through onWarning so /memory health (and SDK consumers)
                  // can see something is wrong.
                  const sid = opts.sessionId ?? "default";
                  const next = (memoryExtractionErrorCounts.get(sid) ?? 0) + 1;
                  memoryExtractionErrorCounts.set(sid, next);
                  const msg = err instanceof Error ? err.message : String(err);
                  logger.debug("memory:extract_error", {
                    sessionId: opts.sessionId,
                    tool: tc.function.name,
                    count: next,
                    error: msg,
                  });
                  // Only emit the user-visible warning on the first failure
                  // per session — repeated errors stay in the counter.
                  // Wrapped defensively for the same reason as the
                  // onKimiMdStale fire above.
                  if (next === 1) {
                    try {
                      opts.callbacks.onWarning?.(
                        `[memory] auto-extraction failed (${msg}). Subsequent failures will be counted silently; check /memory health.`,
                      );
                    } catch (cbErr) {
                      logger.debug("memory:onWarning_threw", {
                        sessionId: opts.sessionId,
                        error: cbErr instanceof Error ? cbErr.message : String(cbErr),
                      });
                    }
                  }
                }
              })();
            }
          }
        }

        recentToolCalls.push(loopSignature);
        if (recentToolCalls.length > LOOP_WINDOW) recentToolCalls.shift();
      }

      // Heuristic auto-advance: if the model has executed multiple mutating
      // tools without calling tasks_set, nudge the task list forward so the
      // UI stays honest. We only do this when tasks_set is not coming later
      // in the same batch of tool calls.
      if (MUTATING_TOOLS.has(tc.function.name)) {
        mutatingToolsSinceLastTasksSet++;
        const hasTasksSetComing = toolCalls.slice(i + 1).some((t) => t.function.name === "tasks_set");
        if (!hasTasksSetComing && mutatingToolsSinceLastTasksSet >= AUTO_ADVANCE_THRESHOLD) {
          const inProgressIdx = currentTasks.findIndex((t) => t.status === "in_progress");
          const nextPendingIdx = currentTasks.findIndex((t) => t.status === "pending");
          if (inProgressIdx !== -1 && nextPendingIdx !== -1) {
            const updated = currentTasks.map((t, idx) => {
              if (idx === inProgressIdx) return { ...t, status: "completed" as const };
              if (idx === nextPendingIdx) return { ...t, status: "in_progress" as const };
              return t;
            });
            currentTasks = updated;
            mutatingToolsSinceLastTasksSet = 0;
            wrappedOnTasks(updated);
          }
        }
      }
    }
    }

    if (blockedCount === toolCalls.length && toolCalls.length > 0) {
      loopExhausted = true;
    }

    // (Drift accumulator decay was removed in OP-8 — drift detection is
    // now a sliding window over recent turns, not a decaying counter.)

    // Mid-turn user input (steering) lands at the tool boundary.
    appendPendingInput();

    // Allow external compaction / state management between iterations
    if (opts.onIterationEnd) {
      replaceMessagesInPlace(opts.messages, await opts.onIterationEnd(opts.messages, opts.signal));
      if (opts.signal.aborted) throw new DOMException("aborted", "AbortError");
    }

    if (opts.sessionId && lastUsage) {
      void logTurnDebug({
        sessionId: opts.sessionId,
        turn,
        messages: opts.messages,
        previousMessages,
        toolResults,
        usage: lastUsage,
        shadowStrip: shadowStripMetrics,
        durationMs: Math.round(performance.now() - turnStart),
        intentClassification: opts.intentClassification,
        codeMode: opts.codeMode,
        selectedSkills: opts.selectedSkills,
        userPromptPreview,
        preTurnMs,
        memoryRecalled: memoryRecalledCount > 0,
      });
    }

    if (budgetExhausted) {
      throw new BudgetExhaustedError();
    }
    if (loopExhausted) {
      // Never block on a user decision here: unattended runs must keep
      // moving. Give the model one chance to change approach; if it trips
      // the guardrail again, run a final tool-free summary and end the turn.
      loopExhausted = false;
      recentToolCalls.length = 0;
      if (loopRecoveries < MAX_LOOP_RECOVERIES) {
        loopRecoveries++;
        opts.messages.push({
          role: "system",
          content:
            "Every tool call in your last step was blocked because you kept repeating the same calls with identical arguments. " +
            "Do not repeat them. Either take a genuinely different approach (different tools, arguments, or files), " +
            "or, if you already have enough information, stop calling tools and give your final answer.",
        });
        notifyGuardrail({
          kind: "loop_recovery",
          message: "Loop guardrail: repeated tool calls were blocked — asked the agent to change approach.",
        });
        continue;
      }
      finalizeReason = "loop";
      opts.messages.push({
        role: "system",
        content:
          "You are still repeating blocked tool calls after being asked to change approach, so this turn is ending. " +
          "Do not call any more tools. Summarize what you accomplished, what is blocking you, " +
          "and what the user could do next.",
      });
      notifyGuardrail({
        kind: "loop_stopped",
        message: "Loop guardrail: the agent kept repeating blocked tool calls — ending the turn with a summary.",
      });
      continue;
    }
  }
}

function parseArgsObject(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Hosts keep a reference to the messages array they passed in; replacing
 *  the array would leave them holding stale history (everything appended
 *  after a mid-turn compaction would be lost on save). Mutate in place. */
function replaceMessagesInPlace(target: ChatMessage[], next: ChatMessage[]): void {
  if (next === target) return;
  target.splice(0, target.length, ...next);
}

/** `spawn_worker` was renamed to `subagent`; models primed by older history
 *  may still emit the old name. The subagent tool accepts the old arguments. */
function normalizeToolName(name: string, tools: ToolSpec[]): string {
  return name === "spawn_worker" && tools.some((t) => t.name === "subagent") ? "subagent" : name;
}

function validateToolArguments(raw: string, name: string, id: string, finishReason: string | null, sessionId?: string): string {
  let issue: string | null = null;
  if (!raw.trim()) {
    issue = "empty arguments";
  } else {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) issue = "arguments must be a JSON object";
    } catch (error) {
      issue = error instanceof Error ? error.message : "invalid JSON";
    }
  }
  if (issue) {
    logger.warn("turn:tool_arguments_invalid", {
      sessionId,
      tool: name,
      toolCallId: id,
      argumentBytes: Buffer.byteLength(raw, "utf8"),
      finishReason,
      issue,
    });
  }
  return raw;
}

/** The credential subset of turn opts, for side-calls made on the turn's behalf. */
function llmAuthOf(opts: LlmAuth): LlmAuth {
  return {
    ...(opts.openrouterApiKey ? { openrouterApiKey: opts.openrouterApiKey } : {}),
    ...(opts.requestyApiKey ? { requestyApiKey: opts.requestyApiKey } : {}),
    ...(opts.customEndpoint ? { customEndpoint: opts.customEndpoint } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
}
