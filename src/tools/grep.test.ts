import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runJsFallback } from "./grep.js";

async function withTempDir(test: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "autopilot-grep-"));
  try {
    await test(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("grep JavaScript fallback", () => {
  it("searches a file path directly", async () => {
    await withTempDir(async (root) => {
      const file = join(root, "single.ts");
      await writeFile(file, "first line\nneedle here\n");
      const result = await runJsFallback({ pattern: "needle" }, file, "content");
      assert.match(result.content, /single\.ts:2:needle here/);
    });
  });

  it("excludes files ignored by Git", async () => {
    await withTempDir(async (root) => {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      await writeFile(join(root, ".gitignore"), "target/\n");
      await mkdir(join(root, "target"));
      await writeFile(join(root, "target", "generated.rs"), "needle generated\n");
      await writeFile(join(root, "source.rs"), "needle source\n");

      const result = await runJsFallback({ pattern: "needle" }, root, "content");
      assert.match(result.content, /source\.rs:1:needle source/);
      assert.doesNotMatch(result.content, /target/);
    });
  });

  it("caps returned output at 30 KB", async () => {
    await withTempDir(async (root) => {
      await writeFile(join(root, "many.txt"), ("needle " + "λ".repeat(80) + "\n").repeat(500));
      const result = await runJsFallback({ pattern: "needle" }, root, "content");
      assert.ok(Buffer.byteLength(result.content, "utf8") <= 30 * 1024);
      assert.match(result.content, /truncated at 30 KB/);
      assert.ok(result.rawBytes > result.reducedBytes);
    });
  });
});
