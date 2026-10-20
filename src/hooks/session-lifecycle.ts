/**
 * SessionStart / SessionEnd hooks (#871). Every host runs turns through
 * the agent loop, so the loop reports a session the first time it sees it
 * in this process; hosts call endSessions() as they shut down. Observers
 * such as Agent Beacon key their events by this lifecycle.
 */

import type { HooksManager } from "./manager.js";
import { emitOtelEvent } from "../util/otel-events.js";

const started = new Map<string, { hooks: HooksManager | undefined; cwd: string }>();

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

/** Fire SessionEnd for one session (e.g. /clear). */
export async function endSession(sessionId: string, reason: "exit" | "clear", timeoutMs = 3000): Promise<void> {
  const entry = started.get(sessionId);
  if (!entry) return;
  started.delete(sessionId);
  emitOtelEvent("session.end", sessionId, { "session.end_reason": reason });
  if (!entry.hooks?.hasEnabledHooks("SessionEnd")) return;
  await Promise.race([
    entry.hooks
      .fire("SessionEnd", { event: "SessionEnd", session_id: sessionId, cwd: entry.cwd, reason }, null)
      .catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
}

/** Fire SessionEnd for every session started in this process (host shutdown). */
export async function endSessions(reason: "exit" | "clear" = "exit", timeoutMs = 3000): Promise<void> {
  await Promise.all([...started.keys()].map((id) => endSession(id, reason, timeoutMs)));
}

/** Test-only. */
export function resetSessionLifecycleForTesting(): void {
  started.clear();
}
