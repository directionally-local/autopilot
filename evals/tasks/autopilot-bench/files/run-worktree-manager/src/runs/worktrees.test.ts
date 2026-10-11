import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunWorktreeManager } from "./worktrees.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("RunWorktreeManager", () => {
  it("creates an isolated branch and preserves the requested subdirectory", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-worktrees-"));
    tempDirs.push(root);
    const repo = await createRepo(root);
    const sourceCwd = join(repo, "packages", "app");
    const manager = new RunWorktreeManager(join(root, "state", "worktrees"));

    const worktree = await manager.create("run-123", sourceCwd);

    assert.equal(worktree.repositoryRoot, repo);
    assert.equal(worktree.sourceCwd, sourceCwd);
    assert.equal(worktree.cwd, join(worktree.worktreePath, "packages", "app"));
    assert.equal(worktree.branch, "autopilot/run/run-123");
    assert.equal(git(["branch", "--show-current"], worktree.worktreePath), worktree.branch);
    assert.notEqual(worktree.worktreePath, repo);
    assert.equal(await readFile(join(worktree.cwd, "README.md"), "utf8"), "tracked source\n");

    await writeFile(join(worktree.cwd, "only-in-worktree.txt"), "isolated\n");
    await assert.rejects(readFile(join(sourceCwd, "only-in-worktree.txt"), "utf8"), { code: "ENOENT" });
    assert.equal(git(["worktree", "list", "--porcelain"], repo).includes(worktree.worktreePath), true);
  });

  it("rejects a source directory that is not in a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-worktrees-"));
    tempDirs.push(root);
    const manager = new RunWorktreeManager(join(root, "state", "worktrees"));

    await assert.rejects(manager.create("run-123", root), /git rev-parse failed/);
  });

  it("rejects unsafe IDs and a worktree root nested in the source repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-worktrees-"));
    tempDirs.push(root);
    const repo = await createRepo(root);
    const manager = new RunWorktreeManager(join(repo, ".autopilot", "worktrees"));

    await assert.rejects(manager.create("../escape", repo), /runId must contain/);
    await assert.rejects(manager.create(".", repo), /runId must contain/);
    await assert.rejects(manager.create("..", repo), /runId must contain/);
    await assert.rejects(manager.create("run-123", repo), /worktree root must be outside/);
  });
});

async function createRepo(parent: string): Promise<string> {
  const repo = join(parent, "repo");
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  git(["init", "--quiet", "--initial-branch=main"], repo);
  git(["config", "user.name", "Autopilot test"], repo);
  git(["config", "user.email", "autopilot-test@example.invalid"], repo);
  await writeFile(join(repo, "packages", "app", "README.md"), "tracked source\n");
  git(["add", "."], repo);
  git(["commit", "--quiet", "-m", "initial"], repo);
  return realpath(repo);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
