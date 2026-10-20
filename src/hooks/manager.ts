import { loadHooksSettings } from "./settings.js";
import { runHooks } from "./runner.js";
import { hookMatcherNames } from "./claude-compat.js";
import type {
  HookConfig,
  HookEvent,
  HookEventOutcome,
  HookPayload,
  KimiflareSettings,
} from "./types.js";

/**
 * Thin facade over `loadHooksSettings` + `runHooks`. Caches the merged
 * settings per process so the loop doesn't re-read settings.json on
 * every tool call. Call `reload()` after `/hooks enable|disable` to
 * pick up edits without restarting.
 */
export class HooksManager {
  private cwd: string;
  private settings: KimiflareSettings;

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

  /** Fire all matching hooks for `event`. Toolname is used only by
   *  PreToolUse / PostToolUse matchers, which are tested against both the
   *  native and the Claude Code name (plus `MultiEdit` for an edit with
   *  `edits[]`, read from the payload's args). */
  fire(
    event: HookEvent,
    payload: HookPayload,
    toolName: string | null = null,
    signal?: AbortSignal,
  ): Promise<HookEventOutcome> {
    const args = "args" in payload && payload.args && typeof payload.args === "object" ? payload.args : undefined;
    const names = toolName === null ? null : hookMatcherNames(toolName, args as Record<string, unknown> | undefined);
    return runHooks(event, this.hooksFor(event), payload, names, signal);
  }
}
