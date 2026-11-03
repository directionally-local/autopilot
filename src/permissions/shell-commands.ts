/**
 * What a bash command really runs: every simple command inside it, with the
 * wrappers around it taken off.
 *
 * Permission checks (the once-per-project setup question, and any
 * classifier of destructive actions) need to see `npm install` in all of:
 *
 *   timeout 120 npm install 2>&1 | tail -5
 *   cd app && sudo -u ci env CI=1 nice -n 5 npm install
 *   bash -c "npm install"            ( npm install )      echo $(npm install)
 *   find . -name '*.lock' | xargs rm -f
 *
 * and must not see it in `echo "npm install"`. So the command is split the
 * way a shell would split it (quotes, escapes, `;` `&&` `||` `|` `&`,
 * newlines, subshells, `$( … )`, backticks, process substitution,
 * here-documents), every segment is listed, and for each one the leading
 * `VAR=value` assignments and wrapper commands (with their options and
 * positional arguments, e.g. `timeout`'s duration) are skipped. A shell
 * started with `-c` (and `eval`, `env -S`, `flock -c`) contributes the
 * commands of its script instead.
 *
 * This is a best-effort reading for asking the right question, not a
 * sandbox: it errs on the side of finding commands.
 */

/** An output or input redirection on a command, e.g. `>` `out.txt`, `2>&` `1`. */
export interface Redirect {
  /** The operator without its descriptor number: `>`, `>>`, `>|`, `&>`, `&>>`, `>&`, `<`, `<&`, `<>`, `<<`, `<<<`. */
  op: string;
  target: string;
  /** A here-document's text, for `<<` (the destructive-action check reads SQL from it). */
  body?: string;
}

/** One command the shell would run. */
export interface SimpleCommand {
  /** The command and its arguments, quotes removed, after assignments and wrappers. Empty for a bare redirection (`> file`). */
  argv: string[];
  /** `argv[0]` without its directory (`/usr/bin/npm` → `npm`); "" when argv is empty. */
  name: string;
  /** The segment as written, trimmed (wrappers and redirections included). */
  text: string;
  /** The wrappers taken off, outermost first, e.g. `["sudo", "timeout"]`. */
  wrappers: string[];
  /** Leading `VAR=value` assignments. */
  assignments: string[];
  redirects: Redirect[];
  /** The command before it in a pipeline (`echo "…" | psql`), whose output this one reads. */
  pipedFrom?: SimpleCommand;
}

/** How deep scripts inside scripts (`bash -c "sh -c '…'"`) are followed. */
const MAX_DEPTH = 8;

// ── Lexing ───────────────────────────────────────────────────────────────

type Token =
  | { kind: "word"; value: string; start: number; end: number }
  | { kind: "op"; value: string; start: number; end: number }
  | { kind: "redir"; op: string; target: string; start: number; end: number; body?: string }
  | { kind: "group"; start: number; end: number };

const SPACE = /[ \t\r]/;
/** Characters that end an unquoted word. */
const WORD_END = /[\s;&|<>()]/;

/** Index of the `)` closing the `(` just before `from`, skipping quotes and escapes; -1 when unbalanced. */
function closingParen(src: string, from: number): number {
  let depth = 1;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") i++;
    else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === "\\") i++;
        i++;
      }
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the closing backtick for one opened at `from - 1`; -1 when there is none. */
function closingBacktick(src: string, from: number): number {
  for (let i = from; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === "`") return i;
  }
  return -1;
}

/**
 * Split `src` into words, operators, redirections and groups. Scripts inside
 * it (subshells, command and process substitutions, backticks) are handed
 * to `nested` as they are met.
 */
