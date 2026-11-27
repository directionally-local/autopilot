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

/**
 * The prefix of the Autopilot key dl passes instead of the dl key when it launches Autopilot
 * (dl_ak_…): minted from the dl key for this one Autopilot, short-lived and refreshed by dl while
 * Autopilot runs. With it, the service counts Autopilot's requests as Autopilot's (GPT-6 and the
 * plans' GPT-6 launch bonus), which a dl key in another tool doesn't get.
 */
export const DL_AUTOPILOT_KEY_PREFIX = "dl_ak_";

/** The file dl keeps Autopilot's current key in (dl writes a new one there when it re-mints the key). */
export const DL_TOKEN_FILE_ENV = "AUTOPILOT_DL_FREE_TOKEN_FILE";

/**
 * True for a dl key: a dl.new API key (dl_sk_…) or the Autopilot key dl made from it (dl_ak_…),
 * as opposed to a free-tier GitHub sign-in's access token. Either way it is dl's plan at api.dl.new.
 */
export function isDlApiKey(token: string | undefined | null): boolean {
  const trimmed = token?.trim() ?? "";
  return trimmed.startsWith(DL_API_KEY_PREFIX) || trimmed.startsWith(DL_AUTOPILOT_KEY_PREFIX);
}

/** True for the Autopilot key dl made from the dl key (dl_ak_…). */
export function isDlAutopilotKey(token: string | undefined | null): boolean {
  return !!token && token.trim().startsWith(DL_AUTOPILOT_KEY_PREFIX);
}

/**
 * Key mode: dl signed the person in at dl.new and passed their dl key (or the Autopilot key it
 * made from it) in AUTOPILOT_DL_FREE_TOKEN.
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
