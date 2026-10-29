/**
 * Autopilot environment variables (#911).
 *
 * Every setting variable is read as `AUTOPILOT_<NAME>` first and falls back to
 * the legacy `KIMIFLARE_<NAME>` spelling from before the rename, so existing
 * shells, CI configs and host apps keep working. Callers pass the suffix only:
 *
 *   readEnv("TRACE")  // process.env.AUTOPILOT_TRACE ?? process.env.KIMIFLARE_TRACE
 *
 * The new name wins whenever it is set, even to an empty string — the value is
 * then interpreted by the call site exactly as a legacy value would have been,
 * so "empty means unset" (or not) stays a per-variable decision.
 *
 * When Autopilot itself hands variables to a child process (hooks, workers),
 * use `withEnvAliases` so the child sees both spellings.
 */

export const ENV_PREFIX = "AUTOPILOT_";
export const LEGACY_ENV_PREFIX = "KIMIFLARE_";

type EnvLike = Readonly<Record<string, string | undefined>>;

/** `[AUTOPILOT_<suffix>, KIMIFLARE_<suffix>]`, preferred name first. */
export function envNames(suffix: string): [current: string, legacy: string] {
  return [ENV_PREFIX + suffix, LEGACY_ENV_PREFIX + suffix];
}

/** Value of `AUTOPILOT_<suffix>`, else `KIMIFLARE_<suffix>`, else undefined. */
export function readEnv(suffix: string, env: EnvLike = process.env): string | undefined {
  const [current, legacy] = envNames(suffix);
  const value = env[current];
  if (value !== undefined) return value;
  const old = env[legacy];
  if (old !== undefined) noteLegacy(legacy, current);
  return old;
}

/** True when either spelling is set to a non-blank value. */
export function hasEnv(suffix: string, env: EnvLike = process.env): boolean {
  return !!readEnv(suffix, env)?.trim();
}

/**
 * Copy of `vars` where every `KIMIFLARE_*` key also appears as `AUTOPILOT_*`
 * and vice versa (an explicitly given key is never overwritten). For env
 * blocks Autopilot builds for child processes, so old and new consumers both
 * find their variable.
 */
export function withEnvAliases(vars: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = { ...vars };
  for (const [key, value] of Object.entries(vars)) {
    let alias: string | undefined;
    if (key.startsWith(LEGACY_ENV_PREFIX)) alias = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    else if (key.startsWith(ENV_PREFIX)) alias = LEGACY_ENV_PREFIX + key.slice(ENV_PREFIX.length);
    if (alias && !(alias in vars)) out[alias] = value;
  }
  return out;
}

// ── one-time deprecation notice ───────────────────────────────────────────
// Recorded here (no imports, so the logger can use readEnv at module load)
// and reported once per variable per process through whatever listener the
// logger registers. Never printed to the TUI.

type LegacyListener = (legacy: string, current: string) => void;
const noted = new Map<string, string>();
let listener: LegacyListener | undefined;

function noteLegacy(legacy: string, current: string): void {
  if (noted.has(legacy)) return;
  noted.set(legacy, current);
  listener?.(legacy, current);
}

/** Register the deprecation reporter; replays names already seen. */
export function onLegacyEnvVar(fn: LegacyListener | undefined): void {
  listener = fn;
  if (fn) for (const [legacy, current] of noted) fn(legacy, current);
}

/** Legacy names read so far in this process (for diagnostics and tests). */
export function legacyEnvVarsUsed(): string[] {
  return [...noted.keys()];
}

/** Test hook: forget which legacy names were seen. */
export function resetLegacyEnvNotices(): void {
  noted.clear();
}