function lex(src: string, nested: (inner: string) => void): Token[] {
  const tokens: Token[] = [];
  const heredocs: Array<{ delim: string; strip: boolean; token: Token & { kind: "redir" } }> = [];
  let i = 0;
  const n = src.length;

  /** Read one word starting at `i`; returns its value with quotes removed. */
  const readWord = (): string => {
    let value = "";
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        if (src[i + 1] === "\n") i += 2;
        else {
          value += src[i + 1] ?? "";
          i += 2;
        }
      } else if (c === "'") {
        const j = src.indexOf("'", i + 1);
        const end = j < 0 ? n : j;
        value += src.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < n && src[i] !== '"') {
          const d = src[i]!;
          if (d === "\\" && i + 1 < n && '$`"\\\n'.includes(src[i + 1]!)) {
            if (src[i + 1] !== "\n") value += src[i + 1];
            i += 2;
          } else if (d === "$" && src[i + 1] === "(") {
            i = substitution(i + 2, (s) => (value += s));
          } else if (d === "`") {
            i = backtick(i + 1, (s) => (value += s));
          } else {
            value += d;
            i++;
          }
        }
        i++;
      } else if (c === "$" && src[i + 1] === "(") {
        i = substitution(i + 2, (s) => (value += s));
      } else if (c === "`") {
        i = backtick(i + 1, (s) => (value += s));
      } else if ((c === "<" || c === ">") && src[i + 1] === "(") {
        // Process substitution: <(cmd) / >(cmd).
        i = substitution(i + 2, (s) => (value += c + s.slice(1)));
      } else if (c === "$" && src[i + 1] === "{") {
        const j = src.indexOf("}", i + 2);
        const end = j < 0 ? n : j + 1;
        value += src.slice(i, end);
        i = end;
      } else if (WORD_END.test(c)) {
        break;
      } else {
        value += c;
        i++;
      }
    }
    return value;
  };

  /** `$(` … `)` from `from` (just past the paren): nested, appended as written; returns the index after it. */
  const substitution = (from: number, append: (s: string) => void): number => {
    const close = closingParen(src, from);
    const end = close < 0 ? n : close;
    nested(src.slice(from, end));
    append(`$(${src.slice(from, end)})`);
    return end + 1;
  };
  const backtick = (from: number, append: (s: string) => void): number => {
    const close = closingBacktick(src, from);
    const end = close < 0 ? n : close;
    nested(src.slice(from, end));
    append(`\`${src.slice(from, end)}\``);
    return end + 1;
  };

  /** After a newline: skip the bodies of here-documents opened on the line before, keeping their text. */
  const skipHeredocs = () => {
    while (heredocs.length > 0) {
      const { delim, strip, token } = heredocs.shift()!;
      const lines: string[] = [];
      while (i < n) {
        const eol = src.indexOf("\n", i);
        const line = src.slice(i, eol < 0 ? n : eol);
        i = eol < 0 ? n : eol + 1;
        if ((strip ? line.replace(/^\t+/, "") : line).trim() === delim) break;
        lines.push(line);
      }
      token.body = lines.join("\n");
    }
  };

  while (i < n) {
    const c = src[i]!;
    const start = i;
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      tokens.push({ kind: "op", value: "\n", start, end: ++i });
      skipHeredocs();
      continue;
    }
    // Redirections: [n]> [n]>> >| [n]>& [n]< [n]<& <> << <<- <<< &> &>> (not <( or >(, process substitution).
    const redir = /^(?:\d*(>>|>\||>&|>|<<<|<<-|<<|<>|<&|<)|(&>>|&>))/.exec(src.slice(i, i + 8));
    if (redir && !((c === "<" || c === ">") && src[i + 1] === "(")) {
      const op = (redir[1] ?? redir[2])!;
      i += redir[0].length;
      while (i < n && SPACE.test(src[i]!)) i++;
      const target = readWord();
      const token: Token & { kind: "redir" } = { kind: "redir", op, target, start, end: i };
      if (op === "<<" || op === "<<-") heredocs.push({ delim: target, strip: op === "<<-", token });
      tokens.push(token);
      continue;
    }
    if (c === "&" || c === "|" || c === ";") {
      const two = src.slice(i, i + 2);
      const value = two === "&&" || two === "||" || two === "|&" || two === ";;" ? two : c;
      i += value.length;
      tokens.push({ kind: "op", value, start, end: i });
      continue;
    }
    if (c === "(") {
      // A subshell (or the body of `f() ( … )`, or `$(( … ))` arithmetic).
      const close = closingParen(src, i + 1);
      const end = close < 0 ? n : close;
      nested(src.slice(i + 1, end));
      i = end + 1;
      tokens.push({ kind: "group", start, end: i });
      continue;
    }
    if (c === ")") {
      i++;
      continue;
    }
    const value = readWord();
    if (i === start) {
      // Nothing consumed (a lone `<(` without a close, say): step over it.
      i++;
      continue;
    }
    tokens.push({ kind: "word", value, start, end: i });
  }
  return tokens;
}

// ── Wrappers ─────────────────────────────────────────────────────────────

/** What a wrapper leaves: the index where the wrapped command starts, a script to read instead, or nothing run at all. */
type Unwrapped = number | { script: string } | null;

/**
 * Skip options from `i`: `-abc` clusters, `--long`, `--long=value`, up to
 * `--`. Options in `withArg` (short letters, or long names) take the next
 * word as their value unless it is attached (`-n5`, `--signal=KILL`).
 */
