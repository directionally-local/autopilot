import { spawn } from "node:child_process";
import { platform } from "node:os";
import { readEnv } from "./env.js";

/**
 * Whether a browser can open on the screen in front of the person. False when
 * opening is disabled (AUTOPILOT_NO_BROWSER=1 or BROWSER=none), over SSH (a
 * browser would open on the remote machine, if anywhere), and on Linux and
 * the BSDs without a graphical session (no DISPLAY or WAYLAND_DISPLAY), where
 * xdg-open has nothing to open into. WSL opens the Windows browser.
 */
export function canOpenBrowser(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform()): boolean {
  if (readEnv("NO_BROWSER", env) === "1" || env.BROWSER === "none") return false;
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (os === "darwin" || os === "win32") return true;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  return !!(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
}

/**
 * Open a URL in the user's browser. Returns false when no browser can open
 * here (see canOpenBrowser) or the opener couldn't be started, so callers can
 * tell the person to open the link themselves. Never throws.
 */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const os = platform();
  if (!canOpenBrowser(env, os)) return false;
  try {
    // start is a cmd.exe builtin; the empty string is its window-title argument.
    const [cmd, args] =
      os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    // No pid: the opener isn't installed (spawn reports ENOENT asynchronously).
    return typeof child.pid === "number";
  } catch {
    return false;
  }
}
