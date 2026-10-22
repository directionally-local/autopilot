import { isBlockedInPlanMode, isReadOnlyBash, type Mode } from "../mode.js";
import type { PermissionHandler, PermissionRequest, PermissionDecision } from "./types.js";

export function createDefaultPermissionHandler(options: {
  mode: Mode;
  onRequest?: (req: PermissionRequest) => void;
}): PermissionHandler {
  return async (req) => {
    if (options.mode === "auto") {
      return "allow";
    }

    if (options.mode === "plan") {
      if (req.tool.name === "bash" && typeof req.args.command === "string" && isReadOnlyBash(req.args.command)) {
        return "allow";
      }
      if (isBlockedInPlanMode(req.tool.name)) {
        return "deny";
      }
      if (!req.sensitiveReason) return "allow";
      // A read of a credentials file needs a decision, as in edit mode.
      options.onRequest?.(req);
      return "deny";
    }

    // edit mode: emit event and wait for external decision
    options.onRequest?.(req);
    // If no external handler resolves it, deny to avoid hanging.
    // The SDK session will override this with its own event-based waiter.
    return "deny";
  };
}
