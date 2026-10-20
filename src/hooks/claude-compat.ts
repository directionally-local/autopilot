/**
 * Claude Code's names and shapes for the tool fields of a hook payload
 * (#877). Autopilot's tools are lowercase (`bash`, `edit`, `write`, …) and
 * take `path`; Claude Code hook scripts, and tools built for them such as
 * Agent Beacon's `--platform claude` mode, key on `Bash`, `Edit`, `Write`,
 * `MultiEdit`, … with `file_path`, and read a shell result's `stdout`,
 * `stderr` and a failure's top-level `error`. This module builds those
 * fields; the payload keeps Autopilot's own (`tool`, `args`, `result`) too.
 *
 * The mapping is documented in docs/beacon.md; keep the two in step.
 */
import type {
  PermissionRequestPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
} from "./types.js";
import { editPairs } from "../tools/edit.js";
import { resolvePath } from "../util/paths.js";

/** Autopilot tool → Claude Code tool. Tools not listed keep their own name. */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: "Bash",
  edit: "Edit", // "MultiEdit" when the call passes edits[]
  write: "Write",
  read: "Read",
  glob: "Glob",
  grep: "Grep",
  web_fetch: "WebFetch",
  search_web: "WebSearch",
};

/** Claude names that assert "this file changed". */
const FILE_EDIT_NAMES = new Set(["Write", "Edit", "MultiEdit"]);

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number";

/** The Claude Code name for a call: `MultiEdit` for an edit with edits[]. */
export function claudeToolName(tool: string, args: Record<string, unknown>): string {
  if (tool === "edit" && Array.isArray(args.edits)) return "MultiEdit";
  return CLAUDE_TOOL_NAMES[tool] ?? tool;
}

/**
 * The names a hook `matcher` is tested against for a call (#890): the
 * native name and its Claude Code name, so a matcher copied from a Claude
 * Code config (`Bash`, `Edit|Write`) works as well as `bash`. An edit
 * carrying `edits[]` also answers to `MultiEdit`. Without `args` (only a
 * name known) the MultiEdit form is not added.
 */
export function hookMatcherNames(tool: string, args?: Record<string, unknown>): string[] {
  const names = [tool];
  const claude = CLAUDE_TOOL_NAMES[tool];
  if (claude && claude !== tool) names.push(claude);
  if (args && claudeToolName(tool, args) === "MultiEdit") names.push("MultiEdit");
  return names;
}

/**
 * True when `matcher` selects a call known by `names`. Empty or `*`
 * matches everything; anything else is a case-sensitive, unanchored
 * regex tested against each name. A malformed regex matches nothing.
 */
export function hookMatcherMatches(matcher: string | undefined, names: readonly string[]): boolean {
  if (!matcher || matcher === "*") return true;
  let re: RegExp;
  try {
    re = new RegExp(matcher);
  } catch {
    return false;
  }
  return names.some((n) => re.test(n));
}

/** The call's arguments under Claude Code's field names (absolute `file_path`). */
export function claudeToolInput(tool: string, args: Record<string, unknown>, cwd: string): Record<string, unknown> {
  // Claude Code sends absolute paths; Autopilot's tools accept relative ones.
  const filePath = isStr(args.path) && args.path ? resolvePath(cwd, args.path) : undefined;
  switch (tool) {
    case "bash":
      return { command: args.command, ...(isNum(args.timeout_ms) ? { timeout: args.timeout_ms } : {}) };
    case "write":
      return { file_path: filePath, content: args.content };
    case "read":
      return {
        file_path: filePath,
        ...(isNum(args.offset) ? { offset: args.offset } : {}),
        ...(isNum(args.limit) ? { limit: args.limit } : {}),
      };
    case "edit": {
      if (Array.isArray(args.edits)) return { file_path: filePath, edits: editPairs(args) };
      return {
        file_path: filePath,
        old_string: args.old_string,
        new_string: args.new_string,
        ...(args.replace_all === true ? { replace_all: true } : {}),
      };
    }
    case "glob":
      return { pattern: args.pattern, ...(filePath ? { path: filePath } : {}) };
    case "grep":
      return {
        pattern: args.pattern,
        ...(filePath ? { path: filePath } : {}),
        ...(isStr(args.glob) ? { glob: args.glob } : {}),
        ...(args.case_insensitive === true ? { "-i": true } : {}),
        ...(isStr(args.output_mode)
          ? { output_mode: args.output_mode === "files" ? "files_with_matches" : args.output_mode }
          : {}),
      };
    case "web_fetch":
      return { url: args.url };
    case "search_web":
      return { query: args.query };
    default:
      return args;
  }
}

