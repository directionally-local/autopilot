/**
 * Graceful process exit (#877). Every host — TUI, Camouflage bridge, print,
 * emit, RPC and `serve` — ends through here, so SessionEnd hooks and the
 * OpenTelemetry flush run on every exit path (normal quit, SIGTERM/SIGHUP,
 * an uncaught crash), bounded by one short deadline so a hung hook or
 * collector can never keep the process alive.
 *
 * Modules register their own shutdown work with `onShutdown()` (session
 * lifecycle, the OTLP exporter, the server, the Camouflage renderer); hosts
 * call `runShutdownTasks()` when they finish normally, or `gracefulExit()`
 * when the process must end now.
 */

import { logger } from "./logger.js";

/** Total time budget for all shutdown work. */
export const SHUTDOWN_TIMEOUT_MS = 3000;

/** Ordering phases: lower runs first; tasks within one phase run in parallel. */
export const SHUTDOWN_PHASE = {
  /** End sessions (SessionEnd hooks), stop servers, close renderers. */
  sessions: 0,
  /** Flush exporters once everything above has emitted its last events. */
  flush: 10,
} as const;

/** Time each later phase is guaranteed even when an earlier one hangs. */
const LATER_PHASE_RESERVE_MS = 500;

type ShutdownTask = () => unknown;

interface Registered {
  name: string;
  phase: number;
  task: ShutdownTask;
}

const tasks = new Set<Registered>();
let running: Promise<void> | null = null;
let exiting = false;

/** Register work to run once at shutdown. Returns an unregister function. */
export function onShutdown(name: string, task: ShutdownTask, phase: number = SHUTDOWN_PHASE.sessions): () => void {
  const entry: Registered = { name, phase, task };
  tasks.add(entry);
  return () => {
    tasks.delete(entry);
  };
}

/**
 * Settle with `work`, or with "timeout" after `ms`. The deadline timer is
 * deliberately not unref'd: during shutdown it may be the only thing keeping
 * the event loop alive while a hook or flush runs. It's cleared as soon as
 * `work` settles, so it never delays an exit.
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Run every registered task once, phase by phase, within `timeoutMs` in total.
 * Never throws; a task that fails or overruns is logged and abandoned.
 * Concurrent and repeated calls share the first run.
 */
export function runShutdownTasks(timeoutMs: number = SHUTDOWN_TIMEOUT_MS): Promise<void> {
  if (running) return running;
  running = (async () => {
    const deadline = Date.now() + timeoutMs;
    const phases = [...new Set([...tasks].map((t) => t.phase))].sort((a, b) => a - b);
    for (const [i, phase] of phases.entries()) {
      // Earlier phases leave time for the later ones (the OTel flush comes last).
      const reserve = Math.min(LATER_PHASE_RESERVE_MS * (phases.length - 1 - i), timeoutMs / 2);
      const remaining = deadline - reserve - Date.now();
      if (remaining <= 0) {
        logger.warn("shutdown:deadline_exceeded", { skippedPhase: phase });
        break;
      }
      const group = [...tasks].filter((t) => t.phase === phase);
      for (const t of group) tasks.delete(t);
      const settled = Promise.all(
        group.map(async (t) => {
          try {
            await t.task();
          } catch (err) {
            logger.warn("shutdown:task_failed", { task: t.name, error: (err as Error)?.message ?? String(err) });
          }
        }),
      );
      const timedOut = (await withDeadline(settled, remaining)) === "timeout";
      if (timedOut) logger.warn("shutdown:timeout", { phase, tasks: group.map((t) => t.name) });
    }
  })();
  return running;
}

/** Run the shutdown tasks (bounded), then exit with `code`. Idempotent. */
export async function gracefulExit(code: number, timeoutMs: number = SHUTDOWN_TIMEOUT_MS): Promise<never> {
  exiting = true;
  await runShutdownTasks(timeoutMs);
  process.exit(code);
}

/** True once an exit through `gracefulExit` has begun. */
export function isExiting(): boolean {
  return exiting;
}

const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

export interface ExitSignalOptions {
  /** Signals to handle. SIGINT is left to the host by default (it may cancel a turn first). */
  signals?: NodeJS.Signals[];
  /** Exit code for a signal; defaults to the conventional 128 + signal number. */
  exitCode?: (signal: NodeJS.Signals) => number;
  /** Also run the shutdown tasks after an uncaught exception or unhandled rejection. */
  crashes?: boolean;
}

const installed = new Set<string>();

/**
 * Exit gracefully on termination signals (and, optionally, crashes). A second
 * signal while shutting down exits immediately. Idempotent per signal.
 */
export function installExitHandlers(opts: ExitSignalOptions = {}): void {
  const exitCode = opts.exitCode ?? ((signal: NodeJS.Signals) => 128 + (SIGNAL_NUMBERS[signal] ?? 0));
  for (const signal of opts.signals ?? (["SIGTERM", "SIGHUP"] as NodeJS.Signals[])) {
    if (installed.has(signal)) continue;
    installed.add(signal);
    process.on(signal, () => {
      const code = exitCode(signal);
      if (exiting) process.exit(code);
      logger.info("shutdown:signal", { signal });
      void gracefulExit(code);
    });
  }
  if (opts.crashes && !installed.has("crash")) {
    installed.add("crash");
    const onCrash = (err: unknown) => {
      if (exiting) return;
      process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      logger.error("shutdown:crash", { error: err instanceof Error ? err.message : String(err) });
      void gracefulExit(1);
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
  }
}

/** Test-only. */
export function resetExitForTesting(): void {
  tasks.clear();
  running = null;
  exiting = false;
}
