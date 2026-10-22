/**
 * What an untrusted project would run, shown to the user before they trust
 * it, plus the startup notice and the trust action shared by `/trust` and
 * `autopilot trust`. See src/util/project-trust.ts for the trust model.
 */
import { hookSettingsLocations } from "../hooks/settings.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import { findProjectLspConfigPath } from "./lsp-config.js";
import { readProjectFile, trustProjectFiles, TRUST_PROJECT_ENV } from "./project-trust.js";

export interface PendingProjectFile {
  path: string;
  kind: "hooks" | "lsp";
  /** Human-readable lines naming what the file would run. */
  commands: string[];
}

function parseObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // invalid JSON never loads, so there is nothing to trust
  }
}

function hookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: string[] = [];
  for (const ev of HOOK_EVENTS) {
    const list = (hooks as Record<string, unknown>)[ev];
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const command = h && typeof h === "object" ? (h as Record<string, unknown>).command : undefined;
      if (typeof command === "string" && command.trim()) out.push(`${ev} hook: ${command}`);
    }
  }
  return out;
}

function lspCommands(settings: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof settings.lspEnabled === "boolean") out.push(`lspEnabled: ${settings.lspEnabled}`);
  const servers = settings.lspServers;
  if (servers && typeof servers === "object") {
    for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
      const command = server && typeof server === "object" ? (server as Record<string, unknown>).command : undefined;
      const text = Array.isArray(command) ? command.map(String).join(" ") : String(command ?? "");
      out.push(`LSP server ${name}: ${text}`);
    }
  }
  return out;
}

/** Project files that exist, would run something, and are not trusted. */
export function pendingProjectConfig(cwd: string): PendingProjectFile[] {
  const out: PendingProjectFile[] = [];
  for (const loc of hookSettingsLocations(cwd)) {
    if (loc.scope !== "project") continue;
    const read = readProjectFile(loc.path);
    if (!read || read.trusted) continue;
    const settings = parseObject(read.content);
    const commands = settings ? hookCommands(settings) : [];
    if (commands.length > 0) out.push({ path: loc.path, kind: "hooks", commands });
  }
  const lspPath = findProjectLspConfigPath(cwd);
  if (lspPath) {
    const read = readProjectFile(lspPath);
    if (read && !read.trusted) {
      const settings = parseObject(read.content);
      const commands = settings ? lspCommands(settings) : [];
      if (commands.length > 0) out.push({ path: lspPath, kind: "lsp", commands });
    }
  }
  return out;
}

/** Startup notice when this project has settings that were not loaded. */
export function projectTrustNoticeText(pending: readonly PendingProjectFile[]): string | null {
  if (pending.length === 0) return null;
  const files = pending.map((p) => `  ${p.path} (${p.kind === "hooks" ? "hooks" : "LSP servers"})`).join("\n");
  return (
    `This project has settings that run commands, and they were not loaded because you have not trusted them:\n${files}\n` +
    `Review them with /trust (or \`autopilot trust\` in this directory). For CI, set ${TRUST_PROJECT_ENV}=1.`
  );
}

/** The review shown before trusting: every file and what it would run. */
export function formatPendingReview(pending: readonly PendingProjectFile[]): string {
  return pending.map((p) => [p.path, ...p.commands.map((c) => `  ${c}`)].join("\n")).join("\n");
}

/** Trust every pending file's current content. Returns what was trusted. */
export function trustPendingProjectConfig(cwd: string): PendingProjectFile[] {
  const pending = pendingProjectConfig(cwd);
  trustProjectFiles(pending.map((p) => p.path));
  return pending;
}
