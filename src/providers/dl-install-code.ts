/**
 * dl.new's personal install command (`curl -fsSL https://dl.new/i/<code> | sh`) installs dl
 * already signed in: the command's one-time code reaches Autopilot as DL_INSTALL_CODE (dl.new's
 * script → the install script → dl → here, on dl's first start only), and Autopilot trades it,
 * once, for the free tier's normal access and refresh tokens:
 *
 *   POST <origin>/v1/install-code/exchange {code} → {access_token, refresh_token, expires_in, login, option, plan}
 *
 * `option` is what the person chose on dl.new: "computer" (the free tier on this computer, so
 * the free provider becomes the provider when none is set up yet) or "gpu" (their Nvidia GPU, so
 * the first run goes straight to the own-GPU path; the sign-in is kept for later). A used,
 * expired or refused code leaves one line and the normal GitHub sign-in. Already signed in to
 * the free tier: the code is left alone. The code is never printed or logged.
 */

import { readFile } from "node:fs/promises";
import { configPath, loadConfig, type AutopilotConfig } from "../config.js";
import { getUserAgent } from "../util/version.js";
import { dlOrigin } from "./dl-endpoint.js";
import { DL_FREE_MODEL, DL_PROVIDER_ID, dlSettings, saveDlSettings } from "./directionally-local.js";
import { switchProvider } from "./keys.js";

export const DL_INSTALL_CODE_ENV = "DL_INSTALL_CODE";
const CODE = /^[A-Za-z0-9_-]{22,64}$/;
const EXCHANGE_TIMEOUT_MS = 10_000;

export type DlInstallOption = "computer" | "gpu";

export type DlInstallCodeOutcome =
  | { kind: "none" }
  | { kind: "signed-in"; login: string; option: DlInstallOption; line: string }
  | { kind: "fallback"; line: string };

/** The line when the code can't be used: the normal sign-in follows. */
export const INSTALL_CODE_USED_LINE = "Your dl.new install command was already used or has expired, so sign in with GitHub below.";
export const INSTALL_CODE_FAILED_LINE = "Couldn't sign in with your dl.new install command, so sign in with GitHub below.";

let chosen: DlInstallOption | undefined;
let notice: string | undefined;

/** What the person chose on dl.new, once the code was exchanged on this start; undefined otherwise. */
export function dlInstallOption(): DlInstallOption | undefined {
  return chosen;
}

/** The exchange's line, once: for the first run's screen (it is also printed before the screen starts). */
export function takeDlInstallNotice(): string[] {
  const line = notice;
  notice = undefined;
  return line ? [line] : [];
}

/** For tests. */
export function resetDlInstallCodeForTesting(): void {
  chosen = undefined;
  notice = undefined;
}

async function signedIn(): Promise<boolean> {
  try {
    const cfg = JSON.parse(await readFile(configPath(), "utf8")) as Partial<AutopilotConfig>;
    const saved = cfg.providers?.[DL_PROVIDER_ID]?.refreshToken;
    return typeof saved === "string" && saved.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Exchanges DL_INSTALL_CODE, when set, before anything loads the config. Never throws: a
 * failure is a line and the normal sign-in.
 */
export async function redeemDlInstallCode(o: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}): Promise<DlInstallCodeOutcome> {
  const env = o.env ?? process.env;
  const code = env[DL_INSTALL_CODE_ENV]?.trim();
  if (!code || !CODE.test(code)) return { kind: "none" };
  if (await signedIn()) return { kind: "none" };
  const fallback = (line: string): DlInstallCodeOutcome => {
    notice = line;
    return { kind: "fallback", line };
  };
  let res: Response;
  try {
    res = await (o.fetchImpl ?? fetch)(`${dlOrigin(env)}/v1/install-code/exchange`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": getUserAgent() },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    return fallback(INSTALL_CODE_FAILED_LINE);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const error = body?.error as { code?: unknown; message?: unknown } | undefined;
    if (error?.code === "invalid_install_code") return fallback(INSTALL_CODE_USED_LINE);
    // Blocked, device taken, paused: the service's own sentence says why.
    return fallback(typeof error?.message === "string" && error.message ? `${error.message} Sign in with GitHub below, or use your own key.` : INSTALL_CODE_FAILED_LINE);
  }
  const access = body?.access_token;
  const refresh = body?.refresh_token;
  if (typeof access !== "string" || !access || typeof refresh !== "string" || !refresh) return fallback(INSTALL_CODE_FAILED_LINE);
  const expires = typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : undefined;
  const option: DlInstallOption = body?.option === "gpu" ? "gpu" : "computer";
  const login = typeof body?.login === "string" ? body.login.replace(/[^A-Za-z0-9-]/g, "").slice(0, 39) : "";
  try {
    await saveDlSettings(dlSettings({ access_token: access, refresh_token: refresh, ...(expires ? { expires_in: expires } : {}) }));
    // This computer: the free tier becomes the provider, unless one is set up already.
    if (option === "computer" && !(await loadConfig().catch(() => null))) await switchProvider(null, DL_PROVIDER_ID, DL_FREE_MODEL);
  } catch {
    return fallback(INSTALL_CODE_FAILED_LINE);
  }
  chosen = option;
  const who = login ? ` as @${login}` : "";
  const line = option === "gpu" ? `✓ Signed in${who} from dl.new. Next: your own model on your Nvidia GPU.` : `✓ Signed in${who} from dl.new.`;
  notice = line;
  return { kind: "signed-in", login, option, line };
}
