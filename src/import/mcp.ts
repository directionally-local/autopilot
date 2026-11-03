/**
 * MCP servers from other coding agents (#1126): listed, never started
 * silently.
 *
 * Found in, first name wins:
 *   Claude Code  ~/.claude.json (this project's entry, then .mcp.json, then user-wide)
 *   Cursor       .cursor/mcp.json, ~/.cursor/mcp.json
 *   OpenCode     opencode.json(c) in the project, ~/.config/opencode/opencode.json(c)
 * A server Autopilot's own config already names, one denied by a Claude
 * Code `mcp__<server>` rule, or one turned off in its source is left out.
 *
 * Each server stays off until a task needs it. The interactive session
 * offers one tool, `mcp_imported`; the first time the model calls it for a
 * server the user is asked once ("Allow once / Always / Don't"). "Always"
 * and "Don't" are remembered per machine under Autopilot's state folder,
 * keyed by the server's command or URL, so a changed command asks again.
 *
 * Secrets: env values and headers are never copied or stored. They are
 * read from the source file at the moment the server starts and handed to
 * that process only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import type { ToolContext, ToolSpec } from "../tools/registry.js";
import { statePath } from "../util/app-dirs.js";
import { homeOf, isRecord, projectRootOf, readJson, setupImportEnabled, type ImportEnv } from "./paths.js";
import { loadDenyRules, mcpDenied } from "./permissions.js";

export type McpAgent = "claude" | "cursor" | "opencode";

export const MCP_AGENT_NAMES: Record<McpAgent, string> = {
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export interface ImportedMcpServer {
  name: string;
  agent: McpAgent;
  /** The file it is read from (and re-read from when it starts). */
  sourcePath: string;
  /** Where in that file: a JSON path such as ["projects", "/repo", "mcpServers", "github"]. */
  pointer: string[];
  kind: "local" | "remote";
  /** Command and arguments, as written (no secrets: env is not included). */
  command?: string[];
  url?: string;
  /** False when Autopilot can't run it yet; `reason` says why. */
  supported: boolean;
  reason?: string;
  /** Changes when the command or URL changes, so consent is asked again. */
  fingerprint: string;
}

export interface SkippedServer {
  name: string;
  agent: McpAgent;
  reason: string;
}

export interface McpDiscovery {
  servers: ImportedMcpServer[];
  skipped: SkippedServer[];
}

