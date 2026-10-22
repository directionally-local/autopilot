/**
 * One-time, non-blocking hook notices shown at startup. Each is recorded in
 * the shared state file (src/util/state.ts) once shown, so it never repeats.
 *
 *   - Legacy path (#887): hooks found only in a kimiflare settings file.
 *     They keep working; the notice names the canonical autopilot path that
 *     new hooks are written to. Files are never moved automatically.
 *   - Exit codes (#888): since 1.29.0 only exit 2 blocks a PreToolUse /
 *     UserPromptSubmit call; exit 1 now allows. Checked once (first run of
 *     this version) and shown if an enabled custom (not bundled
 *     recommended) hook is registered for a blocking event, naming any
 *     whose command contains `exit 1`.
 *   - Untrusted project settings: project hooks or LSP servers that were
 *     not loaded because the user has not trusted them. Shown every start
 *     while they are pending (src/util/project-config-review.ts).
 */
import { readState, writeState, type StateFile } from "../util/state.js";
import { RECOMMENDED_HOOKS } from "./recommended.js";
import { globalSettingsPath, legacyOnlyHookPaths, loadHooksSettings, projectSettingsPath } from "./settings.js";
import type { HookConfig, KimiflareSettings } from "./types.js";

export const HOOKS_EXIT_CODE_DOCS_URL = "https://github.com/sinameraji/autopilot#blocking-and-exit-codes";

const BLOCKING_EVENTS = ["PreToolUse", "UserPromptSubmit"] as const;

const RECOMMENDED_COMMANDS = new Set(RECOMMENDED_HOOKS.map((r) => r.hook.command));

/** Bundled recommended hooks are matched by command text (the loader has
 *  already upgraded legacy recommended commands to the current ones). */
function isRecommended(hook: HookConfig): boolean {
  return RECOMMENDED_COMMANDS.has(hook.command);
}

/** The exit-code notice text for these settings, or null when no enabled
 *  custom hook is registered for a blocking event. */
export function exitCodeNoticeText(settings: KimiflareSettings): string | null {
  const custom = BLOCKING_EVENTS.flatMap((ev) => settings.hooks?.[ev] ?? []).filter(
    (h) => h.enabled !== false && !isRecommended(h),
  );
  if (custom.length === 0) return null;
  const exit1 = custom.filter((h) => /\bexit\s+1\b/.test(h.command)).map((h) => h.id ?? h.command.slice(0, 40));
  let text = `Hooks changed in 1.29.0: only exit 2 blocks; exit 1 now allows. Update custom guards: ${HOOKS_EXIT_CODE_DOCS_URL}`;
  if (exit1.length > 0) text += `\nThese hooks use \`exit 1\` and no longer block: ${[...new Set(exit1)].join(", ")}`;
  return text;
}

/** The legacy-path notice for these files. */
export function legacyPathNoticeText(cwd: string, legacyPaths: readonly string[]): string {
  return (
    `Hooks found only in the legacy path ${legacyPaths.join(" and ")}. They still run. ` +
    `New hooks are saved to ${globalSettingsPath()} (global) or ${projectSettingsPath(cwd)} (project); ` +
    `move yours there when convenient.`
  );
}

/**
 * Notices due for this startup, each marked shown in the state file before
 * returning. Never throws: a notice is not worth failing startup over.
 */
export async function takeHookStartupNotices(cwd: string): Promise<string[]> {
  try {
    const state: StateFile = await readState();
    const notices: string[] = [];
    let dirty = false;

    const seen = new Set(state.legacyHooksNoticePaths ?? []);
    const fresh = legacyOnlyHookPaths(cwd).filter((p) => !seen.has(p));
    if (fresh.length > 0) {
      notices.push(legacyPathNoticeText(cwd, fresh));
      state.legacyHooksNoticePaths = [...seen, ...fresh];
      dirty = true;
    }

    // Checked once, on the first run of this version: a user with no custom
    // blocking hook then has nothing to update, and hooks written later are
    // written against the current docs.
    if (!state.hooksExitCodeNoticeShown) {
      const text = exitCodeNoticeText(loadHooksSettings(cwd));
      if (text) notices.push(text);
      state.hooksExitCodeNoticeShown = true;
      dirty = true;
    }

    if (dirty) await writeState(state);

    // Shown on every start until the user trusts (or removes) the files:
    // skipped hooks and LSP servers are otherwise invisible.
    const { pendingProjectConfig, projectTrustNoticeText } = await import("../util/project-config-review.js");
    const trustText = projectTrustNoticeText(pendingProjectConfig(cwd));
    if (trustText) notices.push(trustText);
    return notices;
  } catch {
    return [];
  }
}
