/**
 * What each permission mode decides on its own, before anyone is asked.
 * Shared by the interactive TUI (ui/use-permission-controller.ts) and print
 * mode (permissions/headless-policy.ts), so both follow one policy.
 */

import type { PermissionDecision, PermissionDecisionResult, PermissionRequest } from "../tools/executor.js";
import { isBlockedInPlanMode, isReadOnlyBash, type Mode } from "../mode.js";
import type { PermissionRules } from "../config.js";

/** Pre-built typed decisions for the two auto-resolve paths so we don't
 *  recreate them on every call. M2.2 — see `PermissionDecisionResult`. */
export const AUTO_ALLOW: PermissionDecisionResult = { decision: "allow", scope: "once" };
export const AUTO_DENY: PermissionDecisionResult = { decision: "deny", scope: "once" };

export type PermissionOutcome =
  | { kind: "resolve"; decision: PermissionDecision }
  | { kind: "prompt" }
  | { kind: "plan_blocked"; toolName: string };

export interface DecidePermissionOptions {
  /**
   * When the active mode is "plan" and the requested tool is blocked, the
   * default is to emit a "plan mode blocked" event and deny. If this flag
   * is true and the blocked tool is `bash`, prompt the user instead. This
   * preserves the pre-refactor asymmetry between the init-turn and
   * main-turn call sites in `app.tsx` (the init-turn path allowed
   * one-shot bash prompts while in plan mode; the main-turn path did
   * not).
   */
  promptOnBlockedBash?: boolean;
  /**
   * The config's permission rules (config.json `permissions`). Consulted for
   * an irreversible call: a rule naming that exact action allows it without a
   * prompt, the same way headless runs and dl server sessions do
   * (permissions/guardrails.ts). Globs and broad patterns never count.
   */
  rules?: Record<string, PermissionRules>;
  /** Where relative paths in `args` resolve. Defaults to process.cwd(). */
  cwd?: string;
}

export function decidePermission(
  req: PermissionRequest,
  mode: Mode,
  opts: DecidePermissionOptions = {},
): PermissionOutcome {
  if (mode === "auto") return { kind: "resolve", decision: AUTO_ALLOW };
  if (mode === "plan" && isBlockedInPlanMode(req.tool.name)) {
    if (
      req.tool.name === "bash" &&
      typeof req.args.command === "string" &&
      isReadOnlyBash(req.args.command)
    ) {
      return { kind: "resolve", decision: AUTO_ALLOW };
    }
    if (req.tool.name === "bash" && opts.promptOnBlockedBash) {
      return { kind: "prompt" };
    }
    return { kind: "plan_blocked", toolName: req.tool.name };
  }
  return { kind: "prompt" };
}

