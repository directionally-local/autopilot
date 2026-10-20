/**
 * Process-exit handling for SDK sessions (#893). The CLI ends every session
 * through `util/exit.ts`; an app embedding the SDK may exit (or be killed)
 * without calling `session.dispose()`. While at least one SDK session is
 * live, this module runs the same bounded shutdown work — SessionEnd hooks,
 * then the OpenTelemetry flush, within SHUTDOWN_TIMEOUT_MS — when the
 * process is about to end.
 *
 * It never decides whether the process exits, and never calls process.exit:
 *  - beforeExit: the event loop is empty, so the work runs and the process
 *    exits on its own once it settles.
 *  - SIGTERM / SIGINT / SIGHUP: a listener suppresses Node's default "die on
 *    signal". When the host (or another library that defers, like
 *    signal-exit) has no listener of its own, the SDK keeps the default: it
 *    runs the shutdown work, removes its listeners and re-raises the signal,
 *    so the process still dies from it (exit status 128 + signal number). A
 *    second signal re-raises at once. When the host listens too, the SDK
 *    only starts the shutdown work and leaves exiting to the host.
 *  - uncaughtExceptionMonitor / exit: nothing asynchronous can complete, so
 *    the work is only started (SessionEnd hook commands are spawned with
 *    their payload; the OTel flush can't finish). When the host handles
 *    uncaughtException itself the SDK does nothing: the process survives.
 *    `dispose()` is the reliable path.
 */

import { isExiting, onShutdown, runShutdownTasks, SHUTDOWN_PHASE } from "../util/exit.js";
import { isOtelEnabled, shutdownOtelSink } from "../util/otel-sink.js";
import { logger } from "../util/logger.js";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type ExitSignal = (typeof SIGNALS)[number];

const live = new Set<symbol>();
let uninstallHandlers: (() => void) | null = null;

/** Listeners that signal-exit (v3 and v4) adds for each signal. They re-raise
 *  only when they are alone, so they must not count as the host's own. */
function signalExitListenerCount(): number {
  const v4 = (globalThis as Record<symbol, unknown>)[Symbol.for("signal-exit emitter")] as { count?: unknown } | undefined;
  const v3 = (process as unknown as { __signal_exit_emitter__?: { count?: unknown } }).__signal_exit_emitter__;
  return (typeof v4?.count === "number" ? v4.count : 0) + (typeof v3?.count === "number" ? v3.count : 0);
}

function install(): () => void {
  let reraising = false;
  let shuttingDown = false;

  const reraise = (signal: ExitSignal) => {
    if (reraising) return;
    reraising = true;
    uninstall();
    process.kill(process.pid, signal);
  };

  const onSignal = (signal: ExitSignal) => {
    const hostListeners = process.listenerCount(signal) - 1 - signalExitListenerCount();
    if (hostListeners > 0 || isExiting()) {
      // The host decides whether (and when) to exit; just do the work.
      void runShutdownTasks();
      return;
    }
    if (shuttingDown) return reraise(signal);
    shuttingDown = true;
    logger.info("sdk:shutdown_signal", { signal });
    void runShutdownTasks().then(() => reraise(signal));
  };

  const signalListeners = SIGNALS.map((signal) => [signal, () => onSignal(signal)] as const);
  const onBeforeExit = () => void runShutdownTasks();
  const onCrash = () => {
    // A host that handles the exception keeps running; leave its sessions alone.
    if (process.listenerCount("uncaughtException") > 0) return;
    void runShutdownTasks();
  };
  const onExit = () => void runShutdownTasks();
  const unregisterFlush = onShutdown("sdk-otel-flush", () => (isOtelEnabled() ? shutdownOtelSink() : undefined), SHUTDOWN_PHASE.flush);

  for (const [signal, listener] of signalListeners) process.on(signal, listener);
  process.on("beforeExit", onBeforeExit);
  process.on("uncaughtExceptionMonitor", onCrash);
  process.on("exit", onExit);

  const uninstall = () => {
    if (uninstallHandlers !== uninstall) return;
    uninstallHandlers = null;
    for (const [signal, listener] of signalListeners) process.off(signal, listener);
    process.off("beforeExit", onBeforeExit);
    process.off("uncaughtExceptionMonitor", onCrash);
    process.off("exit", onExit);
    unregisterFlush();
  };
  return uninstall;
}

/**
 * Keep the process-exit handlers installed while this session is live.
 * Returns the unregister function (idempotent); the handlers are removed
 * once the last registered session unregisters.
 */
export function registerSessionForExit(): () => void {
  const token = Symbol("sdk-session");
  live.add(token);
  uninstallHandlers ??= install();
  return () => {
    if (!live.delete(token)) return;
    if (live.size === 0) uninstallHandlers?.();
  };
}
