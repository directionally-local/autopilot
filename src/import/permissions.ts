/**
 * Claude Code's permission deny rules, honoured by Autopilot (#1126).
 *
 * Importing permissions only ever tightens: a `deny` rule in Claude Code's
 * settings denies the matching Autopilot tool call too, in every mode
 * (including auto). `allow` rules are never imported. `ask` rules are not
 * imported yet (a follow-up); they stay as Autopilot's own mode decides.
 *
 * Read from, every time a tool runs (cached by file modification time):
 *   managed settings (/etc/claude-code/managed-settings.json, or
 *   /Library/Application Support/ClaudeCode/managed-settings.json),
 *   ~/.claude/settings.json, <project>/.claude/settings.json and
 *   <project>/.claude/settings.local.json.
 *
 * Rule shapes understood (Claude Code's syntax):
 *   Bash, Bash(npm run test:*), Bash(curl *), Bash(git push)
 *   Read(./.env), Read(./secrets/**), Read(~/.ssh/**), Read(//etc/**), Read(*.pem)
 *   Edit(...) and Write(...) (Edit also covers write), WebFetch, WebFetch(domain:x.com),
 *   WebSearch, mcp__server, mcp__server__tool, mcp__server__*, Task / Agent
 * A rule in a shape not listed is ignored (and so cannot loosen anything).
 *
 * Bash rules deny conservatively: `Bash(git push)` also denies
 * `git push origin main`, and every command in a compound command is checked.
 */
import { statSync } from "node:fs";
import { join, relative, resolve, sep, isAbsolute, basename } from "node:path";
import { homeOf, isRecord, projectRootOf, readJson, setupImportEnabled, type ImportEnv } from "./paths.js";

export interface DenyRule {
  /** The rule as written, e.g. `Bash(rm -rf:*)`. */
  raw: string;
  /** Autopilot tools it applies to. */
  tools: string[];
  /** The part in parentheses, if any. */
  spec?: string;
  /** For mcp rules: server, and tool (or "*"). */
  mcp?: { server: string; tool: string };
  /** Settings file it came from. */
  source: string;
  /** Folder that relative path patterns are resolved against. */
  base: string;
}

export function managedSettingsPaths(): string[] {
  return process.platform === "darwin"
    ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
    : process.platform === "win32"
      ? ["C:\\ProgramData\\ClaudeCode\\managed-settings.json"]
      : ["/etc/claude-code/managed-settings.json"];
}

/** Claude Code settings files that apply to `cwd`, with the folder their relative patterns use. */
export function claudeSettingsFiles(cwd: string, env?: ImportEnv & { managed?: string[] }): Array<{ path: string; base: string }> {
  const home = homeOf(env);
  const root = projectRootOf(cwd);
  return [
    ...(env?.managed ?? managedSettingsPaths()).map((path) => ({ path, base: root })),
    { path: join(home, ".claude", "settings.json"), base: root },
    { path: join(root, ".claude", "settings.json"), base: root },
    { path: join(root, ".claude", "settings.local.json"), base: root },
  ];
}

const TOOL_MAP: Record<string, string[]> = {
  Bash: ["bash", "job_start"],
  Read: ["read", "grep", "glob"],
  Edit: ["edit", "write"],
  MultiEdit: ["edit"],
  Write: ["write"],
  NotebookEdit: ["edit", "write"],
  WebFetch: ["web_fetch", "browser_fetch"],
  WebSearch: ["search_web"],
  Task: ["subagent"],
  Agent: ["subagent"],
};

export function parseDenyRule(raw: string, source: string, base: string): DenyRule | null {
  const s = raw.trim();
  const mcp = s.match(/^mcp__([^_].*?)(?:__(.+))?$/);
  if (mcp) {
    return { raw: s, tools: [], mcp: { server: mcp[1]!, tool: mcp[2] ?? "*" }, source, base };
  }
  const m = s.match(/^([A-Za-z]+)(?:\((.*)\))?$/s);
  if (!m) return null;
  const tools = TOOL_MAP[m[1]!];
  if (!tools) return null;
  const spec = m[2]?.trim();
  return { raw: s, tools, ...(spec && spec !== "*" ? { spec } : {}), source, base };
}

