import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface AsterWorkspace {
  id: string;
  displayName: string;
  rootPath: string;
}

export interface AsterServerConfig {
  /** Fixed model allowlist; empty when `modelCatalog` is "openrouter". */
  models: string[];
  /** "openrouter": every model in OpenRouter's live catalog is selectable. */
  modelCatalog: "fixed" | "openrouter";
  workspaces: AsterWorkspace[];
  approvalTtlMs: number;
}

export class AsterConfigError extends Error {
  constructor(message = "Aster server configuration is unavailable or invalid") {
    super(message);
    this.name = "AsterConfigError";
  }
}

const SYSTEM_ASTER_CONFIG_PATH = "/etc/autopilot/aster.json";

export function localAsterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return resolve(configHome, "autopilot", "aster.json");
}

export function resolveAsterServerConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredPath = env.AUTOPILOT_ASTER_CONFIG?.trim();
  if (configuredPath) return resolve(configuredPath);
  const userConfigPath = localAsterConfigPath(env);
  return existsSync(userConfigPath) ? userConfigPath : SYSTEM_ASTER_CONFIG_PATH;
}

export async function loadAsterServerConfig(
  configPath = resolveAsterServerConfigPath(),
): Promise<AsterServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch {
    throw new AsterConfigError();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AsterConfigError();
  const record = raw as Record<string, unknown>;
  const modelCatalog = record.models === "openrouter" ? "openrouter" : "fixed";
  if (modelCatalog === "fixed" && (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > 100)) {
    throw new AsterConfigError();
  }
  const models = modelCatalog === "fixed" ? [...new Set(record.models as unknown[])] : [];
  if (models.some((model) => typeof model !== "string" || !model.trim() || model.length > 200)) {
    throw new AsterConfigError();
  }
  if (!Array.isArray(record.workspaces) || record.workspaces.length === 0 || record.workspaces.length > 100) {
    throw new AsterConfigError();
  }

  const approvalTtlMs = record.approvalTtlMs ?? 5 * 60 * 1000;
  if (!Number.isInteger(approvalTtlMs) || (approvalTtlMs as number) < 1000 || (approvalTtlMs as number) > 60 * 60 * 1000) {
    throw new AsterConfigError();
  }
  const ids = new Set<string>();
  const roots: string[] = [];
  const workspaces: AsterWorkspace[] = [];
  for (const entry of record.workspaces) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new AsterConfigError();
    const workspace = entry as Record<string, unknown>;
    if (typeof workspace.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspace.id) || ids.has(workspace.id)) {
      throw new AsterConfigError();
    }
    if (typeof workspace.displayName !== "string" || !workspace.displayName.trim() || workspace.displayName.length > 100) {
      throw new AsterConfigError();
    }
    if (typeof workspace.rootPath !== "string" || !isAbsolute(workspace.rootPath)) throw new AsterConfigError();

    let rootPath: string;
    try {
      rootPath = await realpath(workspace.rootPath);
      if (!(await stat(rootPath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new AsterConfigError();
    }
    if (roots.some((root) => isWithin(root, rootPath) || isWithin(rootPath, root))) {
      throw new AsterConfigError();
    }
    ids.add(workspace.id);
    roots.push(rootPath);
    workspaces.push({ id: workspace.id, displayName: workspace.displayName.trim(), rootPath });
  }
  return { models: models as string[], modelCatalog, workspaces, approvalTtlMs: approvalTtlMs as number };
}

export function findAsterWorkspace(config: AsterServerConfig, workspaceId: string): AsterWorkspace | undefined {
  return config.workspaces.find((workspace) => workspace.id === workspaceId);
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
