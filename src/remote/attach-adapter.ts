/**
 * Aster event → interactive UI state, for `autopilot attach-remote`.
 *
 * The Camouflage view draws App snapshots (ChatEvents, tasks, usage, a
 * pending permission). A remote session has no App: its events arrive from
 * the Aster API's SSE stream instead. This module folds those events into
 * the same snapshot pieces a local session produces, so the view renders a
 * remote turn exactly like a local one. Pure: no I/O, no timers.
 */

import type { ChatEvent, ToolEventState, TurnPhase } from "../ui/view-types.js";
import type { Task } from "../tools/registry.js";
import type { Usage } from "../agent/messages.js";
import type { RemoteEvent } from "./client.js";

/** Run outcomes the server emits as their own event type. */
export const ASTER_TERMINAL_EVENTS = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface PendingApproval {
  approvalId: string;
  tool: string;
  explanation: string;
  expiresAt?: number | string;
}

export interface AsterViewState {
  events: ChatEvent[];
  tasks: Task[];
  /** The current run's cumulative usage (the server reports totals per run). */
  usage: Usage | null;
  /** Cost of the current run so far. */
  runCostUsd: number;
  /** Cost of the conversation's finished runs. */
  priorCostUsd: number;
  /** A turn is in flight on the server, as far as the events say. */
  running: boolean;
  phase: TurnPhase;
  currentTool: string | null;
  approval: PendingApproval | null;
  /** The assistant message deltas are appended to, until a tool or the turn's end closes it. */
  openAssistant: string | null;
  lastEventId: number;
}

/** What the session controller must act on after an event (the adapter itself does no I/O). */
export type AsterEffect =
  | { kind: "turnEnded"; status: string }
  | { kind: "approvalRequired"; approvalId: string }
  | { kind: "approvalResolved"; approvalId: string };

export function initialAsterState(): AsterViewState {
  return {
    events: [],
    tasks: [],
    usage: null,
    runCostUsd: 0,
    priorCostUsd: 0,
    running: false,
    phase: "waiting",
    currentTool: null,
    approval: null,
    openAssistant: null,
    lastEventId: 0,
  };
}

/** Total cost of the conversation as far as the events go. */
export function totalCostUsd(state: AsterViewState): number {
  return state.priorCostUsd + state.runCostUsd;
}

/**
 * Fold one Aster event into the state. Events at or below the last applied
 * ID are ignored (SSE delivery is at-least-once). Returns what the caller
 * must do about it.
 */
