import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemote, snapshotWorkingTree } from "./git.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** A pushed main branch on a local "origin", cloned into a working checkout. */
async function clonedRepository(): Promise<{ root: string; checkout: string; origin: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-remote-git-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, checkout], { stdio: "ignore" });
  await writeFile(join(checkout, "README.md"), "hello\n");
  await writeFile(join(checkout, ".gitignore"), "secret.env\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "initial");
  git(checkout, "push", "--quiet", "origin", "main");
  return { root, checkout, origin };
}

describe("remote git snapshot", () => {
  it("parses GitHub remotes in every common form", () => {
    assert.equal(parseGitHubRemote("git@github.com:acme/app.git"), "acme/app");
    assert.equal(parseGitHubRemote("https://github.com/acme/app"), "acme/app");
    assert.equal(parseGitHubRemote("https://x-access-token@github.com/acme/my.app.git"), "acme/my.app");
    assert.equal(parseGitHubRemote("ssh://git@github.com/acme/app.git"), "acme/app");
    assert.equal(parseGitHubRemote("https://gitlab.com/acme/app.git"), undefined);
  });

  it("bases the run on a pushed commit and carries every local change without touching the index", async () => {
    const { root, checkout, origin } = await clonedRepository();
    const pushed = git(checkout, "rev-parse", "HEAD");

    await writeFile(join(checkout, "committed.txt"), "unpushed commit\n");
    git(checkout, "add", "committed.txt");
    git(checkout, "commit", "--quiet", "-m", "local only");
    await writeFile(join(checkout, "staged.txt"), "staged\n");
    git(checkout, "add", "staged.txt");
    await writeFile(join(checkout, "README.md"), "hello\nedited\n");
    await writeFile(join(checkout, "untracked.bin"), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(checkout, "secret.env"), "ignored\n");
    const statusBefore = git(checkout, "status", "--porcelain");

    const snapshot = await snapshotWorkingTree(checkout);
    assert.equal(snapshot.baseCommit, pushed);
    assert.equal(snapshot.baseRef, "origin/main");
    assert.deepEqual(snapshot.files.sort(), ["README.md", "committed.txt", "staged.txt", "untracked.bin"]);
    assert.doesNotMatch(snapshot.patch, /secret\.env/);
    assert.equal(git(checkout, "status", "--porcelain"), statusBefore, "the user's index is untouched");

    // Applying the patch to a fresh clone of the base reproduces the working tree.
    const replay = join(root, "replay");
    execFileSync("git", ["clone", "--quiet", origin, replay], { stdio: "ignore" });
    git(replay, "checkout", "--quiet", snapshot.baseCommit);
    await writeFile(join(root, "local.patch"), snapshot.patch);
    git(replay, "apply", "--binary", "--index", join(root, "local.patch"));
    assert.equal(await readFile(join(replay, "README.md"), "utf8"), "hello\nedited\n");
    assert.equal(await readFile(join(replay, "committed.txt"), "utf8"), "unpushed commit\n");
    assert.deepEqual([...await readFile(join(replay, "untracked.bin"))], [0, 1, 2, 255]);
  });

  it("sends no patch for a clean checkout and refuses one with no pushed history", async () => {
    const { root, checkout } = await clonedRepository();
    const clean = await snapshotWorkingTree(checkout);
    assert.equal(clean.patch, "");
    assert.deepEqual(clean.files, []);

    const lonely = join(root, "lonely");
    execFileSync("git", ["init", "--quiet", "--initial-branch=main", lonely]);
    await writeFile(join(lonely, "a.txt"), "a\n");
    git(lonely, "add", ".");
    git(lonely, "commit", "--quiet", "-m", "first");
    await assert.rejects(() => snapshotWorkingTree(lonely), /git fetch origin/);
  });
});
