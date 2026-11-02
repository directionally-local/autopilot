/**
 * Where the Directionally Local free tier lives. A leaf module (no imports)
 * so presets.ts and resolve.ts can use it without an import cycle.
 */

export const DL_FREE_DEFAULT_URL = "https://free.directionallylocal.com";

/** The service origin from AUTOPILOT_DL_FREE_URL or the default (no trailing slash, no /v1). */
export function dlOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AUTOPILOT_DL_FREE_URL?.trim();
  return (raw || DL_FREE_DEFAULT_URL).replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The OpenAI-compatible base URL (origin + /v1). */
export function dlApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return `${dlOrigin(env)}/v1`;
}
