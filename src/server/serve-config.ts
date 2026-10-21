import { DEFAULT_MODEL, type KimiConfig } from "../config.js";

/**
 * The config `autopilot serve` runs with. Without provider credentials it still serves
 * when it fronts Hotcell cells (AUTOPILOT_HOTCELL_ENDPOINT): cells reach the model
 * through Hotcell's credential gateway, so the host needs no provider key of its own.
 * Only the legacy local routes and Aster memory, which call the model from the host,
 * stay unavailable. Returns undefined when serving makes no sense.
 */
export function resolveServeConfig(
  cfg: KimiConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): { config: KimiConfig; asterOnly: boolean } | undefined {
  if (cfg) return { config: cfg, asterOnly: false };
  if (!env.AUTOPILOT_HOTCELL_ENDPOINT?.trim()) return undefined;
  return { config: { model: DEFAULT_MODEL } as KimiConfig, asterOnly: true };
}
