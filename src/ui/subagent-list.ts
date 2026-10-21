import { useEffect, useState } from "react";
import { workerRegistry, type RunningWorker } from "../tools/worker-registry.js";

/** `/subagents`, `/subagents list`, and `/subagents cancel …` run immediately
 *  even while a turn is busy (subagents only exist during a turn). Policy
 *  changes (`/subagents off|suggest|auto`) still wait for the turn. */
export function isImmediateSubagentCommand(text: string): boolean {
  return /^\/subagents(?:\s+(?:list|ls|help|cancel|stop|stats)\b.*|\s*)$/i.test(text.trim());
}

/** `/now`: promote the latest queued message (same as Ctrl+G, which the
 *  Camouflage renderer cannot deliver as a key press). */
export function isRunNowCommand(text: string): boolean {
  return /^\/now\s*$/i.test(text.trim());
}

/** Running subagents, updated on start/stop/cancel (no timer). */
export function useSubagentList(): RunningWorker[] {
  const [workers, setWorkers] = useState<RunningWorker[]>(() => workerRegistry.list());
  useEffect(() => workerRegistry.subscribe(setWorkers), []);
  return workers;
}