interface Cached {
  sig: string;
  rules: DenyRule[];
}
const cache = new Map<string, Cached>();

function signature(files: Array<{ path: string }>): string {
  return files
    .map((f) => {
      try {
        const s = statSync(f.path);
        return `${f.path}:${s.mtimeMs}:${s.size}`;
      } catch {
        return `${f.path}:-`;
      }
    })
    .join("|");
}

/** The deny rules in effect for `cwd`. */
export function loadDenyRules(cwd: string, env?: ImportEnv & { managed?: string[] }): DenyRule[] {
  if (!setupImportEnabled()) return [];
  const files = claudeSettingsFiles(cwd, env);
  const key = `${homeOf(env)}\0${resolve(cwd)}`;
  const sig = signature(files);
  const hit = cache.get(key);
  if (hit && hit.sig === sig) return hit.rules;
  const rules: DenyRule[] = [];
  for (const f of files) {
    const json = readJson(f.path);
    const perms = json && isRecord(json.permissions) ? json.permissions : null;
    const deny = perms && Array.isArray(perms.deny) ? perms.deny : [];
    for (const r of deny) {
      if (typeof r !== "string") continue;
      const parsed = parseDenyRule(r, f.path, f.base);
      if (parsed) rules.push(parsed);
    }
  }
  cache.set(key, { sig, rules });
  return rules;
}

// ── Matching ──────────────────────────────────────────────────────────────

function globRe(glob: string, opts: { slashStar: boolean }): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += opts.slashStar ? "[^/]*" : ".*";
    } else if (ch === "?") re += opts.slashStar ? "[^/]" : ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** Split a shell command into its simple commands (best effort, quote-aware). */
export function commandSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (q) {
      if (ch === q) q = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (";&|\n\r`(){}".includes(ch) || (ch === "$" && command[i + 1] === "(")) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  const strip = (seg: string) => {
    let s = seg.trim();
    // Leading env assignments and wrappers do not change what runs.
    for (;;) {
      const m = s.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:sudo|env|time|command|nohup|exec|nice)\s+)/);
      if (!m) break;
      s = s.slice(m[0].length);
    }
    return s;
  };
  return [command.trim(), ...out.map(strip)].filter((s, i, a) => s && a.indexOf(s) === i);
}

function bashMatches(command: string, spec: string | undefined): boolean {
  if (!spec) return true;
  const segs = commandSegments(command);
  let pattern = spec;
  let prefix = false;
  if (pattern.endsWith(":*")) {
    pattern = pattern.slice(0, -2);
    prefix = true;
  }
  if (!pattern.includes("*")) {
    // Exact, or the same command with more arguments (deny errs on the safe side).
    return segs.some((s) => s === pattern || s.startsWith(`${pattern} `) || (prefix && s.startsWith(pattern)));
  }
  const re = globRe(pattern, { slashStar: false });
  return segs.some((s) => re.test(s) || (prefix && globRe(`${pattern}*`, { slashStar: false }).test(s)));
}

