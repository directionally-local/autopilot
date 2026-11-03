/**
 * Instruction files from other coding agents, read in place every session
 * (#1126). Nothing is copied: an edit to CLAUDE.md applies on the next
 * session, and the files only ever reach the model the user already uses,
 * as ordinary context.
 *
 * Precedence, highest first (a file listed earlier wins a conflict):
 *   1. AGENTS.md in the working directory (Autopilot's own; legacy KIMI.md,
 *      KIMIFLARE.md, AGENT.md when it is absent)
 *   2. CLAUDE.local.md, from the working directory up to the project root
 *   3. CLAUDE.md and .claude/CLAUDE.md, from the working directory up to the root
 *   4. GEMINI.md, from the working directory up to the root
 *   5. .cursor/rules/*.mdc|*.md, then .cursorrules (project root)
 *   6. .github/copilot-instructions.md (project root)
 *   7. ~/.claude/CLAUDE.md (personal, all projects)
 *
 * The same file under two names (AGENTS.md symlinked to CLAUDE.md, or two
 * identical copies) is read once, under its highest-precedence name.
 *
 * `@path` imports in CLAUDE.md, CLAUDE.local.md and GEMINI.md are followed
 * two levels deep (a file and the files it imports may import), relative to
 * the importing file, within the size caps below. Secret-looking files
 * (.env, keys, ~/.ssh, …) are never imported.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseFrontmatter } from "../commands/frontmatter.js";
import { dirsUpTo, homeOf, isDir, projectRootOf, setupImportEnabled, type ImportEnv } from "./paths.js";

export type InstructionAgent = "autopilot" | "claude" | "gemini" | "cursor" | "copilot";

export interface InstructionFile {
  agent: InstructionAgent;
  /** How the file is named to the user and the model, e.g. `CLAUDE.md`, `~/.claude/CLAUDE.md`. */
  label: string;
  path: string;
  scope: "project" | "personal";
  /** The text the model sees: the file, then its imports. */
  content: string;
  lineCount: number;
  /** Other names that were the same file (or identical text) and were skipped. */
  also: string[];
  /** Files pulled in by `@path` imports, as shown to the model. */
  imports: string[];
  /** For a Cursor rule: when it applies. */
  note?: string;
  truncated?: boolean;
}

/** AGENTS.md keeps its existing limit: a larger file is skipped, as before. */
export const MAX_AGENTS_BYTES = 20 * 1024;
/** Any other single file (or import) is cut at this size. */
export const MAX_FILE_BYTES = 20 * 1024;
/** All instruction text from other agents together, imports included. */
export const MAX_TOTAL_BYTES = 64 * 1024;
/** `@path` imports are followed this many levels deep. */
export const MAX_IMPORT_DEPTH = 2;

const AUTOPILOT_NAMES = ["AGENTS.md", "KIMI.md", "KIMIFLARE.md", "AGENT.md"];

interface Candidate {
  agent: InstructionAgent;
  label: string;
  path: string;
  scope: "project" | "personal";
  imports: boolean;
  note?: string;
  /** Text to use instead of the file's own (Cursor rules drop their frontmatter). */
  body?: (raw: string) => string;
}

