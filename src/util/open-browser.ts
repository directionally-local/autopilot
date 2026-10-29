import { spawn } from "node:child_process";
import { platform } from "node:os";
import { readEnv } from "./env.js";

/**
 * Open a URL in the user's browser. Returns false when opening is disabled
 * (KIMIFLARE_NO_BROWSER=1 or BROWSER=none) so callers can provide a fallback.
 * Never throws when an OS opener is unavailable.
 */
export function openBrowser(url: string): boolean {
  if (readEnv("NO_BROWSER") === "1" || process.env.BROWSER === "none") return false;
  try {
    const os = platform();
    // start is a cmd.exe builtin; the empty string is its window-title argument.
    const [cmd, args] =
      os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