function skipOptions(w: string[], i: number, withArg: { short?: string; long?: string[] } = {}): number {
  while (i < w.length) {
    const a = w[i]!;
    if (a === "--") return i + 1;
    if (!a.startsWith("-") || a === "-") return i;
    if (a.startsWith("--")) {
      i += !a.includes("=") && withArg.long?.includes(a) ? 2 : 1;
      continue;
    }
    let takesNext = false;
    for (let k = 1; k < a.length; k++) {
      if (withArg.short?.includes(a[k]!)) {
        takesNext = k === a.length - 1;
        break;
      }
    }
    i += takesNext ? 2 : 1;
  }
  return i;
}

/** Whether any option before the command matches. */
function hasOption(w: string[], from: number, to: number, short: string, long: string[] = []): boolean {
  for (let k = from; k < to && k < w.length; k++) {
    const a = w[k]!;
    if (long.some((l) => a === l || a.startsWith(`${l}=`))) return true;
    if (/^-[^-]/.test(a) && [...short].some((s) => a.slice(1).includes(s))) return true;
  }
  return false;
}

const WRAPPERS: Record<string, (w: string[], i: number) => Unwrapped> = {
  sudo: (w, i) => skipOptions(w, i, { short: "ugCDhpRrtTU", long: ["--user", "--group", "--chdir", "--prompt", "--close-from", "--role", "--type", "--host", "--other-user", "--command-timeout"] }),
  doas: (w, i) => skipOptions(w, i, { short: "uC" }),
  env: (w, i) => {
    for (let k = i; k < w.length; k++) {
      const a = w[k]!;
      if (a === "-S" || a === "--split-string") return { script: w.slice(k + 1).join(" ") };
      if (a.startsWith("--split-string=")) return { script: [a.slice("--split-string=".length), ...w.slice(k + 1)].join(" ") };
      if (/^-[^-]*S./.test(a)) return { script: [a.slice(a.indexOf("S") + 1), ...w.slice(k + 1)].join(" ") };
      if (!a.startsWith("-") || a === "--") break;
    }
    return skipOptions(w, i, { short: "uCP", long: ["--unset", "--chdir"] });
  },
  time: (w, i) => skipOptions(w, i, { short: "fo", long: ["--format", "--output"] }),
  // `command -v npm` only says where npm is.
  command: (w, i) => (hasOption(w, i, skipOptions(w, i), "vV") ? null : skipOptions(w, i)),
  builtin: (_w, i) => i,
  exec: (w, i) => skipOptions(w, i, { short: "a" }),
  nice: (w, i) => skipOptions(w, i, { short: "n", long: ["--adjustment"] }),
  nohup: (w, i) => skipOptions(w, i),
  setsid: (w, i) => skipOptions(w, i),
  unbuffer: (w, i) => skipOptions(w, i),
  caffeinate: (w, i) => skipOptions(w, i, { short: "tw" }),
  // timeout [opts] DURATION CMD
  timeout: (w, i) => skipOptions(w, i, { short: "sk", long: ["--signal", "--kill-after"] }) + 1,
  // ionice [-c class] [-n level] [-t] CMD; with -p/-P/-u it changes running processes instead.
  ionice: (w, i) => {
    const j = skipOptions(w, i, { short: "cnpPu", long: ["--class", "--classdata", "--pid", "--pgid", "--uid"] });
    return hasOption(w, i, j, "pPu", ["--pid", "--pgid", "--uid"]) ? null : j;
  },
  stdbuf: (w, i) => skipOptions(w, i, { short: "ioe", long: ["--input", "--output", "--error"] }),
  // xargs [opts] [CMD [args]]: the command (echo by default) runs with arguments from stdin.
  xargs: (w, i) => skipOptions(w, i, { short: "adEILnPs", long: ["--arg-file", "--delimiter", "--eof", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"] }),
  // flock [opts] FILE CMD, flock [opts] FILE -c 'script'; flock [opts] FD locks only.
  flock: (w, i) => {
    const withValue = ["-w", "-E", "--timeout", "--wait", "--conflict-exit-code"];
    const file = skipOptions(w, i, { short: "wE", long: withValue });
    if (file >= w.length || /^\d+$/.test(w[file]!)) return null;
    let k = file + 1;
    while (k < w.length && w[k]!.startsWith("-")) {
      const a = w[k]!;
      if (a === "--") return k + 1;
      if (a === "-c" || a === "--command") return { script: w[k + 1] ?? "" };
      if (a.startsWith("--command=")) return { script: a.slice("--command=".length) };
      k += withValue.includes(a) ? 2 : 1;
    }
    return k;
  },
  // chrt [opts] PRIORITY CMD; -p changes a running process, -m only prints.
  chrt: (w, i) => {
    const j = skipOptions(w, i, { short: "TPD", long: ["--sched-runtime", "--sched-period", "--sched-deadline"] });
    return hasOption(w, i, j, "pm", ["--pid", "--max"]) ? null : j + 1;
  },
  // taskset [opts] MASK CMD; -p changes a running process.
  taskset: (w, i) => {
    const j = skipOptions(w, i);
    return hasOption(w, i, j, "p", ["--pid"]) ? null : j + 1;
  },
};

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);

/** Words that start a segment without being its command: `if`, `then`, `do`, `!`, `{`, … */
const LEADING_KEYWORDS = new Set(["!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"]);
/** Segments that are syntax, not a command run (`for x in a b`, `case $x in`). */
const NOT_COMMANDS = new Set(["for", "select", "case", "function"]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

function basename(word: string): string {
  return word.split("/").pop() ?? word;
}

/** `bash [opts] -c SCRIPT`: the script; undefined when the shell runs a file or reads stdin. */
function shellScript(w: string[]): string | undefined {
  let i = 1;
  let c = false;
  while (i < w.length) {
    const a = w[i]!;
    if (a === "--") {
      i++;
      break;
    }
    if (!/^[-+]/.test(a) || a === "-" || a === "+") break;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(a) || a === "--command") c = true;
    i += ["-o", "+o", "-O", "+O", "--rcfile", "--init-file"].includes(a) ? 2 : 1;
  }
  return c ? (w[i] ?? "") : undefined;
}

// ── Commands ─────────────────────────────────────────────────────────────

/** Every command `command` runs, in the order written (substitutions before the command using them). */
export function simpleCommands(command: string): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  collect(command, 0, out);
  return out;
}

function collect(src: string, depth: number, out: SimpleCommand[]): void {
  if (depth > MAX_DEPTH) return;
  const tokens = lex(src, (inner) => collect(inner, depth + 1, out));
  let seg: Token[] = [];
  let piped = false;
  let prev: SimpleCommand | undefined;
  const flush = () => {
    if (seg.length > 0) {
      const before = out.length;
      segment(src, seg, depth, out);
      const cmd = out.length > before ? out[out.length - 1] : undefined;
      if (cmd && piped && prev) cmd.pipedFrom = prev;
      prev = cmd;
    }
    seg = [];
  };
  for (const t of tokens) {
    if (t.kind === "op") {
      flush();
      piped = t.value === "|" || t.value === "|&";
    } else seg.push(t);
  }
  flush();
}

function segment(src: string, seg: Token[], depth: number, out: SimpleCommand[]): void {
  const words = seg.flatMap((t) => (t.kind === "word" ? [t.value] : []));
  const redirects = seg.flatMap((t) => (t.kind === "redir" ? [{ op: t.op, target: t.target, ...(t.body !== undefined ? { body: t.body } : {}) }] : []));
  const text = src.slice(seg[0]!.start, seg[seg.length - 1]!.end).trim();
  const wrappers: string[] = [];
  const assignments: string[] = [];
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i]!)) assignments.push(words[i++]!);
    if (i >= words.length) break;
    const w = words[i]!;
    if (LEADING_KEYWORDS.has(w)) {
      i++;
      continue;
    }
    if (NOT_COMMANDS.has(w)) return;
    const name = basename(w);
    if (name === "eval") return collect(words.slice(i + 1).join(" "), depth + 1, out);
    if (SHELLS.has(name)) {
      const script = shellScript(words.slice(i));
      if (script !== undefined) return collect(script, depth + 1, out);
      break;
    }
    const wrapper = WRAPPERS[name];
    if (!wrapper) break;
    const next = wrapper(words, i + 1);
    if (next === null) return;
    wrappers.push(name);
    if (typeof next === "object") return collect(next.script, depth + 1, out);
    i = next;
    // `xargs` with nothing after it runs echo.
    if (name === "xargs" && i >= words.length) words.push("echo");
  }
  const argv = words.slice(i);
  if (argv.length === 0 && redirects.length === 0) return;
  out.push({ argv, name: argv[0] ? basename(argv[0]) : "", text, wrappers, assignments, redirects });
}

/** True for an output redirection into a file (not a descriptor, not /dev/null or the terminal). */
export function writesFile(r: Redirect): boolean {
  if (!r.op.includes(">") || r.op === "<>") return r.op === "<>";
  if (r.op === ">&" && /^(\d+-?|-)$/.test(r.target)) return false;
  return !/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(r.target);
}