function pathMatches(target: string, spec: string | undefined, rule: DenyRule, home: string): boolean {
  if (!spec) return true;
  let pattern = spec;
  let anchored: string;
  if (pattern.startsWith("//")) anchored = pattern.slice(1);
  else if (pattern.startsWith("~/")) anchored = join(home, pattern.slice(2));
  else if (pattern.startsWith("/")) anchored = join(rule.base, pattern.slice(1));
  else if (pattern.startsWith("./")) anchored = join(rule.base, pattern.slice(2));
  else if (!pattern.replace(/\/$/, "").includes("/")) {
    // No slash: matches that name at any depth (gitignore style).
    pattern = pattern.replace(/\/$/, "");
    const re = globRe(pattern, { slashStar: true });
    const parts = target.split(sep);
    return parts.some((p) => re.test(p));
  } else anchored = join(rule.base, pattern);
  const norm = anchored.split(sep).join("/").replace(/\/$/, "");
  const t = target.split(sep).join("/");
  const re = globRe(norm, { slashStar: true });
  // A folder pattern also covers everything inside it.
  return re.test(t) || globRe(`${norm}/**`, { slashStar: true }).test(t);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function webMatches(url: string, spec: string | undefined): boolean {
  if (!spec) return true;
  const m = spec.match(/^domain:(.+)$/);
  if (!m) return false;
  const host = hostOf(url);
  const domain = m[1]!.trim().toLowerCase();
  if (!host) return false;
  if (domain.startsWith("*.")) return host.endsWith(domain.slice(1));
  return host === domain || host.endsWith(`.${domain}`);
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** True when a deny rule for MCP server `server` (and `tool`, if given) applies. */
export function mcpDenied(rules: DenyRule[], server: string, tool?: string): DenyRule | null {
  for (const r of rules) {
    if (!r.mcp) continue;
    if (r.mcp.server !== server && sanitize(r.mcp.server) !== sanitize(server)) continue;
    if (r.mcp.tool === "*") return r;
    if (tool !== undefined && (r.mcp.tool === tool || sanitize(r.mcp.tool) === sanitize(tool))) return r;
  }
  return null;
}

/**
 * The deny rule that blocks this Autopilot tool call, or null. `knownMcp`
 * lists the MCP servers whose tools are named `mcp_<server>_<tool>`.
 */
export function deniedBy(
  rules: DenyRule[],
  call: { tool: string; args: Record<string, unknown>; cwd: string },
  env?: ImportEnv,
): DenyRule | null {
  if (rules.length === 0) return null;
  const home = homeOf(env);
  const { tool, args, cwd } = call;
  // MCP: configured servers' tools (mcp_<server>_<tool>) and imported servers (mcp_imported).
  if (tool === "mcp_imported" && typeof args.server === "string") {
    return mcpDenied(rules, args.server, typeof args.tool === "string" ? args.tool : undefined);
  }
  if (tool.startsWith("mcp_")) {
    for (const r of rules) {
      if (!r.mcp) continue;
      const prefix = `mcp_${sanitize(r.mcp.server)}_`;
      if (!tool.startsWith(prefix)) continue;
      if (r.mcp.tool === "*" || tool === `${prefix}${sanitize(r.mcp.tool)}`) return r;
    }
    return null;
  }
  for (const r of rules) {
    if (!r.tools.includes(tool)) continue;
    if (tool === "bash" || tool === "job_start") {
      if (typeof args.command !== "string") continue;
      if (bashMatches(args.command, r.spec)) return r;
    } else if (tool === "web_fetch" || tool === "browser_fetch") {
      if (!r.spec) return r;
      if (typeof args.url === "string" && webMatches(args.url, r.spec)) return r;
    } else if (tool === "search_web" || tool === "subagent") {
      if (!r.spec) return r;
    } else {
      if (!r.spec) return r;
      const p = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
      if (!p) continue;
      const abs = p.startsWith("~/") ? join(home, p.slice(2)) : isAbsolute(p) ? p : resolve(cwd, p);
      if (pathMatches(abs, r.spec, r, home)) return r;
    }
  }
  return null;
}

/** The rule denying this call under the settings for `cwd`, or null. Never throws. */
export function importedDenyFor(call: { tool: string; args: Record<string, unknown>; cwd: string }, env?: ImportEnv): DenyRule | null {
  try {
    return deniedBy(loadDenyRules(call.cwd, env), call, env);
  } catch {
    return null;
  }
}

/** For messages: the settings file a rule came from, shortened. */
export function ruleSourceLabel(rule: DenyRule, env?: ImportEnv): string {
  const home = homeOf(env);
  const rel = relative(home, rule.source);
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `~/${rel.split(sep).join("/")}`;
  const root = rule.base;
  const relRoot = relative(root, rule.source);
  if (!relRoot.startsWith("..") && !isAbsolute(relRoot)) return relRoot.split(sep).join("/");
  return basename(rule.source);
}
