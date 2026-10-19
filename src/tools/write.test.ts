import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import type { ToolContext } from "./registry.js";

describe("write tool", () => {
  it("creates nested files and reports create vs overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "write-tool-"));
    const ctx: ToolContext = { cwd: dir };
    assert.strictEqual(await writeTool.run({ path: "a/b/c.txt", content: "one" }, ctx), "Created a/b/c.txt (3 chars).");
    assert.strictEqual(await writeTool.run({ path: "a/b/c.txt", content: "two!" }, ctx), "Overwrote a/b/c.txt (4 chars).");
    assert.strictEqual(await readFile(join(dir, "a/b/c.txt"), "utf8"), "two!");
  });

  it("never interleaves with a concurrent edit on the same path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "write-tool-"));
    const file = join(dir, "f.txt");
    const ctx: ToolContext = { cwd: dir };
    for (let i = 0; i < 20; i++) {
      await writeFile(file, "START\n", "utf8");
      const [w, e] = await Promise.allSettled([
        writeTool.run({ path: file, content: "FRESH\n" }, ctx),
        editTool.run({ path: file, old_string: "FRESH", new_string: "FRESH-EDITED" }, ctx),
      ]);
      const onDisk = await readFile(file, "utf8");
      assert.strictEqual(w.status, "fulfilled", `iteration ${i}: write must succeed`);
      // Either order is a consistent outcome; a mix of the two images is not.
      if (e.status === "fulfilled") assert.strictEqual(onDisk, "FRESH-EDITED\n", `iteration ${i}: edit after write`);
      else {
        assert.match(String(e.reason), /not found/, `iteration ${i}: edit before write must fail cleanly`);
        assert.strictEqual(onDisk, "FRESH\n", `iteration ${i}: write after failed edit`);
      }
    }
  });
});
