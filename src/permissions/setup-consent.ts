/**
 * Ask before installing packages or running commands that write, the first
 * time in a project.
 *
 * Interactive sessions run in auto by default (modes are off), so every tool
 * call runs without a prompt. That is right for reading and for the agent's
 * own file edits, but not for a first `npm install` in a repository someone
 * just cloned: it fetches from the network, writes node_modules and a
 * lockfile, and runs install scripts. So the first time in a project the
 * agent wants to install dependencies or run a command that writes outside
 * its own source edits, the person is asked once:
 *
 *   Allow once · Always allow in this project · Don't
 *
 * "Always allow in this project" is stored per project under the user's
 * state directory (never inside the repository, which could otherwise ship
 * its own approval). Explicit auto mode, headless runs and configured allow
 * rules are unchanged: the host only asks when none of those decided.
 *
 * Broader destructive-action guardrails are tracked in autopilot#1125.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { statePath } from "../util/app-dirs.js";
import { simpleCommands, writesFile, type Redirect, type SimpleCommand } from "./shell-commands.js";

export type SetupKind = "install" | "fetch-run" | "write";

/** A command that needs the once-per-project question, and the part of it that does. */
export interface SetupCommand {
  kind: SetupKind;
  /** The segment of the command that installs or writes, e.g. `npm install`. */
  segment: string;
}

