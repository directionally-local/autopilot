/**
 * `autopilot connect`: what an installer that hands provider setup to
 * Autopilot gets back. The screens are the first-run ones (camouflage-view);
 * this module is the UI-free part: which providers a plain key gateway can
 * proxy, the JSON written to `--state-file`, and the exit codes.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openRouterBaseUrl } from "../models/openrouter.js";
import { requestyBaseUrl } from "../models/requesty.js";
import type { KimiConfig } from "../config.js";
import { getPreset, type ProviderId } from "./presets.js";
import { resolveActiveProvider, resolveProviderKey } from "./resolve.js";

/** `autopilot connect` exit codes: the contract installers build against. */
export const CONNECT_EXIT = {
  /** Provider and model saved (and the state file written when asked). */
  success: 0,
  /** The user backed out, or the connection never verified. Nothing was saved. */
  cancelled: 1,
  /** Bad flags, no terminal, or the renderer can't start. */
  usage: 2,
} as const;

/**
 * Providers a plain key gateway (one upstream URL, one key, one auth header)
 * cannot proxy: OAuth or device sign-ins, cloud SDK credentials, and
 * per-account URLs. Hidden when `--state-file` is given.
 */
export const HIDDEN_WITHOUT_GATEWAY: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "copilot",
  "chatgpt",
  "vertex",
  "bedrock",
  "azure",
  "cloudflare",
]);

/** The JSON `--state-file` holds. Field names and shapes are the contract; don't rename. */
export interface ConnectState {
  provider: ProviderId;
  /** Display name, e.g. "DeepSeek". */
  name: string;
  /** The effective upstream URL: the preset's, or the custom URL the user entered. */
  baseUrl: string;
  /** Null for keyless providers (Ollama, LM Studio) and a custom endpoint without a key. */
  apiKey: string | null;
  /** The first env var the provider reads its key from, when it has one. */
  apiKeyEnv: string | null;
  keyRequired: boolean;
  model: string;
  /** Which request header carries the key. */
  authHeader: "authorization" | "x-api-key" | "api-key";
  /** The header's value with `{key}` in the key's place. */
  authFormat: string;
}

/** What the setup screens saved: the provider, the credentials it was verified with, and the model. */
export interface ConnectResult {
  id: ProviderId;
  key?: string;
  /** The custom endpoint's URL, or a saved per-provider override. */
  baseUrl?: string;
  model: string;
}

/** The header a provider expects the key in; Anthropic's Messages API and Azure don't take a Bearer token. */
export function authHeaderFor(id: ProviderId): Pick<ConnectState, "authHeader" | "authFormat"> {
  if (id === "anthropic") return { authHeader: "x-api-key", authFormat: "{key}" };
  if (getPreset(id).authHeader === "api-key") return { authHeader: "api-key", authFormat: "{key}" };
  return { authHeader: "authorization", authFormat: "Bearer {key}" };
}

/**
 * The state file's contents for a finished setup. `cfg` is the config as
 * saved by that setup: it supplies the key and base URL when the screens
 * reused saved credentials instead of asking for them. Throws when the
 * provider has no reachable URL (a custom endpoint without one).
 */
export function buildConnectState(result: ConnectResult, cfg: Partial<KimiConfig> | null, env: NodeJS.ProcessEnv = process.env): ConnectState {
  const { id, model } = result;
  const preset = getPreset(id);
  let baseUrl: string | undefined;
  if (id === "openrouter") baseUrl = openRouterBaseUrl();
  else if (id === "requesty") baseUrl = requestyBaseUrl();
  else baseUrl = result.baseUrl ?? resolveActiveProvider({ ...(cfg ?? {}), provider: id }, env, id).baseUrl;
  if (!baseUrl) throw new Error(`${preset.name} has no base URL to connect to`);
  const key = result.key ?? resolveProviderKey(id, cfg, env);
  return {
    provider: id,
    name: preset.name,
    baseUrl,
    apiKey: key ?? null,
    apiKeyEnv: preset.apiKeyEnv[0] ?? null,
    keyRequired: preset.keyRequired,
    model,
    ...authHeaderFor(id),
  };
}

/** Write the state file, readable by its owner only; parent directories are created. */
export async function writeConnectState(path: string, state: ConnectState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  // writeFile's mode only applies to a file it creates; an existing one keeps its bits.
  await chmod(path, 0o600);
}