function realOf(path: string): string | null {
  try {
    const s = statSync(path);
    if (!s.isFile()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readCapped(path: string, cap: number): { text: string; truncated: boolean } | null {
  try {
    const buf = readFileSync(path);
    if (buf.length <= cap) return { text: buf.toString("utf8"), truncated: false };
    return { text: buf.subarray(0, cap).toString("utf8").replace(/�$/, ""), truncated: true };
  } catch {
    return null;
  }
}

function sha(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n").trim()).digest("hex");
}

function labelFor(path: string, root: string, home: string): string {
  const rel = relative(root, path);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  const fromHome = relative(home, path);
  if (fromHome && !fromHome.startsWith("..") && !isAbsolute(fromHome)) return `~/${fromHome.split(sep).join("/")}`;
  return path;
}

function cursorRuleNote(data: Record<string, string>): string {
  if (/^true$/i.test(data.alwaysApply ?? "")) return "always applies";
  const globs = (data.globs ?? "").trim();
  if (globs) return `applies when working on ${globs}`;
  const desc = (data.description ?? "").trim();
  if (desc) return `use when relevant: ${desc}`;
  return "always applies";
}

function candidates(cwd: string, root: string, home: string): Candidate[] {
  const out: Candidate[] = [];
  const up = dirsUpTo(cwd, root);
  for (const name of AUTOPILOT_NAMES) {
    const path = join(cwd, name);
    try {
      const s = statSync(path);
      if (!s.isFile() || s.size > MAX_AGENTS_BYTES) continue;
    } catch {
      continue;
    }
    out.push({ agent: "autopilot", label: name, path, scope: "project", imports: false });
    break;
  }
  for (const dir of up) {
    out.push({ agent: "claude", label: labelFor(join(dir, "CLAUDE.local.md"), root, home), path: join(dir, "CLAUDE.local.md"), scope: "personal", imports: true });
  }
  for (const dir of up) {
    out.push({ agent: "claude", label: labelFor(join(dir, "CLAUDE.md"), root, home), path: join(dir, "CLAUDE.md"), scope: "project", imports: true });
    // In the home folder, .claude/CLAUDE.md is the personal file (added last).
    if (resolve(dir) !== resolve(home)) {
      out.push({ agent: "claude", label: labelFor(join(dir, ".claude", "CLAUDE.md"), root, home), path: join(dir, ".claude", "CLAUDE.md"), scope: "project", imports: true });
    }
  }
  for (const dir of up) {
    out.push({ agent: "gemini", label: labelFor(join(dir, "GEMINI.md"), root, home), path: join(dir, "GEMINI.md"), scope: "project", imports: true });
  }
  const rulesDir = join(root, ".cursor", "rules");
  if (isDir(rulesDir)) {
    let names: string[] = [];
    try {
      names = readdirSync(rulesDir).filter((n) => extname(n) === ".mdc" || extname(n) === ".md").sort();
    } catch {
      names = [];
    }
    for (const n of names) {
      const path = join(rulesDir, n);
      let note: string | undefined;
      try {
        const head = readFileSync(path, "utf8").slice(0, 4096);
        note = cursorRuleNote(parseFrontmatter(head).data);
      } catch {
        note = undefined;
      }
      out.push({
        agent: "cursor",
        label: labelFor(path, root, home),
        path,
        scope: "project",
        imports: false,
        ...(note ? { note } : {}),
        body: (raw) => parseFrontmatter(raw).body,
      });
    }
  }
  out.push({ agent: "cursor", label: ".cursorrules", path: join(root, ".cursorrules"), scope: "project", imports: false });
  out.push({ agent: "copilot", label: ".github/copilot-instructions.md", path: join(root, ".github", "copilot-instructions.md"), scope: "project", imports: false });
  out.push({ agent: "claude", label: "~/.claude/CLAUDE.md", path: join(home, ".claude", "CLAUDE.md"), scope: "personal", imports: true });
  return out;
}

// ── @path imports ─────────────────────────────────────────────────────────

const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\.json)?|.*\.(pem|key|p12|pfx|kdbx))$/i;
const SECRET_DIR = /(^|[\\/])(\.ssh|\.aws|\.gnupg|\.docker|\.kube|\.config[\\/]gh)([\\/]|$)/;

export function isSecretPath(path: string): boolean {
  return SECRET_NAME.test(basename(path)) || SECRET_DIR.test(path);
}

/** The `@path` references in markdown, outside code fences and inline code. */
export function findImports(markdown: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const plain = line.replace(/`[^`]*`/g, " ");
    for (const m of plain.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s@`'"<>()[\]]+)/g)) {
      const ref = m[1]!.replace(/[.,;:!?]+$/, "");
      // A path, not a mention: it has a slash or a file extension.
      if (!ref.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(ref)) continue;
      out.push(ref);
    }
  }
  return out;
}

interface Budget {
  left: number;
}

function expandImports(
  text: string,
  fromFile: string,
  home: string,
  depth: number,
  seen: Set<string>,
  budget: Budget,
  shown: (path: string) => string,
  imported: string[],
): string {
  if (depth >= MAX_IMPORT_DEPTH) return "";
  let appended = "";
  for (const ref of findImports(text)) {
    const target = ref.startsWith("~/") ? join(home, ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(fromFile), ref);
    if (isSecretPath(target)) continue;
    const real = realOf(target);
    if (!real || seen.has(real) || isSecretPath(real)) continue;
    if (budget.left <= 0) break;
    seen.add(real);
    const read = readCapped(real, Math.min(MAX_FILE_BYTES, budget.left));
    if (!read) continue;
    budget.left -= Buffer.byteLength(read.text);
    const name = shown(target);
    imported.push(name);
    appended += `\n\n--- imported from ${shown(fromFile)}: ${name} ---\n${read.text.trim()}${read.truncated ? "\n[… cut: file too large]" : ""}`;
    appended += expandImports(read.text, real, home, depth + 1, seen, budget, shown, imported);
  }
  return appended;
}

// ── Loading ───────────────────────────────────────────────────────────────

