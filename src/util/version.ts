import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** npm package name (the old `kimiflare` package is deprecated in its favour). */
export const PACKAGE_NAME = "autopilot-ai";
/** The installed command. */
export const CLI_NAME = "autopilot";

let cachedVersion: string | null = null;

export function getAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  const here = dirname(fileURLToPath(import.meta.url));
  // When running from source: src/util/ -> ../../package.json
  // When bundled by tsup: dist/ -> ../package.json
  const candidates = [join(here, "..", "..", "package.json"), join(here, "..", "package.json")];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
      cachedVersion = pkg.version ?? "0.0.0";
      return cachedVersion;
    } catch {
      // try next candidate
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

export function getUserAgent(): string {
  return `${CLI_NAME}/${getAppVersion()} (+https://github.com/directionally-local/autopilot)`;
}
