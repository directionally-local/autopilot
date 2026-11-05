import { useCallback, useRef, useState } from "react";
import {
  permissionFromHook,
  type PermissionDecision,
  type PermissionDecisionResult,
  type PermissionRequest,
} from "../tools/executor.js";
import { isBlockedInPlanMode, isReadOnlyBash, type Mode } from "../mode.js";

/** Pre-built typed decisions for the two auto-resolve paths so we don't
 *  recreate them on every call. M2.2 — see `PermissionDecisionResult`. */
const AUTO_ALLOW: PermissionDecisionResult = { decision: "allow", scope: "once" };
const AUTO_DENY: PermissionDecisionResult = { decision: "deny", scope: "once" };

export interface PendingPermission {
  tool: PermissionRequest["tool"];
  args: Record<string, unknown>;
  resolve: (decision: PermissionDecision) => void;
}

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

/**
 * The TUI's answer to one permission request: mode rules first, then any
 * PermissionRequest hooks (#891), and only then the user's prompt.
 */
export async function resolvePermission(
  req: PermissionRequest,
  mode: Mode,
  opts: DecidePermissionOptions | undefined,
  host: { onPlanModeBlocked: (toolName: string) => void; prompt: () => Promise<PermissionDecision> },
): Promise<PermissionDecision> {
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
): PermissionController {
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const resolveRef = useRef<((d: PermissionDecision) => void) | null>(null);
  // Latest getter / callback are stashed in refs so the public methods
  // (askPermission especially) keep stable identities across renders.
  const getModeRef = useRef(getMode);
  getModeRef.current = getMode;
  const onPlanModeBlockedRef = useRef(onPlanModeBlocked);
  onPlanModeBlockedRef.current = onPlanModeBlocked;

  const askPermission = useCallback<PermissionController["askPermission"]>(
    (req, askOpts) =>
      resolvePermission(req, getModeRef.current(), askOpts, {
        onPlanModeBlocked: (toolName) => onPlanModeBlockedRef.current(toolName),
        prompt: () =>
          new Promise<PermissionDecision>((resolve) => {
            resolveRef.current = resolve;
            setPending({ tool: req.tool, args: req.args, resolve });
          }),
      }),
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
