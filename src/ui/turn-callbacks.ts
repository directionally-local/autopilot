/**
 * The TUI's agent-turn callbacks, extracted from App.processMessage: how
 * loop events (assistant streaming, tool lifecycle, usage, notices) become
 * chat events and turn-status updates. App supplies the state setters and
 * refs through `TurnCallbackDeps`; the mapping itself is plain functions,
 * tested without rendering the app.
 */

import type { AgentCallbacks, GuardrailEvent } from "../agent/loop.js";
import type { ResponseMeta } from "../agent/client.js";
import type { ToolCall, Usage } from "../agent/messages.js";
import type { PermissionAsker, ToolResult } from "../tools/executor.js";
import type { PlanOption, Task, ToolRender, ToolSpec } from "../tools/registry.js";
import type { SemanticSkillRoutingResult } from "../skills/index.js";
import type { ChatEvent } from "./view-types.js";
import { KimiApiError, humanizeApiError } from "../util/errors.js";

type ToolEvent = Extract<ChatEvent, { kind: "tool" }>;
type AssistantEvent = Extract<ChatEvent, { kind: "assistant" }>;
type Ref<T> = { current: T };

/** The chat event for a tool call the model just finalized (queued until it runs). */
export function toolCallEvent(call: ToolCall, spec: Pick<ToolSpec, "render"> | undefined): ToolEvent {
  let render: ToolRender | undefined;
  try {
    const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    render = spec?.render?.(args);
  } catch {
    /* ignore render failure */
  }
  return {
    kind: "tool",
    key: `tool_${call.id}`,
    id: call.id,
    name: call.function.name,
    args: call.function.arguments,
    status: "queued",
    render,
    expanded: false,
  };
}

/** How a tool result shows in the chat: blocked by a guardrail, rejected by the user, done, or failed. */
export function toolResultPatch(r: ToolResult): Partial<ToolEvent> {
  const rejected = !r.ok && typeof r.content === "string" && r.content.startsWith("Permission denied");
  return {
    status: r.guardrail ? "blocked" : rejected ? "rejected" : r.ok ? "done" : "error",
    result: r.guardrail ? undefined : r.content,
  };
}

/**
 * Settle everything a turn left in motion: running tools stop, queued ones
 * are cancelled, streaming assistants end. Unsettled events keep themselves
 * and everything after them in Ink's live tree, and their spinners animate
 * forever, so a turn must never end with any. Returns the same array when
 * nothing needed settling.
 */
export function settleTurnEvents(events: ChatEvent[]): ChatEvent[] {
  const unsettled = events.some(
    (e) => (e.kind === "assistant" && e.streaming) || (e.kind === "tool" && (e.status === "running" || e.status === "queued")),
  );
  if (!unsettled) return events;
  return events.map((e) =>
    e.kind === "tool" && e.status === "running"
      ? { ...e, status: "error" as const, result: "(stopped)" }
      : e.kind === "tool" && e.status === "queued"
        ? { ...e, status: "cancelled" as const }
        : e.kind === "assistant" && e.streaming
          ? { ...e, streaming: false }
          : e,
  );
}

export type TurnFailure =
  | { kind: "aborted" }
  | { kind: "api_error"; httpStatus: number; code?: number; message: string }
  | { kind: "error"; text: string };

/** Classify a failed turn: an abort, a transient provider error (429/5xx, shown with a status link), or anything else. */
export function classifyTurnFailure(e: Error): TurnFailure {
  if (e.name === "AbortError") return { kind: "aborted" };
  if (e instanceof KimiApiError && (e.httpStatus === 429 || (e.httpStatus !== undefined && e.httpStatus >= 500))) {
    return { kind: "api_error", httpStatus: e.httpStatus, ...(e.code !== undefined ? { code: e.code } : {}), message: humanizeApiError(e) };
  }
  return { kind: "error", text: e instanceof KimiApiError ? humanizeApiError(e) : e.message ?? String(e) };
}

export interface TurnCallbackDeps {
  mkKey(): string;
  mkAssistantId(): number;
  setEvents(update: (events: ChatEvent[]) => ChatEvent[]): void;
  updateAssistant(id: number, patch: (e: AssistantEvent) => Partial<ChatEvent>): void;
  updateTool(id: string, patch: Partial<ToolEvent>): void;
  beginTurn(): void;
  endTurn(): void;
  setTurnPhase(phase: "generating" | "waiting" | "executing"): void;
  setCurrentToolName(name: string | null): void;
  setLastActivityAt(at: number): void;
  activeAsstIdRef: Ref<number | null>;
  /** Tool calls finalized but not yet answered (id → name). */
  pendingToolCallsRef: Ref<Map<string, string>>;
  findTool(name: string): Pick<ToolSpec, "render"> | undefined;
  onUsage(usage: Usage): void;
  onUsageFinal(usage: Usage, meta?: ResponseMeta): void;
  onResponseMeta(meta: ResponseMeta): void;
  onTasks(tasks: Task[]): void;
  onPlanOptions(options: PlanOption[]): void;
  askPermission: PermissionAsker;
  /** Project context looks stale (shown once per session). */
  onKimiMdStale(): void;
  setSkillsActive(count: number): void;
  now?: () => number;
}

