import React, { useCallback, useRef, useState } from "react";
import { TurnSupervisor } from "../agent/supervisor.js";
import type { TurnPhase } from "./view-types.js";
import type { Task } from "../tools/registry.js";

export interface TurnController {
  // ── Lifecycle state ────────────────────────────────────────────────
  /** True while a model turn is in flight. */
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Synchronous mirror of `busy` for hot paths (input handler, agent
   *  callbacks) that need to read it without waiting for a re-render. */
  busyRef: React.MutableRefObject<boolean>;

  /** Guard against double-aborts when Ctrl+C / Esc fire while abort is
   *  already in progress. */
  isAbortingRef: React.MutableRefObject<boolean>;
  /** Esc debounce (used by the input handler to require two quick
   *  presses for certain paths). */
  lastEscapeAtRef: React.MutableRefObject<number>;

  /** The TurnSupervisor instance that owns per-turn phase tracking. */
  supervisorRef: React.MutableRefObject<TurnSupervisor>;

  /** Coarse phase for the status pill ("generating" / "executing" / "waiting"). */
  turnPhase: TurnPhase;
  setTurnPhase: (p: TurnPhase) => void;

  /** Timestamp the current turn started, or null between turns. Drives
   *  the elapsed-time display in the status bar. */
  turnStartedAt: number | null;
  setTurnStartedAt: (n: number | null) => void;

  /** Name of the currently-executing tool, surfaced in the status pill. */
  currentToolName: string | null;
  setCurrentToolName: (n: string | null) => void;

  /** Wall-clock of the last streamed delta / tool result. Used by the
   *  status pill to detect stalls. */
  lastActivityAt: number | null;
  setLastActivityAt: (n: number | null) => void;

  /** Counter that ticks once per completed turn — used by the periodic
   *  hooks (memory housekeeping, etc.) that fire every N turns. */
  turnCounterRef: React.MutableRefObject<number>;

  // ── Reasoning view ─────────────────────────────────────────────────
  showReasoning: boolean;
  setShowReasoning: (b: boolean | ((prev: boolean) => boolean)) => void;
  toggleReasoning: () => void;

  // ── Task tracking (the agent's todo list during a turn) ────────────
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  tasksRef: React.MutableRefObject<Task[]>;
  tasksStartedAt: number | null;
  setTasksStartedAt: (n: number | null) => void;
  tasksStartTokens: number;
  setTasksStartTokens: (n: number) => void;

  // ── Operations ─────────────────────────────────────────────────────
  /** Flip into the "model is running" state. Sets busy=true, mirrors
   *  to the ref, stamps turnStartedAt=now. */
  beginTurn: () => void;

  /** Tear down per-turn lifecycle state. Clears busy / busyRef / phase
   *  / current tool / activity / abort flag / turnStartedAt. Does NOT
   *  touch refs owned by other controllers (permission, limit/loop,
   *  pending tool calls); the caller orchestrates those. */
  endTurn: () => void;

  /** Wipe the task-list state (tasks, startedAt, startTokens). Called
   *  on abort and at turn end so the list doesn't linger. */
  clearTaskTracking: () => void;

  /** Mark abort-in-progress and ask the supervisor to kill the turn.
   *  Returns true on the first call within a turn, false on re-entry. */
  markAborting: () => boolean;
}

export function useTurnController(): TurnController {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const isAbortingRef = useRef(false);
  const lastEscapeAtRef = useRef(0);
  const supervisorRef = useRef<TurnSupervisor>(new TurnSupervisor());

  const [turnPhase, setTurnPhase] = useState<TurnPhase>("waiting");
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [currentToolName, setCurrentToolName] = useState<string | null>(null);
  const [lastActivityAt, setLastActivityAt] = useState<number | null>(null);
  const turnCounterRef = useRef(0);

  const [showReasoning, setShowReasoning] = useState(false);
  const toggleReasoning = useCallback(() => {
    setShowReasoning((s) => !s);
  }, []);

  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);
  const [tasksStartedAt, setTasksStartedAt] = useState<number | null>(null);
  const [tasksStartTokens, setTasksStartTokens] = useState<number>(0);

  const beginTurn = useCallback(() => {
    setBusy(true);
    busyRef.current = true;
    setTurnStartedAt(Date.now());
  }, []);

  const endTurn = useCallback(() => {
    setBusy(false);
    busyRef.current = false;
    setTurnStartedAt(null);
    setTurnPhase("waiting");
    setCurrentToolName(null);
    setLastActivityAt(null);
    isAbortingRef.current = false;
  }, []);

  const clearTaskTracking = useCallback(() => {
    setTasks([]);
    setTasksStartedAt(null);
    setTasksStartTokens(0);
    tasksRef.current = [];
  }, []);

  const markAborting = useCallback((): boolean => {
    if (isAbortingRef.current) return false;
    isAbortingRef.current = true;
    supervisorRef.current.killTurn();
    return true;
  }, []);

  return {
    busy, setBusy, busyRef,
    isAbortingRef, lastEscapeAtRef,
    supervisorRef,
    turnPhase, setTurnPhase,
    turnStartedAt, setTurnStartedAt,
    currentToolName, setCurrentToolName,
    lastActivityAt, setLastActivityAt,
    turnCounterRef,
    showReasoning, setShowReasoning, toggleReasoning,
    tasks, setTasks, tasksRef,
    tasksStartedAt, setTasksStartedAt,
    tasksStartTokens, setTasksStartTokens,
    beginTurn, endTurn, clearTaskTracking, markAborting,
  };
}
