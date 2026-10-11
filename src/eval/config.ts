/**
 * Harness configuration snapshot for an eval arm (plan §4.2): a partial
 * KimiConfig override plus an optional model. Every harness change gets its
 * own file under `evals/configs/` so the arms of a comparison are matched.
 */

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { KimiConfig } from "../config.js";

export interface EvalConfig {
  /** Arm name recorded in results; defaults to the file name. */
  name: string;
  /** Model id; `--model` on the command line wins. */
  model?: string;
  /** Partial KimiConfig merged over the user's config for every run. */
  config: Partial<KimiConfig>;
  /** Sampling temperature passed to every request. */
  temperature?: number;
}

export async function loadEvalConfig(file: string): Promise<EvalConfig> {
  const path = resolve(file);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  if (!raw || typeof raw !== "object") throw new Error(`${file}: config must be a JSON object`);
  const config = (raw.config ?? {}) as Partial<KimiConfig>;
  if (typeof config !== "object" || Array.isArray(config)) throw new Error(`${file}: "config" must be an object`);
  if (raw.model !== undefined && typeof raw.model !== "string") throw new Error(`${file}: "model" must be a string`);
  if (raw.temperature !== undefined && typeof raw.temperature !== "number") throw new Error(`${file}: "temperature" must be a number`);
  return {
    name: typeof raw.name === "string" && raw.name ? raw.name : basename(path).replace(/\.json$/, ""),
    ...(raw.model ? { model: raw.model as string } : {}),
    ...(raw.temperature !== undefined ? { temperature: raw.temperature as number } : {}),
    config,
  };
}
