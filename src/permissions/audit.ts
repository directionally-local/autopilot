/**
 * `/audit` (autopilot#1125): a read-only report of what the agent could
 * destroy from here, in plain words:
 *
 *   - which destructive actions permission rules and the mode allow without
 *     asking (irreversible ones still ask — permissions/guardrails.ts);
 *   - databases and cloud accounts reachable from this environment (env vars
 *     and .env files) and MCP servers, flagging ones that look like
 *     production;
 *   - whether recovery exists: git state, uncommitted work, saved recovery
 *     points;
 *   - suggested rule changes. They are only printed; nothing is applied.
 *
 * Everything is read locally. Values of variables are never shown — only
 * names and the host part of URLs — and nothing is sent anywhere.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PermissionRules } from "../config.js";
import { listRecoveryPoints } from "./recovery.js";

export interface AuditInput {
  cwd: string;
  /** Environment to inspect (defaults to process.env). */
  env?: Record<string, string | undefined>;
  permissions?: Record<string, PermissionRules> | undefined;
  mcpServers?: Record<string, unknown> | undefined;
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|.*\.local|.*\.internal)(:\d+)?$/i;
// Variable names that usually hold a database connection string or DSN.
const DB_VAR = /(DATABASE|DB|MYSQL|POSTGRES|PG|MARIA|MONGO|REDIS|SQLITE|SUPABASE|CLICKHOUSE|COCKROACH|NEON|PLANETSCALE|TURSO)[A-Z0-9_]*(_URL|_URI|_DSN|_HOST)$/i;
const CLOUD_VAR = /^(AWS_|AMAZON_|GCLOUD_|GOOGLE_|GCP_|AZURE_|CLOUDFLARE_|CF_|DIGITALOCEAN|DO_|HEROKU_|KUBECONFIG)/i;
const SECRETISH = /(KEY|SECRET|TOKEN|PASS|PASSWORD|PWD|PRIVATE)/i;
const PROD = /prod|production|live/i;

interface Target {
  /** Where it came from: `env DATABASE_URL` or `.env:DATABASE_URL`. */
  source: string;
  label: string;
  production: boolean;
}

/** The host part of a URL-ish value, or "a file path" / null. Never the value. */
function hostOf(value: string): { host: string | null; production: boolean } {
  const v = value.trim();
  // sqlite and file DSNs are local.
  if (/^(sqlite|file):/i.test(v) || v.startsWith("/") || v.startsWith(".")) return { host: null, production: false };
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:?]+)/i.exec(v);
  if (m) {
    const host = m[1]!;
    const production = !LOCAL_HOST.test(host) || PROD.test(host);
    return { host, production: production && !LOCAL_HOST.test(host) ? true : PROD.test(host) };
  }
  // A bare host(:port).
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(v) && v.includes(".")) {
    return { host: v, production: !LOCAL_HOST.test(v) };
  }
  return { host: null, production: false };
}

function dbTargetsFrom(env: Record<string, string | undefined>, source: string, into: Target[]): void {
  for (const [key, value] of Object.entries(env)) {
    if (!value || !DB_VAR.test(key)) continue;
    const { host, production } = hostOf(value);
    const namedProd = PROD.test(key);
    into.push({
      source: `${source} ${key}`,
      label: host ? `the database at ${host}` : "a local database (file DSN)",
      production: production || namedProd,
    });
  }
}

function cloudFrom(env: Record<string, string | undefined>, source: string, into: string[]): void {
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (!value || !CLOUD_VAR.test(key) || !SECRETISH.test(key)) continue;
    const provider = key.startsWith("AWS") || key.startsWith("AMAZON") ? "AWS" : /^(GCLOUD|GOOGLE|GCP)/.test(key) ? "Google Cloud" : key.startsWith("AZURE") ? "Azure" : /^CLOUDFLARE|^CF_/.test(key) ? "Cloudflare" : /^(DIGITALOCEAN|DO_)/.test(key) ? "DigitalOcean" : key.startsWith("HEROKU") ? "Heroku" : key === "KUBECONFIG" ? "Kubernetes" : key.replace(/_.*/, "");
    if (!into.includes(provider)) into.push(provider);
  }
}

/** Variable assignments from a .env-style file; malformed lines are skipped. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

function gitSummary(cwd: string): { repo: boolean; branch: string | null; dirty: number } {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return { repo: false, branch: null, dirty: 0 };
  }
  let branch: string | null = null;
  let dirty = 0;
  try {
    branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim() || null;
    dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).split("\n").filter(Boolean).length;
  } catch {
    /* leave defaults */
  }
  return { repo: true, branch, dirty };
}

