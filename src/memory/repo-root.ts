import { execFileSync } from "node:child_process";
import { basename, dirname } from "node:path";

/**
 * Resolve a stable repository identity for memory storage.
 *
 * Memory used to key everything by the absolute cwd. That fragments a project
 * across subdirectories, worktrees, and clones, and orphans every row when the
 * checkout is moved or renamed. Resolve the git common dir instead so all
 * worktrees of one repository share a single memory DB and repo_path.
 *
 * Falls back to the cwd when git is unavailable or the path is not a repo.
 */
const cache = new Map<string, string>();

export function resolveRepoRoot(cwd: string): string {
  const cached = cache.get(cwd);
  if (cached) return cached;
  const root = detectRepoRoot(cwd);
  cache.set(cwd, root);
  return root;
}

/** Test hook: clear the per-process cache. */
export function clearRepoRootCache(): void {
  cache.clear();
}

function detectRepoRoot(cwd: string): string {
  // The common dir is shared by every worktree of a repository. For a normal
  // checkout it is <root>/.git; for a linked worktree it is the main
  // repository's .git. Submodules have a non-.git common dir, so fall through
  // to --show-toplevel for those.
  try {
    const common = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (common && basename(common) === ".git") return dirname(common);
  } catch {
    // git missing, not a repo, or an older git without --path-format
  }

  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) return top;
  } catch {
    // not a git repository
  }

  return cwd;
}