/** The instruction files for `cwd`, highest precedence first, deduplicated. */
export function loadInstructions(cwd: string, env?: ImportEnv): InstructionFile[] {
  const home = homeOf(env);
  const root = projectRootOf(cwd);
  const files: InstructionFile[] = [];
  const byReal = new Map<string, InstructionFile>();
  const byHash = new Map<string, InstructionFile>();
  const budget: Budget = { left: MAX_TOTAL_BYTES };
  const importsOn = setupImportEnabled();

  /** AGENTS.md that is also CLAUDE.md: the CLAUDE.md `@imports` apply to it. */
  const followed = new Set<InstructionFile>();
  const followAliasImports = (file: InstructionFile, alias: Candidate, real: string) => {
    if (!alias.imports || file.imports.length > 0 || followed.has(file)) return;
    followed.add(file);
    const imported: string[] = [];
    const extra = expandImports(file.content, alias.path, home, 0, new Set([real]), budget, (p) => labelFor(p, root, home), imported);
    if (!extra) return;
    file.content += extra;
    file.imports.push(...imported);
    file.lineCount = file.content.split("\n").length;
  };

  for (const c of candidates(cwd, root, home)) {
    if (c.agent !== "autopilot" && !importsOn) continue;
    const real = realOf(c.path);
    if (!real) continue;
    const dupe = byReal.get(real);
    if (dupe) {
      if (!dupe.also.includes(c.label)) dupe.also.push(c.label);
      followAliasImports(dupe, c, real);
      continue;
    }
    const cap = c.agent === "autopilot" ? MAX_AGENTS_BYTES : Math.min(MAX_FILE_BYTES, budget.left);
    if (cap <= 0) continue;
    const read = readCapped(real, cap);
    if (!read) continue;
    const raw = read.text;
    const hash = sha(raw);
    const same = byHash.get(hash);
    if (same) {
      byReal.set(real, same);
      if (!same.also.includes(c.label)) same.also.push(c.label);
      followAliasImports(same, c, real);
      continue;
    }
    const body = c.body ? c.body(raw) : raw;
    if (!body.trim()) continue;
    if (c.agent !== "autopilot") budget.left -= Buffer.byteLength(body);
    const imported: string[] = [];
    const extra = c.imports
      ? expandImports(raw, c.path, home, 0, new Set([real]), budget, (p) => labelFor(p, root, home), imported)
      : "";
    const content = body.trim() + (read.truncated ? "\n[… cut: file too large]" : "") + extra;
    const file: InstructionFile = {
      agent: c.agent,
      label: c.label,
      path: c.path,
      scope: c.scope,
      content,
      lineCount: (c.agent === "autopilot" ? raw : content).split("\n").length,
      also: [],
      imports: imported,
      ...(c.note ? { note: c.note } : {}),
      ...(read.truncated ? { truncated: true } : {}),
    };
    files.push(file);
    byReal.set(real, file);
    byHash.set(hash, file);
  }
  return files;
}

const AGENT_NAMES: Record<InstructionAgent, string> = {
  autopilot: "Autopilot",
  claude: "Claude Code",
  gemini: "Gemini CLI",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
};

function heading(f: InstructionFile): string {
  const also = f.also.length > 0 ? `, same file as ${f.also.join(", ")}` : "";
  const scope = f.agent === "claude" && f.scope === "personal" ? (f.label.startsWith("~/") ? ", personal for all projects" : ", personal for this project") : "";
  const note = f.note ? `, ${f.note}` : "";
  return `--- ${f.label} (${AGENT_NAMES[f.agent]}${scope}${also}${note}) ---`;
}

/**
 * The project-context part of the system prompt. With only AGENTS.md (or
 * nothing from other agents) it is exactly what it was before #1126.
 */
export function buildInstructionsBlock(cwd: string, env?: ImportEnv): string {
  return formatInstructions(loadInstructions(cwd, env));
}

export function formatInstructions(files: InstructionFile[]): string {
  if (files.length === 0) return "";
  const [first, ...rest] = files;
  const primary = first!.agent === "autopilot" ? first! : null;
  const others = primary ? rest : files;
  let out = "";
  if (primary) {
    const also = primary.also.length > 0 ? `, same file as ${primary.also.join(", ")}` : "";
    out += `\n\nProject context from ${primary.label} (${primary.lineCount} lines${also}, treat as authoritative):\n${primary.content.trim()}`;
  }
  if (others.length > 0) {
    const intro = primary
      ? `Instructions from the user's other coding agents, read in place from their files on this computer. Follow them as project instructions. Where they conflict, ${primary.label} above wins, then the file listed first.`
      : "Project instructions from the user's coding agents, read in place from their files on this computer. Treat them as authoritative. Where they conflict, the file listed first wins.";
    out += `\n\n${intro}`;
    for (const f of others) out += `\n\n${heading(f)}\n${f.content.trim()}`;
  }
  return out;
}

/** Names of other agents' instruction files in use, for the one-line notice. */
export function otherAgentFileNames(files: InstructionFile[]): string[] {
  const names: string[] = [];
  const add = (n: string) => {
    if (!names.includes(n)) names.push(n);
  };
  for (const f of files) {
    for (const label of [f.label, ...f.also]) {
      const base = label.split("/").pop() ?? label;
      if (base === "CLAUDE.md" || base === "CLAUDE.local.md") add(base === "CLAUDE.md" ? "CLAUDE.md" : "CLAUDE.local.md");
      else if (base === "GEMINI.md") add("GEMINI.md");
      else if (label.startsWith(".cursor/rules")) add(".cursor/rules");
      else if (label === ".cursorrules") add(".cursorrules");
      else if (label === ".github/copilot-instructions.md") add(".github/copilot-instructions.md");
    }
  }
  return names;
}
