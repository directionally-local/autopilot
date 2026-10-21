import React from "react";
import type { TurnSupervisor } from "../agent/supervisor.js";
import type { AbortScope } from "../util/abort-scope.js";
import type { LspManager } from "../lsp/manager.js";
import type { ChatEvent } from "./view-types.js";
import { appendStoppedToolResults, type ChatMessage } from "../agent/messages.js";

// ── Shared dep shape ─────────────────────────────────────────────────────

export interface InterruptDeps {
  // Turn-state refs
  busyRef: React.MutableRefObject<boolean>;
  activeScopeRef: React.MutableRefObject<AbortScope | null>;
  isAbortingRef: React.MutableRefObject<boolean>;
  supervisorRef: React.MutableRefObject<TurnSupervisor>;
  // Permission controller
  hasPendingPermission: () => boolean;
  denyPendingPermission: () => boolean;
  // In-flight tool calls (so we can mark them cancelled on abort)
  pendingToolCallsRef: React.MutableRefObject<Map<string, string>>;
  // Conversation history: in-flight tool calls get a "(stopped)" result so
  // the saved history stays valid for the API.
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  updateTool: (id: string, patch: Partial<Extract<ChatEvent, { kind: "tool" }>>) => void;
  // Event stream
  setEvents: React.Dispatch<React.SetStateAction<ChatEvent[]>>;
  mkKey: () => string;
  // Side-effects on interrupt
  saveSessionSafe: () => Promise<void> | void;
  clearTaskTracking: () => void;
  // App exit (Ctrl+C / SIGINT idle path)
  lspManagerRef: React.MutableRefObject<LspManager>;
  exit: () => void;
  /**
   * If true, do not iterate `pendingToolCallsRef` to mark in-flight
   * tool events as cancelled. Preserves the pre-refactor asymmetry
   * where the SIGINT handler (process-level signal, not Ink-level
   * keystroke) skipped this cleanup. Defaults to false.
   */
  skipPendingToolCleanup?: boolean;
}

// ── Outcome reporting ────────────────────────────────────────────────────

export interface InterruptOutcome {
  hadPermission: boolean;
  /** True when the busy turn was actually interrupted (i.e. all guards
   *  passed: busy + active scope + not already aborting). */
  didInterruptTurn: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Common interrupt sequence used by Ctrl+C, Esc, and SIGINT. Denies any
 * pending permission and (if a turn is
 * actually running) kills the turn, aborts the scope, marks in-flight
 * tools cancelled, emits an "(interrupted)" event, and triggers a
 * session save + task-list clear. Returns flags so the caller can take
 * follow-up action (e.g. exit the app when nothing was interrupted).
 *
 * NOTE: this does NOT exit the app on its own — that's left to
 * `exitAppIfIdle`, which checks the returned flags.
 */
export function interruptTurn(deps: InterruptDeps): InterruptOutcome {
  const hadPermission = deps.denyPendingPermission();

  if (
    (deps.busyRef.current || deps.supervisorRef.current.isRunning) &&
    deps.activeScopeRef.current &&
    !deps.isAbortingRef.current
  ) {
    deps.isAbortingRef.current = true;
    deps.supervisorRef.current.killTurn();
    deps.activeScopeRef.current.abort("user_stopped");
    deps.setEvents((e) => [
      ...e,
      { kind: "info", key: deps.mkKey(), text: "(interrupted)" },
    ]);
    // The assistant message carrying these tool_calls is already in history,
    // so the save below would otherwise persist calls without results and
    // the next request (or a later resume) would be rejected by the API.
    appendStoppedToolResults(deps.messagesRef.current, deps.pendingToolCallsRef.current);
    if (!deps.skipPendingToolCleanup) {
      for (const [toolId] of deps.pendingToolCallsRef.current) {
        deps.updateTool(toolId, { status: "cancelled" });
      }
      deps.pendingToolCallsRef.current.clear();
    }
    void deps.saveSessionSafe();
    deps.clearTaskTracking();
    return { hadPermission, didInterruptTurn: true };
  }
  return { hadPermission, didInterruptTurn: false };
}

/**
 * Exit the app cleanly via the LSP manager's stopAll(). Used by Ctrl+C
 * and SIGINT when there was nothing to interrupt — the user wants to
 * quit.
 */
export function exitApp(deps: InterruptDeps): void {
  void deps.lspManagerRef.current.stopAll().finally(() => deps.exit());
}

/**
 * Convenience: run `interruptTurn`, then exit the app if nothing was
 * actually pending (no permission, nothing to interrupt). Mirrors the Ctrl+C / SIGINT decision tree.
 */
export function interruptOrExit(deps: InterruptDeps): InterruptOutcome {
  const outcome = interruptTurn(deps);
  if (!outcome.didInterruptTurn && !outcome.hadPermission) {
    exitApp(deps);
  }
  return outcome;
}
