/**
 * "Bring your setup from other coding agents" (#1126): what was found, and
 * how it is shown.
 *
 * The first session on a machine that finds anything shows the checklist;
 * later sessions show at most one line ("Using your CLAUDE.md"); `/setup-import`
 * shows the checklist again. Nothing is shown when nothing is found, and
 * nothing about these files is sent anywhere: usage events carry no new
 * fields (the events allowlist has none for this).
 *
 * The only file written is a marker under Autopilot's state folder that
 * the checklist was shown; nothing is written to the repository.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { statePath } from "../util/app-dirs.js";
import { findClaudeSkills, findClaudeSubagents, loadClaudeCommands, SKIP_REASON_TEXT, type SkippedItem, type SkipReason } from "./commands.js";
import { loadInstructions, otherAgentFileNames, type InstructionFile } from "./instructions.js";
import { discoverMcpServers, MCP_AGENT_NAMES, type ImportedMcpServer, type McpAgent, type SkippedServer } from "./mcp.js";
import { homeOf, isRecord, readJson, setupImportEnabled, type ImportEnv } from "./paths.js";
import { claudeSettingsFiles, loadDenyRules, type DenyRule } from "./permissions.js";

export interface SetupScan {
  instructions: InstructionFile[];
  mcp: ImportedMcpServer[];
  mcpSkipped: SkippedServer[];
  commands: number;
  commandsSkipped: SkippedItem[];
  subagents: number;
  skills: number;
  hooks: number;
  plugins: number;
  denyRules: DenyRule[];
}

export interface ScanOptions extends ImportEnv {
  /** MCP server names Autopilot's own config already has. */
  configuredMcp?: Iterable<string>;
  /** Managed-settings paths (tests). */
  managed?: string[];
}

function countHooks(settings: Record<string, unknown> | null): number {
  if (!settings || !isRecord(settings.hooks)) return 0;
  let n = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const g of groups) {
      if (isRecord(g) && Array.isArray(g.hooks)) n += g.hooks.length;
      else if (isRecord(g) && typeof g.command === "string") n += 1;
    }
  }
  return n;
}

function countPlugins(settings: Record<string, unknown> | null): string[] {
  if (!settings || !isRecord(settings.enabledPlugins)) return [];
  return Object.entries(settings.enabledPlugins)
    .filter(([, on]) => on === true)
    .map(([name]) => name);
}

/** Everything found for `cwd`. Reads only. */
export function scanSetup(cwd: string, opts: ScanOptions = {}): SetupScan {
  const empty: SetupScan = { instructions: [], mcp: [], mcpSkipped: [], commands: 0, commandsSkipped: [], subagents: 0, skills: 0, hooks: 0, plugins: 0, denyRules: [] };
  if (!setupImportEnabled()) return empty;
  const home = homeOf(opts);
  const instructions = loadInstructions(cwd, opts).filter((f) => f.agent !== "autopilot" || f.also.length > 0);
  const mcp = discoverMcpServers(cwd, { ...opts, ...(opts.configuredMcp ? { exclude: opts.configuredMcp } : {}) });
  const cmds = loadClaudeCommands(cwd, opts);
  let hooks = 0;
  const plugins = new Set<string>();
  for (const f of claudeSettingsFiles(cwd, opts)) {
    const json = readJson(f.path);
    hooks += countHooks(json);
    for (const p of countPlugins(json)) plugins.add(p);
  }
  // Installed plugins (Claude Code keeps a list) count too, if not already enabled by name.
  const installed = readJson(join(home, ".claude", "plugins", "installed_plugins.json"));
  if (installed && isRecord(installed.plugins)) for (const name of Object.keys(installed.plugins)) plugins.add(name);
  return {
    instructions,
    mcp: mcp.servers,
    mcpSkipped: mcp.skipped,
    commands: cmds.commands.length,
    commandsSkipped: cmds.skipped,
    subagents: findClaudeSubagents(cwd, opts).length,
    skills: findClaudeSkills(cwd, opts).length,
    hooks,
    plugins: plugins.size,
    denyRules: loadDenyRules(cwd, opts),
  };
}

