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
import { dirname } from "node:path";
import { statePath } from "../util/app-dirs.js";

export type SetupKind = "install" | "fetch-run" | "write";

/** A command that needs the once-per-project question, and the part of it that does. */
export interface SetupCommand {
  kind: SetupKind;
  /** The segment of the command that installs or writes, e.g. `npm install`. */
  segment: string;
}

const WRAPPERS = new Set(["sudo", "env", "time", "command", "nohup", "exec", "nice"]);

/** Split on shell separators outside quotes: `&&`, `||`, `;`, `|`, `&`, newlines. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && command[i - 1] !== ">" && command[i + 1] !== ">")) {
      out.push(cur);
      cur = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function words(segment: string): string[] {
  const toks = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return toks.map((t) => t.replace(/^["']|["']$/g, ""));
}

/** The command words after env assignments and wrappers like sudo. */
function commandWords(segment: string): string[] {
  const w = words(segment);
  let i = 0;
  while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!) || WRAPPERS.has(w[i]!) || (i > 0 && WRAPPERS.has(w[i - 1]!) && w[i]!.startsWith("-")))) i++;
  const rest = w.slice(i);
  if (rest[0]) rest[0] = rest[0].split("/").pop()!;
  return rest;
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

/** The second word, skipping options (`npm --silent install`). */
function sub(w: string[], from = 1): string | undefined {
  return w.slice(from).find((a) => !a.startsWith("-"));
}

function classifySegment(segment: string): SetupKind | null {
  const w = commandWords(segment);
  const cmd = w[0];
  if (!cmd) return null;
  const s = sub(w);
  switch (cmd) {
    case "npm":
      if (s && NPM_INSTALL.has(s)) return "install";
      if (s === "exec" || s === "x") return "fetch-run";
      break;
    case "npx":
    case "bunx":
      return "fetch-run";
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
      if (s === "x") return "fetch-run";
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
    default:
      if (FILE_WRITES.has(cmd)) return "write";
  }
  // Output redirected into a file (not /dev/null, not another descriptor).
  const redirect = /(?:^|[^0-9&<>])&?>>?\s*([^\s&|;]+)/g;
  for (const m of segment.replace(/"[^"]*"|'[^']*'/g, "''").matchAll(redirect)) {
    const target = m[1]!;
    if (target !== "/dev/null" && !target.startsWith("&")) return "write";
  }
  return null;
}

/**
 * The install, fetch-and-run or write in a bash command, if any: the
 * strongest one across a compound command (install > fetch-run > write).
 */
export function setupCommandOf(command: string): SetupCommand | null {
  let best: SetupCommand | null = null;
  const rank: Record<SetupKind, number> = { install: 3, "fetch-run": 2, write: 1 };
  for (const segment of segments(command)) {
    const kind = classifySegment(segment);
    // Shown in the question: descriptor redirections like `2>&1` add nothing there.
    if (kind && (!best || rank[kind] > rank[best.kind])) best = { kind, segment: segment.replace(/\s+\d*>&\d+/g, "").trim() };
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
