import { loadConfig, saveConfig, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, type AutopilotConfig, type KimiConfig } from "../config.js";
import { isProviderUsable, resolveActiveProvider } from "../providers/resolve.js";
import type { CreateSessionOptions } from "./types.js";

export { loadConfig, saveConfig, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT };
export type { AutopilotConfig };
/** @deprecated Use {@link AutopilotConfig} (#911). */
export type { KimiConfig };

export async function resolveSdkConfig(opts: CreateSessionOptions): Promise<AutopilotConfig> {
  const loaded = await loadConfig();
  const merged: AutopilotConfig = {
    model: DEFAULT_MODEL,
    ...loaded,
    ...opts.config,
  };

  // The active provider (config.provider / AUTOPILOT_PROVIDER, else inferred
  // from the credentials present) must be able to take requests.
  const active = resolveActiveProvider(merged);
  if (!isProviderUsable(active)) {
    const envs = active.preset.apiKeyEnv.join(" or ");
    throw new Error(
      `autopilot SDK: missing credentials for ${active.preset.name}. ` +
        (active.id === "custom"
          ? "Set AUTOPILOT_BASE_URL (+ AUTOPILOT_API_KEY) for a custom OpenAI-compatible endpoint."
          : `Set ${envs}, or config.providers.${active.id}.apiKey (OpenRouter: config.openrouterApiKey).`),
    );
  }

  return merged;
}