function fingerprintOf(kind: string, command: string[] | undefined, url: string | undefined): string {
  return createHash("sha256").update(JSON.stringify({ kind, command: command ?? null, url: url ?? null })).digest("hex").slice(0, 16);
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Claude Code / Cursor shape: {type?, command, args, env} or {type?, url, headers}. */
function fromMcpServersEntry(name: string, raw: unknown, agent: McpAgent, sourcePath: string, pointer: string[]): ImportedMcpServer | SkippedServer | null {
  if (!isRecord(raw)) return null;
  if (raw.disabled === true || raw.enabled === false) return { name, agent, reason: `turned off in ${MCP_AGENT_NAMES[agent]}` };
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (typeof raw.command === "string" && raw.command.trim()) {
    const command = [raw.command, ...strings(raw.args)];
    return { name, agent, sourcePath, pointer, kind: "local", command, supported: true, fingerprint: fingerprintOf("local", command, undefined) };
  }
  if (typeof raw.url === "string" && raw.url.trim()) {
    const url = raw.url;
    const sse = type === "sse" || (type === undefined && /\/sse\/?$/.test(url));
    return {
      name,
      agent,
      sourcePath,
      pointer,
      kind: "remote",
      url,
      supported: sse,
      ...(sse ? {} : { reason: "remote HTTP servers aren't supported yet" }),
      fingerprint: fingerprintOf("remote", undefined, url),
    };
  }
  return null;
}

/** OpenCode shape: {type: "local", command: [...], environment} or {type: "remote", url, headers}. */
function fromOpenCodeEntry(name: string, raw: unknown, sourcePath: string, pointer: string[]): ImportedMcpServer | SkippedServer | null {
  if (!isRecord(raw)) return null;
  if (raw.enabled === false) return { name, agent: "opencode", reason: "turned off in OpenCode" };
  if (raw.type === "local") {
    const command = strings(raw.command);
    if (command.length === 0) return null;
    return { name, agent: "opencode", sourcePath, pointer, kind: "local", command, supported: true, fingerprint: fingerprintOf("local", command, undefined) };
  }
  if (raw.type === "remote" && typeof raw.url === "string") {
    return {
      name,
      agent: "opencode",
      sourcePath,
      pointer,
      kind: "remote",
      url: raw.url,
      supported: false,
      reason: "remote HTTP servers aren't supported yet",
      fingerprint: fingerprintOf("remote", undefined, raw.url),
    };
  }
  return null;
}

function at(obj: unknown, pointer: string[]): unknown {
  let cur: unknown = obj;
  for (const k of pointer) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Find MCP servers from other agents for `cwd`. `exclude`: names Autopilot's own config already has. */
export function discoverMcpServers(cwd: string, opts: ImportEnv & { exclude?: Iterable<string> } = {}): McpDiscovery {
  const out: McpDiscovery = { servers: [], skipped: [] };
  if (!setupImportEnabled()) return out;
  const home = homeOf(opts);
  const root = projectRootOf(cwd);
  const taken = new Set(opts.exclude ?? []);
  const denyRules = loadDenyRules(cwd, opts);

  const add = (entry: ImportedMcpServer | SkippedServer | null) => {
    if (!entry || taken.has(entry.name)) return;
    taken.add(entry.name);
    if (!("kind" in entry)) {
      out.skipped.push(entry);
      return;
    }
    const denied = mcpDenied(denyRules, entry.name);
    if (denied) {
      out.skipped.push({ name: entry.name, agent: entry.agent, reason: "denied in your Claude Code settings" });
      return;
    }
    if (!entry.supported) {
      out.skipped.push({ name: entry.name, agent: entry.agent, reason: entry.reason ?? "not supported yet" });
      return;
    }
    out.servers.push(entry);
  };

  const fromMap = (agent: McpAgent, path: string, json: Record<string, unknown> | null, pointer: string[]) => {
    const map = at(json, pointer);
    if (!isRecord(map)) return;
    for (const [name, raw] of Object.entries(map)) add(fromMcpServersEntry(name, raw, agent, path, [...pointer, name]));
  };

  // Claude Code
  const claudeJsonPath = join(home, ".claude.json");
  const claudeJson = readJson(claudeJsonPath, 64 * 1024 * 1024);
  const projects = claudeJson && isRecord(claudeJson.projects) ? claudeJson.projects : {};
  const projectKey = [cwd, root].find((k) => isRecord(projects[k]));
  const disabledMcpJson = new Set(projectKey ? strings(at(projects, [projectKey, "disabledMcpjsonServers"])) : []);
  if (projectKey) fromMap("claude", claudeJsonPath, claudeJson, ["projects", projectKey, "mcpServers"]);
  const mcpJsonPath = join(root, ".mcp.json");
  const mcpJson = readJson(mcpJsonPath);
  if (mcpJson && isRecord(mcpJson.mcpServers)) {
    for (const [name, raw] of Object.entries(mcpJson.mcpServers)) {
      if (disabledMcpJson.has(name)) add({ name, agent: "claude", reason: "turned off in Claude Code" });
      else add(fromMcpServersEntry(name, raw, "claude", mcpJsonPath, ["mcpServers", name]));
    }
  }
  fromMap("claude", claudeJsonPath, claudeJson, ["mcpServers"]);

  // Cursor
  for (const path of [join(root, ".cursor", "mcp.json"), join(home, ".cursor", "mcp.json")]) {
    fromMap("cursor", path, readJson(path), ["mcpServers"]);
  }

  // OpenCode
  for (const path of [
    join(root, "opencode.json"),
    join(root, "opencode.jsonc"),
    join(home, ".config", "opencode", "opencode.json"),
    join(home, ".config", "opencode", "opencode.jsonc"),
  ]) {
    const json = readJson(path);
    if (!json || !isRecord(json.mcp)) continue;
    for (const [name, raw] of Object.entries(json.mcp)) add(fromOpenCodeEntry(name, raw, path, ["mcp", name]));
  }
  return out;
}

// ── Starting a server: secrets are read here, in place, and not kept ─────

/** Expand `${VAR}` and `${VAR:-default}` as Claude Code does in .mcp.json. */
export function expandVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => env[name] ?? def ?? "");
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = expandVars(val);
  return out;
}

