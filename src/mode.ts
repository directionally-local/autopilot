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

export function isBlockedInPlanMode(toolName: string): boolean {
  if (MUTATING_TOOLS.has(toolName)) return true;
  if (toolName.startsWith("mcp_")) return true;
  if (toolName === "lsp_rename" || toolName === "lsp_codeAction") return true;
  // browser_fetch with screenshot writes files to disk
  if (toolName === "browser_fetch") return true;
  return false;
}

// Bash safety for plan mode ---------------------------------------------------
//
// Plan mode runs any command this classifier accepts WITHOUT asking, so it
// must only accept commands bash will run as pure reads. Anything it cannot
// parse with certainty is rejected (the host then blocks or prompts).
//
//  - Shell syntax is refused unless it is a plain pipe or `&&`: redirection,
//    `;`, `||`, a lone `&`, substitution, expansion, backslash escapes (which
//    make quoting ambiguous), brace expansion, and every control character
//    (a newline is a command separator to bash).
//  - Each segment's command must be allowlisted, and its arguments must not
//    use an option that runs a program or writes a file.
//  - A glob that could expand to a word starting with `-` (`*`, `-*`, `?x`)
//    is refused for commands that have such options: a repository can
//    contain a file named `--pre=sh`.

const DANGEROUS_PATTERNS = /[<>;`$\\{}]|\|\|/;
// Control characters, except tab (plain whitespace to bash).
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;

/** `--name` or `--name=value`. */
function isLong(arg: string, ...names: string[]): boolean {
  return names.some((n) => arg === n || arg.startsWith(`${n}=`));
}

/** A short-option cluster (`-uo`) containing any of `letters`. */
function hasShort(arg: string, letters: string): boolean {
  return /^-[^-]/.test(arg) && [...letters].some((l) => arg.slice(1).includes(l));
}

/** Non-option arguments, skipping the value of each option in `valueOpts`. */
function positionals(args: string[], valueOpts: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return [...out, ...args.slice(i + 1)];
    if (valueOpts.includes(a)) {
      i++;
      continue;
    }
    if (!a.startsWith("-") || a === "-") out.push(a);
  }
  return out;
}

type ArgCheck = (args: string[]) => boolean;
const anyArgs: ArgCheck = () => true;

/**
 * Allowlisted commands and the argument check each must pass. Commands
 * that can execute programs or write files are listed with a check;
 * `env`, `man`, `less`, `more` and `history` are deliberately absent
 * (`env cmd` and `man -P cmd` run arbitrary programs; pagers have shell
 * escapes), as is `printenv` (it prints secrets from the environment).
 */
const READONLY_COMMANDS: Record<string, ArgCheck> = {
  // File system
  cd: anyArgs, ls: anyArgs, cat: anyArgs, head: anyArgs, tail: anyArgs, pwd: anyArgs, echo: anyArgs,
  file: (args) => !args.some((a) => isLong(a, "--compile") || hasShort(a, "C")),
  stat: anyArgs, readlink: anyArgs, realpath: anyArgs, dirname: anyArgs, basename: anyArgs,
  wc: anyArgs,
  sort: (args) => !args.some((a) => isLong(a, "--output", "--compress-program") || hasShort(a, "o")),
  uniq: (args) => positionals(args, ["-f", "-s", "-w"]).length <= 1, // `uniq in out` writes out
  diff: anyArgs, cmp: anyArgs,
  // Search
  grep: anyArgs,
  rg: (args) => !args.some((a) => isLong(a, "--pre", "--hostname-bin")),
  ag: (args) => !args.some((a) => isLong(a, "--pager")),
  fd: (args) => !args.some((a) => isLong(a, "--exec", "--exec-batch") || hasShort(a, "xX")),
  locate: anyArgs,
  // System info
  ps: anyArgs, df: anyArgs, du: anyArgs, which: anyArgs, whereis: anyArgs, uname: anyArgs,
  hostname: (args) => args.every((a) => HOSTNAME_READ_FLAGS.has(a)), // a name or -F sets it
  uptime: anyArgs, free: anyArgs,
  date: (args) => !args.some((a) => isLong(a, "--set") || hasShort(a, "s")),
  id: anyArgs, whoami: anyArgs, groups: anyArgs,
  // Utilities
  jq: anyArgs, cut: anyArgs, tr: anyArgs,
  base64: anyArgs, sha256sum: anyArgs, md5sum: anyArgs, shasum: anyArgs, hexdump: anyArgs, strings: anyArgs,
  xxd: (args) => !args.some((a) => hasShort(a, "r")) && positionals(args, ["-c", "-g", "-l", "-s", "-o", "-cols", "-len", "-seek"]).length <= 1,
  clear: anyArgs,
  // Archive inspection
  zipinfo: anyArgs,
  // Network
  ping: anyArgs, netstat: anyArgs, lsof: anyArgs,
  ss: (args) => !args.some((a) => isLong(a, "--kill", "--diag") || hasShort(a, "KD")),
};

const HOSTNAME_READ_FLAGS = new Set([
  "-f", "-s", "-d", "-i", "-I", "-a", "-A",
  "--fqdn", "--long", "--short", "--domain", "--ip-address", "--all-ip-addresses", "--alias", "--all-fqdns",
]);

/** Commands with no option that executes or writes: a glob that expands
 *  to an option-like file name cannot hurt them. */
const GLOB_SAFE = new Set([
  "cd", "ls", "cat", "head", "tail", "echo", "stat", "readlink", "realpath", "dirname", "basename",
  "wc", "diff", "cmp", "grep", "du", "base64", "sha256sum", "md5sum", "shasum", "hexdump", "strings", "zipinfo",
]);

/** `git <sub>` options that write a file or run a program. */
function gitArgIsUnsafe(a: string): boolean {
  return isLong(a, "--output", "--open-files-in-pager", "--ext-diff") || /^-O/.test(a);
}

const GIT_BRANCH_WRITE = /^(-[dDmMcCftu]|--(delete|move|copy|force|track|no-track|set-upstream-to|unset-upstream|edit-description|create-reflog))/;
const GIT_BRANCH_VALUE_OPTS = ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"];
const GIT_CONFIG_READ = /^(--list|-l|--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--global|--local|--system|--worktree|--show-origin|--show-scope|--name-only|-z|--null|--type=\S+|--includes|--no-includes)$/;

const GIT_READONLY_SUBCOMMANDS: Record<string, ArgCheck> = {
  log: anyArgs, diff: anyArgs, status: anyArgs, show: anyArgs, blame: anyArgs, describe: anyArgs,
  "rev-parse": anyArgs, "ls-files": anyArgs, shortlog: anyArgs, whatchanged: anyArgs, grep: anyArgs,
  // `git reflog expire|delete` rewrite the reflog.
  reflog: (args) => args.length === 0 || args[0] === "show" || args[0]!.startsWith("-"),
  // `git branch <name>` creates one; only listing forms are read-only.
  branch: (args) => {
    if (args.some((a) => GIT_BRANCH_WRITE.test(a))) return false;
    const listing = args.some((a) => a === "--list" || a === "-l" || a === "-a" || a === "-r" || a === "--all" || a === "--remotes");
    return listing || positionals(args, GIT_BRANCH_VALUE_OPTS).length === 0;
  },
  stash: (args) => args[0] === "list",
  remote: (args) => args.length === 0 || (args.length === 1 && (args[0] === "-v" || args[0] === "--verbose")),
  // `git tag <name>` creates one; only `git tag` / `git tag -l [pattern]`.
  tag: (args) => args.length === 0 || ((args[0] === "-l" || args[0] === "--list") && args.slice(1).every((a) => !a.startsWith("-"))),
  // Reads only: every option must be a read option, and a lookup needs --get*/--list.
  config: (args) => {
    const opts = args.filter((a) => a.startsWith("-"));
    if (!opts.every((a) => GIT_CONFIG_READ.test(a))) return false;
    const pos = args.filter((a) => !a.startsWith("-"));
    return pos.length === 0 || opts.some((a) => a.startsWith("--get") || a === "--list" || a === "-l");
  },
};

interface Token {
  text: string;
  /** An unquoted glob character appears before any other character that
   *  could make the expansion start with something other than `-`. */
  optionGlob: boolean;
}

/** Split a segment into shell words, or null if quoting is unbalanced. */
function getTokens(s: string): Token[] | null {
  const toks: Token[] = [];
  let cur = "";
  let started = false;
  let optionGlob = false;
  let q: string | null = null;
  const flush = () => {
    if (started) toks.push({ text: cur, optionGlob });
    cur = "";
    started = false;
    optionGlob = false;
  };
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      started = true;
    } else if (ch === " " || ch === "\t") {
      flush();
    } else {
      // `*`, `?x`, `[a]x`, `-*`: the expansion may begin with `-`.
      if ((ch === "*" || ch === "?" || ch === "[") && /^-*$/.test(cur)) optionGlob = true;
      cur += ch;
      started = true;
    }
  }
  if (q) return null;
  flush();
  return toks;
}

function isReadOnlySegment(seg: string): boolean {
  const toks = getTokens(seg.trim());
  if (!toks || toks.length === 0) return false;
  const [cmdTok, ...argToks] = toks;
  const cmd = cmdTok!.text;
  const args = argToks.map((t) => t.text);
  if (cmdTok!.optionGlob) return false;
  if (!GLOB_SAFE.has(cmd) && argToks.some((t) => t.optionGlob)) return false;

  if (cmd === "find") {
    // `find` is read-only EXCEPT for the action primaries that mutate or
    // run arbitrary commands: -delete, -exec, -execdir, -ok, -okdir, -fls,
    // -fprint*. Anything else (-name, -path, -type, -print, -size, …) is safe.
    const DENY = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"]);
    return !args.some((t) => DENY.has(t) || /^-fprint/.test(t));
  }
  if (cmd === "git") {
    const [sub, ...rest] = args;
    const check = GIT_READONLY_SUBCOMMANDS[sub ?? ""];
    if (!check) return false;
    if (rest.some(gitArgIsUnsafe)) return false;
    return check(rest);
  }

  const check = Object.hasOwn(READONLY_COMMANDS, cmd) ? READONLY_COMMANDS[cmd] : undefined;
  return check !== undefined && check(args);
}

export function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  // Reject redirections, separators other than | and &&, subshells,
  // expansion, escapes, and control characters (a newline separates commands).
  if (DANGEROUS_PATTERNS.test(trimmed) || CONTROL_CHARS.test(trimmed)) return false;

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
    } else if (ch === "&") {
      return false; // a lone & backgrounds the left side and runs the right
    } else if (ch === "|") {
      segs.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (q) return false;
  segs.push(cur);

  // An empty segment (`ls |`, `&& ls`) is a syntax error at best.
  for (const seg of segs) {
    if (!isReadOnlySegment(seg.trim())) return false;
  }
  return true;
}

export function systemPromptForMode(m: Mode): string {
  if (m === "plan") {
    return "\n\nPLAN MODE is active. The user wants you to investigate and produce a plan WITHOUT making any changes. Do not call write, edit, or mutating bash commands. You may use read-only bash commands (e.g., git log, git diff, ls, cat, grep) along with read/glob/grep/web-fetch. For research, prefer these read-only tools: search_web (when you need to find information but don't have a URL), web_fetch (when you already know the exact URL), browser_fetch (for JavaScript-rendered pages where web_fetch is insufficient), github_read_pr / github_read_issue / github_read_code (to inspect GitHub repositories without cloning). Scripting interpreters (node, python3, ruby, perl, awk) and build/package tools (npm, cargo, go, tsc, jest, etc.) are blocked in plan mode. At the end, present a concise plan (bullets, files to change, approach). The user will review and then exit plan mode to execute.";
  }
  if (m === "auto") {
    return "\n\nAUTO MODE is active. The user has opted into autonomous execution — every tool call will be auto-approved. Work efficiently, but do not take irreversible destructive actions (rm -rf, git push --force, dropping tables, etc.) without pausing to describe them in chat first. Prefer smaller reversible steps.";
  }
  return "";
}
