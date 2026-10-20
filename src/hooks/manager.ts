import { loadHooksSettings } from "./settings.js";
import { runHooks } from "./runner.js";
import { hookMatcherNames } from "./claude-compat.js";
import { emitOtelEvent } from "../util/otel-events.js";
import type {
  HookConfig,
  HookEvent,
  HookEventOutcome,
  HookFailure,
  HookPayload,
  KimiflareSettings,
} from "./types.js";

/** A hook failure as hosts receive it. */
export interface HookFailureNotice extends HookFailure {
  /** How many times this hook has failed in this session, including this one. */
  count: number;
  /** True only for the hook's first failure this session. Hosts show a
   *  notice when it is set and stay quiet otherwise (the count keeps
   *  going; `/hooks list` shows it). */
  firstInSession: boolean;
}

export type HookFailureListener = (notice: HookFailureNotice) => void;

/**
 * One-line, user-facing text for a hook failure, shared by every host.
 * Mentions the hook, the event, why it failed, and what happened to the
 * action (allowed — fail-open — or blocked by `failClosed`).
 */
export function formatHookFailureNotice(n: HookFailureNotice): string {
  const outcome = !n.allowed
    ? "blocked it (failClosed)"
    : n.event === "PermissionRequest"
      ? "showed the normal permission prompt instead (fail-open)"
      : n.event === "PreToolUse" || n.event === "UserPromptSubmit"
        ? "allowed it anyway (fail-open)"
        : "carried on";
  const repeat = n.count > 1 ? ` (failure ${n.count} this session)` : "";
  return `hook ${n.hookId} (${n.event}) failed: ${n.reason}; Autopilot ${outcome}${repeat}. Further failures of this hook this session are counted, not shown.`;
}

/** A hook failure as a wire event (stream-json, emit mode, server SSE). */
export function hookFailureEvent(n: HookFailureNotice): Record<string, unknown> {
  return {
    hook_id: n.hookId,
    hook_event: n.event,
    failure: n.kind,
    reason: n.reason,
    allowed: n.allowed,
    fail_closed: n.failClosed,
    count: n.count,
    message: formatHookFailureNotice(n),
  };
}

/**
 * Thin facade over `loadHooksSettings` + `runHooks`. Caches the merged
 * settings per process so the loop doesn't re-read settings.json on
 * every tool call. Call `reload()` after `/hooks enable|disable` to
 * pick up edits without restarting.
 *
 * It also keeps the session's hook-failure tally (#889): every failure is
 * logged and sent as an `autopilot.hook.failed` OTel event; listeners
 * (the host UIs) hear about every failure with a running count and a
 * `firstInSession` flag so they can show one notice per hook.
 */
export class HooksManager {
  private cwd: string;
  private settings: KimiflareSettings;
  private failureCounts = new Map<string, number>();
  private failureListeners = new Set<HookFailureListener>();

  constructor(cwd: string) {
    this.cwd = cwd;
    this.settings = loadHooksSettings(cwd);
  }

  /** Re-read settings from disk. */
  reload(): void {
    this.settings = loadHooksSettings(this.cwd);
  }

  /** All hooks registered for an event, before matcher filtering. */
  hooksFor(event: HookEvent): HookConfig[] {
    return this.settings.hooks?.[event] ?? [];
  }

  /** True if at least one enabled hook would match this event. Cheap
   *  pre-check the loop can use to avoid building payloads for events
   *  that have no listeners. */
  hasEnabledHooks(event: HookEvent): boolean {
    const list = this.hooksFor(event);
    return list.some((h) => h.enabled !== false);
  }

  /** Subscribe to hook failures. Returns an unsubscribe function. */
  onFailure(listener: HookFailureListener): () => void {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  /** Failures per hook id so far this session. */
  failureCount(hookId: string): number {
    return this.failureCounts.get(hookId) ?? 0;
  }

  /** Start a new session's tally (e.g. after `/clear`). */
  resetFailureCounts(): void {
    this.failureCounts.clear();
  }

  /** Fire all matching hooks for `event`. Toolname is used only by the
   *  tool events' matchers, which are tested against both the native and
   *  the Claude Code name (plus `MultiEdit` for an edit with `edits[]`,
   *  read from the payload's args). */
  async fire(
    event: HookEvent,
    payload: HookPayload,
    toolName: string | null = null,
    signal?: AbortSignal,
  ): Promise<HookEventOutcome> {
    const args = "args" in payload && payload.args && typeof payload.args === "object" ? payload.args : undefined;
    const names = toolName === null ? null : hookMatcherNames(toolName, args as Record<string, unknown> | undefined);
    const outcome = await runHooks(event, this.hooksFor(event), payload, names, signal);
    for (const failure of outcome.failures) this.reportFailure(failure, payload.session_id);
    return outcome;
  }

  private reportFailure(failure: HookFailure, sessionId: string | null): void {
    const count = (this.failureCounts.get(failure.hookId) ?? 0) + 1;
    this.failureCounts.set(failure.hookId, count);
    emitOtelEvent(
      "hook.failed",
      sessionId,
      {
        "hook.id": failure.hookId,
        "hook.event": failure.event,
        "hook.failure": failure.kind,
        "hook.reason": failure.reason.slice(0, 300),
        "hook.allowed": failure.allowed,
        "hook.fail_closed": failure.failClosed,
        "hook.failure_count": count,
      },
      "warn",
    );
    const notice: HookFailureNotice = { ...failure, count, firstInSession: count === 1 };
    for (const listener of this.failureListeners) {
      try {
        listener(notice);
      } catch {
        // a host's notice must never break the hook path
      }
    }
  }
}
