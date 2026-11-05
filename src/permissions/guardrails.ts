/**
 * What a destructive file or git action would lose (autopilot#1125), so the
 * executor can save a recovery point (permissions/recovery.ts) before it
 * runs, for /undo. Nothing here asks or blocks: the action runs as the
 * mode and permission rules decide.
 */

import { resolve } from "node:path";
import { classifyToolCall, repoRootOf, type Assessment } from "./destructive.js";

/** The classifier's view of one tool call: null when nothing is lost. */
export function guardToolCall(tool: string, args: Record<string, unknown>, cwd: string): Assessment | null {
  const a = classifyToolCall(tool, args, { cwd });
  return a.verdict === "safe" ? null : a;
}

/** The project a recovery point belongs to. */
export function projectOf(cwd: string): string {
  return repoRootOf(cwd) ?? resolve(cwd);
}
