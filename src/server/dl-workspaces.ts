import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getPreset, isProviderId, type ProviderId } from "../providers/presets.js";
import { configDir } from "../util/app-dirs.js";
import { serverEnv, warnDeprecated } from "./dl-compat.js";

export interface DlWorkspace {
  id: string;
  displayName: string;
  rootPath: string;
}

/**
 * The LLM provider every conversation cell talks to, through the Hotcell egress route of
 * the same name. Absent from server.json: OpenRouter, exactly as before the block existed.
 */
export interface DlProviderConfig {
  id: ProviderId;
  /** Display name from the preset ("DeepSeek"). */
  name: string;
  /**
   * OpenAI-compatible base URL the server lists models from (`GET {baseUrl}/models`) and
   * whose path the cell's gateway URL inherits. Undefined for OpenRouter and Requesty,
   * whose modules own their URLs.
   */
  baseUrl?: string;
  /** Env var holding the server's own key for the catalog call, and the cell's token env. */
  apiKeyEnv: string;
  /** False for local runtimes (Ollama, LM Studio) that take unauthenticated requests. */
  keyRequired: boolean;
  /** The preset's default chat model; the catalog fallback when the live list is unavailable. */
  defaultModel?: string;
}

export interface DlServerConfig {
  provider: DlProviderConfig;
  /** Fixed model allowlist; empty when `modelCatalog` is "catalog". */
  models: string[];
  /**
   * "catalog": the provider's live model list is selectable (OpenRouter's catalog, or
   * `GET {baseUrl}/models` for other providers). server.json spells it "catalog", or the
   * older "openrouter".
   */
  modelCatalog: "fixed" | "catalog";
  workspaces: DlWorkspace[];
  approvalTtlMs: number;
}

export class DlConfigError extends Error {
  constructor(message = "dl server configuration is unavailable or invalid") {
    super(message);
    this.name = "DlConfigError";
  }
}

const SYSTEM_SERVER_CONFIG_PATH = "/etc/autopilot/server.json";
const LEGACY_SYSTEM_ASTER_CONFIG_PATH = "/etc/autopilot/aster.json";

/** The machine-wide config files, read after the user's own. Tests pass their own. */
export interface DlSystemConfigPaths {
  server: string;
  legacyAster: string;
}
const SYSTEM_CONFIG_PATHS: DlSystemConfigPaths = {
  server: SYSTEM_SERVER_CONFIG_PATH,
  legacyAster: LEGACY_SYSTEM_ASTER_CONFIG_PATH,
};

export function localDlConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configDir(env), "server.json");
}

/** The pre-rename local config path, still read when no server.json exists. */
export function legacyLocalAsterConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(configDir(env), "aster.json");
}

export function resolveDlServerConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  system: DlSystemConfigPaths = SYSTEM_CONFIG_PATHS,
): string {
  const configuredPath = serverEnv(env, "CONFIG");
  if (configuredPath) return resolve(configuredPath);
  const userConfigPath = localDlConfigPath(env);
  if (existsSync(userConfigPath)) return userConfigPath;
  const legacyUserConfigPath = legacyLocalAsterConfigPath(env);
  if (existsSync(legacyUserConfigPath)) {
    warnDeprecated(
      "config:aster.json",
      `reading the pre-rename config at ${legacyUserConfigPath}; rename it to ${userConfigPath} when convenient.`,
    );
    return legacyUserConfigPath;
  }
  if (existsSync(system.server)) return system.server;
  if (existsSync(system.legacyAster)) {
    warnDeprecated(
      `config:${system.legacyAster}`,
      `reading the pre-rename config at ${system.legacyAster}; rename it to ${system.server} when convenient.`,
    );
    return system.legacyAster;
  }
  return system.server;
}

