import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getPreset, isProviderId, type ProviderId } from "../providers/presets.js";

export interface AsterWorkspace {
  id: string;
  displayName: string;
  rootPath: string;
}

/**
 * The LLM provider every conversation cell talks to, through the Hotcell egress route of
 * the same name. Absent from aster.json: OpenRouter, exactly as before the block existed.
 */
export interface AsterProviderConfig {
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

export interface AsterServerConfig {
  provider: AsterProviderConfig;
  /** Fixed model allowlist; empty when `modelCatalog` is "catalog". */
  models: string[];
  /**
   * "catalog": the provider's live model list is selectable (OpenRouter's catalog, or
   * `GET {baseUrl}/models` for other providers). aster.json spells it "catalog", or the
   * older "openrouter".
   */
  modelCatalog: "fixed" | "catalog";
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
  const provider = parseProvider(record.provider);
  const modelCatalog = record.models === "catalog" || record.models === "openrouter" ? "catalog" : "fixed";
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
  return { provider, models: models as string[], modelCatalog, workspaces, approvalTtlMs: approvalTtlMs as number };
}

/** The provider block, or OpenRouter when aster.json has none. */
export function parseProvider(value: unknown): AsterProviderConfig {
  if (value === undefined) return providerConfig("openrouter");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AsterConfigError("aster.json: provider must be an object");
  const record = value as Record<string, unknown>;
  if (!isProviderId(record.id)) throw new AsterConfigError(`aster.json: provider.id must be one of Autopilot's provider ids (received ${JSON.stringify(record.id)})`);
  const baseUrl = optionalString(record.baseUrl, "provider.baseUrl");
  const apiKeyEnv = optionalString(record.apiKeyEnv, "provider.apiKeyEnv");
  if (apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(apiKeyEnv)) throw new AsterConfigError("aster.json: provider.apiKeyEnv must be an environment variable name");
  return providerConfig(record.id, baseUrl, apiKeyEnv);
}

export function providerConfig(id: ProviderId, baseUrl?: string, apiKeyEnv?: string): AsterProviderConfig {
  const preset = getPreset(id);
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl ?? preset.baseUrl);
  if (resolvedBaseUrl === undefined && id !== "openrouter" && id !== "requesty") {
    throw new AsterConfigError(`aster.json: provider ${id} needs provider.baseUrl`);
  }
  const resolvedKeyEnv = apiKeyEnv ?? preset.apiKeyEnv[0];
  if (!resolvedKeyEnv) throw new AsterConfigError(`aster.json: provider ${id} needs provider.apiKeyEnv`);
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
  if (typeof value !== "string" || !value.trim() || value.length > 500) throw new AsterConfigError(`aster.json: ${field} must be a non-empty string`);
  return value.trim();
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AsterConfigError(`aster.json: provider.baseUrl is not a valid URL (${value})`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AsterConfigError("aster.json: provider.baseUrl must be http(s)");
  return value.replace(/\/+$/, "");
}

export function findAsterWorkspace(config: AsterServerConfig, workspaceId: string): AsterWorkspace | undefined {
  return config.workspaces.find((workspace) => workspace.id === workspaceId);
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