/** The report /audit prints. */
export function buildAudit(input: AuditInput): string {
  const env = input.env ?? process.env;
  const lines: string[] = [];
  lines.push("Autopilot audit — what the agent could destroy from here, and what saves you");
  lines.push("");

  // 1. What runs without asking.
  lines.push("Allowed without asking:");
  const allows: string[] = [];
  for (const [tool, rules] of Object.entries(input.permissions ?? {})) {
    for (const [pattern, rule] of Object.entries(rules ?? {})) {
      if (rule === "allow") allows.push(`${tool}: ${JSON.stringify(pattern)}`);
    }
  }
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    allows.push(`MCP servers: ${Object.keys(input.mcpServers).join(", ")} (their tools follow the same rules)`);
  }
  if (allows.length === 0) lines.push("  - no allow rules; mutating tools follow the mode");
  else for (const a of allows) lines.push(`  - ${a}`);
  lines.push("  In auto mode everything else also runs without asking — except irreversible actions (dropped tables, force pushes, deleting untracked work, terraform destroy, …): those always stop and ask, and in headless and dl server sessions they are denied unless a rule names that exact action.");
  lines.push("");

  // 2. Reachable databases and cloud accounts.
  const db: Target[] = [];
  dbTargetsFrom(env, "env", db);
  const clouds: string[] = [];
  cloudFrom(env, "env", clouds);
  let envFiles: string[] = [];
  try {
    envFiles = readdirSync(input.cwd).filter((f) => f === ".env" || f.startsWith(".env."));
  } catch {
    /* unreadable directory */
  }
  for (const f of envFiles.sort()) {
    const vars = readEnvFile(join(input.cwd, f));
    dbTargetsFrom(vars, `${f}:`, db);
    cloudFrom(vars, f, clouds);
  }
  lines.push("Reachable from here (names and hosts only — values never read aloud):");
  if (db.length === 0 && clouds.length === 0) lines.push("  - no database URLs or cloud credentials found");
  for (const t of db) lines.push(`  - ${t.label} — via ${t.source}${t.production ? " — looks like PRODUCTION" : ""}`);
  for (const c of clouds) lines.push(`  - ${c} credentials in the environment`);
  lines.push("");

  // 3. Recovery.
  const git = gitSummary(input.cwd);
  const project = resolve(input.cwd);
  const points = listRecoveryPoints().filter((m) => m.project === project || m.project.endsWith(project) || project.endsWith(m.project));
  lines.push("If something goes wrong:");
  if (git.repo) {
    lines.push(`  - git repo on ${git.branch ?? "(detached HEAD)"}${git.dirty ? ` with ${git.dirty} uncommitted file${git.dirty === 1 ? "" : "s"}` : ", clean"}. Committed work is recoverable; uncommitted work relies on Autopilot's recovery points.`);
  } else {
    lines.push("  - not a git repo: nothing here is versioned — deleting or overwriting files can't be undone by git. Autopilot still keeps a copy before destructive file actions, for /undo.");
  }
  lines.push(points.length ? `  - ${points.length} recovery point${points.length === 1 ? "" : "s"} saved for this project; /undo restores the latest.` : "  - no recovery points yet; /undo has nothing to restore.");
  lines.push("  - database backups or point-in-time recovery can't be detected from here; before an approved destructive database action Autopilot says plainly when there is no automatic recovery.");
  lines.push("");

  // 4. Suggested rules.
  lines.push("Suggested rules (not applied — add them to config.json if you agree):");
  const suggestions: string[] = [];
  const broad = allows.filter((a) => /"\*+"|\*\*:/.test(a));
  if (broad.length > 0) {
    suggestions.push(`narrow the broad allow rule${broad.length === 1 ? "" : "s"} (${broad.join(", ")}) — broad allows never cover irreversible actions anyway;`);
  }
  if (db.some((t) => t.production)) {
    suggestions.push('consider a deny rule for the ORM/database commands you never run by hand, e.g. "bash": { "prisma migrate reset*": "deny", "rails db:reset*": "deny" }, so not even a mistaken Enter runs them;');
  }
  if (!git.repo) {
    suggestions.push("put this project under git so most file damage becomes recoverable;");
  }
  if (suggestions.length === 0) suggestions.push("nothing to change — the setup looks sane.");
  for (const s of suggestions) lines.push(`  - ${s}`);
  return lines.join("\n");
}
