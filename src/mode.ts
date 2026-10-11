export type Mode = "edit" | "plan" | "auto";

export const MODES: Mode[] = ["edit", "plan", "auto"];

export function nextMode(m: Mode): Mode {
  const i = MODES.indexOf(m);
  return MODES[(i + 1) % MODES.length]!;
}

export function modeDescription(m: Mode): string {
  switch (m) {
    case "edit":
      return "edit — default; prompts for permission before mutating tools";
    case "plan":
      return "plan — read-only research; blocks writes/edits/mutating bash until you exit plan mode";
    case "auto":
      return "auto — autonomous; auto-approves every tool call (use with care)";
  }
}

export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);
const PLAN_BLOCKED_TOOLS = new Set([
  "github_create_pr", "memory_remember", "memory_forget", "job_start", "job_cancel",
  "subagent", "changelog_image", "wait_for", "lsp_rename", "lsp_codeAction", "browser_fetch",
]);
const PLAN_READ_ONLY_TOOLS = new Set([
  "read", "glob", "grep", "expand_artifact", "web_fetch", "search_web",
  "github_read_pr", "github_read_issue", "github_read_code", "github_list_merged_prs", "github_list_releases",
  "memory_recall", "job_status", "job_logs", "lsp_definition", "lsp_typeDefinition", "lsp_references",
  "lsp_hover", "lsp_workspaceSymbol", "tasks_set", "present_plan_options",
]);

export function isBlockedInPlanMode(toolName: string): boolean {
  if (MUTATING_TOOLS.has(toolName) || PLAN_BLOCKED_TOOLS.has(toolName)) return true;
  if (toolName.startsWith("mcp_")) return true;
  return false;
}

/** Fail-closed permission policy for plan-mode sessions. */
export function isAllowedInPlanMode(toolName: string, args?: unknown): boolean {
  if (toolName === "bash") {
    const command = args && typeof args === "object" ? (args as { command?: unknown }).command : undefined;
    return typeof command === "string" && isReadOnlyBash(command);
  }
  return PLAN_READ_ONLY_TOOLS.has(toolName);
}

/** External actions in auto mode pause before the action executes. */
export function requiresApprovalInAutoMode(toolName: string, args?: unknown): boolean {
  if (toolName === "github_create_pr") return true;
  if (toolName !== "bash" || !args || typeof args !== "object") return false;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string") return false;
  if (/\bgit\s+push\b/i.test(command)) return true;
  const curlLike = /\b(?:curl|wget)\b/i.test(command);
  const mutatingMethod = /(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command);
  const hasBody = /(?:^|\s)(?:-d|--data(?:-raw|-binary)?)\b/i.test(command);
  return curlLike && (mutatingMethod || hasBody);
}

// Bash safety for plan mode ---------------------------------------------------

const DANGEROUS_PATTERNS = /[<>;`$]|\$\(|\$\{|\|\||\b&\s*$/;

const GIT_READONLY_SUBCOMMANDS: Record<string, boolean> = {
  log: true,
  diff: true,
  status: true,
  show: true,
  blame: true,
  describe: true,
  "rev-parse": true,
  "ls-files": true,
  reflog: true,
  shortlog: true,
  whatchanged: true,
  grep: true,
  branch: false, // needs check: block -d/-D/-m/-M/-c/-C
  stash: false, // needs check: only allow "list"
  remote: false, // needs check: only allow -v
  tag: false, // needs check: only allow -l
  config: false, // needs check: only allow --list/--get
};

const READONLY_COMMANDS = new Set([
  // File system
  "cd", "ls", "cat", "head", "tail", "pwd", "echo",
  "file", "stat", "readlink", "realpath", "dirname", "basename",
  "wc", "sort", "uniq", "diff", "cmp",
  // Search
  "grep", "rg", "ag", "fd", "locate",
  // System info
  "ps", "df", "du", "env", "printenv", "which", "whereis",
  "uname", "hostname", "uptime", "free", "date", "id", "whoami", "groups",
  // Utilities
  "jq", "cut", "tr",
  "base64", "sha256sum", "md5sum", "shasum", "hexdump", "xxd", "strings",
  "less", "more", "man", "clear", "history",
  // Archive inspection
  "zipinfo",
  // Network
  "ping", "netstat", "ss", "lsof",
]);

function getTokens(s: string): string[] {
  const toks: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        toks.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) toks.push(cur);
  return toks;
}

function isReadOnlySegment(seg: string): boolean {
  const toks = getTokens(seg.trim());
  if (toks.length === 0) return false;

  const [cmd, sub, ...rest] = toks;
  if (cmd === "find") {
    // `find` is read-only EXCEPT for the action primaries that mutate or
    // run arbitrary commands: -delete, -exec, -execdir, -ok, -okdir, -fprint*.
    // Anything else (-name, -path, -type, -print, -size, …) is safe.
    const all = [sub ?? "", ...rest];
    const DENY = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);
    if (all.some((t) => DENY.has(t) || /^-fprint/.test(t))) return false;
    return true;
  }
  if (cmd === "git") {
    const allowed = GIT_READONLY_SUBCOMMANDS[sub ?? ""];
    if (allowed === undefined) return false;
    if (allowed === true) return true;

    switch (sub) {
      case "branch":
        return !rest.some((a) => /^-[dDmMcC]/.test(a));
      case "stash":
        return rest[0] === "list";
      case "remote":
        return rest[0] === "-v" || rest[0] === "--verbose" || rest.length === 0;
      case "tag":
        return rest[0] === "-l" || rest[0] === "--list" || rest.length === 0;
      case "config":
        return rest[0] === "--list" || rest[0]?.startsWith("--get") === true || rest.length === 0;
      default:
        return false;
    }
  }

  return READONLY_COMMANDS.has(cmd!);
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Reject redirections, background, subshells, variable expansion
  if (DANGEROUS_PATTERNS.test(trimmed)) return false;

  // Split by pipes and && chains, validating each segment independently
  const segs: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (trimmed.slice(i, i + 2) === "&&") {
      segs.push(cur);
      cur = "";
      i++;
    } else if (ch === "|") {
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) segs.push(cur);
  if (segs.length === 0) return false;

  for (const seg of segs) {
    if (!isReadOnlySegment(seg.trim())) return false;
  }
  return true;
}

export function systemPromptForMode(m: Mode): string {
  if (m === "plan") {
    return "\n\nPLAN MODE is active. The user wants you to investigate and produce a plan WITHOUT making any changes. Do not call write, edit, or mutating bash commands. You may use read-only bash commands (e.g., git log, git diff, ls, cat, grep) along with read/glob/grep/web-fetch. For research, prefer these read-only tools: search_web (when you need to find information but don't have a URL), web_fetch (when you already know the exact URL), github_read_pr / github_read_issue / github_read_code (to inspect GitHub repositories without cloning). `browser_fetch` is blocked because screenshots write files. Scripting interpreters (node, python3, ruby, perl, awk) and build/package tools (npm, cargo, go, tsc, jest, etc.) are blocked in plan mode. At the end, present a concise numbered plan (1., 2., ...) naming the files to change and the approach. The user will review and then exit plan mode to execute.";
  }
  if (m === "auto") {
    return "\n\nAUTO MODE is active. The user has opted into autonomous execution — every tool call will be auto-approved. Work efficiently, but do not take irreversible destructive actions (rm -rf, git push --force, dropping tables, etc.) without pausing to describe them in chat first. Prefer smaller reversible steps.";
  }
  return "";
}
