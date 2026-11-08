/**
 * Recognise destructive actions, whatever the tool (autopilot#1125).
 *
 * Tags a tool call as:
 *   - "irreversible": data is lost and Autopilot can't bring it back
 *     (a dropped table, a force push over others' work, `rm -rf` outside
 *     the project, `terraform destroy`, files too large to keep a copy of);
 *   - "recoverable": something is deleted or overwritten, but git, a
 *     rebuild, or a copy Autopilot makes first can bring it back
 *     (`rm -rf node_modules`, `git reset --hard` over a few changed files,
 *     `git push --force-with-lease`, `git branch -D`);
 *   - "safe": nothing is lost.
 *
 * Used for bash and job_start commands, the write tool, and MCP tools whose
 * input contains SQL. Database and cloud actions are always irreversible:
 * Autopilot has no automatic recovery for them yet.
 *
 * Nothing here leaves the machine: it reads the command, local files that
 * are small (SQL files, package.json scripts, .env for DATABASE_URL's host),
 * local git state, and runs `find` / `git clean -n` dry runs. A target
 * written with a variable or a common substitution is expanded first
 * (`$BUILD_DIR` from the environment, `$(pwd)`, `$(git rev-parse
 * --show-toplevel)`), so it is classified on what it really names.
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { simpleCommands as parseCommands, type SimpleCommand as ParsedCommand } from "./shell-commands.js";

export type Verdict = "irreversible" | "recoverable" | "safe";
export type Category = "database" | "files" | "git" | "cloud";

/** Where the action lands, and whether it looks like production. */
export interface Target {
  /** Plain words: "the database at DATABASE_URL (db.example.com/shop)". */
  label: string;
  production: boolean;
  /** For a production-looking target: the name a person types to confirm. */
  confirmName?: string;
}

/** What Autopilot saves before the action runs, so /undo can put it back. */
export type RecoveryPlan =
  | { kind: "files"; repo: string | null; files: string[]; bytes: number }
  | { kind: "git-head"; repo: string; files: string[]; bytes: number }
  | { kind: "git-branch"; repo: string; branches: string[] }
  | { kind: "git-remote"; repo: string; remote: string; branch: string };

export interface Finding {
  verdict: Exclude<Verdict, "safe">;
  category: Category;
  /** The exact command (one simple command of a compound one) or tool action. */
  action: string;
  /** What is lost, in plain words: "drops table `orders`". */
  loss: string;
  target?: Target;
  /** Whether and how it can be brought back, in plain words. */
  recovery: string;
  plan?: RecoveryPlan;
}

export interface Assessment {
  verdict: Verdict;
  findings: Finding[];
}

export interface ClassifyContext {
  cwd: string;
  /** The project (git top level of the starting directory); worked out from `cwd` when absent. */
  project?: string;
  /** Environment the command sees (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Directories where deleting is never "outside the project" (default: the system temp dirs). */
  scratchDirs?: string[];
  /** Recovery copy limits (defaults: 50 MB, 5,000 files). */
  maxCopyBytes?: number;
  maxCopyFiles?: number;
}

export const MAX_COPY_BYTES = 50 * 1024 * 1024;
export const MAX_COPY_FILES = 5000;
const MAX_READ_BYTES = 256 * 1024;
const NO_RECOVERY = "No automatic recovery: Autopilot can't put this back.";

const RANK: Record<Verdict, number> = { safe: 0, recoverable: 1, irreversible: 2 };

export function worstVerdict(findings: Finding[]): Verdict {
  let v: Verdict = "safe";
  for (const f of findings) if (RANK[f.verdict] > RANK[v]) v = f.verdict;
  return v;
}

// ── Commands (on top of shell-commands.ts) ───────────────────────────────

interface ShellWord {
  text: string;
  /** The word as written, before a variable or substitution was expanded. */
  raw: string;
  /** Depends on an expansion or substitution whose value isn't known here. */
  dynamic: boolean;
  /** Has a glob character. */
  glob: boolean;
}

interface Redirect {
  op: string;
  target: ShellWord;
  body?: string;
}

/** One command, as the classifier sees it. */
interface SimpleCommand {
  argv: ShellWord[];
  env: Record<string, string>;
  /** Directory it runs in, after an earlier `cd` in the same command. */
  cwd: string;
  redirects: Redirect[];
  pipeFrom?: SimpleCommand;
  /** The command as written. */
  raw: string;
  /** Run through xargs: more arguments arrive at run time. */
  argsFromInput?: boolean;
  /** Runs elsewhere: "ssh prod-1", "docker exec db", "kubectl exec". */
  via?: string;
}