export function scanIsEmpty(s: SetupScan): boolean {
  return (
    s.instructions.length === 0 &&
    s.mcp.length === 0 &&
    s.mcpSkipped.length === 0 &&
    s.commands === 0 &&
    s.commandsSkipped.length === 0 &&
    s.subagents === 0 &&
    s.skills === 0 &&
    s.hooks === 0 &&
    s.plugins === 0 &&
    s.denyRules.length === 0
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Agent = "claude" | "cursor" | "gemini" | "copilot" | "opencode";
const AGENT_LABEL: Record<Agent, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot",
  opencode: "OpenCode",
};

function claudeInstructionLabel(files: InstructionFile[]): string | null {
  const labels = files.flatMap((f) => [f.label, ...f.also]);
  const isClaude = (l: string) => /(^|\/)CLAUDE(\.local)?\.md$/.test(l);
  const claude = labels.filter(isClaude);
  if (claude.length === 0) return null;
  const personal = claude.some((l) => l === "~/.claude/CLAUDE.md" || l.endsWith("CLAUDE.local.md"));
  const project = claude.some((l) => l !== "~/.claude/CLAUDE.md" && !l.endsWith("CLAUDE.local.md"));
  return `CLAUDE.md (${project && personal ? "project + personal" : project ? "project" : "personal"})`;
}

/** The checklist, or null when nothing was found. */
export function formatChecklist(s: SetupScan): string | null {
  if (scanIsEmpty(s)) return null;
  const items: Record<Agent, string[]> = { claude: [], cursor: [], gemini: [], copilot: [], opencode: [] };
  const claudeMd = claudeInstructionLabel(s.instructions);
  if (claudeMd) items.claude.push(claudeMd);
  const all = s.instructions.flatMap((f) => [f.label, ...f.also]);
  if (all.some((l) => /(^|\/)GEMINI\.md$/.test(l))) items.gemini.push("GEMINI.md");
  const rules = all.filter((l) => l.startsWith(".cursor/rules/")).length;
  if (rules > 0) items.cursor.push(`.cursor/rules (${plural(rules, "file")})`);
  if (all.includes(".cursorrules")) items.cursor.push(".cursorrules");
  if (all.includes(".github/copilot-instructions.md")) items.copilot.push(".github/copilot-instructions.md");
  const mcpBy = new Map<McpAgent, number>();
  for (const m of s.mcp) mcpBy.set(m.agent, (mcpBy.get(m.agent) ?? 0) + 1);
  for (const [agent, n] of mcpBy) items[agent].push(plural(n, "MCP server"));
  if (s.commands > 0) items.claude.push(plural(s.commands, "command"));
  if (s.denyRules.length > 0) items.claude.push(plural(s.denyRules.length, "deny rule"));

  const lines = ["Bringing in your setup (stays on this computer)"];
  const shownAgents = (Object.keys(items) as Agent[]).filter((a) => items[a].length > 0);
  const width = Math.max(14, ...shownAgents.map((a) => AGENT_LABEL[a].length + 2));
  for (const agent of shownAgents) lines.push(`  ✓ ${AGENT_LABEL[agent].padEnd(width)}${items[agent].join(" · ")}`);
  const skip = (text: string) => lines.push(`  ↷ ${text}`);
  if (s.hooks > 0) skip(`${plural(s.hooks, "Claude Code hook")} found, not turned on · they run shell commands`);
  if (s.plugins > 0) skip(`${plural(s.plugins, "Claude Code plugin")} found, not turned on · plugins aren't supported yet`);
  if (s.subagents > 0) skip(`${plural(s.subagents, "Claude Code subagent")} found, not brought in · Autopilot has no custom subagents yet`);
  if (s.skills > 0) skip(`${plural(s.skills, "Claude Code skill")} found, not brought in yet`);
  const byReason = new Map<SkipReason, number>();
  for (const c of s.commandsSkipped) byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
  for (const [reason, n] of byReason) skip(`${plural(n, "Claude Code command")} not brought in · ${SKIP_REASON_TEXT[reason][n === 1 ? 0 : 1]}`);
  for (const m of s.mcpSkipped) skip(`${m.name} MCP server (${MCP_AGENT_NAMES[m.agent]}) not brought in · ${m.reason}`);
  if (s.mcp.length > 0) lines.push("  MCP servers stay off until a task needs one; you're asked before each starts the first time.");
  return lines.join("\n");
}

/** The once-per-session line, or null. */
export function formatSessionLine(s: SetupScan): string | null {
  const names = otherAgentFileNames(s.instructions);
  if (names.length === 0) return null;
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Using your ${list}`;
}

// ── First run ─────────────────────────────────────────────────────────────

function markerPath(): string {
  return statePath("setup-import.json");
}

export function checklistShown(): boolean {
  return existsSync(markerPath());
}

export function markChecklistShown(now = new Date()): void {
  try {
    const path = markerPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify({ version: 1, shownAt: now.toISOString() }) + "\n", { mode: 0o600 });
  } catch {
    /* shown again next time */
  }
}

/**
 * What to show when a session starts: the checklist the first time
 * anything is found on this machine, then at most the one line. Null when
 * there is nothing to show.
 */
export function sessionStartNotice(cwd: string, opts: ScanOptions = {}): string | null {
  if (!setupImportEnabled()) return null;
  const scan = scanSetup(cwd, opts);
  if (scanIsEmpty(scan)) return null;
  if (!checklistShown()) {
    const checklist = formatChecklist(scan);
    markChecklistShown();
    return checklist;
  }
  return formatSessionLine(scan);
}

/** `/setup-import`: the checklist, or a sentence when nothing was found. */
export function setupImportReport(cwd: string, opts: ScanOptions = {}): string {
  if (!setupImportEnabled()) return "Bringing in other agents' setup is off (AUTOPILOT_IMPORT_SETUP=0).";
  const checklist = formatChecklist(scanSetup(cwd, opts));
  if (checklist) markChecklistShown();
  return checklist ?? "No setup from other coding agents (Claude Code, Cursor, Gemini CLI, GitHub Copilot, OpenCode) found for this project.";
}
