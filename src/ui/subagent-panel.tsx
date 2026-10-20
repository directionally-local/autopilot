import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme-context.js";
import { workerRegistry, type RunningWorker } from "../tools/worker-registry.js";
import { formatElapsed } from "./slash-commands.js";

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

/** Live list of running subagents, re-rendered each second for elapsed time. */
export function useRunningSubagents(): { workers: RunningWorker[]; now: number } {
  const [workers, setWorkers] = useState<RunningWorker[]>(() => workerRegistry.list());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => workerRegistry.subscribe(setWorkers), []);
  useEffect(() => {
    if (workers.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [workers.length]);
  return { workers, now };
}

export function SubagentPanel() {
  const theme = useTheme();
  const { workers, now } = useRunningSubagents();
  if (workers.length === 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {workers.map((w) => (
        <Text key={w.id} color={theme.info.color}>
          <Text color={theme.accent}>⧉ #{w.index}</Text> {formatElapsed(now - w.startedAt)}{" "}
          {w.status === "cancelling" ? <Text dimColor>(cancelling) </Text> : null}
          {w.background ? <Text dimColor>(background) </Text> : null}
          <Text dimColor={theme.info.dim}>{preview(w.task)}</Text>
        </Text>
      ))}
      <Text color={theme.info.color} dimColor={theme.info.dim}>
        <Text bold>/subagents cancel {workers.length === 1 ? workers[0]!.index : "<n>"}</Text> stops one
        {workers.length > 1 ? <> · <Text bold>/subagents cancel all</Text></> : null} · the turn keeps going
      </Text>
    </Box>
  );
}

function preview(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 90 ? `${single.slice(0, 89)}…` : single;
}
