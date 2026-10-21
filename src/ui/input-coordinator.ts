/**
 * The TUI's input coordinator, extracted from App: what happens to a line
 * the user submits (run it, queue it behind the running turn, edit the
 * latest prompt, plan the queue, act on a subagent command mid-turn), and
 * mid-turn triage of queued prompts (#725) — keep queued, answer as an
 * aside, steer the running turn, or interrupt it.
 *
 * The decisions are pure functions; the triage coordinator takes its IO
 * (queue, events, the aside model, the interrupt) as explicit deps. App
 * executes the decision against its own state.
 */

import type { ChatMessage } from "../agent/messages.js";
import { createQueueBatch, type QueuedPrompt } from "../agent/queue-batch.js";
import { planTriageAction, steerMessage, type TriageResult } from "../agent/inbox-triage.js";
import { isImmediateSubagentCommand, isRunNowCommand } from "./subagent-list.js";
import { parseBangCommand } from "./bang-command.js";
import { replaceQueuedPrompt } from "./app-helpers.js";
import type { Task } from "../tools/registry.js";

/** The latest submitted chat prompt, editable from history. */
export interface PromptEditTarget {
  key: string;
  historyText: string;
  /** History before that prompt ran (null while it's still queued). */
  messagesBefore: ChatMessage[] | null;
}

export interface SubmitState {
  busy: boolean;
  queue: QueuedPrompt[];
  history: string[];
  historyIndex: number;
  editTarget: PromptEditTarget | null;
  /** The edit target's user event is still in the transcript. */
  editTargetVisible: boolean;
}

export type SubmitDecision =
  | { do: "ignore" }
  /** `/queue plan`: open the planner, or explain why not. */
  | { do: "queue-plan"; notice?: string }
  /** Re-submitted the latest prompt unchanged. */
  | { do: "edit-unchanged" }
  /** Edited the latest prompt while it's still queued. */
  | { do: "edit-queued"; target: PromptEditTarget; queue: QueuedPrompt[] }
  /** Edited the latest prompt after it ran: rerun it from the history before it. */
  | { do: "edit-rerun"; target: PromptEditTarget & { messagesBefore: ChatMessage[] } }
  /** `/now`: promote the latest queued prompt into the running turn. */
  | { do: "run-now" }
  /** Subagent management runs immediately, even mid-turn. */
  | { do: "subagent-command" }
  /** Busy: queue it; chat prompts are then triaged. */
  | { do: "enqueue"; isChatPrompt: boolean }
  | { do: "run" };

export function decideSubmit(full: string, display: string, state: SubmitState): SubmitDecision {
  if (!full) return { do: "ignore" };

  if (/^\/queue\s+plan$/i.test(full)) {
    if (state.queue.length < 2) return { do: "queue-plan", notice: "Queue planning needs at least two queued chat prompts." };
    if (!createQueueBatch(state.queue)) {
      return { do: "queue-plan", notice: "Queue planning only groups chat prompts; slash commands and ! shell commands stay in the FIFO queue." };
    }
    return { do: "queue-plan" };
  }

  const target = state.editTarget;
  const selected = state.history[state.historyIndex];
  if (target && state.editTargetVisible && state.historyIndex === state.history.length - 1 && selected === target.historyText) {
    if (display === selected) return { do: "edit-unchanged" };
    const queue = replaceQueuedPrompt(state.queue, target.key, full, display);
    if (queue) return { do: "edit-queued", target, queue };
    if (target.messagesBefore) return { do: "edit-rerun", target: { ...target, messagesBefore: target.messagesBefore } };
  }

  if (isRunNowCommand(full)) return { do: "run-now" };
  if (state.busy && isImmediateSubagentCommand(full)) return { do: "subagent-command" };
  if (state.busy) return { do: "enqueue", isChatPrompt: !full.startsWith("/") && parseBangCommand(full) === null };
  return { do: "run" };
}

/** Append to input history unless it repeats the last entry. */
export function pushHistory(history: string[], entry: string): string[] {
  return history.length > 0 && history[history.length - 1] === entry ? history : [...history, entry];
}

// ── Mid-turn triage ──────────────────────────────────────────────────────

export interface ActivitySnapshot {
  currentTask: string;
  activity?: string;
  progress?: string;
  recentAssistantText?: string;
}

const textOf = (m: ChatMessage | undefined): string =>
  !m
    ? ""
    : typeof m.content === "string"
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join(" ")
        : "";