export type McpLaunch =
  | { kind: "local"; command: string[]; env?: Record<string, string> }
  | { kind: "remote"; url: string; headers?: Record<string, string> };

/**
 * Re-read the server's entry from its source file and build what starting
 * it needs. Fails if the entry changed since it was approved.
 */
export function resolveLaunch(server: ImportedMcpServer): McpLaunch {
  const json = readJson(server.sourcePath, 64 * 1024 * 1024);
  const raw = at(json, server.pointer);
  const now =
    server.agent === "opencode"
      ? fromOpenCodeEntry(server.name, raw, server.sourcePath, server.pointer)
      : fromMcpServersEntry(server.name, raw, server.agent, server.sourcePath, server.pointer);
  if (!now || !("kind" in now) || now.fingerprint !== server.fingerprint) {
    throw new Error(`the ${server.name} entry in ${server.sourcePath} changed or is gone; restart Autopilot to pick it up`);
  }
  if (!isRecord(raw)) throw new Error(`the ${server.name} entry is gone`);
  if (now.kind === "local") {
    const env = stringMap(server.agent === "opencode" ? raw.environment : raw.env);
    return { kind: "local", command: now.command!.map((c) => expandVars(c)), ...(env ? { env } : {}) };
  }
  const headers = stringMap(raw.headers);
  return { kind: "remote", url: expandVars(now.url!), ...(headers ? { headers } : {}) };
}

// ── Consent: one question per server ──────────────────────────────────────

export type McpConsent = "once" | "always" | "deny";

interface ConsentFile {
  version: 1;
  servers: Record<string, { decision: "always" | "never"; at: string }>;
}

function consentPath(): string {
  return statePath("imported-mcp.json");
}

function consentKey(s: ImportedMcpServer): string {
  return `${s.agent}:${s.name}:${s.fingerprint}`;
}

function readConsent(): ConsentFile {
  try {
    const parsed = JSON.parse(readFileSync(consentPath(), "utf8")) as Partial<ConsentFile>;
    if (parsed && isRecord(parsed.servers)) return { version: 1, servers: parsed.servers as ConsentFile["servers"] };
  } catch {
    /* nothing remembered yet */
  }
  return { version: 1, servers: {} };
}

function writeConsent(file: ConsentFile): void {
  try {
    const path = consentPath();
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    /* asked again next time */
  }
}

/** This process's answers ("Allow once" lasts for the session). */
const sessionAnswers = new Map<string, "allow" | "deny">();

export function storedConsent(s: ImportedMcpServer): "always" | "never" | null {
  return readConsent().servers[consentKey(s)]?.decision ?? null;
}

export function consentState(s: ImportedMcpServer): "allowed" | "denied" | "unasked" {
  const session = sessionAnswers.get(consentKey(s));
  if (session === "allow") return "allowed";
  if (session === "deny") return "denied";
  const stored = storedConsent(s);
  return stored === "always" ? "allowed" : stored === "never" ? "denied" : "unasked";
}

export function recordConsent(s: ImportedMcpServer, answer: McpConsent, now = new Date()): void {
  const key = consentKey(s);
  sessionAnswers.set(key, answer === "deny" ? "deny" : "allow");
  if (answer === "once") return;
  const file = readConsent();
  file.servers[key] = { decision: answer === "always" ? "always" : "never", at: now.toISOString() };
  writeConsent(file);
}

/** Test hook. */
export function resetMcpSessionState(): void {
  sessionAnswers.clear();
  registered.clear();
  connected.clear();
}

export const MCP_CHOICES: ReadonlyArray<{ value: McpConsent; label: string }> = [
  { value: "once", label: "Allow once" },
  { value: "always", label: "Always" },
  { value: "deny", label: "Don't" },
];

