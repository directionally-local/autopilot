/**
 * Trust for project-local files that make Autopilot run commands.
 *
 * A repository can ship `.autopilot/settings.json` (hooks, run through a
 * shell) and `.autopilot/lsp.json` (language servers, spawned at startup).
 * Loading them unconditionally meant cloning a repository and starting
 * Autopilot in it ran whatever the repository chose. They now load only when
 * the user has trusted that file's exact bytes: the trust store records a
 * SHA-256 per file, so a later change (a `git pull`, a branch switch) needs
 * a fresh review.
 *
 * Global settings are never gated: the user wrote them.
 *
 * `AUTOPILOT_TRUST_PROJECT=1` trusts every project file for this process,
 * for CI and other headless runs in repositories the operator controls.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { logger } from "./logger.js";
import { configDir } from "./app-dirs.js";

export const TRUST_PROJECT_ENV = "AUTOPILOT_TRUST_PROJECT";

interface TrustStore {
  version: 1;
  /** Canonical file path -> SHA-256 (hex) of the trusted content. */
  files: Record<string, string>;
}

export function trustStorePath(): string {
  return join(configDir(), "trusted-project-files.json");
}

/** True when the operator opted every project file into trust via env. */
export function trustedByEnv(): boolean {
  const v = process.env[TRUST_PROJECT_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function readStore(): TrustStore {
  try {
    const parsed = JSON.parse(readFileSync(trustStorePath(), "utf8")) as Partial<TrustStore>;
    if (parsed && typeof parsed.files === "object" && parsed.files !== null && !Array.isArray(parsed.files)) {
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.files)) if (typeof v === "string") files[k] = v;
      return { version: 1, files };
    }
  } catch {
    // missing or unreadable: nothing is trusted
  }
  return { version: 1, files: {} };
}

function writeStore(store: TrustStore): void {
  const path = trustStorePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export interface ProjectFileRead {
  /** File content as read; trust was decided on exactly these bytes. */
  content: string;
  trusted: boolean;
}

/**
 * Read a project file once and decide trust on the bytes read, so the
 * content that is parsed is the content that was checked. Null when the
 * file does not exist or cannot be read.
 */
export function readProjectFile(path: string): ProjectFileRead | null {
  if (!existsSync(path)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  const trusted = trustedByEnv() || readStore().files[canonicalPath(path)] === digest(bytes);
  return { content: bytes.toString("utf8"), trusted };
}

/** True when the file is missing (nothing to run) or its current content is trusted. */
export function isProjectFileTrusted(path: string): boolean {
  const read = readProjectFile(path);
  return read === null || read.trusted;
}

/** Record the current content of each existing file as trusted. */
export function trustProjectFiles(paths: readonly string[]): void {
  const store = readStore();
  let changed = false;
  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      continue;
    }
    store.files[canonicalPath(path)] = digest(bytes);
    changed = true;
  }
  if (!changed) return;
  try {
    writeStore(store);
  } catch (e) {
    logger.warn("project-trust:write_failed", { error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
