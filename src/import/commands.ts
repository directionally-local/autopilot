/**
 * Claude Code's markdown slash commands as Autopilot commands (#1126).
 *
 * Read in place from ~/.claude/commands (personal) and .claude/commands
 * (project) each time commands load; nothing is copied. A command maps when
 * its format does: frontmatter `description`, `$ARGUMENTS` and `$1`…`$9`
 * work as in Claude Code, and `@file` references are included as Claude
 * Code includes them. Not brought in, with the reason:
 *   - commands that run shell (`!` + backticks): Autopilot never runs
 *     another agent's shell snippets on its own;
 *   - commands whose frontmatter Autopilot can't read;
 *   - commands named like an Autopilot built-in.
 * Claude-only frontmatter (`model`, `allowed-tools`, `argument-hint`, …) is
 * ignored: Autopilot keeps its own model and permissions.
 *
 * Autopilot's own commands (.autopilot/commands, ~/.config/autopilot/commands)
 * win over a Claude Code command of the same name.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtins.js";
import { parseFrontmatter } from "../commands/frontmatter.js";
import type { CommandSource, CustomCommand } from "../commands/types.js";
import { homeOf, isDir, setupImportEnabled, type ImportEnv } from "./paths.js";

const MAX_COMMAND_BYTES = 256 * 1024;

/** `dir/name` for `<root>/dir/name.md`, as Autopilot's own loader names commands. */
function filenameToCommandName(file: string, rootDir: string): string | null {
  const rel = relative(rootDir, file);
  if (!rel || rel.startsWith("..")) return null;
  const parts = rel.replace(/\.md$/i, "").split(sep).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.some((p) => !/^[\w.-]+$/.test(p))) return null;
  return parts.join("/");
}

export type SkipReason = "shell" | "frontmatter" | "builtin" | "name" | "size";

export interface SkippedItem {
  name: string;
  reason: SkipReason;
}

/** Why a command was not brought in: for one command, and for several. */
export const SKIP_REASON_TEXT: Record<SkipReason, [string, string]> = {
  shell: ["it runs shell commands", "they run shell commands"],
  frontmatter: ["its frontmatter isn't understood", "their frontmatter isn't understood"],
  builtin: ["Autopilot has a built-in command with that name", "Autopilot has built-in commands with those names"],
  name: ["its name isn't a valid command name", "their names aren't valid command names"],
  size: ["it's too large", "they're too large"],
};

export interface ClaudeCommandsResult {
  commands: CustomCommand[];
  skipped: SkippedItem[];
}

function mdFiles(dir: string, depth = 0): string[] {
  if (depth > 4 || !isDir(dir)) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...mdFiles(p, depth + 1));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(p);
  }
  return out;
}

/** A project folder must not reach outside the project through a symlink. */
function safeProjectDir(dir: string, cwd: string): string | null {
  try {
    const real = realpathSync(dir);
    const rel = relative(realpathSync(cwd), real);
    if (rel.startsWith("..")) return null;
    return real;
  } catch {
    return null;
  }
}

export function loadClaudeCommands(cwd: string, env?: ImportEnv): ClaudeCommandsResult {
  const out: ClaudeCommandsResult = { commands: [], skipped: [] };
  if (!setupImportEnabled()) return out;
  const home = homeOf(env);
  const byName = new Map<string, CustomCommand>();
  const sources: Array<{ dir: string | null; source: CommandSource }> = [
    { dir: isDir(join(home, ".claude", "commands")) ? join(home, ".claude", "commands") : null, source: "global" },
    { dir: isDir(join(cwd, ".claude", "commands")) ? safeProjectDir(join(cwd, ".claude", "commands"), cwd) : null, source: "project" },
  ];
  for (const { dir, source } of sources) {
    if (!dir) continue;
    for (const file of mdFiles(dir)) {
      const name = filenameToCommandName(file, dir);
      if (!name) {
        out.skipped.push({ name: relative(dir, file), reason: "name" });
        continue;
      }
      let text: string;
      try {
        if (statSync(file).size > MAX_COMMAND_BYTES) {
          out.skipped.push({ name, reason: "size" });
          continue;
        }
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { data, body, errors } = parseFrontmatter(text);
      if (errors.length > 0) {
        out.skipped.push({ name, reason: "frontmatter" });
        continue;
      }
      if (/!`[^`]+`/.test(body)) {
        out.skipped.push({ name, reason: "shell" });
        continue;
      }
      if (BUILTIN_COMMAND_NAMES.has(name.toLowerCase()) || name.toLowerCase() === "setup-import") {
        out.skipped.push({ name, reason: "builtin" });
        continue;
      }
      const cmd: CustomCommand = {
        name,
        template: body,
        source,
        filepath: file,
        description: data.description ? `${data.description} (Claude Code)` : "Claude Code command",
        importedFrom: "claude",
      };
      if (/(?<![\w`])@(\.?[^\s`,]+?)/.test(body)) cmd.files = true;
      byName.set(name, cmd);
    }
  }
  out.commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Claude Code subagents (.claude/agents, ~/.claude/agents): Autopilot has no named subagents yet. */
export function findClaudeSubagents(cwd: string, env?: ImportEnv): string[] {
  const home = homeOf(env);
  return [...mdFiles(join(home, ".claude", "agents")), ...mdFiles(join(cwd, ".claude", "agents"))];
}

/** Claude Code skills (<dir>/SKILL.md under .claude/skills or ~/.claude/skills). */
export function findClaudeSkills(cwd: string, env?: ImportEnv): string[] {
  const home = homeOf(env);
  const out: string[] = [];
  for (const dir of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")]) {
    if (!isDir(dir)) continue;
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const skill = join(dir, e.name, "SKILL.md");
        try {
          if (statSync(skill).isFile()) out.push(skill);
        } catch {
          /* not a skill */
        }
      }
    } catch {
      /* unreadable */
    }
  }
  return out;
}