export async function loadDlServerConfig(
  configPath = resolveDlServerConfigPath(),
): Promise<DlServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch {
    throw new DlConfigError();
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DlConfigError();
  const record = raw as Record<string, unknown>;
  const provider = parseProvider(record.provider);
  const modelCatalog = record.models === "catalog" || record.models === "openrouter" ? "catalog" : "fixed";
  if (modelCatalog === "fixed" && (!Array.isArray(record.models) || record.models.length === 0 || record.models.length > 100)) {
    throw new DlConfigError();
  }
  const models = modelCatalog === "fixed" ? [...new Set(record.models as unknown[])] : [];
  if (models.some((model) => typeof model !== "string" || !model.trim() || model.length > 200)) {
    throw new DlConfigError();
  }
  if (!Array.isArray(record.workspaces) || record.workspaces.length === 0 || record.workspaces.length > 100) {
    throw new DlConfigError();
  }

  const approvalTtlMs = record.approvalTtlMs ?? 5 * 60 * 1000;
  if (!Number.isInteger(approvalTtlMs) || (approvalTtlMs as number) < 1000 || (approvalTtlMs as number) > 60 * 60 * 1000) {
    throw new DlConfigError();
  }
  const ids = new Set<string>();
  const roots: string[] = [];
  const workspaces: DlWorkspace[] = [];
  for (const entry of record.workspaces) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new DlConfigError();
    const workspace = entry as Record<string, unknown>;
    if (typeof workspace.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workspace.id) || ids.has(workspace.id)) {
      throw new DlConfigError();
    }
    if (typeof workspace.displayName !== "string" || !workspace.displayName.trim() || workspace.displayName.length > 100) {
      throw new DlConfigError();
    }
    if (typeof workspace.rootPath !== "string" || !isAbsolute(workspace.rootPath)) throw new DlConfigError();

    let rootPath: string;
    try {
      rootPath = await realpath(workspace.rootPath);
      if (!(await stat(rootPath)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new DlConfigError();
    }
    if (roots.some((root) => isWithin(root, rootPath) || isWithin(rootPath, root))) {
      throw new DlConfigError();
    }
    ids.add(workspace.id);
    roots.push(rootPath);
    workspaces.push({ id: workspace.id, displayName: workspace.displayName.trim(), rootPath });
  }
  return { provider, models: models as string[], modelCatalog, workspaces, approvalTtlMs: approvalTtlMs as number };
}

/** The provider block, or OpenRouter when server.json has none. */
export function parseProvider(value: unknown): DlProviderConfig {
  if (value === undefined) return providerConfig("openrouter");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DlConfigError("server.json: provider must be an object");
  const record = value as Record<string, unknown>;
  if (!isProviderId(record.id)) throw new DlConfigError(`server.json: provider.id must be one of Autopilot's provider ids (received ${JSON.stringify(record.id)})`);
  const baseUrl = optionalString(record.baseUrl, "provider.baseUrl");
  const apiKeyEnv = optionalString(record.apiKeyEnv, "provider.apiKeyEnv");
  if (apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new DlConfigError("server.json: provider.apiKeyEnv must be an environment variable name");
  return providerConfig(record.id, baseUrl, apiKeyEnv);
}

export function providerConfig(id: ProviderId, baseUrl?: string, apiKeyEnv?: string): DlProviderConfig {
  const preset = getPreset(id);
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl ?? preset.baseUrl);
  if (resolvedBaseUrl === undefined && id !== "openrouter" && id !== "requesty") {
    throw new DlConfigError(`server.json: provider ${id} needs provider.baseUrl`);
  }
  const resolvedKeyEnv = apiKeyEnv ?? preset.apiKeyEnv[0];
  if (!resolvedKeyEnv) throw new DlConfigError(`server.json: provider ${id} needs provider.apiKeyEnv`);
  return {
    id,
    name: preset.name,
    ...(resolvedBaseUrl !== undefined ? { baseUrl: resolvedBaseUrl } : {}),
    apiKeyEnv: resolvedKeyEnv,
    keyRequired: preset.keyRequired,
    ...(preset.defaultModel ? { defaultModel: preset.defaultModel } : {}),
  };
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new DlConfigError(`server.json: ${field} must be a non-empty string`);
  return value.trim();
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DlConfigError(`server.json: provider.baseUrl is not a valid URL (${value})`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new DlConfigError("server.json: provider.baseUrl must be http(s)");
  return value.replace(/\/+$/, "");
}

export function findDlWorkspace(config: DlServerConfig, workspaceId: string): DlWorkspace | undefined {
  return config.workspaces.find((workspace) => workspace.id === workspaceId);
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
