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

  /** Guard against double-aborts when an interrupt fires while abort is
   *  already in progress. */
  isAbortingRef: React.MutableRefObject<boolean>;

  /** The TurnSupervisor instance that owns per-turn phase tracking. */
  supervisorRef: React.MutableRefObject<TurnSupervisor>;

  /** Coarse phase for the status pill ("generating" / "executing" / "waiting"). */
  turnPhase: TurnPhase;
  setTurnPhase: (p: TurnPhase) => void;

  /** Name of the currently-executing tool, surfaced in the status pill. */
  currentToolName: string | null;
  setCurrentToolName: (n: string | null) => void;

  /** Counter that ticks once per completed turn — used by the periodic
   *  hooks (memory housekeeping, etc.) that fire every N turns. */
  turnCounterRef: React.MutableRefObject<number>;

  // ── Reasoning view ─────────────────────────────────────────────────
  showReasoning: boolean;
  setShowReasoning: (b: boolean | ((prev: boolean) => boolean)) => void;

  // ── Task tracking (the agent's todo list during a turn) ────────────
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  tasksRef: React.MutableRefObject<Task[]>;

  // ── Operations ─────────────────────────────────────────────────────
  /** Flip into the "model is running" state. Sets busy=true and mirrors
   *  it to the ref. */
  beginTurn: () => void;

  /** Tear down per-turn lifecycle state. Clears busy / busyRef / phase
   *  / current tool / abort flag. Does NOT
   *  touch refs owned by other controllers (permission, limit/loop,
   *  pending tool calls); the caller orchestrates those. */
  endTurn: () => void;

  /** Wipe the task-list state. Called
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
  const supervisorRef = useRef<TurnSupervisor>(new TurnSupervisor());

  const [turnPhase, setTurnPhase] = useState<TurnPhase>("waiting");
  const [currentToolName, setCurrentToolName] = useState<string | null>(null);
  const turnCounterRef = useRef(0);

  const [showReasoning, setShowReasoning] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const tasksRef = useRef<Task[]>([]);

  const beginTurn = useCallback(() => {
    setBusy(true);
    busyRef.current = true;
  }, []);

  const endTurn = useCallback(() => {
    setBusy(false);
    busyRef.current = false;
    setTurnPhase("waiting");
    setCurrentToolName(null);
    isAbortingRef.current = false;
  }, []);

  const clearTaskTracking = useCallback(() => {
    setTasks([]);
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
    isAbortingRef,
    supervisorRef,
    turnPhase, setTurnPhase,
    currentToolName, setCurrentToolName,
    turnCounterRef,
    showReasoning, setShowReasoning,
    tasks, setTasks, tasksRef,
    beginTurn, endTurn, clearTaskTracking, markAborting,
  };
}