type ToolResultFields = PostToolUsePayload["result"];

/** True when the call did not do what it was asked: the tool failed, or a shell command exited non-zero or was killed. */
export function toolCallFailed(result: ToolResultFields): boolean {
  if (!result.ok) return true;
  if (result.interrupted === true) return true;
  return isNum(result.exitCode) ? result.exitCode !== 0 : result.exitCode === null;
}

/**
 * `tool_response`: Autopilot's `{ok, content, errorCode}` plus an explicit
 * `success` / `is_error`, and for bash Claude's `stdout`, `stderr`,
 * `interrupted` with `exit_code`.
 */
export function claudeToolResponse(tool: string, args: Record<string, unknown>, cwd: string, result: ToolResultFields): Record<string, unknown> {
  const failed = toolCallFailed(result);
  const response: Record<string, unknown> = {
    ok: result.ok,
    content: result.content,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    success: !failed,
    is_error: failed,
  };
  if (result.exitCode !== undefined) {
    response.stdout = result.stdout ?? "";
    response.stderr = result.stderr ?? "";
    response.exit_code = result.exitCode;
    response.interrupted = result.interrupted === true;
  }
  if ((tool === "write" || tool === "edit") && isStr(args.path) && !failed) {
    response.filePath = resolvePath(cwd, args.path);
  }
  return response;
}

/**
 * A failed call's top-level `error`, as Claude Code reports one: a shell
 * command that ran and exited non-zero starts with `Exit code N`, then its
 * output; anything else carries Autopilot's error text.
 */
export function claudeError(result: ToolResultFields): string {
  if (isNum(result.exitCode) && result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter((s) => s && s.trim()).map((s) => s!.trimEnd()).join("\n");
    return output ? `Exit code ${result.exitCode}\n${output}` : `Exit code ${result.exitCode}`;
  }
  return result.content || `${result.errorCode ?? "tool"} error`;
}

/**
 * The Claude Code tool fields of a PreToolUse / PostToolUse /
 * PostToolUseFailure / PermissionRequest payload.
 *
 * A failed write or edit (PostToolUse or PostToolUseFailure) keeps its native name (`write`, `edit`) in
 * `tool_name`: `Write`, `Edit` and `MultiEdit` tell Claude-mode consumers
 * that the file changed, and Beacon's Claude mode builds a `file.modified`
 * diff from any payload so named, failed or not.
 */
export function claudeToolFields(
  payload: PreToolUsePayload | PostToolUsePayload | PostToolUseFailurePayload | PermissionRequestPayload,
): Record<string, unknown> {
  const { tool, args, cwd } = payload;
  let toolName = claudeToolName(tool, args);
  const fields: Record<string, unknown> = {
    autopilot_tool_name: tool,
    tool_input: claudeToolInput(tool, args, cwd),
  };
  if (payload.event === "PostToolUse") {
    const { result } = payload;
    fields.tool_response = claudeToolResponse(tool, args, cwd, result);
    if (toolCallFailed(result)) {
      fields.error = claudeError(result);
      fields.is_interrupt = result.interrupted === true || result.errorCode === "aborted";
      if (FILE_EDIT_NAMES.has(toolName)) toolName = tool;
    }
  } else if (payload.event === "PostToolUseFailure") {
    const { result } = payload;
    fields.tool_response = claudeToolResponse(tool, args, cwd, result);
    fields.error = payload.error;
    fields.is_interrupt = result.interrupted === true || result.errorCode === "aborted";
    if (FILE_EDIT_NAMES.has(toolName)) toolName = tool;
  }
  return { tool_name: toolName, ...fields };
}