export function applyAsterEvent(state: AsterViewState, event: RemoteEvent): AsterEffect[] {
  if (event.id <= state.lastEventId) return [];
  state.lastEventId = event.id;
  const d = event.data;
  const key = `aster-${event.id}`;
  switch (event.type) {
    case "assistant.delta": {
      const text = str(d.text) ?? str(d.delta) ?? "";
      if (!text) return [];
      beginActivity(state);
      state.phase = "generating";
      const msg = openAssistant(state, key);
      replace(state, msg.key, { ...msg, text: msg.text + text });
      return [];
    }
    case "assistant.reasoning": {
      const text = str(d.text) ?? "";
      if (!text) return [];
      beginActivity(state);
      const msg = openAssistant(state, key);
      replace(state, msg.key, { ...msg, reasoning: msg.reasoning + text });
      return [];
    }
    case "tool.activity":
      return toolActivity(state, key, d);
    case "todo.updated": {
      const items = Array.isArray(d.items) ? d.items : [];
      state.tasks = items.flatMap((raw, i) => {
        if (!raw || typeof raw !== "object") return [];
        const item = raw as Record<string, unknown>;
        const title = str(item.title);
        if (!title) return [];
        const status = item.status === "done" || item.status === "completed" ? "completed" : item.status === "in_progress" ? "in_progress" : "pending";
        return [{ id: String(i + 1), title, status } satisfies Task];
      });
      return [];
    }
    case "usage": {
      const input = num(d.inputTokens);
      const output = num(d.outputTokens);
      state.usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, cost: num(d.costUsd) };
      // Cumulative per run (the documented shape); a non-cumulative event adds to it.
      state.runCostUsd = d.cumulative === false ? state.runCostUsd + num(d.costUsd) : num(d.costUsd);
      return [];
    }
    case "approval.required": {
      const approvalId = str(d.approvalId);
      if (!approvalId) return [];
      closeAssistant(state);
      state.approval = {
        approvalId,
        tool: str(d.tool) ?? "tool",
        explanation: str(d.explanation) ?? "",
        ...(typeof d.expiresAt === "number" || typeof d.expiresAt === "string" ? { expiresAt: d.expiresAt } : {}),
      };
      state.phase = "waiting";
      return [{ kind: "approvalRequired", approvalId }];
    }
    case "approval.resolved":
    case "approval.expired": {
      const approvalId = str(d.approvalId) ?? "";
      if (state.approval && (!approvalId || state.approval.approvalId === approvalId)) {
        const id = state.approval.approvalId;
        state.approval = null;
        if (event.type === "approval.expired") push(state, { kind: "info", key, text: "The approval request expired; the action was not run.", tone: "warn" });
        return [{ kind: "approvalResolved", approvalId: id }];
      }
      return [];
    }
    case "checkpoint.created": {
      const id = str(d.id);
      const message = str(d.message);
      push(state, { kind: "info", key, text: `Checkpoint ${id ? id.slice(0, 7) : ""}${message ? ` · ${oneLine(message, 100)}` : ""}`.trim() });
      return [];
    }
    case "checkpoint.restored":
      push(state, { kind: "info", key, text: `Workspace restored to checkpoint ${str(d.restoredFrom)?.slice(0, 7) ?? ""}`.trim() });
      return [];
    case "memory.updated": {
      const items = Array.isArray(d.items) ? d.items.length : 0;
      if (items > 0) push(state, { kind: "memory", key, text: `Remembered ${items} ${items === 1 ? "thing" : "things"} for this project` });
      return [];
    }
    case "artifact.updated": {
      const path = str(d.path);
      if (path) push(state, { kind: "info", key, text: `Artifact updated: ${path}` });
      return [];
    }
    case "outcome": {
      const summary = str(d.summary);
      if (summary) push(state, { kind: "info", key, text: summary });
      return [];
    }
    case "outcome.failed":
      push(state, { kind: "error", key, text: outcomeFailure(str(d.reason)) });
      return [];
    case "conversation.paused":
      push(state, { kind: "info", key, text: "The conversation's sandbox was paused." });
      return [];
    case "conversation.resumed":
      push(state, { kind: "info", key, text: "The conversation's sandbox resumed." });
      return [];
    case "conversation.destroyed":
      push(state, { kind: "error", key, text: "This conversation was deleted on the server." });
      return [];
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      endTurn(state, key, event.type, str(d.reason) ?? str(d.code));
      return [{ kind: "turnEnded", status: event.type }];
    default:
      // conversation.created, heartbeats and future event types: nothing to show.
      return [];
  }
}

