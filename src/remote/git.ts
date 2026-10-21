import { execFile } from "node:child_process";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Matches the server's limit on an uploaded patch. */
export const MAX_PATCH_CHARS = 3 * 1024 * 1024;

export interface WorkingTreeSnapshot {
  /** A commit GitHub already has: where the remote run starts. */
  baseCommit: string;
  /** Everything since baseCommit: unpushed commits, staged, unstaged, and untracked (not ignored) files. */
  patch: string;
  /** The remote-tracking ref baseCommit came from, for messages. */
  baseRef: string;
  /** Paths the patch touches, so the user sees what leaves the laptop. */
  files: string[];
}

/** owner/name of the GitHub repository behind a git remote URL, or undefined for other hosts. */
export function parseGitHubRemote(url: string): string | undefined {
  const match = url.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function detectGitHubRepository(cwd: string, remote = "origin"): Promise<string> {
  let url: string;
  try {
    url = await git(cwd, ["remote", "get-url", remote]);
  } catch {
    throw new Error(`This directory has no "${remote}" git remote; pass --repo owner/name`);
  }
  const repository = parseGitHubRemote(url);
  if (!repository) throw new Error(`The "${remote}" remote is not a GitHub repository (${url}); pass --repo owner/name`);
  return repository;
}

/**
 * The local work a remote run should start from. The base is the merge-base of HEAD
 * with its upstream (or origin's default branch), so it exists on GitHub; the patch
 * carries everything newer, built in a throwaway index so the user's index is untouched.
 */
export async function snapshotWorkingTree(cwd: string): Promise<WorkingTreeSnapshot> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("Not inside a git repository");
  });
  await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new Error("This repository has no commits yet; push a first commit before running remotely");
  });
  const baseRef = await upstreamRef(root);
  const baseCommit = await git(root, ["merge-base", "HEAD", baseRef]).catch(() => {
    throw new Error(`HEAD shares no history with ${baseRef}`);
  });

  const scratch = await mkdtemp(join(tmpdir(), "autopilot-snapshot-"));
  try {
    const index = join(scratch, "index");
    const realIndex = resolve(root, await git(root, ["rev-parse", "--git-path", "index"]));
    await copyFile(realIndex, index).catch(() => { /* a fresh repository may have no index yet */ });
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(root, ["add", "--all"], env);
    const patch = await git(root, ["diff", "--cached", "--binary", "--no-color", "--no-ext-diff", baseCommit], env, false);
    if (patch.length > MAX_PATCH_CHARS) {
      throw new Error(`Local changes are ${(patch.length / 1024 / 1024).toFixed(1)} MiB, over the 3 MiB limit; commit and push some of them first`);
    }
    const files = (await git(root, ["diff", "--cached", "--name-only", "--no-renames", baseCommit], env)).split("\n").filter(Boolean);
    return { baseCommit, patch, baseRef, files };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function upstreamRef(root: string): Promise<string> {
  const upstream = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "");
  if (upstream.startsWith("origin/")) return upstream;
  const originHead = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
  if (originHead) return originHead;
  for (const candidate of ["origin/main", "origin/master"]) {
    if (await git(root, ["rev-parse", "--verify", "--quiet", candidate]).then(() => true, () => false)) return candidate;
  }
  throw new Error("Can't find this branch on origin; run `git fetch origin` (or push the branch) first");
}

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv, trim = true): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  return trim ? stdout.trim() : stdout;
}
