/**
 * Helper: run git diff --name-status in a session's working directory.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitDiffSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  fileTypes: string[];
  /** The raw `git diff --numstat` output the summary was computed from. */
  raw: string;
}

export interface NumstatEntry {
  file: string;
  /** NaN for binary files in git's output is normalized to 0. */
  insertions: number;
  deletions: number;
}

export interface GitNumstat {
  raw: string;
  entries: NumstatEntry[];
}

export interface GitNumstatOptions {
  /** Compare the working tree against HEAD (staged + unstaged). Default: index only, like `git diff`. */
  againstHead?: boolean;
  /** Append untracked files (via `git ls-files --others --exclude-standard`) as all-insertions entries. */
  includeUntracked?: boolean;
}

/** Parse `git diff --numstat` lines. */
export function parseNumstat(raw: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parseInt(parts[0]!, 10);
    const del = parseInt(parts[1]!, 10);
    entries.push({
      file: parts.slice(2).join("\t"),
      insertions: Number.isNaN(ins) ? 0 : ins,
      deletions: Number.isNaN(del) ? 0 : del,
    });
  }
  return entries;
}

/** Raw numstat plus parsed entries, or null when `cwd` is not a git repository. */
export async function gitNumstat(cwd: string, opts: GitNumstatOptions = {}): Promise<GitNumstat | null> {
  let raw: string;
  try {
    const args = ["diff", "--numstat"];
    if (opts.againstHead) args.push("HEAD");
    args.push("--", ".");
    try {
      raw = (await execFileAsync("git", args, { cwd, timeout: 5000 })).stdout;
    } catch (err) {
      // A repository with no commits has no HEAD; fall back to the index diff.
      if (!opts.againstHead) throw err;
      raw = (await execFileAsync("git", ["diff", "--numstat", "--", "."], { cwd, timeout: 5000 })).stdout;
    }
  } catch {
    return null;
  }
  const entries = parseNumstat(raw);
  if (opts.includeUntracked) {
    try {
      const { stdout } = await execFileAsync("git", ["ls-files", "--others", "--exclude-standard"], { cwd, timeout: 5000 });
      const { readFile, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      for (const file of stdout.split("\n").filter(Boolean)) {
        let lines = 0;
        try {
          const path = join(cwd, file);
          const size = (await stat(path)).size;
          if (size > 0 && size <= 1024 * 1024) {
            const text = await readFile(path, "utf8");
            lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
          }
        } catch {
          /* unreadable: count as 0 */
        }
        entries.push({ file, insertions: lines, deletions: 0 });
        raw += `${lines}\t0\t${file}\n`;
      }
    } catch {
      /* ls-files failed: untracked files are simply not counted */
    }
  }
  return { raw, entries };
}

export async function gitDiffSummary(cwd: string): Promise<GitDiffSummary | null> {
  const numstat = await gitNumstat(cwd);
  if (!numstat) return null;
  let insertions = 0;
  let deletions = 0;
  const types = new Set<string>();
  for (const entry of numstat.entries) {
    insertions += entry.insertions;
    deletions += entry.deletions;
    const ext = entry.file.includes(".") ? entry.file.slice(entry.file.lastIndexOf(".")) : "";
    types.add(ext || "(none)");
  }
  return {
    filesChanged: numstat.entries.length,
    insertions,
    deletions,
    fileTypes: Array.from(types),
    raw: numstat.raw,
  };
}

/** Full patch of the working tree against HEAD (or the index when there is no HEAD); null outside a repo. */
export async function gitPatch(cwd: string, maxBytes: number): Promise<string | null> {
  try {
    let stdout: string;
    try {
      stdout = (await execFileAsync("git", ["diff", "HEAD", "--", "."], { cwd, timeout: 10_000, maxBuffer: maxBytes * 4 })).stdout;
    } catch {
      stdout = (await execFileAsync("git", ["diff", "--", "."], { cwd, timeout: 10_000, maxBuffer: maxBytes * 4 })).stdout;
    }
    return Buffer.byteLength(stdout, "utf8") <= maxBytes ? stdout : null;
  } catch {
    return null;
  }
}
