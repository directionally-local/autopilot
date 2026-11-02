/**
 * Names the dl server used before the Aster → dl server rename. Every legacy name keeps
 * working; the new name wins when both are set, and the first use of a legacy name
 * prints a one-line deprecation note.
 */

const warned = new Set<string>();

/** Print a deprecation note once per key. */
export function warnDeprecated(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`autopilot: ${message}\n`);
}

/**
 * Read `AUTOPILOT_SERVER_<suffix>`, falling back to the pre-rename
 * `AUTOPILOT_ASTER_<suffix>`. Empty values count as unset.
 */
export function serverEnv(env: NodeJS.ProcessEnv, suffix: string): string | undefined {
  const current = env[`AUTOPILOT_SERVER_${suffix}`]?.trim();
  if (current) return current;
  const legacy = env[`AUTOPILOT_ASTER_${suffix}`]?.trim();
  if (!legacy) return undefined;
  warnDeprecated(
    `env:${suffix}`,
    `AUTOPILOT_ASTER_${suffix} is deprecated; use AUTOPILOT_SERVER_${suffix}.`,
  );
  return legacy;
}
