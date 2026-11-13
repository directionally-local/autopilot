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
 *  3. A config rule: "deny" denies, "allow" approves (except step 4), "ask"
 *     means a person decides (step 6).
 *  4. Reads and writes of credentials (util/sensitive-paths.ts: ~/.ssh,
 *     ~/.aws, Autopilot's config, .env files, /proc/<pid>/environ, …) are
 *     denied unless a config "allow" rule names that exact path. Interactive
 *     auto mode approves them because a person watches the session; print
 *     mode runs unwatched, where a prompt injection could read a key and send
 *     it out with web_fetch, or write ~/.ssh/authorized_keys and keep access.
 *     Broad allow rules and PermissionRequest hooks don't approve them.
 *     Bash commands are not covered: a command that writes a credentials
 *     path (`echo … >> ~/.ssh/authorized_keys`) isn't recognised yet.
 *  5. A PermissionRequest hook may approve or deny.
 *  6. Interactive mode's own answer: approved unless it would ask a person
 *     (an "ask" rule, a PreToolUse hook answering "ask", or `edit` mode's
 *     prompt), which is denied.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PermissionRule, PermissionRules } from "../config.js";
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
export type HeadlessDecisionReason = "irreversible" | "allow_all" | "config_rule" | "credentials" | "hook" | "mode" | "no_one_to_ask";

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

interface CredentialTarget {
  access: "read" | "write";
  path: string;
}

/**
 * The credentials path a call reads or writes, from the reason its tool gave
 * (util/sensitive-paths.ts readsCredentials / writesCredentials): `path`, the
 * cwd for a search without one, or `output` for a tool that saves a file there.
 */
function credentialTarget(req: PermissionRequest, cwd: string): CredentialTarget | null {
  const reason = req.sensitiveReason ?? "";
  const { args } = req;
  if (reason.startsWith("reads ")) {
    const path = typeof args.path === "string" ? args.path : req.tool.name === "grep" ? cwd : null;
    return path === null ? null : { access: "read", path: resolve(cwd, expandHome(path)) };
  }
  if (reason.startsWith("writes ")) {
    const path = typeof args.path === "string" ? args.path : typeof args.output === "string" ? args.output : null;
    return path === null ? null : { access: "write", path: resolve(cwd, expandHome(path)) };
  }
  return null;
}

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/** True when a config "allow" rule for this tool names exactly this path (no globs or prefixes). */
function exactPathRuleAllows(toolName: string, target: string, rules: Record<string, PermissionRules> | undefined, cwd: string): boolean {
  const toolRules = rules?.[toolName];
  if (!toolRules) return false;
  return Object.entries(toolRules).some(
    ([pattern, rule]) => (rule as PermissionRule) === "allow" && resolve(cwd, expandHome(pattern.trim())) === target,
  );
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
  if (rule === "deny") {
    return {
      decision: deny(`Permission denied by a permission rule in the user's config.json. ${HEADLESS_DENIAL_ADVICE}`),
      reason: "config_rule",
      notice: `[permission denied by config rule: ${shown}]`,
    };
  }

  const credentials = credentialTarget(req, opts.cwd);
  if (credentials !== null) {
    if (exactPathRuleAllows(tool.name, credentials.path, opts.rules, opts.cwd)) return { decision: AUTO_ALLOW, reason: "config_rule" };
    const verb = credentials.access === "read" ? "reads" : "writes";
    return {
      decision: deny(`Permission denied: this ${req.sensitiveReason}, and print mode ${verb} credentials only when a config rule names the exact path. ${HEADLESS_DENIAL_ADVICE}`),
      reason: "credentials",
      notice: `[permission denied: ${shown} ${req.sensitiveReason}. Print mode doesn't ${credentials.access} credentials without a config.json rule naming the exact path, e.g. "permissions": { ${JSON.stringify(tool.name)}: { ${JSON.stringify(credentials.path)}: "allow" } }, or --dangerously-allow-all]`,
    };
  }

  if (rule === "allow") return { decision: AUTO_ALLOW, reason: "config_rule" };

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
