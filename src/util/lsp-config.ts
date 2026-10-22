import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import type { KimiConfig, LspServerConfig } from "../config.js";
import { isProjectFileTrusted, readProjectFile, trustProjectFiles } from "./project-trust.js";

const PROJECT_CONFIG_DIR = ".kimiflare";
const PROJECT_LSP_FILE = "lsp.json";

export interface ResolvedLspConfig {
  lspEnabled: boolean;
  lspServers: Record<string, LspServerConfig>;
  scope: "project" | "global";
  projectPath: string | null;
  /** A project lsp.json that exists but was ignored because its content is
   *  not trusted (see src/util/project-trust.ts). */
  untrustedProjectPath: string | null;
}

function isGitRoot(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Walk up from cwd looking for .kimiflare/lsp.json.
 * Stops at git root or filesystem root.
 */
export function findProjectLspConfigPath(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = join(current, PROJECT_CONFIG_DIR, PROJECT_LSP_FILE);
    if (existsSync(candidate)) {
      return candidate;
    }
    if (isGitRoot(current)) {
      return null;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * The project's lsp.json, or null when there is none or its content is not
 * trusted. The file names commands that are spawned at startup, so a
 * repository's copy is only honoured once the user has trusted it.
 */
export async function loadProjectLspConfig(cwd: string): Promise<Partial<Pick<KimiConfig, "lspEnabled" | "lspServers">> | null> {
  const path = findProjectLspConfigPath(cwd);
  if (!path) return null;
  const read = readProjectFile(path);
  if (!read?.trusted) return null;
  try {
    const parsed = JSON.parse(read.content) as Partial<KimiConfig>;
    return {
      lspEnabled: parsed.lspEnabled,
      lspServers: parsed.lspServers,
    };
  } catch {
    return null;
  }
}

async function ensureGitignore(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");
  const entry = `${PROJECT_CONFIG_DIR}/${PROJECT_LSP_FILE}`;
  try {
    const content = await readFile(gitignorePath, "utf8");
    if (content.includes(entry)) return;
    await writeFile(gitignorePath, content.trimEnd() + "\n" + entry + "\n", "utf8");
  } catch {
    // No .gitignore or can't read it — ignore
  }
}

export async function saveProjectLspConfig(
  cwd: string,
  cfg: Partial<Pick<KimiConfig, "lspEnabled" | "lspServers">>,
): Promise<string> {
  const dir = join(cwd, PROJECT_CONFIG_DIR);
  await mkdir(dir, { recursive: true });
  const path = join(dir, PROJECT_LSP_FILE);
  await writeFile(path, JSON.stringify(cfg, null, 2), "utf8");
  // Written from the user's own choices in /lsp config, so it is trusted.
  trustProjectFiles([path]);
  await ensureGitignore(cwd);
  return path;
}

/**
 * Merge project LSP config over global config.
 * Project config wins entirely for lspEnabled and lspServers.
 * If project config exists but has no lspEnabled key, fall back to global.
 * If project config is empty {}, treat as explicitly disabled.
 */
export async function resolveLspConfig(
  globalCfg: KimiConfig,
  cwd: string,
): Promise<ResolvedLspConfig> {
  const project = await loadProjectLspConfig(cwd);
  const projectPath = findProjectLspConfigPath(cwd);

  if (!project) {
    return {
      lspEnabled: globalCfg.lspEnabled ?? false,
      lspServers: globalCfg.lspServers ?? {},
      scope: "global",
      projectPath: null,
      untrustedProjectPath: projectPath && !isProjectFileTrusted(projectPath) ? projectPath : null,
    };
  }

  // If project config exists but has no lspEnabled key, fall back to global
  const enabled = project.lspEnabled !== undefined ? project.lspEnabled : (globalCfg.lspEnabled ?? false);

  // If project config has lspServers, use them; otherwise fall back to global
  const servers = project.lspServers !== undefined ? project.lspServers : (globalCfg.lspServers ?? {});

  return {
    lspEnabled: enabled,
    lspServers: servers,
    scope: "project",
    projectPath,
    untrustedProjectPath: null,
  };
}
