/**
 * Secret scrubbing for tool results on their way to the model.
 *
 * Pattern masking lives in {@link scrubSecrets}; this module adds the exact
 * values Autopilot itself holds at runtime (the active provider keys, keys in
 * the environment, and the dl key in ~/.config/directionallylocal). File I/O
 * happens once per process, so a tool call never pays for it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { scrubSecrets } from "../secrets.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";

/** The credential fields of an LlmAuth, structurally (no import cycle). */
export interface RuntimeCredentials {
  openrouterApiKey?: string;
  requestyApiKey?: string;
  customEndpoint?: { apiKey?: string };
}

const ENV_KEY_NAMES = [
  ...new Set([
    ...Object.values(PROVIDER_PRESETS).flatMap((preset) => preset.apiKeyEnv),
    "AUTOPILOT_DL_FREE_TOKEN",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ]),
];

const DL_CONFIG_DIR = join(homedir(), ".config", "directionallylocal");
const MIN_EXACT_LENGTH = 6;
const MIN_SCRUB_LENGTH = 8;
const SECRETISH_KEY_RE = /(?:key|token|secret|credential|auth|password)/i;
const SECRET_SHAPE_RE = /^(?:dlk_|dl_ak_|dl_sk_|sk-|gh[pousr]_|github_pat_|AKIA)/;

let cachedFileSecrets: string[] | undefined;

function collectStrings(value: unknown, out: string[], force: boolean): void {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= MIN_EXACT_LENGTH && (force || SECRET_SHAPE_RE.test(trimmed))) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out, force);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(nested, out, force || SECRETISH_KEY_RE.test(key));
    }
  }
}

function loadFileSecrets(): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(DL_CONFIG_DIR).filter((name) => name.endsWith(".json"));
  } catch {
    // No dl config directory: nothing to add.
  }
  for (const name of names) {
    let raw: string;
    try {
      raw = readFileSync(join(DL_CONFIG_DIR, name), "utf8");
    } catch {
      continue;
    }
    const force = SECRETISH_KEY_RE.test(name);
    try {
      collectStrings(JSON.parse(raw), out, force);
    } catch {
      const trimmed = raw.trim();
      if (force && trimmed.length >= MIN_EXACT_LENGTH) out.push(trimmed);
    }
  }
  const tokenFile = process.env.AUTOPILOT_DL_FREE_TOKEN_FILE?.trim();
  if (tokenFile) {
    try {
      const token = readFileSync(tokenFile, "utf8").trim();
      if (token.length >= MIN_EXACT_LENGTH) out.push(token);
    } catch {
      // The key file may not exist yet; the environment value covers it.
    }
  }
  return [...new Set(out)];
}

function fileSecrets(): string[] {
  cachedFileSecrets ??= loadFileSecrets();
  return cachedFileSecrets;
}

function envSecrets(): string[] {
  const out: string[] = [];
  for (const name of ENV_KEY_NAMES) {
    const value = process.env[name]?.trim();
    if (value && value.length >= MIN_EXACT_LENGTH) out.push(value);
  }
  return out;
}

/** The provider keys an LlmAuth carries, for exact-match masking. */
export function runtimeSecretsFromAuth(auth: RuntimeCredentials | null | undefined): string[] {
  if (!auth) return [];
  const values = [auth.openrouterApiKey, auth.requestyApiKey, auth.customEndpoint?.apiKey];
  return values.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

/**
 * Mask secrets in a tool result before the model sees it. Short results skip
 * the work; the pattern pass and the exact runtime values are both applied.
 */
export function scrubToolResultSecrets(
  text: string,
  extraValues: Iterable<string | null | undefined> = [],
): string {
  if (!text || text.length < MIN_SCRUB_LENGTH) return text;
  const exactValues: Array<string | null | undefined> = [...envSecrets(), ...fileSecrets()];
  for (const value of extraValues) exactValues.push(value);
  return scrubSecrets(text, { exactValues });
}

/** @internal Test hook: forget the cached dl key-file contents. */
export function resetRuntimeSecretCache(): void {
  cachedFileSecrets = undefined;
}
