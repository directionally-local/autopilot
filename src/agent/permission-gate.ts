import type { PermissionAsker, PermissionDecision, PermissionRequest } from "../tools/executor.js";

export interface GateCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Wrap a permission asker for a batch of concurrently executing tool calls.
 *
 * Hosts present one permission prompt at a time (the TUI keeps a single
 * pending slot), so concurrent asks must never overlap. The gate:
 * - serializes asks, so the host only ever sees one outstanding request;
 * - coalesces asks that share a session key into one prompt; for tools
 *   approved per tool, its args list every call of that tool in the batch
 *   (`args.batch`), so the user approves "3 research workers" once instead
 *   of three times;
 * - hands the same decision to every coalesced call. A session-scoped allow
 *   is still cached by the executor, per call, as usual.
 */
export function createPermissionGate(ask: PermissionAsker, calls: GateCall[]): PermissionAsker {
  const decisions = new Map<string, Promise<PermissionDecision>>();
  let tail: Promise<unknown> = Promise.resolve();

  return (req: PermissionRequest) => {
    const existing = decisions.get(req.sessionKey);
    if (existing) return existing;

    // List the batch only for tools approved per tool. bash, write and edit
    // are approved per command / per file (executor sessionPermissionKey),
    // so their prompt must show only the call its answer covers.
    const sameTool = req.sessionKey === req.tool.name ? calls.filter((call) => call.name === req.tool.name) : [];
    const request: PermissionRequest =
      sameTool.length > 1 ? { ...req, args: { ...req.args, batch: sameTool.map((call) => call.args) } } : req;
    const decision = tail.then(() => ask(request));
    // Keep the chain alive even if one ask rejects.
    tail = decision.catch(() => undefined);
    decisions.set(req.sessionKey, decision);
    return decision;
  };
}
