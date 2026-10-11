import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTasks, matchesTaskFilter, validateTask } from "./tasks.js";

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "autopilot-eval-tasks-"));
  await mkdir(join(dir, "files", "a"), { recursive: true });
  await writeFile(join(dir, "files", "a", "x.test.ts"), "// spec", "utf8");
  await writeFile(
    join(dir, "a.json"),
    JSON.stringify({ id: "a", repo: "/repo", base_commit: "abc", prompt: "do", test: "exit 0", files: { "src/x.test.ts": "files/a/x.test.ts" } }),
  );
  await writeFile(join(dir, "b-two.json"), JSON.stringify({ id: "b-two", repo: "/repo", base_commit: "abc", prompt: "do", test: "exit 0", tags: ["x"] }));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadTasks", () => {
  it("loads, validates, resolves files, and filters by glob", async () => {
    const all = await loadTasks(dir);
    assert.deepStrictEqual(all.map((t) => t.id), ["a", "b-two"]);
    assert.strictEqual(all[0]!.resolvedFiles["src/x.test.ts"], join(dir, "files", "a", "x.test.ts"));
    const filtered = await loadTasks(dir, "b-*");
    assert.deepStrictEqual(filtered.map((t) => t.id), ["b-two"]);
    const both = await loadTasks(dir, "b-*, a");
    assert.deepStrictEqual(both.map((t) => t.id), ["a", "b-two"]);
  });

  it("matchesTaskFilter accepts comma-separated globs and an empty filter", () => {
    assert.strictEqual(matchesTaskFilter("x", undefined), true);
    assert.strictEqual(matchesTaskFilter("x", "  "), true);
    assert.strictEqual(matchesTaskFilter("queue-batch-grouping", "subagent-*,queue-batch-grouping"), true);
    assert.strictEqual(matchesTaskFilter("other", "subagent-*,queue-batch-grouping"), false);
  });

  it("rejects malformed tasks", () => {
    assert.throws(() => validateTask({ id: "x" }, "x.json"), /"repo" must be/);
    assert.throws(() => validateTask({ id: "../x", repo: "r", base_commit: "c", prompt: "p", test: "t" }, "x.json"), /"id" may only/);
    assert.throws(() => validateTask({ id: "x", repo: "r", base_commit: "c", prompt: "p", test: "t", files: { "../etc": "f" } }, "x.json"), /relative path/);
    assert.throws(() => validateTask({ id: "x", repo: "r", base_commit: "c", prompt: "p", test: "t", timeout_s: -1 }, "x.json"), /timeout_s/);
  });
});
