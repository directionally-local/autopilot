/**
 * Where the Directionally Local free tier lives. A leaf module (no imports)
 * so presets.ts and resolve.ts can use it without an import cycle.
 */

export const DL_FREE_DEFAULT_URL = "https://free.directionallylocal.com";

/** The free tier's default model: DeepSeek V4.1 Flash (GPT-6 is paused on the free tier). Kept here so presets.ts can use it without a cycle. */
export const DL_FREE_DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash-1017";

/** dl's public API: where a dl key (dl_sk_…, from dl's browser sign-in at dl.new) is used. */
export const DL_API_URL = "https://api.dl.new";

/** A dl.new API key's prefix: what dl passes in AUTOPILOT_DL_FREE_TOKEN once signed in. */
export const DL_API_KEY_PREFIX = "dl_sk_";

/** True for a dl.new API key (dl_sk_…), as opposed to a free-tier GitHub sign-in's access token. */
export function isDlApiKey(token: string | undefined | null): boolean {
  return !!token && token.trim().startsWith(DL_API_KEY_PREFIX);
}

/**
 * Key mode: dl signed the person in at dl.new and passed their dl key in AUTOPILOT_DL_FREE_TOKEN.
 * The key is the provider: dl's plan, at api.dl.new, with no GitHub sign-in of Autopilot's own.
 */
export function dlKeyMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDlApiKey(env.AUTOPILOT_DL_FREE_TOKEN);
}

/** The service origin: AUTOPILOT_DL_FREE_URL, else api.dl.new for a dl key, else the default (no trailing slash, no /v1). */
export function dlOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.AUTOPILOT_DL_FREE_URL?.trim();
  return (raw || (dlKeyMode(env) ? DL_API_URL : DL_FREE_DEFAULT_URL)).replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The OpenAI-compatible base URL (origin + /v1). */
export function dlApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return `${dlOrigin(env)}/v1`;
}
