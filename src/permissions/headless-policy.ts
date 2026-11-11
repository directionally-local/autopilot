/**
 * Print mode's permission policy: the interactive TUI's, with no one to ask.
 *
 * Interactive mode starts in `auto` (or `edit` when the modes feature flag
 * is on, mode.ts startMode). Print mode copies what that mode decides on its
 * own (permissions/mode-policy.ts): whatever it approves without asking is
 * approved here too, and the executor takes recovery points before approved
 * recoverable file and git actions exactly as it does for the TUI. Whatever
 * it would stop and ask a person about is denied, because no one can answer.
 *
 * In order:
 *  1. Irreversible actions (permissions/guardrails.ts): a PermissionRequest
 *     hook may deny; otherwise only a config rule naming that exact action
 *     allows them. --dangerously-allow-all and broad rules never do.
 *  2. --dangerously-allow-all approves everything else, as before.
 *  3. A config rule: "allow" approves, "deny" denies, "ask" means a person
 *     decides (step 5).
 *  4. A PermissionRequest hook may approve or deny.
 *  5. Interactive mode's own answer: approved unless it would ask a person
 *     (an "ask" rule, a PreToolUse hook answering "ask", or `edit` mode's
 *     prompt), which is denied.
 */

import type { PermissionRules } from "../config.js";
import type { Mode } from "../mode.js";
import { matchPermissionRule } from "../permissions-evaluator.js";
import { permissionFromHook, toPermissionResult, type PermissionDecisionResult, type PermissionRequest } from "../tools/executor.js";
import { unattendedDestructiveDecision } from "./guardrails.js";
import { AUTO_ALLOW, decidePermission } from "./mode-policy.js";

export interface HeadlessPermissionOptions {
  /** --dangerously-allow-all */
  allowAll: boolean;
  /** config.json `permissions` */
  rules?: Record<string, PermissionRules>;
  cwd: string;
  /** The mode an interactive session would start in (mode.ts startMode). */
  mode: Mode;
}

/** Why a call was decided the way it was. */
export type HeadlessDecisionReason = "irreversible" | "allow_all" | "config_rule" | "hook" | "mode" | "no_one_to_ask";

export interface HeadlessDecision {
  decision: PermissionDecisionResult;
  reason: HeadlessDecisionReason;
  /** A line for stderr / the stream-json event, when the host should say something. */
  notice?: string;
}

/** What the model hears after a denial in a headless run. */
export const HEADLESS_DENIAL_ADVICE =
  "No one can approve it in this headless run: do not retry it or ask for permission; do the task another way, or finish and report what's left.";

function deny(message: string): PermissionDecisionResult {
  return { decision: "deny", scope: "once", message };
}

export async function decideHeadlessPermission(req: PermissionRequest, opts: HeadlessPermissionOptions): Promise<HeadlessDecision> {
  const { tool, args } = req;
  const shown = `${tool.name}(${JSON.stringify(args)})`;

  if (req.destructive) {
    const fromHook = await permissionFromHook(req, "edit");
    if (fromHook?.decision === "deny") {
      return { decision: fromHook, reason: "hook", notice: `[permission denied by a PermissionRequest hook: ${tool.name}]` };
    }
    const { decision, message } = unattendedDestructiveDecision(req, opts.rules, opts.cwd);
    return { decision, reason: "irreversible", notice: message };
  }

  if (opts.allowAll) return { decision: AUTO_ALLOW, reason: "allow_all" };

  const rule = opts.rules ? matchPermissionRule({ tool: tool.name, args, cwd: opts.cwd }, opts.rules) : null;
  if (rule === "allow") return { decision: AUTO_ALLOW, reason: "config_rule" };
  if (rule === "deny") {
    return {
      decision: deny(`Permission denied by a permission rule in the user's config.json. ${HEADLESS_DENIAL_ADVICE}`),
      reason: "config_rule",
      notice: `[permission denied by config rule: ${shown}]`,
    };
  }

  const fromHook = await permissionFromHook(req, "edit");
  if (fromHook) {
    return {
      decision: fromHook,
      reason: "hook",
      ...(fromHook.decision === "deny" ? { notice: `[permission denied by a PermissionRequest hook: ${tool.name}]` } : {}),
    };
  }

  const why = rule === "ask" ? "a config rule says to ask" : req.hookAsked ? "a PreToolUse hook asked for a person" : null;
  if (why === null) {
    const outcome = decidePermission(req, opts.mode);
    if (outcome.kind === "resolve") return { decision: toPermissionResult(outcome.decision), reason: "mode" };
  }
  const because = why ?? `interactive ${opts.mode} mode asks before this`;
  return {
    decision: deny(`Permission denied: ${because}. ${HEADLESS_DENIAL_ADVICE}`),
    reason: "no_one_to_ask",
    notice: `[permission denied: ${shown} — ${because} and no one can answer in print mode. Allow it with a config.json permission rule or --dangerously-allow-all]`,
  };
}
