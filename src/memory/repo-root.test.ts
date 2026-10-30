import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearRepoRootCache, resolveRepoRoot } from "./repo-root.js";

describe("resolveRepoRoot", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-repo-root-test-"));
    execFileSync("git", ["init", tmpDir], { stdio: "ignore" });
    await mkdir(join(tmpDir, "src", "nested"), { recursive: true });
    clearRepoRootCache();
  });

  after(async () => {
    clearRepoRootCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves a subdirectory to the repository root", () => {
    const root = resolveRepoRoot(join(tmpDir, "src", "nested"));
    assert.strictEqual(realpathSync(root), realpathSync(tmpDir));
  });

  it("returns the repository root for the root itself", () => {
    const root = resolveRepoRoot(tmpDir);
    assert.strictEqual(realpathSync(root), realpathSync(tmpDir));
  });

  it("falls back to the cwd outside a git repository", async () => {
    const plain = await mkdtemp(join(tmpdir(), "kimiflare-no-git-"));
    try {
      clearRepoRootCache();
      assert.strictEqual(resolveRepoRoot(plain), plain);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