function toolActivity(state: AsterViewState, key: string, d: Record<string, unknown>): AsterEffect[] {
  const tool = str(d.tool) ?? "tool";
  const callId = str(d.toolCallId);
  const activity = str(d.activity);
  if (activity === "started") {
    beginActivity(state);
    closeAssistant(state);
    const toolKey = `tool-${callId ?? key}`;
    if (!state.events.some((e) => e.key === toolKey)) {
      push(state, {
        kind: "tool",
        key: toolKey,
        id: callId ?? key,
        name: tool,
        args: str(d.input) ?? "",
        status: "running",
        startedAt: Date.now(),
      });
    }
    state.phase = "executing";
    state.currentTool = tool;
    return [];
  }
  if (activity === "completed" || activity === "failed") {
    const toolKey = `tool-${callId ?? ""}`;
    const existing = callId ? state.events.find((e): e is Extract<ChatEvent, { kind: "tool" }> => e.kind === "tool" && e.key === toolKey) : undefined;
    const status: ToolEventState["status"] = activity === "completed" ? "done" : "error";
    const result = str(d.output) ?? "";
    if (existing) replace(state, existing.key, { ...existing, status, result });
    else push(state, { kind: "tool", key: `tool-${callId ?? key}`, id: callId ?? key, name: tool, args: "", status, result });
    if (!state.events.some((e) => e.kind === "tool" && (e.status === "running" || e.status === "queued"))) {
      state.currentTool = null;
      state.phase = "generating";
    }
    return [];
  }
  if (activity === "rejected") {
    const reason = str(d.reason);
    push(state, { kind: "info", key, text: `${tool} was not run${reason ? ` (${reason.replace(/_/g, " ")})` : " (denied)"}`, tone: "warn" });
    return [];
  }
  // "proposed" / "approved": the approval prompt and the tool row say it already.
  return [];
}

function endTurn(state: AsterViewState, key: string, status: string, reason: string | undefined): void {
  closeAssistant(state);
  const toolStatus: ToolEventState["status"] = status === "completed" ? "done" : status === "failed" ? "error" : "cancelled";
  state.events = state.events.map((e) => (e.kind === "tool" && (e.status === "running" || e.status === "queued") ? { ...e, status: toolStatus } : e));
  if (status === "failed") push(state, { kind: "error", key, text: `The turn failed${reason && reason !== "error" ? `: ${reason}` : ""}.` });
  else if (status === "cancelled") push(state, { kind: "info", key, text: "Turn cancelled." });
  else if (status === "interrupted") {
    push(state, { kind: "info", key, text: `The turn was interrupted on the server${reason ? ` (${reason.replace(/_/g, " ")})` : ""}. Send a message to continue.`, tone: "warn" });
  }
  state.running = false;
  state.phase = "waiting";
  state.currentTool = null;
  state.approval = null;
  state.priorCostUsd += state.runCostUsd;
  state.runCostUsd = 0;
}

/** Any run activity means a turn is in flight (also true while replaying history). */
function beginActivity(state: AsterViewState): void {
  state.running = true;
}

function openAssistant(state: AsterViewState, key: string): Extract<ChatEvent, { kind: "assistant" }> {
  const open = state.openAssistant ? state.events.find((e) => e.key === state.openAssistant) : undefined;
  if (open?.kind === "assistant") return open;
  const msg: Extract<ChatEvent, { kind: "assistant" }> = { kind: "assistant", key, id: state.lastEventId, text: "", reasoning: "", streaming: true };
  state.events.push(msg);
  state.openAssistant = key;
  return msg;
}

function closeAssistant(state: AsterViewState): void {
  if (!state.openAssistant) return;
  const open = state.events.find((e) => e.key === state.openAssistant);
  if (open?.kind === "assistant") replace(state, open.key, { ...open, streaming: false });
  state.openAssistant = null;
}

function push(state: AsterViewState, event: ChatEvent): void {
  // Notices end the assistant message they follow, like a local turn's step boundary.
  if (event.kind !== "assistant") closeAssistant(state);
  state.events.push(event);
}

function replace(state: AsterViewState, key: string, next: ChatEvent): void {
  const i = state.events.findIndex((e) => e.key === key);
  if (i >= 0) state.events[i] = next;
}

function outcomeFailure(reason: string | undefined): string {
  if (reason === "git_push_failed") return "The changes couldn't be pushed to the conversation branch.";
  if (reason === "pull_request_failed") return "The changes were pushed, but opening the pull request failed.";
  return `The turn's outcome failed${reason ? `: ${reason.replace(/_/g, " ")}` : ""}.`;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
