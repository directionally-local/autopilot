import { useCallback, useRef, useState } from "react";
import {
  permissionFromHook,
  type PermissionDecision,
  type PermissionRequest,
} from "../tools/executor.js";
import { isBlockedInPlanMode, type Mode } from "../mode.js";
import { AUTO_DENY, decidePermission, type DecidePermissionOptions } from "../permissions/mode-policy.js";
import { CONFIRMED_IRREVERSIBLE, exactRuleAllows, type DestructivePrompt } from "../permissions/guardrails.js";
import type { PermissionRules } from "../config.js";

export { decidePermission, type DecidePermissionOptions, type PermissionOutcome } from "../permissions/mode-policy.js";

export interface PendingPermission {
  tool: PermissionRequest["tool"];
  args: Record<string, unknown>;
  /** Why a normally-quiet call needs a prompt (reads/writes a credentials location). */
  sensitiveReason?: string;
  /** Set when the call is irreversible: the guardrail question (permissions/guardrails.ts). */
  destructive?: DestructivePrompt;
  resolve: (decision: PermissionDecision) => void;
}

/**
 * The TUI's answer to one permission request: mode rules first, then any
 * PermissionRequest hooks (#891), and only then the user's prompt.
 */
export async function resolvePermission(
  req: PermissionRequest,
  mode: Mode,
  opts: DecidePermissionOptions | undefined,
  host: {
    onPlanModeBlocked: (toolName: string) => void;
    prompt: () => Promise<PermissionDecision>;
    /** Asks about an irreversible action; without it such a call is denied. */
    promptDestructive?: (destructive: DestructivePrompt) => Promise<PermissionDecision>;
  },
): Promise<PermissionDecision> {
  // Irreversible (#1125): asked in every mode, auto included; a hook may deny but not allow.
  if (req.destructive) {
    if (mode === "plan" && isBlockedInPlanMode(req.tool.name)) {
      host.onPlanModeBlocked(req.tool.name);
      return AUTO_DENY;
    }
    const fromHook = await permissionFromHook(req, mode);
    if (fromHook?.decision === "deny") return fromHook;
    // A rule naming this exact action allows it unattended, as in headless runs.
    if (exactRuleAllows(req, opts?.rules, opts?.cwd ?? process.cwd())) return CONFIRMED_IRREVERSIBLE;
    return host.promptDestructive ? host.promptDestructive(req.destructive) : AUTO_DENY;
  }
  const outcome = decidePermission(req, mode, opts);
  if (outcome.kind === "resolve") return outcome.decision;
  if (outcome.kind === "plan_blocked") {
    host.onPlanModeBlocked(outcome.toolName);
    return AUTO_DENY;
  }
  const fromHook = await permissionFromHook(req, mode);
  if (fromHook) return fromHook;
  return host.prompt();
}

export interface PermissionController {
  pending: PendingPermission | null;
  askPermission: (
    req: PermissionRequest,
    opts?: DecidePermissionOptions,
  ) => Promise<PermissionDecision>;
  /**
   * Synchronously check whether a permission promise is awaiting a
   * decision. Reads from the resolver ref so it stays correct between
   * the moment a promise was created and the corresponding state
   * update flushes.
   */
  hasPending: () => boolean;
  /** Resolve the pending permission with a user-chosen decision. */
  decide: (decision: PermissionDecision) => void;
  /**
   * Synchronously deny any pending permission. Used by Ctrl+C and Escape
   * to unblock the agent loop while tearing down the modal. Returns true
   * if there was a pending permission.
   */
  denyPending: () => boolean;
  /**
   * Defensive clear used at turn-end cleanup. Does NOT resolve any
   * pending promise — only clears the internal resolver ref so a stale
   * resolver does not get triggered later.
   */
  clearResolveRef: () => void;
}

export function usePermissionController(
  getMode: () => Mode,
  onPlanModeBlocked: (toolName: string) => void,
  /** The config's permission rules, read fresh on each request. */
  getRules?: () => Record<string, PermissionRules> | undefined,
): PermissionController {
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const resolveRef = useRef<((d: PermissionDecision) => void) | null>(null);
  // Latest getter / callback are stashed in refs so the public methods
  // (askPermission especially) keep stable identities across renders.
  const getModeRef = useRef(getMode);
  getModeRef.current = getMode;
  const onPlanModeBlockedRef = useRef(onPlanModeBlocked);
  onPlanModeBlockedRef.current = onPlanModeBlocked;
  const getRulesRef = useRef(getRules);
  getRulesRef.current = getRules;

  const askPermission = useCallback<PermissionController["askPermission"]>(
    (req, askOpts) => {
      const rules = getRulesRef.current?.();
      return resolvePermission(req, getModeRef.current(), { ...askOpts, ...(rules ? { rules } : {}) }, {
        onPlanModeBlocked: (toolName) => onPlanModeBlockedRef.current(toolName),
        prompt: () =>
          new Promise<PermissionDecision>((resolve) => {
            resolveRef.current = resolve;
            setPending({ tool: req.tool, args: req.args, ...(req.sensitiveReason ? { sensitiveReason: req.sensitiveReason } : {}), ...(req.destructive ? { destructive: req.destructive } : {}), resolve });
          }),
        promptDestructive: (destructive) =>
          new Promise<PermissionDecision>((resolve) => {
            resolveRef.current = resolve;
            setPending({ tool: req.tool, args: req.args, destructive, resolve });
          }),
      });
    },
    [],
  );

  const hasPending = useCallback(() => resolveRef.current !== null, []);

  const decide = useCallback((decision: PermissionDecision) => {
    const pendingResolve = resolveRef.current;
    resolveRef.current = null;
    setPending(null);
    pendingResolve?.(decision);
  }, []);

  const denyPending = useCallback(() => {
    const pendingResolve = resolveRef.current;
    if (pendingResolve === null) return false;
    resolveRef.current = null;
    setPending(null);
    pendingResolve(AUTO_DENY);
    return true;
  }, []);

  const clearResolveRef = useCallback(() => {
    resolveRef.current = null;
  }, []);

  return { pending, askPermission, hasPending, decide, denyPending, clearResolveRef };
}