function shown(s: string): string {
  return s.length > 100 ? `${s.slice(0, 99)}…` : s;
}

const SECRET_FLAG = /^--?(token|api[-_]?key|key|secret|password|passwd|pass|auth|access[-_]?token|bearer)$/i;
const SECRET_VALUE = /^(gh[pousr]_|github_pat_|sk-|xox[abp]-|glpat-|AKIA)|^[A-Za-z0-9+/_=-]{32,}$/;

/** A command for display: values that look like keys are replaced with "…". */
export function displayCommand(command: string[]): string {
  const out: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const a = command[i]!;
    const eq = a.match(/^(--?[\w-]+)=(.*)$/);
    if (eq && (SECRET_FLAG.test(eq[1]!) || SECRET_VALUE.test(eq[2]!))) out.push(`${eq[1]}=…`);
    else if (i > 0 && SECRET_FLAG.test(command[i - 1]!)) out.push("…");
    else if (SECRET_VALUE.test(a) && !a.includes("/")) out.push("…");
    else out.push(a);
  }
  return out.join(" ");
}

/** A URL for display, without its query string or credentials. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0]!;
  }
}

function describe(s: ImportedMcpServer): string {
  return shown(s.kind === "local" ? displayCommand(s.command!) : displayUrl(s.url!));
}

function displayPath(path: string, home: string): string {
  const rel = relative(home, path);
  return !rel.startsWith("..") && !isAbsolute(rel) ? `~/${rel.split(sep).join("/")}` : path;
}

/** The one-time question's text. */
export function mcpQuestion(s: ImportedMcpServer, env?: ImportEnv): { prompt: string; subtitle: string } {
  const what = s.kind === "local" ? `It runs \`${describe(s)}\`.` : `It connects to ${describe(s)}.`;
  return {
    prompt: `Use the \`${s.name}\` MCP server from your ${MCP_AGENT_NAMES[s.agent]} setup?`,
    subtitle: `${what} Its settings and any keys stay in ${displayPath(s.sourcePath, homeOf(env))}.`,
  };
}

/** The question for a call that would start an imported server not yet answered for, or null. */
export interface McpConsentPrompt {
  kind: "mcp";
  prompt: string;
  subtitle: string;
  root: string;
  choices: ReadonlyArray<{ value: McpConsent; label: string }>;
  onAnswer: (answer: McpConsent) => void;
}

/** Servers the session's `mcp_imported` tool offers, by name. */
const registered = new Map<string, ImportedMcpServer>();
/** Started servers' tools, by server name. */
const connected = new Map<string, ToolSpec[]>();

export function importedMcpPromptFor(req: { tool: { name: string }; args: Record<string, unknown> }): McpConsentPrompt | null {
  if (req.tool.name !== IMPORTED_MCP_TOOL) return null;
  const name = req.args.server;
  if (typeof name !== "string") return null;
  const server = registered.get(name);
  if (!server || consentState(server) !== "unasked") return null;
  return {
    kind: "mcp",
    ...mcpQuestion(server),
    root: "",
    choices: MCP_CHOICES,
    onAnswer: (answer) => recordConsent(server, answer),
  };
}

// ── The tool ──────────────────────────────────────────────────────────────

export const IMPORTED_MCP_TOOL = "mcp_imported";

