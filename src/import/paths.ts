/**
 * Where other coding agents keep their setup, and the small file helpers the
 * importers share. Everything here only reads; nothing is written to the
 * repository or to the other agents' folders.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Options every importer takes, so tests can point at a fake home. */
export interface ImportEnv {
  /** The user's home directory (default: os.homedir(), which follows $HOME). */
  home?: string;
}

export function homeOf(env?: ImportEnv): string {
  return env?.home ?? homedir();
}

/** `AUTOPILOT_IMPORT_SETUP=0` turns all of this off. */
export function setupImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AUTOPILOT_IMPORT_SETUP?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * The project root for `cwd`: the nearest folder at or above it that holds
 * `.git` (a directory, or the file a worktree has). Without one, `cwd`.
 * Walks the file system only; never runs git.
 */
export function projectRootOf(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

/** Folders from `cwd` up to `root`, closest first. */
export function dirsUpTo(cwd: string, root: string): string[] {
  const out: string[] = [];
  let dir = resolve(cwd);
  const stop = resolve(root);
  for (;;) {
    out.push(dir);
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A JSON (or JSONC: comments and trailing commas) file, or null. */
export function readJson(path: string, maxBytes = 4 * 1024 * 1024): Record<string, unknown> | null {
  try {
    const s = statSync(path);
    if (!s.isFile() || s.size > maxBytes) return null;
    const text = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = JSON.parse(stripJsonComments(text));
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Remove // and /* *\/ comments outside strings, and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