const NPM_INSTALL = new Set(["install", "i", "in", "ci", "add", "update", "up", "upgrade", "isntall", "install-test", "it", "install-ci-test"]);
const PNPM_INSTALL = new Set(["install", "i", "add", "update", "up", "upgrade"]);
const BUN_INSTALL = new Set(["install", "i", "add", "update"]);
const CARGO_FETCH = new Set(["fetch", "install", "add", "update", "build", "b", "run", "r", "test", "t", "check", "c", "bench"]);
const GIT_WRITES = new Set([
  "commit", "push", "pull", "reset", "checkout", "switch", "restore", "clean", "merge", "rebase", "cherry-pick",
  "revert", "am", "apply", "rm", "mv", "init", "clone", "submodule", "worktree", "gc", "prune",
]);
const FILE_WRITES = new Set(["rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "ln", "dd", "truncate", "tee", "unlink", "shred", "wget"]);

/** Where a command runs and what is on disk there; tests pass their own. */
export interface SetupContext {
  /** The directory the command starts in (a leading `cd dir &&` moves it). */
  cwd?: string;
  /** Temporary directories whose files don't count as changes (default: /tmp, /var/tmp, the OS temp dir, $TMPDIR). */
  tempDirs?: string[];
  exists?: (path: string) => boolean;
}

function defaultTempDirs(): string[] {
  const dirs = ["/tmp", "/var/tmp", "/private/tmp", tmpdir()];
  if (process.env.TMPDIR) dirs.push(process.env.TMPDIR);
  return dirs;
}

/** A path in a temporary directory: scratch output there (`> /tmp/test.log`) changes nothing of the person's. */
export function isTempPath(target: string, cwd: string | undefined, tempDirs: string[] = defaultTempDirs()): boolean {
  const t = target.trim();
  if (/^(?:\$TMPDIR|\$\{TMPDIR\})(?:\/|$)/.test(t)) return true;
  if (!isAbsolute(t) && !cwd) return false;
  const abs = resolve(cwd ?? "/", t);
  return tempDirs.some((d) => {
    const dir = resolve(d);
    return dir !== "/" && (abs === dir || abs.startsWith(`${dir}/`));
  });
}

/**
 * Whether `npx NAME` (and friends) would run a binary that is already
 * installed here rather than download one: NAME in node_modules/.bin of this
 * directory or one above (where workspace packages' bins are linked too), an
 * installed package by that name, or this package's own `bin`.
 */
export function resolvesToLocalBin(name: string, cwd: string, exists: (path: string) => boolean = existsSync): boolean {
  // `pkg@version` asks for a specific (possibly different) version: npx may download it.
  const pkg = name.replace(/^(@?[^@]+)@.*$/, "$1");
  if (pkg !== name || !pkg || pkg.startsWith(".") || pkg.includes("..")) return false;
  const binName = pkg.includes("/") ? pkg.slice(pkg.lastIndexOf("/") + 1) : pkg;
  let dir = resolve(cwd);
  for (;;) {
    if (exists(join(dir, "node_modules", ".bin", binName))) return true;
    if (exists(join(dir, "node_modules", pkg, "package.json"))) return true;
    if (ownBin(join(dir, "package.json"), binName, exists)) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

function ownBin(manifest: string, binName: string, exists: (path: string) => boolean): boolean {
  if (!exists(manifest)) return false;
  try {
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; bin?: unknown };
    if (typeof pkg.bin === "string") return typeof pkg.name === "string" && pkg.name.replace(/^@[^/]+\//, "") === binName;
    return !!pkg.bin && typeof pkg.bin === "object" && Object.prototype.hasOwnProperty.call(pkg.bin, binName);
  } catch {
    return false;
  }
}

/**
 * The package `npx`, `bunx`, `bun x` or `npm exec` would run, or undefined
 * when it names one explicitly with `-p`/`--package` (then it may download).
 */
function execTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") return args[i + 1];
    if (a === "-p" || a === "--package" || a.startsWith("--package=") || a === "-c" || a === "--call") return undefined;
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

/** The second word, skipping options (`npm --silent install`). */
function sub(w: string[], from = 1): string | undefined {
  return w.slice(from).find((a) => !a.startsWith("-"));
}

function classify(sc: SimpleCommand, ctx: Required<Pick<SetupContext, "tempDirs" | "exists">> & { cwd: string | undefined }): SetupKind | null {
  const w = [sc.name, ...sc.argv.slice(1)];
  const cmd = sc.name;
  const s = sub(w);
  // Running an installed binary downloads nothing.
  const fetchOrLocal = (args: string[]): SetupKind | null => {
    const target = execTarget(args);
    return target && ctx.cwd && resolvesToLocalBin(target, ctx.cwd, ctx.exists) ? null : "fetch-run";
  };
  const temp = (path: string) => isTempPath(path, ctx.cwd, ctx.tempDirs);
  switch (cmd) {
    case "npm":
      if (s && NPM_INSTALL.has(s)) return "install";
      if (s === "exec" || s === "x") return fetchOrLocal(w.slice(w.indexOf(s) + 1));
      break;
    case "npx":
    case "bunx":
      return fetchOrLocal(w.slice(1));
    case "yarn":
      if (!s || s === "install" || s === "add" || s === "upgrade" || s === "up") return "install";
      if (s === "dlx") return "fetch-run";
      break;
    case "pnpm":
      if (s && PNPM_INSTALL.has(s)) return "install";
      if (s === "dlx") return "fetch-run";
      break;
    case "bun":
      if (s && BUN_INSTALL.has(s)) return "install";
      if (s === "x") return fetchOrLocal(w.slice(w.indexOf(s) + 1));
      break;
    case "pip":
    case "pip3":
    case "pipx":
      if (s === "install") return "install";
      break;
    case "python":
    case "python3":
      if (w[1] === "-m" && (w[2] === "pip" || w[2] === "ensurepip") && (w[2] === "ensurepip" || sub(w, 3) === "install")) return "install";
      break;
    case "uv":
      if (s === "sync" || s === "add" || (s === "pip" && sub(w, 2) === "install") || (s === "tool" && sub(w, 2) === "install")) return "install";
      if (s === "run" || s === "tool") return null;
      break;
    case "uvx":
      return "fetch-run";
    case "poetry":
    case "pipenv":
    case "pdm":
      if (s === "install" || s === "add" || s === "update" || s === "sync") return "install";
      break;
    case "conda":
    case "mamba":
    case "micromamba":
      if (s === "install" || s === "create" || s === "update") return "install";
      break;
    case "cargo":
      if (s && CARGO_FETCH.has(s)) return "install";
      break;
    case "go":
      if (s === "get" || s === "install" || (s === "mod" && (sub(w, 2) === "download" || sub(w, 2) === "tidy"))) return "install";
      break;
    case "bundle":
    case "bundler":
      if (!s || s === "install" || s === "update" || s === "add") return "install";
      break;
    case "gem":
    case "composer":
    case "brew":
    case "apt":
    case "apt-get":
    case "dnf":
    case "yum":
    case "apk":
    case "pacman":
    case "deno":
    case "pod":
      if (s === "install" || s === "add" || s === "require" || s === "update" || (cmd === "pacman" && s?.startsWith("-S")) || (cmd === "apk" && s === "add")) return "install";
      break;
    case "mix":
      if (s === "deps.get") return "install";
      break;
    case "dotnet":
      if (s === "restore" || (s === "add" && w.includes("package"))) return "install";
      break;
    case "git":
      if (s && GIT_WRITES.has(s)) return "write";
      if (s === "stash" && !["list", "show"].includes(sub(w, 2) ?? "")) return "write";
      break;
    case "sed":
    case "perl":
      if (w.slice(1).some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"))) return "write";
      break;
    case "curl":
      if (w.slice(1).some((a) => a === "-o" || a === "-O" || a.startsWith("--output") || a === "--remote-name" || /^-[a-zA-Z]*[oO]$/.test(a))) return "write";
      break;
    case "tar":
      if (w.slice(1).some((a) => /^-?[a-zA-Z]*[xc]/.test(a) || a === "--extract" || a === "--create")) return "write";
      break;
    case "unzip":
      return w.includes("-l") ? null : "write";
    case "":
      break;
    default:
      if (FILE_WRITES.has(cmd)) {
        // Only scratch files in a temp directory (`rm -f /tmp/out.log`, `mkdir -p /tmp/x`).
        const paths = w.slice(1).filter((a) => !a.startsWith("-"));
        if (paths.length > 0 && paths.every(temp)) break;
        return "write";
      }
  }
  // Output redirected into a file (not /dev/null, not another descriptor, not a temp file).
  if (sc.redirects.some((r: Redirect) => writesFile(r) && !temp(r.target))) return "write";
  return null;
}

/**
 * The install, fetch-and-run or write in a bash command, if any: the
 * strongest one across every command it runs (install > fetch-run > write),
 * wrappers like `timeout 120`, `sudo -u x` or `bash -c "…"` included (see
 * shell-commands.ts).
 */
export function setupCommandOf(command: string, context: SetupContext = {}): SetupCommand | null {
  let best: SetupCommand | null = null;
  const rank: Record<SetupKind, number> = { install: 3, "fetch-run": 2, write: 1 };
  const tempDirs = context.tempDirs ?? defaultTempDirs();
  const exists = context.exists ?? existsSync;
  let cwd = context.cwd;
  for (const sc of simpleCommands(command)) {
    // `cd dir && npx xo`: follow the directory the rest runs in.
    if (sc.name === "cd" && sc.wrappers.length === 0) {
      const to = sc.argv.slice(1).find((a) => !a.startsWith("-"));
      cwd = to && !to.includes("$") && !to.startsWith("~") && (isAbsolute(to) || cwd) ? resolve(cwd ?? "/", to) : undefined;
      continue;
    }
    const kind = classify(sc, { cwd, tempDirs, exists });
    // Shown in the question: descriptor redirections like `2>&1` add nothing there.
    if (kind && (!best || rank[kind] > rank[best.kind])) best = { kind, segment: sc.text.replace(/\s*\d*>&\d+/g, "").trim() };
  }
  return best;
}

/** The question's text: one line asking, one saying why. */
export function setupQuestion(sc: SetupCommand, command: string): { prompt: string; subtitle: string } {
  const shown = (s: string) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
  switch (sc.kind) {
    case "install":
      return {
        prompt: `Install dependencies with \`${shown(sc.segment)}\`?`,
        subtitle: `This downloads packages and runs their install scripts.${command.trim() !== sc.segment ? ` Full command: ${shown(command.trim())}` : ""}`,
      };
    case "fetch-run":
      return {
        prompt: `Run \`${shown(sc.segment)}\`?`,
        subtitle: `This downloads a package and runs it.${command.trim() !== sc.segment ? ` Full command: ${shown(command.trim())}` : ""}`,
      };
    case "write":
      return {
        prompt: `Run \`${shown(command.trim())}\`?`,
        subtitle: "This changes files or git state outside Autopilot's own edits.",
      };
  }
}

export type SetupAnswer = "once" | "always" | "deny";

/** The three answers, in order. */
export const SETUP_CHOICES: ReadonlyArray<{ value: SetupAnswer; label: string }> = [
  { value: "once", label: "Allow once" },
  { value: "always", label: "Always allow in this project" },
  { value: "deny", label: "Don't" },
];

// ── Per-project "always allow" ───────────────────────────────────────────

interface ConsentFile {
  version: 1;
  /** Project root → when "always allow" was chosen. */
  projects: Record<string, { setup: "always"; at: string }>;
}

function consentPath(): string {
  return statePath("project-consent.json");
}

function readConsent(): ConsentFile {
  try {
    const parsed = JSON.parse(readFileSync(consentPath(), "utf8")) as Partial<ConsentFile>;
    if (parsed && typeof parsed.projects === "object" && parsed.projects) return { version: 1, projects: parsed.projects };
  } catch {
    /* missing or unreadable: nothing allowed yet */
  }
  return { version: 1, projects: {} };
}

/** True once "Always allow in this project" was chosen for `root`. */
export function hasSetupConsent(root: string): boolean {
  return readConsent().projects[root]?.setup === "always";
}

/** Remember "Always allow in this project" for `root`. Best effort: a failed write only means asking again. */
export function grantSetupConsent(root: string, now = new Date()): void {
  try {
    const file = readConsent();
    file.projects[root] = { setup: "always", at: now.toISOString() };
    const path = consentPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* asked again next time */
  }
}
