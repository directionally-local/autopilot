/**
 * Guardrails for destructive actions that hold in every mode (autopilot#1125).
 *
 * The executor classifies each tool call (permissions/destructive.ts). For an
 * irreversible one it always asks, even in auto mode, with
 * --dangerously-allow-all, under a broad allow rule or a session approval:
 *
 *   - the request carries a `destructive` prompt, and the executor runs the
 *     call only when the host answers with `irreversibleConfirmed: true`;
 *     any other "allow" counts as no;
 *   - the interactive TUI shows what will be lost and whether recovery
 *     exists, and for a production-looking target asks for its name to be
 *     typed, not just Enter;
 *   - headless runs and dl server sessions deny it unless a permission rule
 *     names that exact action (`**: allow` and other patterns never count);
 *     the interactive TUI honours the same exact rules, so a rule naming the
 *     action skips its prompt there too.
 *
 * Before an approved recoverable or irreversible file or git action, the
 * executor saves a recovery point (permissions/recovery.ts) for /undo.
 */

import { resolve } from "node:path";
import type { PermissionRule, PermissionRules } from "../config.js";
import type { PermissionDecisionResult, PermissionRequest } from "../tools/executor.js";
import { classifyToolCall, repoRootOf, type Assessment, type Finding } from "./destructive.js";

/** What the person is asked before an irreversible action. */
export interface DestructivePrompt {
  /** One line: what will be lost and where. */
  title: string;
  /** Whether recovery exists, other findings, and the full command. */
  subtitle: string;
  /** The recovery sentence on its own. */
  recovery: string;
  /** Set for a production-looking target: the name to type to confirm. */
  confirmName?: string;
  /** The exact actions a permission rule must name to allow this unattended. */
  actions: string[];
}

/** The answer that runs an irreversible action: only hosts that asked a person, or matched an exact rule, return it. */
export const CONFIRMED_IRREVERSIBLE: PermissionDecisionResult = { decision: "allow", scope: "once", irreversibleConfirmed: true };

/** The guardrail's view of one tool call: null when nothing is lost. */
export function guardToolCall(tool: string, args: Record<string, unknown>, cwd: string): Assessment | null {
  const a = classifyToolCall(tool, args, { cwd });
  return a.verdict === "safe" ? null : a;
}

/** The project a recovery point belongs to. */
export function projectOf(cwd: string): string {
  return repoRootOf(cwd) ?? resolve(cwd);
}

function sentence(f: Finding): string {
  return `${f.loss}${f.target ? ` in ${f.target.label}` : ""}`;
}

export function destructivePrompt(a: Assessment, fullAction?: string): DestructivePrompt {
  const irreversible = a.findings.filter((f) => f.verdict === "irreversible");
  const first = irreversible[0] ?? a.findings[0]!;
  const others = a.findings.filter((f) => f !== first);
  const prod = irreversible.find((f) => f.target?.production && f.target.confirmName);
  const recovery = first.recovery;
  const also = others.length ? ` Also: ${others.map((f) => `${sentence(f)} (${f.verdict === "irreversible" ? "can't be undone" : "recoverable"})`).join("; ")}.` : "";
  const shownAction = (fullAction ?? first.action).trim();
  const cmd = shownAction.length > 160 ? `${shownAction.slice(0, 159)}…` : shownAction;
  return {
    title: `This can't be undone: ${sentence(first)}.`,
    subtitle: `${recovery}${also} Command: ${cmd}`,
    recovery,
    ...(prod ? { confirmName: prod.target!.confirmName! } : {}),
    actions: [...new Set(irreversible.map((f) => f.action.trim()))],
  };
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * True when a permission rule allows exactly this action: its pattern is
 * the whole command (or path), or every irreversible part of it, word for
 * word. Globs, prefixes and `**` never count.
 */
export function exactRuleAllows(req: Pick<PermissionRequest, "tool" | "args" | "destructive">, rules: Record<string, PermissionRules> | undefined, cwd: string): boolean {
  const toolRules = rules?.[req.tool.name];
  if (!toolRules || !req.destructive) return false;
  const allowed = new Set(
    Object.entries(toolRules)
      .filter(([, rule]) => (rule as PermissionRule) === "allow")
      .map(([pattern]) => normalize(pattern)),
  );
  const whole = typeof req.args.command === "string" ? req.args.command : typeof req.args.path === "string" ? req.args.path : null;
  if (whole !== null) {
    if (allowed.has(normalize(whole))) return true;
    if (typeof req.args.path === "string" && allowed.has(resolve(cwd, req.args.path))) return true;
  }
  return req.destructive.actions.length > 0 && req.destructive.actions.every((a) => allowed.has(normalize(a)));
}

/** A rule to suggest for allowing this action unattended. */
export function exactRuleExample(req: Pick<PermissionRequest, "tool" | "args" | "destructive">): string {
  const target = req.destructive?.actions.length === 1 ? req.destructive.actions[0]! : typeof req.args.command === "string" ? req.args.command : typeof req.args.path === "string" ? req.args.path : "";
  return `"permissions": { ${JSON.stringify(req.tool.name)}: { ${JSON.stringify(normalize(target))}: "allow" } }`;
}

/**
 * Headless runs and dl server sessions: no one can confirm, so an
 * irreversible action runs only when a rule names it exactly.
 */
export function unattendedDestructiveDecision(
  req: PermissionRequest,
  rules: Record<string, PermissionRules> | undefined,
  cwd: string,
): { decision: PermissionDecisionResult; message: string } {
  const d = req.destructive!;
  if (exactRuleAllows(req, rules, cwd)) {
    return { decision: CONFIRMED_IRREVERSIBLE, message: `[allowed by a rule naming this exact action: ${d.title}]` };
  }
  return {
    decision: { decision: "deny", scope: "once" },
    message: `[denied: ${d.title} No one is here to confirm it, and --dangerously-allow-all and broad allow rules don't cover irreversible actions. To allow exactly this, add ${exactRuleExample(req)} to config.json.]`,
  };
}

/** What the model hears when an irreversible action wasn't confirmed by a person. */
export function unconfirmedMessage(d: DestructivePrompt): string {
  return `Not run, because it can't be undone: ${d.title.replace(/^This can't be undone: /, "")} Autopilot runs irreversible actions only after a person confirms them, and no one confirmed this one. Do not retry it or work around it; tell the user what you wanted to run and why, and let them run it or allow it.`;
}
