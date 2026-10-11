/**
 * Worktrees for eval runs. A task repository is either a local path (used
 * directly as the worktree source) or a git URL (cloned once into
 * `<out>/cache/` and reused across tasks and samples). Each run gets a
 * detached worktree at the task's base commit.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string, timeoutMs = 600_000): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

function isLocalRepo(repo: string): boolean {
  return isAbsolute(repo) || repo.startsWith(".") || repo.startsWith("~");
}

/** In-flight preparations keyed by repo + cache dir, so concurrent runs share one clone. */
const preparing = new Map<string, Promise<string>>();

/** Resolve the source repository for `repo`: the local path, or a cached clone under `cacheDir`. */
export function prepareSourceRepo(repo: string, cacheDir: string): Promise<string> {
  const key = `${cacheDir}\0${repo}`;
  let pending = preparing.get(key);
  if (!pending) {
    pending = prepareSourceRepoUncached(repo, cacheDir).finally(() => preparing.delete(key));
    preparing.set(key, pending);
  }
  return pending;
}

async function prepareSourceRepoUncached(repo: string, cacheDir: string): Promise<string> {
  if (isLocalRepo(repo)) {
    const path = resolve(repo.replace(/^~/, process.env.HOME ?? ""));
    await git(["rev-parse", "--git-dir"], path);
    return path;
  }
  const slug = `${repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(-60)}-${createHash("sha1").update(repo).digest("hex").slice(0, 8)}`;
  const dir = join(cacheDir, slug);
  await mkdir(cacheDir, { recursive: true });
  const exists = await stat(join(dir, ".git")).then(() => true).catch(() => false);
  if (!exists) {
    await git(["clone", "--quiet", "--no-checkout", repo, dir], cacheDir);
  } else {
    await git(["fetch", "--quiet", "--all"], dir).catch(() => undefined);
  }
  return dir;
}

/** Make sure `commit` exists in `sourceRepo`, fetching it when it does not. */
export async function ensureCommit(sourceRepo: string, commit: string): Promise<void> {
  try {
    await git(["cat-file", "-e", `${commit}^{commit}`], sourceRepo);
  } catch {
    await git(["fetch", "--quiet", "origin", commit], sourceRepo);
    await git(["cat-file", "-e", `${commit}^{commit}`], sourceRepo);
  }
}

export interface EvalWorktree {
  sourceRepo: string;
  path: string;
}

/** Create a detached worktree of `sourceRepo` at `commit` under `path` (replacing any previous one). */
export async function createWorktree(sourceRepo: string, commit: string, path: string): Promise<EvalWorktree> {
  await ensureCommit(sourceRepo, commit);
  await removeWorktree({ sourceRepo, path }).catch(() => undefined);
  await mkdir(join(path, ".."), { recursive: true });
  await git(["worktree", "add", "--quiet", "--detach", path, commit], sourceRepo);
  return { sourceRepo, path };
}

export async function removeWorktree(wt: EvalWorktree): Promise<void> {
  await git(["worktree", "remove", "--force", wt.path], wt.sourceRepo).catch(() => undefined);
  await rm(wt.path, { recursive: true, force: true });
  await git(["worktree", "prune"], wt.sourceRepo).catch(() => undefined);
}