export interface ImportedMcpDeps {
  /** Start the server and return its tools (named mcp_<server>_<tool>). */
  connect: (server: ImportedMcpServer, launch: McpLaunch) => Promise<ToolSpec[]>;
  /** Called once a server has started, to show it to the user. */
  onStarted?: (server: ImportedMcpServer, tools: ToolSpec[]) => void;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function compactSchema(spec: ToolSpec): string {
  try {
    const s = JSON.stringify(spec.parameters ?? {});
    return s.length > 600 ? `${s.slice(0, 599)}…` : s;
  } catch {
    return "{}";
  }
}

/** The line shown when a server starts. */
export function startedLine(server: ImportedMcpServer, toolCount: number): string {
  return `Turned on the ${server.name} MCP server from your ${MCP_AGENT_NAMES[server.agent]} setup (${toolCount} tool${toolCount === 1 ? "" : "s"})`;
}

/**
 * The `mcp_imported` tool for these servers, or null when there are none.
 * Registers the servers so the permission prompt can find them.
 */
export function createImportedMcpTool(servers: ImportedMcpServer[], deps: ImportedMcpDeps): ToolSpec | null {
  const usable = servers.filter((s) => consentState(s) !== "denied");
  registered.clear();
  for (const s of usable) registered.set(s.name, s);
  if (usable.length === 0) return null;
  const list = usable
    .map((s) => `${s.name} (${MCP_AGENT_NAMES[s.agent]}: ${describe(s)})`)
    .join("; ");
  return {
    name: IMPORTED_MCP_TOOL,
    description:
      `Use an MCP server from the user's other coding agents. Each is off until needed; the user is asked the first time one starts. ` +
      `Call with only \`server\` to turn it on and list its tools, then with \`server\`, \`tool\` and \`arguments\` to call one. Available: ${list}.`,
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", enum: usable.map((s) => s.name), description: "The server to use." },
        tool: { type: "string", description: "A tool on that server. Omit to turn the server on and list its tools." },
        arguments: { type: "object", description: "Arguments for the tool." },
      },
      required: ["server"],
    },
    needsPermission: true,
    render: (args: Record<string, unknown>) => ({
      title: typeof args.tool === "string" ? `${String(args.server)} · ${args.tool}` : `turn on MCP server ${String(args.server)}`,
    }),
    async run(args: { server?: unknown; tool?: unknown; arguments?: unknown }, ctx: ToolContext) {
      const name = typeof args.server === "string" ? args.server : "";
      const server = registered.get(name);
      if (!server) return `Error: no imported MCP server named "${name}". Available: ${[...registered.keys()].join(", ") || "none"}.`;
      const state = consentState(server);
      if (state === "denied") return `The user chose not to use the ${name} MCP server. Do not ask again; do the task another way.`;
      if (state !== "allowed") return `The ${name} MCP server is not turned on: the user has not allowed it.`;
      let tools = connected.get(name);
      if (!tools) {
        try {
          tools = await deps.connect(server, resolveLaunch(server));
        } catch (e) {
          return `Error: the ${name} MCP server did not start: ${(e as Error).message}`;
        }
        connected.set(name, tools);
        deps.onStarted?.(server, tools);
      }
      const prefix = `mcp_${sanitize(name)}_`;
      if (typeof args.tool !== "string" || !args.tool) {
        const lines = tools.map((t) => `- ${t.name.slice(prefix.length)}: ${(t.description ?? "").split("\n")[0]} Arguments: ${compactSchema(t)}`);
        return `The ${name} MCP server is on, with ${tools.length} tool${tools.length === 1 ? "" : "s"}. Call ${IMPORTED_MCP_TOOL} with server "${name}", tool and arguments (they are not separate tools):\n${lines.join("\n")}`;
      }
      const spec = tools.find((t) => t.name === `${prefix}${sanitize(args.tool as string)}`);
      if (!spec) return `Error: the ${name} MCP server has no tool "${args.tool}". Tools: ${tools.map((t) => t.name.slice(prefix.length)).join(", ")}.`;
      return spec.run(isRecord(args.arguments) ? args.arguments : {}, ctx);
    },
  };
}

/** True for a tool of an imported server that was started (reached only through mcp_imported). */
export function isImportedServerTool(toolName: string): boolean {
  for (const tools of connected.values()) if (tools.some((t) => t.name === toolName)) return true;
  return false;
}

/** Lines for `/mcp list`: imported servers and whether each is on. */
export function importedMcpListLines(): string[] {
  return [...registered.values()].map((s) => {
    const on = connected.has(s.name);
    const state = on ? "on" : consentState(s) === "denied" ? "not used (you said Don't)" : "off until a task needs it";
    return `  ${s.name} (from ${MCP_AGENT_NAMES[s.agent]}) — ${state}`;
  });
}
