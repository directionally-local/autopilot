import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, ALL_TOOLS } from "../tools/executor.js";
import { hookWirePayload } from "./runner.js";
import { ORIGINAL_FILE_CAP_BYTES } from "./claude-compat.js";
import type { HookEvent, HookPayload } from "./types.js";

/** Runs write / edit through the executor and returns each PostToolUse payload as hooks receive it. */
function harness() {
  const posts: Array<Record<string, unknown>> = [];
  const fake = {
    hasEnabledHooks: () => true,
    fire: async (event: HookEvent, payload: HookPayload) => {
      if (event === "PostToolUse") posts.push(hookWirePayload(payload));
      return { outcomes: [], vetoed: false, vetoReason: "", failures: [] };
    },
  };
  const tools = ALL_TOOLS.filter((t) => t.name === "read" || t.name === "write" || t.name === "edit");
  const exec = new ToolExecutor(tools, { hooks: fake as never });
  const cwd = mkdtempSync(join(tmpdir(), "autopilot-file-change-"));
  mkdirSync(join(cwd, "adir"));
  let n = 0;
  const run = async (name: string, args: Record<string, unknown>) => {
    if ((name === "edit" || name === "write") && typeof args.path === "string") {
      try {
        if (statSync(join(cwd, args.path)).isFile()) {
          const read = await exec.run(
            { id: `c${++n}`, name: "read", arguments: JSON.stringify({ path: args.path }) },
            async () => "allow",
            { cwd },
          );
          assert.equal(read.ok, true, "test setup must read an existing file before editing it");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await exec.run({ id: `c${++n}`, name, arguments: JSON.stringify(args) }, async () => "allow", { cwd });
    return posts.at(-1)!;
  };
  return { cwd, run };
}

const response = (p: Record<string, unknown>) => p.tool_response as Record<string, unknown>;

describe("Write / Edit / MultiEdit tool_response carries Claude Code's diff fields", () => {
  it("Write of a new file: type create, originalFile null, no hunks", async () => {
    const { cwd, run } = harness();
    const r = response(await run("write", { path: "hello.py", content: "hello\nworld\n" }));
    assert.equal(r.type, "create");
    assert.equal(r.originalFile, null);
    assert.deepEqual(r.structuredPatch, []);
    assert.equal(r.filePath, join(cwd, "hello.py"));
    assert.equal(r.content, "hello\nworld\n");
  });

  it("Write over an existing file: type update, with the previous content and a real patch", async () => {
    const { cwd, run } = harness();
    writeFileSync(join(cwd, "a.txt"), "1\n2\n3\n");
    const r = response(await run("write", { path: "a.txt", content: "1\nTWO\n3\n" }));
    assert.equal(r.type, "update");
    assert.equal(r.originalFile, "1\n2\n3\n");
    assert.deepEqual(r.structuredPatch, [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" 1", "-2", "+TWO", " 3"] }]);
  });

  it("Edit: hunks at the edited lines, originalFile, and Claude's oldString/newString", async () => {
    const { cwd, run } = harness();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    writeFileSync(join(cwd, "big.txt"), lines.join("\n") + "\n");
    const p = await run("edit", { path: "big.txt", old_string: "line 12", new_string: "line twelve" });
    const r = response(p);
    assert.equal(p.tool_name, "Edit");
    assert.equal(r.originalFile, lines.join("\n") + "\n");
    assert.equal(r.oldString, "line 12");
    assert.equal(r.newString, "line twelve");
    assert.equal(r.replaceAll, false);
    assert.deepEqual(r.structuredPatch, [
      { oldStart: 9, oldLines: 7, newStart: 9, newLines: 7, lines: [" line 9", " line 10", " line 11", "-line 12", "+line twelve", " line 13", " line 14", " line 15"] },
    ]);
    // The raw before/after content is not sent next to Autopilot's own result fields.
    assert.ok(!("fileChange" in (p.result as Record<string, unknown>)));
  });

  it("MultiEdit: one patch for all the edits", async () => {
    const { cwd, run } = harness();
    writeFileSync(join(cwd, "m.txt"), "hello beacon\nworld\n");
    const p = await run("edit", { path: "m.txt", edits: [{ old_string: "world", new_string: "WORLD" }, { old_string: "beacon", new_string: "Beacon" }] });
    assert.equal(p.tool_name, "MultiEdit");
    const r = response(p);
    assert.deepEqual(r.structuredPatch, [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-hello beacon", "-world", "+hello Beacon", "+WORLD"] },
    ]);
    assert.equal(r.originalFile, "hello beacon\nworld\n");
  });

  it("omits originalFile above the cap but keeps the patch", async () => {
    const { cwd, run } = harness();
    const big = "x".repeat(ORIGINAL_FILE_CAP_BYTES) + "\nend\n";
    writeFileSync(join(cwd, "huge.txt"), big);
    const r = response(await run("edit", { path: "huge.txt", old_string: "end", new_string: "END" }));
    assert.ok(!("originalFile" in r));
    assert.deepEqual((r.structuredPatch as Array<{ lines: string[] }>)[0]!.lines.slice(-2), ["-end", "+END"]);
  });

  it("a failed write carries no diff fields", async () => {
    const { run } = harness();
    const p = await run("write", { path: "adir", content: "x" });
    const r = response(p);
    assert.equal(r.success, false);
    assert.ok(!("structuredPatch" in r) && !("originalFile" in r) && !("type" in r));
  });
});
