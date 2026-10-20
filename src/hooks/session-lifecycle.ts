/**
 * SessionStart / SessionEnd hooks (#871). Every host runs turns through
 * the agent loop, so the loop reports a session the first time it sees it
 * in this process; hosts call endSessions() as they shut down. Observers
 * such as Agent Beacon key their events by this lifecycle.
 */

import type { HooksManager } from "./manager.js";
import { emitOtelEvent } from "../util/otel-events.js";
import { onShutdown, SHUTDOWN_TIMEOUT_MS } from "../util/exit.js";

const started = new Map<string, { hooks: HooksManager | undefined; cwd: string }>();
let shutdownRegistered = false;

/** End every open session when the process shuts down (#877), leaving the
 *  rest of the shutdown budget for the OTel flush that follows. */
function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  onShutdown("session-end", () => endSessions("exit", SHUTDOWN_TIMEOUT_MS - 1000));
}

export interface SessionStartInfo {
  hooks?: HooksManager;
  sessionId?: string;
  cwd: string;
  /** The session already has history (resumed rather than new). */
  resumed: boolean;
  model?: string;
  provider?: string;
}

/** Fire SessionStart once per session per process. Best-effort: never throws. */
export async function noteSessionStart(info: SessionStartInfo): Promise<void> {
  if (!info.sessionId || started.has(info.sessionId)) return;
  started.set(info.sessionId, { hooks: info.hooks, cwd: info.cwd });
  registerShutdown();
  const source = info.resumed ? "resume" : "startup";
  emitOtelEvent("session.start", info.sessionId, {
    "session.source": source,
    ...(info.model ? { "gen_ai.request.model": info.model } : {}),
    ...(info.provider ? { "gen_ai.provider.name": info.provider } : {}),
  });
  if (!info.hooks?.hasEnabledHooks("SessionStart")) return;
  try {
    await info.hooks.fire(
      "SessionStart",
      {
        event: "SessionStart",
        session_id: info.sessionId,
        cwd: info.cwd,
        source,
        ...(info.model ? { model: info.model } : {}),
        ...(info.provider ? { provider: info.provider } : {}),
      },
      null,
    );
  } catch {
    // best-effort
  }
}

/** SessionEnd hooks still running, e.g. from /clear or an SDK dispose that didn't await. */
const ending = new Set<Promise<void>>();

/** Fire SessionEnd for one session (e.g. /clear). */
export async function endSession(sessionId: string, reason: "exit" | "clear", timeoutMs = 3000): Promise<void> {
  const entry = started.get(sessionId);
  if (!entry) return;
  started.delete(sessionId);
  emitOtelEvent("session.end", sessionId, { "session.end_reason": reason });
  if (!entry.hooks?.hasEnabledHooks("SessionEnd")) return;
  const done: Promise<void> = Promise.race([
    entry.hooks
      .fire("SessionEnd", { event: "SessionEnd", session_id: sessionId, cwd: entry.cwd, reason }, null)
      .then(() => undefined, () => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]).finally(() => ending.delete(done));
  ending.add(done);
  await done;
}

/** Fire SessionEnd for every session started in this process (host shutdown),
 *  and wait for SessionEnd hooks already in flight. */
export async function endSessions(reason: "exit" | "clear" = "exit", timeoutMs = 3000): Promise<void> {
  await Promise.all([...[...started.keys()].map((id) => endSession(id, reason, timeoutMs)), ...ending]);
}

/** Test-only. */
export function resetSessionLifecycleForTesting(): void {
  started.clear();
  ending.clear();
  shutdownRegistered = false;
}