const DYNAMIC = /\$[A-Za-z_{(@*#?!0-9-]|`/;

function toWord(text: string, raw = text): ShellWord {
  const dynamic = DYNAMIC.test(text);
  return { text, raw, dynamic, glob: !dynamic && /[*?[]/.test(text) };
}

/**
 * Expand what the shell would, so a target written with a variable or a
 * common substitution can still be classified: `$VAR` / `${VAR}` from the
 * environment the command sees, `$(pwd)` and `$(git rev-parse
 * --show-toplevel)`. Anything else (`$(cat list)`, `$?`, `${X:-y}`) stays as
 * written and the word stays dynamic.
 */
function expandWord(text: string, env: Record<string, string | undefined>, cwd: string): string {
  if (!DYNAMIC.test(text)) return text;
  let out = text.replace(/\$\(\s*pwd\s*\)|`\s*pwd\s*`/g, () => cwd);
  out = out.replace(/\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)|`\s*git\s+rev-parse\s+--show-toplevel\s*`/g, () => repoRootOf(cwd) ?? "$(git rev-parse --show-toplevel)");
  out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, braced: string | undefined, bare: string | undefined) => {
    const value = env[braced ?? bare ?? ""];
    return value !== undefined && !DYNAMIC.test(value) ? value : whole;
  });
  return out;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return p;
}

/** Resolve a word to a path, or null when it depends on an expansion. */
function wordPath(w: ShellWord, cwd: string): string | null {
  if (w.dynamic) return null;
  const p = expandHome(w.text);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function shellQuote(w: string): string {
  return /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`;
}

/** Skip a runner's options; returns the index of the command it runs. */
function skipRunnerOptions(a: string[], i: number, withValue: string[] = []): number {
  while (i < a.length) {
    const x = a[i]!;
    if (x === "--") return i + 1;
    if (!x.startsWith("-")) return i;
    i += withValue.includes(x) ? 2 : 1;
  }
  return i;
}

/**
 * Package runners and remote wrappers the shared parser leaves on:
 * `npx prisma …`, `bundle exec rails …`, `docker exec db psql …`,
 * `ssh host "…"`, `kubectl exec pod -- …`. Returns the command they run
 * (as argv, or as a script for ssh), or null when `a` isn't one.
 */
function runnerInner(a: string[]): { argv?: string[]; script?: string; via?: string } | null {
  const name = base(a[0]);
  const sub = a[1];
  switch (name) {
    case "npx":
    case "bunx":
    case "pnpx":
      return { argv: a.slice(skipRunnerOptions(a, 1, ["-p", "--package"])) };
    case "npm":
    case "pnpm":
    case "yarn":
      return sub === "exec" || sub === "x" || sub === "dlx" ? { argv: a.slice(skipRunnerOptions(a, 2, ["-p", "--package", "-c", "--call"])) } : null;
    case "bundle":
    case "poetry":
    case "pipenv":
    case "uv":
    case "pdm":
    case "rye":
      return sub === "exec" || sub === "run" ? { argv: a.slice(skipRunnerOptions(a, 2, ["--with", "--python", "-p", "--env-file"])) } : null;
    case "dotenv": {
      const dd = a.indexOf("--");
      return { argv: dd > 0 ? a.slice(dd + 1) : a.slice(skipRunnerOptions(a, 1, ["-e", "-v", "-c"])) };
    }
    case "docker":
    case "podman": {
      if (sub === "exec") {
        const k = skipRunnerOptions(a, 2, ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file"]);
        return { argv: a.slice(k + 1), via: `docker exec ${a[k] ?? ""}`.trim() };
      }
      if (sub === "compose" && (a[2] === "exec" || a[2] === "run")) {
        const k = skipRunnerOptions(a, 3, ["-e", "--env", "-u", "--user", "-w", "--workdir", "--entrypoint", "-p", "--publish", "-v", "--volume", "--name"]);
        return { argv: a.slice(k + 1), via: `docker compose ${a[2]} ${a[k] ?? ""}`.trim() };
      }
      return null;
    }
    case "docker-compose":
      if (sub === "exec" || sub === "run") {
        const k = skipRunnerOptions(a, 2, ["-e", "-u", "--user", "-w", "--workdir", "--entrypoint"]);
        return { argv: a.slice(k + 1), via: `docker compose ${sub} ${a[k] ?? ""}`.trim() };
      }
      return null;
    case "kubectl":
    case "oc": {
      if (!a.includes("exec")) return null;
      const dd = a.indexOf("--");
      return dd > 0 ? { argv: a.slice(dd + 1), via: "kubectl exec" } : null;
    }
    case "ssh": {
      const k = skipRunnerOptions(a, 1, ["-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-E", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-B"]);
      return a[k] && k + 1 < a.length ? { script: a.slice(k + 1).join(" "), via: `ssh ${a[k]}` } : null;
    }
  }
  return null;
}

/** The commands `command` runs, as the classifier sees them. */
function commandsOf(command: string, cwd: string, depth = 0, baseEnv: Record<string, string | undefined> = process.env): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  const converted = new Map<ParsedCommand, SimpleCommand>();
  let dir = cwd;
  // Assignments persist for the rest of the shell line (`DIR=x; rm -rf $DIR`),
  // including ones on a segment of their own, which the parser drops.
  const shellEnv: Record<string, string | undefined> = { ...baseEnv };
  for (const m of command.matchAll(/(?:^|[;&|(\n]\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    shellEnv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  for (const pc of parseCommands(command)) {
    const env: Record<string, string> = {};
    for (const asg of pc.assignments) {
      const eq = asg.indexOf("=");
      const name = asg.slice(0, eq).replace(/\+$/, "");
      const value = expandWord(asg.slice(eq + 1), shellEnv, dir);
      env[name] = value;
      shellEnv[name] = value;
    }
    const seen = { ...shellEnv, ...env };
    let argv = pc.argv.map((w) => expandWord(w, seen, dir));
    // The words as written, so `$DATABASE_URL` still names the variable.
    let rawArgv = pc.argv;
    let via: string | undefined;
    for (let guard = 0; guard < 4 && depth < 4; guard++) {
      const inner = runnerInner(argv);
      if (!inner) break;
      via = inner.via ?? via;
      const script = inner.script ?? (inner.argv && inner.argv.length && ["sh", "bash", "zsh", "dash", "env", "sudo", "timeout", "nice", "xargs"].includes(base(inner.argv[0])) ? inner.argv.map(shellQuote).join(" ") : undefined);
      if (script !== undefined) {
        for (const c of commandsOf(script, dir, depth + 1, seen)) out.push({ ...c, env: { ...env, ...c.env }, raw: pc.text, via: c.via ?? via });
        argv = [];
        break;
      }
      argv = inner.argv ?? [];
      rawArgv = argv;
    }
    if (argv.length === 0 && pc.argv.length > 0) continue;
    const sc: SimpleCommand = {
      argv: argv.map((w, i) => toWord(w, rawArgv[i] ?? w)),
      env,
      cwd: dir,
      redirects: pc.redirects.map((r) => ({ op: r.op, target: toWord(expandWord(r.target, seen, dir), r.target), ...(r.body !== undefined ? { body: r.body } : {}) })),
      raw: pc.text,
      ...(pc.wrappers.includes("xargs") ? { argsFromInput: true } : {}),
      ...(via ? { via } : {}),
    };
    const from = pc.pipedFrom ? converted.get(pc.pipedFrom) : undefined;
    if (from) sc.pipeFrom = from;
    converted.set(pc, sc);
    out.push(sc);
    if (!via && pc.name === "cd") {
      const target = argv.slice(1).find((w) => !w.startsWith("-"));
      if (!target) dir = homedir();
      else if (!DYNAMIC.test(target) && target !== "-") dir = resolve(dir, expandHome(target));
    }
  }
  return out;
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Classify one tool call. */
export function classifyToolCall(tool: string, args: Record<string, unknown>, ctx: ClassifyContext): Assessment {
  let findings: Finding[] = [];
  try {
    if ((tool === "bash" || tool === "job_start") && typeof args.command === "string") {
      findings = classifyCommandFindings(args.command, ctx);
    } else if (tool === "write" && typeof args.path === "string") {
      findings = classifyWrite(args.path, ctx);
    } else if (tool.startsWith("mcp_")) {
      findings = classifyMcp(tool, args);
    }
  } catch {
    findings = [];
  }
  return { verdict: worstVerdict(findings), findings };
}

/** Classify a shell command. */
export function classifyCommand(command: string, ctx: ClassifyContext): Assessment {
  const findings = classifyCommandFindings(command, ctx);
  return { verdict: worstVerdict(findings), findings };
}

function classifyCommandFindings(command: string, ctx: ClassifyContext, depth = 0): Finding[] {
  const out: Finding[] = [];
  const project = projectRoot(ctx);
  for (const sc of commandsOf(command, ctx.cwd, 0, ctx.env ?? process.env)) {
    out.push(...classifySimple(sc, { ...ctx, project, cwd: sc.cwd }, depth));
  }
  return out;
}

// ── Simple commands ──────────────────────────────────────────────────────

function argText(sc: SimpleCommand): string[] {
  return sc.argv.map((w) => w.text);
}

function base(cmd: string | undefined): string {
  return (cmd ?? "").split("/").pop() ?? "";
}

function classifySimple(sc: SimpleCommand, ctx: ClassifyContext, depth: number): Finding[] {
  const out: Finding[] = [];
  const a = argText(sc);
  const cmd = base(a[0]);

  // Output redirected over an existing file (`> notes.txt`).
  for (const r of sc.redirects) {
    if (r.op === ">" || r.op === ">|" || r.op === "&>") {
      const p = wordPath(r.target, sc.cwd);
      if (p && p !== "/dev/null" && !p.startsWith("/dev/") && !p.startsWith("/proc/")) {
        out.push(...overwriteFindings(p, sc.raw, ctx));
      }
    }
  }
  if (!cmd) return out;

  const db = classifyDatabase(sc, cmd, a, ctx);
  if (db) out.push(...db);
  const orm = classifyOrm(sc, a, ctx);
  if (orm) out.push(orm);
  const cloud = classifyCloud(sc, cmd, a, ctx);
  if (cloud) out.push(cloud);

  switch (cmd) {
    case "rm":
    case "unlink":
    case "shred":
    case "srm":
      out.push(...classifyRm(sc, cmd, ctx));
      break;
    case "find":
      out.push(...classifyFind(sc, ctx));
      break;
    case "mv":
    case "cp":
      out.push(...classifyCopyMove(sc, ctx));
      break;
    case "truncate":
      out.push(...classifyTruncate(sc, ctx));
      break;
    case "git":
      out.push(...classifyGit(sc, ctx));
      break;
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      if (depth < 3) out.push(...classifyPackageScript(sc, cmd, a, ctx, depth));
      break;
  }
  return out;
}

// ── Files ────────────────────────────────────────────────────────────────

/** Build output and caches that a build or install brings back. */
const REGENERABLE = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".cache",
  "coverage", ".nyc_output", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  ".venv", "venv", ".gradle", ".angular", ".expo", "bower_components", ".dart_tool", "DerivedData", ".eslintcache",
  "tsconfig.tsbuildinfo",
]);

const SYSTEM_DIRS = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/sbin", "/srv", "/sys", "/usr", "/var", "/System", "/Library", "/Applications", "/private"];

function git(dir: string, args: string[], input?: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      ...(input !== undefined ? { input } : {}),
    });
  } catch {
    return null;
  }
}

export function repoRootOf(path: string): string | null {
  let dir = path;
  while (dir && !existsSync(dir)) dir = dirname(dir);
  try {
    if (!statSync(dir).isDirectory()) dir = dirname(dir);
  } catch {
    return null;
  }
  const out = git(dir, ["rev-parse", "--show-toplevel"]);
  return out ? resolve(out.trim()) : null;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function projectRoot(ctx: ClassifyContext): string {
  return ctx.project ?? repoRootOf(ctx.cwd) ?? resolve(ctx.cwd);
}

function scratchDirs(ctx: ClassifyContext): string[] {
  return ctx.scratchDirs ?? [tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/folders"];
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1).replace(/\.0$/, "")} GB`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** What deleting (or overwriting) a set of paths loses. */
export interface LossReport {
  /** Targets that exist. */
  existing: string[];
  /** Files git can't restore (untracked, ignored or with uncommitted changes): copied before the action. */
  copy: string[];
  copyBytes: number;
  /** Too many or too large to copy. */
  overCap: boolean;
  /** Committed, unchanged files: git brings them back. */
  gitRestores: number;
  /** Build output and caches (node_modules, dist…). */
  regenerable: string[];
  /** `.git` directories (a repository's whole history) inside the targets. */
  repoHistory: string[];
  /** Targets outside the project and the temp directories. */
  outside: string[];
  /** The filesystem root, home, system directories, or the project itself. */
  dangerous: string[];
  repo: string | null;
}

export function analyzeLoss(paths: string[], ctx: ClassifyContext, opts: { recursive: boolean }): LossReport {
  const maxBytes = ctx.maxCopyBytes ?? MAX_COPY_BYTES;
  const maxFiles = ctx.maxCopyFiles ?? MAX_COPY_FILES;
  const root = projectRoot(ctx);
  const home = homedir();
  const scratch = scratchDirs(ctx);
  const r: LossReport = { existing: [], copy: [], copyBytes: 0, overCap: false, gitRestores: 0, regenerable: [], repoHistory: [], outside: [], dangerous: [], repo: null };
  const seen = new Set<string>();
  const addCopy = (file: string, size: number) => {
    if (seen.has(file)) return;
    seen.add(file);
    r.copy.push(file);
    r.copyBytes += size;
    if (r.copy.length > maxFiles || r.copyBytes > maxBytes) r.overCap = true;
  };
  const sizeOf = (p: string): number => {
    try {
      const st = lstatSync(p);
      return st.isFile() ? st.size : 0;
    } catch {
      return 0;
    }
  };
  /** Every file under `dir` git can't restore (no git info): walk it. */
  const walk = (p: string) => {
    if (r.overCap) return;
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      const name = basename(p);
      if (name === ".git") {
        r.repoHistory.push(p);
        return;
      }
      if (REGENERABLE.has(name)) {
        r.regenerable.push(p);
        return;
      }
      if (!opts.recursive) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(p);
      } catch {
        return;
      }
      for (const e of entries) {
        walk(join(p, e));
        if (r.overCap) return;
      }
      return;
    }
    addCopy(p, st.isFile() ? st.size : 0);
  };

  for (const p of paths) {
    if (!existsSync(p) && !isSymlink(p)) continue;
    r.existing.push(p);
    if (p === "/" || p === home || isInside(home, p) || isInside(root, p) || SYSTEM_DIRS.some((d) => p === d || (isInside(p, d) && !scratch.some((s) => isInside(p, s))))) {
      r.dangerous.push(p);
      continue; // never walked: far too much to copy
    }
    if (!isInside(p, root) && !scratch.some((s) => isInside(p, s))) r.outside.push(p);
    const repo = repoRootOf(p);
    if (repo) r.repo ??= repo;
    if (repo && isInside(repo, p)) r.repoHistory.push(join(repo, ".git"));
    if (!repo) {
      walk(p);
      continue;
    }
    const rel = relative(repo, p) || ".";
    if (rel === ".git" || rel.startsWith(`.git${sep}`)) {
      r.repoHistory.push(join(repo, ".git"));
      continue;
    }
    let isDir = false;
    try {
      isDir = lstatSync(p).isDirectory();
    } catch {
      /* gone */
    }
    if (isDir && REGENERABLE.has(basename(p))) {
      r.regenerable.push(p);
      continue;
    }
    if (isDir && !opts.recursive) continue;
    const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional", "--", rel]);
    if (status === null) {
      walk(p);
      continue;
    }
    const changed = new Set<string>();
    const fields = status.split("\0");
    for (let k = 0; k < fields.length; k++) {
      const entry = fields[k]!;
      if (entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const file = join(repo, entry.slice(3));
      if (xy[0] === "R" || xy[0] === "C") k++; // the rename's source path follows
      changed.add(file);
      if (xy === "!!" || (xy === "??" && file.endsWith(sep))) {
        walk(file.replace(/[\\/]$/, ""));
      } else if (existsSync(file) || isSymlink(file)) {
        if (xy === "??" && existsSync(join(file, ".git"))) r.repoHistory.push(join(file, ".git"));
        else addCopy(file, sizeOf(file));
      }
      if (r.overCap) break;
    }
    // Committed, unchanged files under p: git restores them.
    const tracked = git(repo, ["ls-files", "-z", "--", rel]);
    if (tracked) {
      for (const f of tracked.split("\0")) {
        if (f && !changed.has(join(repo, f))) r.gitRestores++;
      }
    }
  }
  return r;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function shortPath(p: string, ctx: ClassifyContext): string {
  const rel = relative(ctx.cwd, p);
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return rel;
  const home = homedir();
  return isInside(p, home) ? `~${p.slice(home.length)}` : p;
}

function listShort(paths: string[], ctx: ClassifyContext, max = 3): string {
  const shown = paths.slice(0, max).map((p) => `\`${shortPath(p, ctx)}\``);
  return paths.length > max ? `${shown.join(", ")} and ${paths.length - max} more` : shown.join(", ");
}

/** A finding for deleting `targets`, from what they hold. */
function deletionFinding(action: string, verb: string, targets: string[], ctx: ClassifyContext, recursive: boolean): Finding | null {
  const loss = analyzeLoss(targets, ctx, { recursive });
  if (loss.existing.length === 0) return null;
  const what = listShort(loss.existing, ctx);
  const parts: string[] = [];
  if (loss.copy.length > 0) parts.push(`${loss.overCap ? "more than " : ""}${plural(loss.copy.length, "file")} git can't restore (${humanBytes(loss.copyBytes)}${loss.overCap ? "+" : ""})`);
  if (loss.gitRestores > 0) parts.push(`${plural(loss.gitRestores, "committed file")}`);
  if (loss.regenerable.length > 0) parts.push(`build output or dependencies (${listShort(loss.regenerable, ctx, 2)})`);
  let text = `${verb} ${what}${parts.length ? `: ${parts.join(", ")}` : ""}`;
  let verdict: Finding["verdict"] = "recoverable";
  const reasons: string[] = [];
  if (loss.dangerous.length > 0) {
    verdict = "irreversible";
    text = `${verb} ${listShort(loss.dangerous, ctx)}, ${loss.dangerous.some((d) => d === "/" || d === homedir()) ? "everything under it" : "a system, home or project folder"}`;
  }
  if (loss.repoHistory.length > 0) {
    verdict = "irreversible";
    reasons.push(`a git repository's history (${listShort(loss.repoHistory.map(dirname), ctx, 2)}), including commits that were never pushed`);
  }
  if (loss.outside.length > 0) {
    verdict = "irreversible";
    reasons.push(`outside this project`);
  }
  if (loss.overCap && loss.copy.length > 0) verdict = "irreversible";
  if (reasons.length) text += ` (${reasons.join("; ")})`;

  let recovery: string;
  let plan: RecoveryPlan | undefined;
  const maxBytes = ctx.maxCopyBytes ?? MAX_COPY_BYTES;
  const maxFiles = ctx.maxCopyFiles ?? MAX_COPY_FILES;
  if (loss.repoHistory.length > 0 || (loss.dangerous.length > 0 && loss.overCap)) {
    recovery = NO_RECOVERY;
  } else if (loss.copy.length > 0 && loss.overCap) {
    recovery = `No copy: that's over Autopilot's recovery limit of ${humanBytes(maxBytes)} or ${plural(maxFiles, "file")}, so nothing can put it back.`;
  } else {
    const bits: string[] = [];
    if (loss.copy.length > 0) {
      bits.push(`Autopilot keeps a copy of ${plural(loss.copy.length, "file")} (${humanBytes(loss.copyBytes)}) first; /undo puts ${loss.copy.length === 1 ? "it" : "them"} back.`);
      plan = { kind: "files", repo: loss.repo, files: loss.copy, bytes: loss.copyBytes };
    }
    if (loss.gitRestores > 0) bits.push("Committed files come back with git.");
    if (loss.regenerable.length > 0) bits.push("Build output and dependencies come back with a build or install.");
    recovery = bits.join(" ") || NO_RECOVERY;
  }
  return { verdict, category: "files", action, loss: text, recovery, ...(plan ? { plan } : {}) };
}

function unknownDeletion(action: string, why: string): Finding {
  return { verdict: "irreversible", category: "files", action, loss: `deletes files Autopilot can't determine ahead of time (${why})`, recovery: NO_RECOVERY };
}

/** Expand a glob in the last path component; null when it can't be resolved here. */
function expandGlob(w: ShellWord, cwd: string): string[] | null {
  if (w.dynamic) return null;
  const p = wordPath({ ...w, glob: false }, cwd);
  if (!p) return null;
  const dir = dirname(p);
  const pattern = basename(p);
  if (/[*?[]/.test(dir)) return null;
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")
        .replace(/\\\[|\[/g, "[") +
      "$",
  );
  try {
    return readdirSync(dir)
      .filter((e) => (pattern.startsWith(".") || !e.startsWith(".")) && re.test(e))
      .map((e) => join(dir, e));
  } catch {
    return [];
  }
}

function targetsOf(words: ShellWord[], cwd: string): { paths: string[]; unknown: string | null } {
  const paths: string[] = [];
  for (const w of words) {
    if (w.dynamic) return { paths, unknown: w.text };
    if (w.glob) {
      const ex = expandGlob(w, cwd);
      if (ex === null) return { paths, unknown: w.text };
      paths.push(...ex);
      continue;
    }
    const p = wordPath(w, cwd);
    if (p === null) return { paths, unknown: w.text };
    paths.push(p);
  }
  return { paths, unknown: null };
}

function positionalWords(argv: ShellWord[], valueOpts: string[] = []): ShellWord[] {
  const out: ShellWord[] = [];
  let opts = true;
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i]!.text;
    if (opts && t === "--") {
      opts = false;
      continue;
    }
    if (opts && t.startsWith("-") && t !== "-") {
      if (valueOpts.includes(t)) i++;
      continue;
    }
    out.push(argv[i]!);
  }
  return out;
}

function classifyRm(sc: SimpleCommand, cmd: string, ctx: ClassifyContext): Finding[] {
  const flags = sc.argv.slice(1).filter((w) => w.text.startsWith("-") && w.text !== "-" && w.text !== "--").map((w) => w.text);
  const recursive = cmd === "rm" && flags.some((f) => f === "--recursive" || /^-[a-zA-Z]*[rR]/.test(f));
  if (cmd === "rm" && flags.some((f) => f === "--help" || f === "--version")) return [];
  if (sc.argsFromInput) return [unknownDeletion(sc.raw, "names come from the command's input")];
  const { paths, unknown } = targetsOf(positionalWords(sc.argv), sc.cwd);
  if (unknown !== null) return [unknownDeletion(sc.raw, `\`${unknown}\``)];
  const f = deletionFinding(sc.raw, cmd === "shred" || cmd === "srm" ? "shreds" : "deletes", paths, ctx, recursive);
  return f ? [f] : [];
}

/** `find … -delete` / `find … -exec rm …`: list what it would delete with a dry run. */
function classifyFind(sc: SimpleCommand, ctx: ClassifyContext): Finding[] {
  const a = argText(sc);
  const del = a.indexOf("-delete");
  let cut = del;
  let recursive = false;
  for (const ex of ["-exec", "-execdir", "-ok", "-okdir"]) {
    const k = a.indexOf(ex);
    if (k > 0 && ["rm", "unlink", "shred"].includes(base(a[k + 1]))) {
      if (cut === -1 || k < cut) cut = k;
      recursive ||= a.slice(k + 2).some((x) => /^-[a-zA-Z]*[rR]/.test(x) || x === "--recursive");
    }
  }
  if (cut === -1) return [];
  if (sc.argv.some((w) => w.dynamic)) return [unknownDeletion(sc.raw, "the command uses variables")];
  const expr = a.slice(1, cut);
  // Only run the dry run when the expression before the action only selects files.
  if (expr.some((x) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|fdelete)$/.test(x))) {
    return [unknownDeletion(sc.raw, "a complex find expression")];
  }
  let out: string;
  try {
    out = execFileSync("find", [...expr, "-print0"], { cwd: sc.cwd, encoding: "utf8", timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    const partial = (e as { stdout?: string }).stdout;
    if (typeof partial !== "string" || partial === "") return [unknownDeletion(sc.raw, "Autopilot couldn't list what it matches")];
    out = partial;
  }
  const paths = out.split("\0").filter(Boolean).map((p) => resolve(sc.cwd, p));
  if (paths.length === 0) return [];
  // find -delete removes the matches one by one (directories only once empty), so they count as files.
  const f = deletionFinding(sc.raw, "deletes", paths, ctx, recursive || del !== -1);
  return f ? [f] : [];
}

function overwriteFindings(path: string, action: string, ctx: ClassifyContext): Finding[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (!st.isFile()) return [];
  const loss = analyzeLoss([path], ctx, { recursive: false });
  if (loss.copy.length === 0) return []; // committed and unchanged: git has it
  const name = `\`${shortPath(path, ctx)}\``;
  const why = loss.repo ? "it isn't committed" : "it isn't in git";
  if (loss.overCap) {
    return [{ verdict: "irreversible", category: "files", action, loss: `overwrites ${name} (${humanBytes(loss.copyBytes)}), and ${why}`, recovery: `No copy: that's over Autopilot's recovery limit of ${humanBytes(ctx.maxCopyBytes ?? MAX_COPY_BYTES)}, so nothing can put it back.` }];
  }
  const outside = loss.outside.length > 0;
  return [{
    verdict: outside ? "irreversible" : "recoverable",
    category: "files",
    action,
    loss: `overwrites ${name}, and ${why}${outside ? " (outside this project)" : ""}`,
    recovery: `Autopilot keeps a copy of it (${humanBytes(loss.copyBytes)}) first; /undo puts it back.`,
    plan: { kind: "files", repo: loss.repo, files: loss.copy, bytes: loss.copyBytes },
  }];
}

function classifyWrite(path: string, ctx: ClassifyContext): Finding[] {
  const p = isAbsolute(path) ? path : resolve(ctx.cwd, path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
  return overwriteFindings(p, `write ${path}`, ctx);
}

function classifyCopyMove(sc: SimpleCommand, ctx: ClassifyContext): Finding[] {
  const a = argText(sc);
  if (a.some((x) => x === "-n" || x === "--no-clobber" || x === "--update=none" || x === "-t" || x.startsWith("--target-directory"))) return [];
  const pos = positionalWords(sc.argv, ["-S", "--suffix"]);
  if (pos.length < 2) return [];
  const dest = pos[pos.length - 1]!;
  const dp = wordPath(dest, sc.cwd);
  if (!dp) return [];
  try {
    if (statSync(dp).isDirectory()) {
      // Into a directory: each source's name may overwrite a file there.
      return pos.slice(0, -1).flatMap((w) => {
        const sp = wordPath(w, sc.cwd);
        return sp ? overwriteFindings(join(dp, basename(sp)), sc.raw, ctx) : [];
      });
    }
  } catch {
    return [];
  }
  return overwriteFindings(dp, sc.raw, ctx);
}

function classifyTruncate(sc: SimpleCommand, ctx: ClassifyContext): Finding[] {
  const { paths, unknown } = targetsOf(positionalWords(sc.argv, ["-s", "--size", "-r", "--reference"]), sc.cwd);
  if (unknown !== null) return [unknownDeletion(sc.raw, `\`${unknown}\``)];
  return paths.flatMap((p) => overwriteFindings(p, sc.raw, ctx));
}

// ── Git ──────────────────────────────────────────────────────────────────

const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

function gitArgs(sc: SimpleCommand): { dir: string; sub: string; args: string[]; words: ShellWord[] } | null {
  const a = argText(sc);
  let dir = sc.cwd;
  let i = 1;
  for (; i < a.length; i++) {
    const t = a[i]!;
    if (!t.startsWith("-")) break;
    if (t === "-C" && a[i + 1]) {
      dir = resolve(dir, a[i + 1]!);
      i++;
    } else if (GIT_GLOBAL_VALUE.has(t)) i++;
  }
  const sub = a[i];
  if (!sub) return null;
  return { dir, sub, args: a.slice(i + 1), words: sc.argv.slice(i + 1) };
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Files with uncommitted changes to tracked files (staged or not) under `paths`. */
function dirtyTracked(repo: string, paths: string[]): string[] {
  const out = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--", ...(paths.length ? paths : ["."])]);
  if (!out) return [];
  const files: string[] = [];
  const fields = out.split("\0");
  for (let k = 0; k < fields.length; k++) {
    const e = fields[k]!;
    if (e.length < 4) continue;
    if (e[0] === "R" || e[0] === "C") k++;
    const f = join(repo, e.slice(3));
    if (existsSync(f)) files.push(f);
  }
  return files;
}

function sumSizes(files: string[]): number {
  let n = 0;
  for (const f of files) {
    try {
      const st = lstatSync(f);
      if (st.isFile()) n += st.size;
    } catch {
      /* gone */
    }
  }
  return n;
}

/** A finding for discarding uncommitted changes to tracked files. */
function discardFinding(action: string, what: string, repo: string, files: string[], ctx: ClassifyContext, extra?: { head?: boolean }): Finding | null {
  const bytes = sumSizes(files);
  const maxBytes = ctx.maxCopyBytes ?? MAX_COPY_BYTES;
  const maxFiles = ctx.maxCopyFiles ?? MAX_COPY_FILES;
  if (files.length === 0 && !extra?.head) return null;
  const changes = files.length ? `uncommitted changes in ${plural(files.length, "file")} (${listShort(files, ctx)})` : "";
  if (files.length > maxFiles || bytes > maxBytes) {
    return { verdict: "irreversible", category: "git", action, loss: `${what}, discarding ${changes}`, recovery: `No copy: ${humanBytes(bytes)} is over Autopilot's recovery limit of ${humanBytes(maxBytes)} or ${plural(maxFiles, "file")}, so nothing can put those changes back.` };
  }
  const loss = changes ? `${what}, discarding ${changes}` : what;
  if (extra?.head) {
    return {
      verdict: "recoverable",
      category: "git",
      action,
      loss,
      recovery: `Autopilot records the current commit${files.length ? ` and keeps a copy of the ${plural(files.length, "changed file")}` : ""} first; /undo puts ${files.length ? "them" : "it"} back.`,
      plan: { kind: "git-head", repo, files, bytes },
    };
  }
  return {
    verdict: "recoverable",
    category: "git",
    action,
    loss,
    recovery: `Autopilot keeps a copy of the ${plural(files.length, "changed file")} (${humanBytes(bytes)}) first; /undo puts them back.`,
    plan: { kind: "files", repo, files, bytes },
  };
}

function classifyGit(sc: SimpleCommand, ctx: ClassifyContext): Finding[] {
  const g = gitArgs(sc);
  if (!g) return [];
  const { dir, sub, args } = g;
  const has = (...f: string[]) => args.some((x) => f.includes(x));
  const shortHas = (letter: string) => args.some((x) => /^-[a-zA-Z]+$/.test(x) && x.slice(1).includes(letter));
  if (has("-h", "--help")) return [];
  switch (sub) {
    case "push":
      return classifyGitPush(sc, dir, args, ctx);
    case "reset": {
      if (!has("--hard")) return [];
      const repo = repoRootOf(dir);
      if (!repo) return [];
      const rest = args.filter((x) => !x.startsWith("-"));
      const target = rest[0] ?? "HEAD";
      const f = discardFinding(sc.raw, `resets to \`${target}\``, repo, dirtyTracked(repo, []), ctx, { head: true });
      return f ? [f] : [];
    }
    case "clean": {
      if (has("-n", "--dry-run") || shortHas("n")) return [];
      if (!(has("-f", "--force") || shortHas("f"))) return []; // git refuses without -f
      const repo = repoRootOf(dir);
      if (!repo) return [];
      const dry = args.filter((x) => x !== "--force" && x !== "-f" && x !== "-i" && x !== "--interactive").map((x) => (/^-[a-zA-Z]+$/.test(x) ? x.replace(/[fi]/g, "") : x)).filter((x) => x !== "-");
      const out = git(dir, ["clean", "-n", ...dry]);
      if (out === null) return [unknownDeletion(sc.raw, "Autopilot couldn't list what git clean removes")];
      const paths = out.split("\n").map((l) => /^Would remove (.+)$/.exec(l)?.[1]).filter((x): x is string => !!x).map((p) => resolve(dir, p.replace(/\/$/, "")));
      const f = deletionFinding(sc.raw, "deletes untracked", paths, ctx, true);
      return f ? [{ ...f, category: "git" }] : [];
    }
    case "checkout":
    case "restore":
    case "switch": {
      const repo = repoRootOf(dir);
      if (!repo) return [];
      if (sub === "restore" && has("--staged", "-S") && !has("--worktree", "-W")) return [];
      const force = has("-f", "--force", "--discard-changes");
      const dd = args.indexOf("--");
      const valueOpts = ["-b", "-B", "--orphan", "-c", "-C", "--source", "-s", "--conflict", "--pathspec-from-file"];
      const pos: string[] = [];
      for (let k = 0; k < (dd === -1 ? args.length : dd); k++) {
        const x = args[k]!;
        if (valueOpts.includes(x)) {
          k++;
          continue;
        }
        if (!x.startsWith("-")) pos.push(x);
      }
      let paths: string[] | null = null;
      if (dd !== -1) paths = args.slice(dd + 1);
      else if (sub === "restore") paths = pos;
      else if (sub === "checkout" && pos.length > 0) {
        const isRef = git(dir, ["rev-parse", "--verify", "-q", `${pos[0]}^{commit}`]) !== null;
        if (isRef && pos.length > 1) paths = pos.slice(1);
        else if (!isRef) paths = pos;
      }
      if (paths && paths.length > 0) {
        const rels = paths.map((p) => relative(repo, resolve(dir, p)) || ".");
        const f = discardFinding(sc.raw, `restores ${paths.map((p) => `\`${p}\``).join(", ")} from git`, repo, dirtyTracked(repo, rels), ctx);
        return f ? [f] : [];
      }
      if (force && (sub === "checkout" || sub === "switch")) {
        const f = discardFinding(sc.raw, `switches to \`${pos[0] ?? "HEAD"}\` with --force`, repo, dirtyTracked(repo, []), ctx);
        return f ? [f] : [];
      }
      return [];
    }
    case "branch": {
      const del = has("-D") || ((has("-d", "--delete") || shortHas("d")) && (has("-f", "--force") || shortHas("f")));
      if (!del || has("-r", "--remotes")) return [];
      const repo = repoRootOf(dir);
      if (!repo) return [];
      const names = args.filter((x) => !x.startsWith("-")).filter((b) => git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${b}`]) !== null);
      if (names.length === 0) return [];
      const shas = names.map((b) => `\`${b}\` (at ${shortSha(git(repo, ["rev-parse", `refs/heads/${b}`])?.trim() ?? "")})`);
      return [{
        verdict: "recoverable",
        category: "git",
        action: sc.raw,
        loss: `deletes branch ${shas.join(", ")}, even if it has commits that aren't merged anywhere`,
        recovery: `Autopilot records where the branch pointed first; /undo recreates it.`,
        plan: { kind: "git-branch", repo, branches: names },
      }];
    }
  }
  return [];
}

function classifyGitPush(sc: SimpleCommand, dir: string, args: string[], ctx: ClassifyContext): Finding[] {
  void ctx;
  let force = false;
  let lease = false;
  let del = false;
  let mirror = false;
  const pos: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const x = args[k]!;
    if (x === "--force" || x === "-f") force = true;
    else if (x.startsWith("--force-with-lease") || x === "--force-if-includes") lease = true;
    else if (x === "--delete" || x === "-d") del = true;
    else if (x === "--mirror" || x === "--prune") mirror = true;
    else if (x === "-n" || x === "--dry-run") return [];
    else if (x === "-o" || x === "--push-option" || x === "--repo" || x === "--receive-pack" || x === "--exec") k++;
    else if (/^-[a-zA-Z]+$/.test(x)) {
      if (x.includes("f")) force = true;
      if (x.includes("d")) del = true;
      if (x.includes("n")) return [];
    } else if (!x.startsWith("-")) pos.push(x);
  }
  const repo = repoRootOf(dir);
  const current = repo ? git(repo, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim() || null : null;
  const remote = pos[0] ?? (current && repo ? git(repo, ["config", `branch.${current}.remote`])?.trim() : undefined) ?? "origin";
  const specs = pos.slice(1);
  if (specs.length === 0 && current) specs.push(current);
  const tracking = (b: string) => (repo ? git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${b}`])?.trim() || null : null);
  const out: Finding[] = [];
  if (mirror) {
    out.push({ verdict: "irreversible", category: "git", action: sc.raw, loss: `may delete branches on \`${remote}\` that this copy doesn't have`, recovery: NO_RECOVERY });
  }
  for (const spec of specs) {
    const plus = spec.startsWith("+");
    const s = plus ? spec.slice(1) : spec;
    const deleting = del || s.startsWith(":");
    let dst = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
    if (dst === "HEAD" && current) dst = current;
    dst = dst.replace(/^refs\/heads\//, "");
    if (!dst) continue;
    const old = tracking(dst);
    const plan: RecoveryPlan | undefined = repo && old ? { kind: "git-remote", repo, remote, branch: dst } : undefined;
    const known = old ? `Autopilot records the branch's old commit (${shortSha(old)}, as of your last fetch) first; /undo pushes it back.` : "";
    if (deleting) {
      out.push({
        verdict: "irreversible",
        category: "git",
        action: sc.raw,
        loss: `deletes branch \`${dst}\` on \`${remote}\``,
        recovery: known ? `${known} Commits pushed there since your last fetch are not covered.` : NO_RECOVERY,
        ...(plan ? { plan } : {}),
      });
    } else if ((force || plus) && !(lease && !force && !plus)) {
      out.push({
        verdict: "irreversible",
        category: "git",
        action: sc.raw,
        loss: `force-pushes over branch \`${dst}\` on \`${remote}\`: commits there that this copy doesn't have are lost`,
        recovery: known ? `${known} Commits pushed there since your last fetch are not covered; --force-with-lease avoids that.` : `${NO_RECOVERY} --force-with-lease avoids overwriting commits you haven't fetched.`,
        ...(plan ? { plan } : {}),
      });
    } else if (lease) {
      out.push({
        verdict: "recoverable",
        category: "git",
        action: sc.raw,
        loss: `rewrites branch \`${dst}\` on \`${remote}\` (only if it still matches your last fetch)`,
        recovery: known || "Your last fetch has the old commits; git's reflog can bring them back.",
        ...(plan ? { plan } : {}),
      });
    }
  }
  return out;
}

// ── Databases ────────────────────────────────────────────────────────────

/** What a piece of SQL (or MongoDB shell code) destroys, one line per statement. */
export function analyzeSql(text: string): string[] {
  const losses: string[] = [];
  // Mongo shell.
  if (/\.dropDatabase\s*\(/.test(text)) losses.push("drops the whole database");
  for (const m of text.matchAll(/db\.(?:getCollection\(\s*["'`]([^"'`]+)["'`]\s*\)|([A-Za-z_][\w]*))\.drop\s*\(/g)) losses.push(`drops collection \`${m[1] ?? m[2]}\``);
  for (const m of text.matchAll(/db\.(?:getCollection\(\s*["'`]([^"'`]+)["'`]\s*\)|([A-Za-z_][\w]*))\.(?:deleteMany|remove)\s*\(\s*\{\s*\}\s*\)/g)) losses.push(`deletes every document in \`${m[1] ?? m[2]}\``);

  const cleaned = text
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
  for (const raw of cleaned.split(";")) {
    const st = raw.replace(/\s+/g, " ").trim();
    if (!st) continue;
    let m: RegExpExecArray | null;
    if ((m = /^drop\s+(table|database|schema|collection|materialized view|view|index|sequence|function|procedure|type|trigger|user|role|owned by|keyspace)\s+(?:if exists\s+)?(?:concurrently\s+)?(.+?)(?:\s+(?:cascade|restrict))?$/i.exec(st))) {
      const kind = m[1]!.toLowerCase();
      losses.push(`drops ${kind} ${m[2]!.split(/\s*,\s*/).map((n) => `\`${n.replace(/^["`]|["`]$/g, "")}\``).join(", ")}`);
    } else if ((m = /^truncate\s+(?:table\s+)?(?:only\s+)?(.+?)(?:\s+(?:restart identity|continue identity|cascade|restrict))*$/i.exec(st))) {
      losses.push(`empties table ${m[1]!.split(/\s*,\s*/).map((n) => `\`${n}\``).join(", ")}`);
    } else if ((m = /^(?:with\s[\s\S]*?\)\s*)?delete\s+from\s+(?:only\s+)?([^\s(]+)([\s\S]*)$/i.exec(st))) {
      if (!hasRealWhere(m[2]!)) losses.push(`deletes every row in \`${m[1]}\``);
    } else if ((m = /^(?:with\s[\s\S]*?\)\s*)?update\s+(?:only\s+)?([^\s(]+)(?:\s+(?:as\s+)?\w+)?\s+set\s([\s\S]*)$/i.exec(st))) {
      if (!hasRealWhere(m[2]!)) losses.push(`changes every row in \`${m[1]}\``);
    } else if ((m = /^alter\s+table\s+(?:if exists\s+)?(?:only\s+)?([^\s]+)\s+([\s\S]*)$/i.exec(st))) {
      const drops = [...m[2]!.matchAll(/\bdrop\s+(?:(column|constraint|partition)\s+)?(?:if exists\s+)?([^\s,]+)/gi)];
      if (drops.length) losses.push(`drops ${drops.map((d) => `${(d[1] ?? "column").toLowerCase()} \`${d[2]}\``).join(", ")} from \`${m[1]}\``);
    } else if (/^(flushall|flushdb)\b/i.test(st)) {
      losses.push(`deletes every key (${st.split(" ")[0]!.toUpperCase()})`);
    }
  }
  return losses;
}

function hasRealWhere(rest: string): boolean {
  const m = /\bwhere\s+([\s\S]*)$/i.exec(rest);
  if (!m) return false;
  const cond = m[1]!.trim().replace(/\s+(?:returning|limit|order by)\b[\s\S]*$/i, "").trim();
  return !/^(?:1\s*=\s*1|true|1|'1'\s*=\s*'1'|''\s*=\s*'')$/i.test(cond);
}

const DB_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3", "sqlite", "mongosh", "mongo", "redis-cli", "duckdb", "cockroach", "clickhouse-client", "pgcli", "mycli", "litecli"]);

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function lookupVar(name: string, sc: SimpleCommand, ctx: ClassifyContext): string | null {
  if (sc.env[name] !== undefined) return sc.env[name]!;
  const env = ctx.env ?? process.env;
  if (env[name] !== undefined) return env[name]!;
  // Tools like prisma read the project's .env file.
  for (const dir of [sc.cwd, projectRoot(ctx)]) {
    const text = readSmall(join(dir, ".env"));
    if (!text) continue;
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, "m").exec(text);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/** `$NAME` / `${NAME}` as a whole word: the variable's name. */
function varName(w: string): string | null {
  return /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(w)?.[1] ?? null;
}

export function isLocalHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "" || h === "localhost" || h === "::1" || h === "0.0.0.0" || h === "host.docker.internal" || h.endsWith(".localhost")) return true;
  if (/^127\./.test(h)) return true;
  // A single-label name (`db`, `postgres`) is a docker compose service or a local alias.
  return !h.includes(".") && !h.includes(":");
}

interface DbTarget {
  host: string;
  db: string;
  via: string;
}

function parseDbUrl(url: string): { host: string; db: string } | null {
  try {
    const u = new URL(url);
    if (!u.protocol || u.protocol === "file:") return null;
    if (/^(sqlite|file)/.test(u.protocol)) return { host: "localhost", db: u.pathname };
    return { host: u.hostname, db: decodeURIComponent(u.pathname.replace(/^\//, "")) };
  } catch {
    return null;
  }
}

const ENV_NAME_VARS = ["RAILS_ENV", "RACK_ENV", "NODE_ENV", "APP_ENV", "ENV", "ENVIRONMENT", "STAGE", "MIX_ENV", "FLASK_ENV", "DJANGO_ENV", "DJANGO_SETTINGS_MODULE", "DEPLOY_ENV", "TF_WORKSPACE"];
const PROD = /(^|[^a-z])prod(uction)?([^a-z]|$)|^prod/i;

/** A production-looking environment name in the command's env or flags. */
function prodEnvName(sc: SimpleCommand, ctx: ClassifyContext): string | null {
  const a = argText(sc);
  for (let k = 0; k < a.length; k++) {
    const x = a[k]!;
    const eq = /^--(?:env|environment|stage|profile|project|context|workspace)=(.+)$/.exec(x);
    if (eq && PROD.test(eq[1]!)) return eq[1]!;
    if (["-e", "--env", "--environment", "--stage", "--profile", "--project", "--context", "--workspace"].includes(x) && a[k + 1] && PROD.test(a[k + 1]!)) return a[k + 1]!;
  }
  const env = ctx.env ?? process.env;
  for (const v of [...ENV_NAME_VARS, "AWS_PROFILE", "CLOUDSDK_CORE_PROJECT", "GOOGLE_CLOUD_PROJECT"]) {
    const val = sc.env[v] ?? env[v];
    if (val && PROD.test(val)) return val;
  }
  return null;
}

function dbTargetFromWords(sc: SimpleCommand, ctx: ClassifyContext, cmd: string): DbTarget | null {
  const a = argText(sc);
  let host: string | null = null;
  let db: string | null = null;
  let via = "";
  for (let k = 1; k < a.length; k++) {
    const x = a[k]!;
    // The word as written: `$DATABASE_URL` still names the variable even
    // though its value was expanded for classification.
    const v = varName(sc.argv[k]?.raw ?? x);
    const val = v ? lookupVar(v, sc, ctx) : x;
    if (val && /^[a-z][a-z0-9+.-]*:\/\//i.test(val)) {
      const p = parseDbUrl(val);
      if (p) {
        host = p.host;
        db = p.db;
        via = v ?? "";
      }
      continue;
    }
    if ((x === "-h" || x === "--host") && a[k + 1] && cmd !== "sqlite3") host = a[++k]!;
    else if (x.startsWith("--host=")) host = x.slice(7);
    else if (/^-h\S/.test(x) && (cmd === "mysql" || cmd === "mariadb")) host = x.slice(2);
    else if ((x === "-d" || x === "--dbname") && a[k + 1]) db = a[++k]!;
    else if (x.startsWith("--dbname=")) db = x.slice(9);
    else if (x === "-u" && cmd === "redis-cli" && a[k + 1]) {
      const p = parseDbUrl(a[++k]!);
      if (p) host = p.host;
    }
  }
  if (cmd === "sqlite3" || cmd === "sqlite" || cmd === "duckdb" || cmd === "litecli") {
    const file = positionalWords(sc.argv, ["-cmd", "-separator", "-newline", "-nullvalue"])[0];
    return { host: "localhost", db: file?.text ?? "", via: "" };
  }
  if (!host) {
    const env = ctx.env ?? process.env;
    host = sc.env.PGHOST ?? env.PGHOST ?? sc.env.MYSQL_HOST ?? env.MYSQL_HOST ?? null;
  }
  if (!host && !db) return null;
  return { host: host ?? "localhost", db: db ?? "", via };
}

function dbTarget(t: DbTarget | null, sc: SimpleCommand, ctx: ClassifyContext, fallbackLabel: string): Target {
  const envName = prodEnvName(sc, ctx);
  if (sc.via) {
    const host = sc.via.startsWith("ssh ") ? sc.via.slice(4) : null;
    const prodHost = host && PROD.test(host) ? host : null;
    const name = prodHost ?? envName;
    const label = `${t?.db ? `the database \`${basename(t.db)}\`` : "the database"} reached through \`${sc.via}\``;
    return name ? { label: `${label}, which looks like production`, production: true, confirmName: name } : { label, production: false };
  }
  if (!t) {
    return envName
      ? { label: `${fallbackLabel}, which looks like production (environment \`${envName}\`)`, production: true, confirmName: envName }
      : { label: fallbackLabel, production: false };
  }
  const where = `${t.host}${t.db ? `/${basename(t.db)}` : ""}`;
  const remote = !isLocalHost(t.host);
  const production = remote || !!envName;
  const label = t.via ? `the database at ${t.via} (${where})` : `the database at ${where}`;
  return {
    label: production ? `${label}, which looks like production (${remote ? "not on this machine" : `environment \`${envName}\``})` : label,
    production,
    ...(production ? { confirmName: remote ? (t.db ? basename(t.db) : t.host) : envName! } : {}),
  };
}

function sqlInputs(sc: SimpleCommand, cmd: string): { texts: string[]; unreadable: string[] } {
  const texts: string[] = [];
  const unreadable: string[] = [];
  const a = argText(sc);
  const readFile = (f: string) => {
    if (f === "-") return;
    const p = resolve(sc.cwd, f);
    if (!existsSync(p)) return;
    const t = readSmall(p);
    if (t === null) unreadable.push(f);
    else texts.push(t);
  };
  for (let k = 1; k < a.length; k++) {
    const x = a[k]!;
    const next = a[k + 1];
    if (["-c", "--command", "-e", "--execute", "--eval", "-cmd", "--query", "-q"].includes(x) && next !== undefined) {
      if (!(cmd === "mysql" || cmd === "mariadb") || x !== "-c") texts.push(next);
      k++;
    } else if (/^--(command|execute|eval|query)=/.test(x)) texts.push(x.slice(x.indexOf("=") + 1));
    else if (/^-e\S/.test(x) && (cmd === "mysql" || cmd === "mariadb")) texts.push(x.slice(2));
    else if (["-f", "--file"].includes(x) && next !== undefined) {
      readFile(next);
      k++;
    } else if (x.startsWith("--file=")) readFile(x.slice(7));
  }
  if (cmd === "sqlite3" || cmd === "sqlite" || cmd === "duckdb") {
    const pos = positionalWords(sc.argv, ["-cmd", "-separator", "-newline", "-nullvalue"]);
    for (const w of pos.slice(1)) texts.push(w.text);
  }
  if (cmd === "redis-cli") texts.push(positionalWords(sc.argv, ["-h", "-p", "-a", "-n", "-u", "--user", "--pass", "-s", "-r", "-i"]).map((w) => w.text).join(" "));
  if (cmd === "mongosh" || cmd === "mongo") {
    for (const w of positionalWords(sc.argv, ["--eval", "-f", "--file", "-u", "-p", "--username", "--password", "--host", "--port", "--authenticationDatabase"])) {
      if (/\.js$/.test(w.text)) readFile(w.text);
    }
  }
  for (const r of sc.redirects) {
    if (r.op === "<<" && r.body !== undefined) texts.push(r.body);
    else if (r.op === "<<<") texts.push(r.target.text);
    else if (r.op === "<" && !r.target.dynamic) readFile(r.target.text);
  }
  const from = sc.pipeFrom;
  if (from) {
    const fa = argText(from);
    const fc = base(fa[0]);
    if (fc === "echo" || fc === "printf") texts.push(fa.slice(1).filter((x) => !/^-[neE]+$/.test(x)).join(" "));
    else if (fc === "cat") {
      for (const w of positionalWords(from.argv)) readFile(w.text);
      for (const r of from.redirects) if (r.op === "<<" && r.body !== undefined) texts.push(r.body);
    }
  }
  return { texts, unreadable };
}

function classifyDatabase(sc: SimpleCommand, cmd: string, a: string[], ctx: ClassifyContext): Finding[] | null {
  if (!DB_CLIENTS.has(cmd)) return null;
  if (a.includes("--help") || a.includes("--version")) return null;
  const { texts, unreadable } = sqlInputs(sc, cmd);
  const losses = [...new Set(texts.flatMap((t) => analyzeSql(t)))];
  if (cmd === "redis-cli") {
    const words = a.map((x) => x.toUpperCase());
    if (words.includes("FLUSHALL")) losses.push("deletes every key in every Redis database (FLUSHALL)");
    else if (words.includes("FLUSHDB")) losses.push("deletes every key in the Redis database (FLUSHDB)");
  }
  const out: Finding[] = [];
  const target = dbTarget(dbTargetFromWords(sc, ctx, cmd), sc, ctx, "the database");
  for (const f of unreadable) {
    out.push({ verdict: "irreversible", category: "database", action: sc.raw, loss: `runs \`${f}\`, which is too large for Autopilot to check`, target, recovery: NO_RECOVERY });
  }
  const unique = [...new Set(losses.filter((l) => !/^deletes every key \((FLUSH)/.test(l) || cmd !== "redis-cli"))];
  if (unique.length > 0) {
    out.push({ verdict: "irreversible", category: "database", action: sc.raw, loss: unique.join("; "), target, recovery: NO_RECOVERY });
  }
  return out;
}

function databaseUrlTarget(sc: SimpleCommand, ctx: ClassifyContext): Target {
  const url = lookupVar("DATABASE_URL", sc, ctx);
  const p = url ? parseDbUrl(url) : null;
  return dbTarget(p ? { ...p, via: "DATABASE_URL" } : null, sc, ctx, "the project's database");
}

/** ORM and framework commands that wipe a database. */
function classifyOrm(sc: SimpleCommand, a: string[], ctx: ClassifyContext): Finding | null {
  const cmd = base(a[0]);
  const rest = a.slice(1);
  const has = (x: string) => rest.includes(x);
  let loss: string | null = null;
  let target: Target | null = null;
  if (cmd === "prisma") {
    if (rest[0] === "migrate" && rest[1] === "reset") loss = "drops and recreates the database, deleting all its data (prisma migrate reset)";
    else if (rest[0] === "db" && rest[1] === "push" && has("--force-reset")) loss = "resets the database, deleting all its data (prisma db push --force-reset)";
    else if (rest[0] === "db" && rest[1] === "push" && has("--accept-data-loss")) loss = "pushes the schema even where that drops columns or tables and their data (prisma db push --accept-data-loss)";
  } else if (cmd === "rails" || cmd === "rake") {
    const t = rest.find((x) => /^db:(drop|drop:all|reset|purge|purge:all|truncate_all|migrate:reset|schema:load|setup)$/.test(x));
    if (t && t !== "db:setup") loss = `${t === "db:schema:load" ? "reloads the schema, deleting all data" : t.startsWith("db:truncate") ? "empties every table" : "drops the database and its data"} (${cmd} ${t})`;
    if (loss) {
      const env = sc.env.RAILS_ENV ?? (ctx.env ?? process.env).RAILS_ENV;
      const e = rest.indexOf("-e");
      const railsEnv = e >= 0 ? rest[e + 1] : rest.find((x) => x.startsWith("RAILS_ENV="))?.slice(10) ?? env;
      if (railsEnv && PROD.test(railsEnv)) target = { label: `the \`${railsEnv}\` database, which looks like production`, production: true, confirmName: railsEnv };
    }
  } else if ((cmd === "manage.py" || ((cmd === "python" || cmd === "python3") && base(rest[0]) === "manage.py") || cmd === "django-admin")) {
    const args = cmd === "python" || cmd === "python3" ? rest.slice(1) : rest;
    if (args[0] === "flush") loss = "deletes all data from every table (django flush)";
    else if (args[0] === "reset_db") loss = "drops and recreates the database (django reset_db)";
    else if (args[0] === "migrate" && args[2] === "zero") loss = `unapplies every migration of \`${args[1]}\`, dropping its tables (django migrate ${args[1]} zero)`;
  } else if (cmd === "knex") {
    if (rest[0] === "migrate:rollback" && has("--all")) loss = "rolls back every migration, dropping their tables (knex migrate:rollback --all)";
  } else if (cmd === "sequelize" || cmd === "sequelize-cli") {
    if (rest[0] === "db:drop") loss = "drops the database (sequelize db:drop)";
    else if (rest[0] === "db:migrate:undo:all") loss = "undoes every migration, dropping their tables (sequelize db:migrate:undo:all)";
  } else if (cmd === "typeorm" || cmd === "typeorm-ts-node-commonjs" || cmd === "typeorm-ts-node-esm") {
    if (rest[0] === "schema:drop") loss = "drops every table (typeorm schema:drop)";
  } else if (cmd === "supabase") {
    if (rest[0] === "db" && rest[1] === "reset") {
      loss = "resets the database, deleting all its data (supabase db reset)";
      if (has("--linked") || rest.some((x) => x.startsWith("--db-url"))) target = { label: "the linked Supabase project, which may be production", production: true, confirmName: "linked" };
    }
  } else if (cmd === "diesel" || cmd === "sqlx") {
    if (rest[0] === "database" && (rest[1] === "reset" || rest[1] === "drop")) loss = `drops the database (${cmd} database ${rest[1]})`;
  }
  if (!loss) return null;
  return { verdict: "irreversible", category: "database", action: sc.raw, loss, target: target ?? databaseUrlTarget(sc, ctx), recovery: NO_RECOVERY };
}

// ── Cloud and infrastructure ─────────────────────────────────────────────

function terraformWorkspace(sc: SimpleCommand, ctx: ClassifyContext): string | null {
  const env = ctx.env ?? process.env;
  const ws = sc.env.TF_WORKSPACE ?? env.TF_WORKSPACE;
  if (ws) return ws;
  const chdir = argText(sc).find((x) => x.startsWith("-chdir="))?.slice(7);
  const dir = chdir ? resolve(sc.cwd, chdir) : sc.cwd;
  return readSmall(join(dir, ".terraform", "environment"))?.trim() || null;
}

function kubeContext(sc: SimpleCommand, ctx: ClassifyContext): string | null {
  const a = argText(sc);
  const k = a.indexOf("--context");
  if (k >= 0 && a[k + 1]) return a[k + 1]!;
  const eq = a.find((x) => x.startsWith("--context="));
  if (eq) return eq.slice(10);
  const env = ctx.env ?? process.env;
  const cfgs = (sc.env.KUBECONFIG ?? env.KUBECONFIG ?? join(homedir(), ".kube", "config")).split(":");
  for (const c of cfgs) {
    const text = readSmall(c);
    const m = text ? /^current-context:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(text) : null;
    if (m) return m[1]!;
  }
  return null;
}

function namedTarget(kind: string, name: string | null, fallback: string): Target {
  if (!name) return { label: fallback, production: false };
  const production = PROD.test(name);
  return { label: `${kind} \`${name}\`${production ? ", which looks like production" : ""}`, production, ...(production ? { confirmName: name } : {}) };
}

function cloudFinding(sc: SimpleCommand, loss: string, target: Target): Finding {
  return { verdict: "irreversible", category: "cloud", action: sc.raw, loss, target, recovery: NO_RECOVERY };
}

function classifyCloud(sc: SimpleCommand, cmd: string, a: string[], ctx: ClassifyContext): Finding | null {
  const rest = a.slice(1);
  const pos = rest.filter((x) => !x.startsWith("-"));
  const has = (...f: string[]) => rest.some((x) => f.includes(x));
  if (has("--help", "-h")) return null;
  switch (cmd) {
    case "terraform":
    case "tofu":
    case "terragrunt": {
      const destroy = pos[0] === "destroy" || (pos[0] === "apply" && rest.includes("-destroy"));
      if (!destroy) return null;
      const ws = terraformWorkspace(sc, ctx);
      return cloudFinding(sc, `destroys every resource this ${cmd === "tofu" ? "OpenTofu" : "Terraform"} configuration manages`, namedTarget("workspace", ws, "the current workspace"));
    }
    case "kubectl":
    case "oc": {
      if (pos[0] !== "delete") return null;
      const ns = rest[rest.indexOf("-n") + 1] ?? rest.find((x) => x.startsWith("--namespace="))?.slice(12);
      return cloudFinding(sc, `deletes Kubernetes ${pos.slice(1).join(" ") || "resources"}${rest.includes("-n") || ns ? ` in namespace \`${ns}\`` : ""}`, namedTarget("cluster context", kubeContext(sc, ctx), "the current cluster"));
    }
    case "docker":
    case "podman":
    case "docker-compose": {
      const sub = cmd === "docker-compose" ? ["compose", ...pos] : pos;
      if (sub[0] === "volume" && (sub[1] === "rm" || sub[1] === "remove" || sub[1] === "prune")) {
        return cloudFinding(sc, sub[1] === "prune" ? "deletes every unused Docker volume and the data in it" : `deletes Docker volume ${sub.slice(2).map((v) => `\`${v}\``).join(", ")} and the data in it`, { label: "this machine's Docker", production: false });
      }
      if (sub[0] === "system" && sub[1] === "prune" && has("--volumes")) {
        return cloudFinding(sc, "deletes every unused Docker volume and the data in it (system prune --volumes)", { label: "this machine's Docker", production: false });
      }
      if (sub[0] === "compose" && sub[1] === "down" && (has("-v", "--volumes") || rest.some((x) => /^-[a-zA-Z]*v/.test(x)))) {
        return cloudFinding(sc, "stops the compose project and deletes its volumes and the data in them", { label: "this machine's Docker", production: false });
      }
      return null;
    }
    case "aws": {
      const profile = rest[rest.indexOf("--profile") + 1] && rest.includes("--profile") ? rest[rest.indexOf("--profile") + 1]! : (sc.env.AWS_PROFILE ?? (ctx.env ?? process.env).AWS_PROFILE ?? null);
      const target = namedTarget("AWS profile", profile, "the current AWS account");
      if (pos[0] === "s3" && pos[1] === "rm") return cloudFinding(sc, `deletes ${has("--recursive") ? "every object under" : ""} \`${pos[2] ?? "the object"}\``.replace("deletes  ", "deletes "), target);
      if (pos[0] === "s3" && pos[1] === "rb" && has("--force")) return cloudFinding(sc, `deletes bucket \`${pos[2] ?? ""}\` and every object in it`, target);
      if (pos[0] === "s3" && pos[1] === "sync" && has("--delete")) return cloudFinding(sc, `deletes files at \`${pos[3] ?? "the destination"}\` that aren't in \`${pos[2] ?? "the source"}\``, target);
      if (pos[1] && /^(delete|terminate|remove|purge)-/.test(pos[1])) return cloudFinding(sc, `runs \`aws ${pos[0]} ${pos[1]}\``, target);
      return null;
    }
    case "gcloud":
    case "gsutil": {
      if (cmd === "gsutil") {
        if (pos[0] === "rm" || pos[0] === "rb") return cloudFinding(sc, `deletes \`${pos.slice(1).join(" ")}\``, namedTarget("Google Cloud project", null, "the current Google Cloud project"));
        return null;
      }
      if (!pos.includes("delete") && !(pos[0] === "storage" && pos[1] === "rm")) return null;
      const pk = rest.indexOf("--project");
      const project = (pk >= 0 ? rest[pk + 1] : rest.find((x) => x.startsWith("--project="))?.slice(10)) ?? sc.env.CLOUDSDK_CORE_PROJECT ?? (ctx.env ?? process.env).CLOUDSDK_CORE_PROJECT ?? null;
      return cloudFinding(sc, `runs \`gcloud ${pos.slice(0, pos.indexOf("delete") >= 0 ? pos.indexOf("delete") + 2 : 3).join(" ")}\``, namedTarget("Google Cloud project", project, "the current Google Cloud project"));
    }
    case "gh": {
      if (pos[0] === "repo" && pos[1] === "delete") return cloudFinding(sc, `deletes the GitHub repository ${pos[2] ? `\`${pos[2]}\`` : "for this directory"}, with its issues, pull requests and releases`, { label: "GitHub", production: false });
      if (pos[0] === "release" && (pos[1] === "delete" || pos[1] === "delete-asset")) return cloudFinding(sc, `deletes GitHub release ${pos[2] ? `\`${pos[2]}\`` : ""}${pos[1] === "delete-asset" ? " asset" : ""}`.trim(), { label: "GitHub", production: false });
      return null;
    }
  }
  return null;
}

// ── Package scripts ──────────────────────────────────────────────────────

const BUILTIN_SUBCOMMANDS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "init", "create", "publish", "pack", "link", "unlink", "audit", "outdated", "ls", "list", "why", "info", "view", "config", "set", "get", "login", "logout", "whoami", "version", "help", "cache", "dlx", "exec", "x", "store", "patch", "import", "rebuild", "prune", "dedupe", "fund", "doctor", "explain", "owner", "search", "test", "t", "start", "stop", "restart"]);

/** `npm run <script>` / `yarn <script>`: classify the script's own command. */
function classifyPackageScript(sc: SimpleCommand, cmd: string, a: string[], ctx: ClassifyContext, depth: number): Finding[] {
  const rest = a.slice(1).filter((x) => !x.startsWith("-"));
  let name: string | undefined;
  if (rest[0] === "run" || rest[0] === "run-script") name = rest[1];
  else if ((cmd === "yarn" || cmd === "pnpm" || cmd === "bun") && rest[0] && !BUILTIN_SUBCOMMANDS.has(rest[0])) name = rest[0];
  else if ((rest[0] === "test" || rest[0] === "start" || rest[0] === "stop" || rest[0] === "restart") && cmd !== "bun") name = rest[0];
  if (!name) return [];
  const pkg = readSmall(join(sc.cwd, "package.json"));
  if (!pkg) return [];
  let script: unknown;
  try {
    script = (JSON.parse(pkg) as { scripts?: Record<string, unknown> }).scripts?.[name];
  } catch {
    return [];
  }
  if (typeof script !== "string") return [];
  return classifyCommandFindings(script, { ...ctx, cwd: sc.cwd }, depth + 1).map((f) => ({
    ...f,
    action: sc.raw,
    loss: `${f.loss} (through the \`${name}\` script: \`${script}\`)`,
  }));
}

// ── MCP ──────────────────────────────────────────────────────────────────

function strings(v: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 5) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, depth + 1, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, depth + 1, out);
  return out;
}

function classifyMcp(tool: string, args: Record<string, unknown>): Finding[] {
  const texts = strings(args);
  const losses = [...new Set(texts.flatMap((t) => analyzeSql(t)))];
  if (losses.length === 0) return [];
  const action = texts.find((t) => analyzeSql(t).length > 0) ?? JSON.stringify(args);
  return [{
    verdict: "irreversible",
    category: "database",
    action,
    loss: losses.join("; "),
    target: { label: `the database behind the MCP tool \`${tool}\``, production: false },
    recovery: NO_RECOVERY,
  }];
}
