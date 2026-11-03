/**
 * After a browser sign-in completes (the free tier's device sign-in, or
 * OpenRouter's OAuth), bring the terminal running Autopilot back to the
 * front so the person doesn't have to find it again.
 *
 * macOS only, and only for a terminal we can name from the environment
 * (TERM_PROGRAM, refined for VS Code forks by __CFBundleIdentifier; kitty
 * and Alacritty by their own variables). Nothing happens on Linux or
 * Windows, over SSH, for an unknown terminal, or when turned off
 * (`/settings refocus off`, refocusTerminal: false, AUTOPILOT_REFOCUS_TERMINAL=0).
 * It never throws and never waits on the app it activates.
 */
import { execFile } from "node:child_process";
import { readEnv } from "./env.js";

/** TERM_PROGRAM → the macOS app to activate. */
export const TERM_PROGRAM_APPS: Readonly<Record<string, string>> = {
  Apple_Terminal: "Terminal",
  "iTerm.app": "iTerm",
  WarpTerminal: "Warp",
  ghostty: "Ghostty",
  WezTerm: "WezTerm",
  Hyper: "Hyper",
  Tabby: "Tabby",
  rio: "Rio",
  zed: "Zed",
  vscode: "Visual Studio Code",
};

/** VS Code and its forks all set TERM_PROGRAM=vscode; the bundle id tells them apart. */
export const VSCODE_BUNDLE_APPS: Readonly<Record<string, string>> = {
  "com.microsoft.VSCode": "Visual Studio Code",
  "com.microsoft.VSCodeInsiders": "Visual Studio Code - Insiders",
  "com.todesktop.230313mzl4w4u92": "Cursor",
  "com.exafunction.windsurf": "Windsurf",
  "com.vscodium": "VSCodium",
};

/** The app to bring forward for this environment, or undefined when the terminal is unknown. */
export function terminalApp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const program = env.TERM_PROGRAM?.trim();
  if (program === "vscode") {
    const bundle = env.__CFBundleIdentifier?.trim();
    return (bundle && VSCODE_BUNDLE_APPS[bundle]) || TERM_PROGRAM_APPS.vscode;
  }
  if (program && Object.hasOwn(TERM_PROGRAM_APPS, program)) return TERM_PROGRAM_APPS[program];
  // Inside tmux/screen TERM_PROGRAM names the multiplexer, not the window: unknown.
  if (program) return undefined;
  if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "kitty";
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return "Alacritty";
  return undefined;
}

export type RefocusSkip = "off" | "not-macos" | "ssh" | "unknown-terminal" | "test";

/** Why not to refocus here, or null with the app to activate. */
export function refocusPlan(
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; enabled?: boolean } = {},
): { app: string } | { skip: RefocusSkip } {
  const env = o.env ?? process.env;
  if (o.enabled === false) return { skip: "off" };
  const fromEnv = readEnv("REFOCUS_TERMINAL", env)?.trim().toLowerCase();
  if (fromEnv === "0" || fromEnv === "false") return { skip: "off" };
  if ((o.platform ?? process.platform) !== "darwin") return { skip: "not-macos" };
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { skip: "ssh" };
  // node:test runs set this: never steal focus from a developer's tests.
  if (env.NODE_TEST_CONTEXT) return { skip: "test" };
  const app = terminalApp(env);
  return app ? { app } : { skip: "unknown-terminal" };
}

export type Activate = (app: string) => void;

/** `open -a <App>`: activates the app (bringing its windows forward). Detached and silent. */
export const openApp: Activate = (app) => {
  try {
    const child = execFile("open", ["-a", app], { timeout: 3_000 }, () => {});
    child.unref?.();
  } catch {
    // Silent: refocusing is a convenience.
  }
};

/**
 * Bring the terminal back after a browser sign-in. Reads the
 * refocusTerminal setting from config.json unless `enabled` is given.
 * Returns what it did, for tests; never throws.
 */
export async function refocusTerminal(
  o: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; enabled?: boolean; activate?: Activate } = {},
): Promise<{ app: string } | { skip: RefocusSkip }> {
  try {
    // The cheap checks first: off macOS the config file is never read.
    const plan = refocusPlan(o);
    if (!("app" in plan)) return plan;
    if (o.enabled === undefined) {
      const { readPersistedConfig } = await import("../config.js");
      if ((await readPersistedConfig().catch(() => null))?.refocusTerminal === false) return { skip: "off" };
    }
    (o.activate ?? openApp)(plan.app);
    return plan;
  } catch {
    return { skip: "off" };
  }
}