/** What the agent is doing right now, for the triage and aside models. */
export function describeActivity(input: {
  messages: ChatMessage[];
  tasks: Task[];
  pendingTools: string[];
  workers: Array<{ task: string }>;
}): ActivitySnapshot {
  const reversed = [...input.messages].reverse();
  const currentTask = textOf(
    reversed.find(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        !m.content.startsWith("[Message from the user") &&
        !m.content.startsWith("[The user asked to handle"),
    ),
  );
  const recentAssistantText = textOf(reversed.find((m) => m.role === "assistant" && textOf(m).length > 0));
  const inProgress = input.tasks.find((t) => t.status === "in_progress");
  const done = input.tasks.filter((t) => t.status === "completed").length;
  const progress =
    input.tasks.length > 0 ? `${done}/${input.tasks.length} tasks done${inProgress ? `; working on: ${inProgress.title}` : ""}` : undefined;
  const activity =
    [
      input.pendingTools.length ? `tools: ${input.pendingTools.join(", ")}` : "",
      input.workers.length ? `${input.workers.length} subagent(s): ${input.workers.map((w) => w.task.slice(0, 60)).join("; ")}` : "",
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  return { currentTask, activity, progress, recentAssistantText };
}

export interface TriageDeps {
  isBusy(): boolean;
  subagentsRunning(): boolean;
  getQueue(): QueuedPrompt[];
  /** Replace the queue (ref and rendered state together). */
  setQueue(update: (queue: QueuedPrompt[]) => QueuedPrompt[]): void;
  /** Mark a queued user event delivered and add a notice. */
  markDelivered(key: string, note: string): void;
  notice(text: string): void;
  /** Camouflage has no inline queue line, so "queued" notes go to the transcript. */
  transcriptQueueNotes: boolean;
  activity(): ActivitySnapshot;
  triage(text: string, activity: ActivitySnapshot): Promise<TriageResult>;
  /** Answer as an aside without stopping the agent; null when no aside model. */
  answerAside: ((text: string, activity: ActivitySnapshot) => Promise<string>) | null;
  /** Steering delivered to the running turn at its next step. */
  steer(item: QueuedPrompt, content: string): void;
  interrupt(): void;
}

/** Apply triage results to queued prompts; returns the hooks App wires to submit and Ctrl+G. */
export function createTriageCoordinator(deps: TriageDeps) {
  const remove = (key: string): QueuedPrompt | null => {
    const item = deps.getQueue().find((q) => q.key === key) ?? null;
    if (item) deps.setQueue((q) => q.filter((i) => i.key !== key));
    return item;
  };
  const retag = (key: string, triage: QueuedPrompt["triage"]) =>
    deps.setQueue((q) => q.map((i) => (i.key === key ? { ...i, triage } : i)));

  const apply = (item: QueuedPrompt, result: TriageResult, promoted = false): void => {
    const action = planTriageAction(result, { busy: deps.isBusy(), subagentsRunning: deps.subagentsRunning(), promoted });
    switch (action.do) {
      case "keep-queued":
        if (action.note) {
          retag(item.key, { source: result.source, reason: result.reason });
          if (deps.transcriptQueueNotes) deps.notice(`${action.note} — runs after the current turn · /now to run it first`);
        }
        return;
      case "aside": {
        if (!deps.answerAside) return;
        void deps
          .answerAside(item.full, deps.activity())
          .then((answer) => {
            if (!remove(item.key)) return; // already ran as a normal turn
            deps.markDelivered(item.key, `aside (the agent keeps working): ${answer}`);
          })
          .catch(() => retag(item.key, { source: "default", reason: "couldn't answer as an aside" }));
        return;
      }
      case "interrupt": {
        if (!remove(item.key)) return;
        // Run it next, ahead of anything else queued; completed tool results are kept.
        deps.setQueue((q) => [{ ...item, triage: undefined }, ...q]);
        deps.notice(action.note);
        deps.interrupt();
        return;
      }
      case "steer":
        if (!remove(item.key)) return;
        deps.steer(item, steerMessage(item.full, action.urgent));
        deps.markDelivered(item.key, action.note);
        return;
    }
  };

  return {
    apply,
    /** Triage a prompt just queued behind the running turn. */
    async triageQueued(item: QueuedPrompt): Promise<void> {
      const result = await deps.triage(item.full, deps.activity());
      if (!deps.getQueue().some((q) => q.key === item.key)) return; // promoted or already ran
      apply(item, result);
    },
    /** Ctrl+G / `/now`: deliver the latest triaged prompt to the running turn. */
    promoteLatest(): boolean {
      if (!deps.isBusy()) return false;
      const latest = [...deps.getQueue()].reverse().find((q) => q.triage !== undefined);
      if (!latest) return false;
      apply(latest, { kind: "steer", source: "rule", reason: "you asked to run it now" }, true);
      return true;
    },
  };
}