/** The AgentCallbacks for one TUI turn. */
export function createTurnCallbacks(deps: TurnCallbackDeps): AgentCallbacks {
  const now = deps.now ?? Date.now;
  const push = (event: ChatEvent) => deps.setEvents((events) => [...events, event]);
  const info = (text: string) => push({ kind: "info", key: deps.mkKey(), text });
  const touch = () => deps.setLastActivityAt(now());
  const plural = (n: number) => `memor${n === 1 ? "y" : "ies"}`;

  return {
    onCompacted: (c) =>
      info(
        `context budget: compacted ${c.turnsRemoved} older turn${c.turnsRemoved === 1 ? "" : "s"} (${c.tokensBefore} → ${c.tokensAfter} tokens, ${c.artifactsArchived} artifacts archived)`,
      ),
    onAssistantStart: () => {
      const id = deps.mkAssistantId();
      deps.activeAsstIdRef.current = id;
      deps.beginTurn();
      deps.setTurnPhase("generating");
      touch();
      push({ kind: "assistant", key: `asst_${id}`, id, text: "", reasoning: "", streaming: true });
    },
    onReasoningDelta: (d) => {
      const id = deps.activeAsstIdRef.current;
      if (id !== null) deps.updateAssistant(id, (e) => ({ reasoning: e.reasoning + d }));
      touch();
    },
    onTextDelta: (d) => {
      const id = deps.activeAsstIdRef.current;
      if (id !== null) deps.updateAssistant(id, (e) => ({ text: e.text + d }));
      touch();
    },
    onInfo: info,
    onAssistantFinal: () => {
      const id = deps.activeAsstIdRef.current;
      if (id !== null) deps.updateAssistant(id, () => ({ streaming: false }));
      deps.setTurnPhase("waiting");
      // No tool calls finalized: the turn is effectively done. Return to idle
      // now rather than waiting for the supervisor's onDone.
      if (deps.pendingToolCallsRef.current.size === 0) deps.endTurn();
    },
    onToolCallFinalized: (call) => {
      deps.pendingToolCallsRef.current.set(call.id, call.function.name);
      deps.setTurnPhase("executing");
      deps.setCurrentToolName(call.function.name);
      touch();
      push(toolCallEvent(call, deps.findTool(call.function.name)));
    },
    onToolWillExecute: (id, name) => {
      deps.setTurnPhase("executing");
      deps.setCurrentToolName(name);
      touch();
      deps.updateTool(id, { status: "running", startedAt: now() });
    },
    onToolResult: (r) => {
      deps.pendingToolCallsRef.current.delete(r.tool_call_id);
      touch();
      if (deps.pendingToolCallsRef.current.size === 0) {
        deps.setTurnPhase("waiting");
        deps.setCurrentToolName(null);
        // Unblock the UI before onIterationEnd (compaction / memory recall)
        // so the user isn't stuck watching a spinner during housekeeping.
        deps.endTurn();
      }
      deps.updateTool(r.tool_call_id, toolResultPatch(r));
    },
    onUsage: deps.onUsage,
    onUsageFinal: deps.onUsageFinal,
    onResponseMeta: deps.onResponseMeta,
    onTasks: deps.onTasks,
    onPlanOptions: deps.onPlanOptions,
    askPermission: deps.askPermission,
    // Sandbox/memory warnings (e.g. Code Mode falling back to node:vm).
    onWarning: info,
    onGuardrail: (ev: GuardrailEvent) => {
      if (ev.kind === "loop_recovery" || ev.kind === "loop_stopped") return;
      info(ev.message);
    },
    onKimiMdStale: deps.onKimiMdStale,
    onMemoryRecalled: (count) => push({ kind: "memory", key: deps.mkKey(), text: `recalled ${count} ${plural(count)} about this repo` }),
    onSkillsSelected: (result: SemanticSkillRoutingResult) => deps.setSkillsActive(result.sectionCount),
    onMetaBanner: (m) =>
      push({
        kind: "meta",
        key: deps.mkKey(),
        intentTier: m.intentTier as "light" | "medium" | "heavy",
        skillsActive: m.skillsActive,
        memoryRecalled: m.memoryRecalled,
      }),
  };
}
