import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "./executor.js";
import { readTool } from "./read.js";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import type { ToolContext } from "./registry.js";

let nextCall = 0;
const allow = async () => "allow" as const;

async function callTool(
  executor: ToolExecutor,
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
) {
  return executor.run(
    { id: `file-version-${++nextCall}`, name, arguments: JSON.stringify(args) },
    allow,
    ctx,
  );
}

describe("read-before-write file snapshots", () => {
  it("requires a read and rejects a file changed since that read", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "file-version-"));
    const path = join(cwd, "source.ts");
    await writeFile(path, "const value = 1;\n");
    const ctx: ToolContext = { cwd, sessionId: "snapshot-session" };
    const executor = new ToolExecutor([readTool, editTool, writeTool]);

    const unreadEdit = await callTool(executor, "edit", {
      path: "source.ts",
      old_string: "1",
      new_string: "2",
    }, ctx);
    assert.equal(unreadEdit.ok, false);
    assert.equal(unreadEdit.errorCode, "policy_rejection");
    assert.equal(unreadEdit.recoverable, true);
    assert.match(unreadEdit.content, /has not been read.*call read/);
    assert.match(unreadEdit.suggestion ?? "", /Read .*review.*retry/);

    const unreadOverwrite = await callTool(executor, "write", {
      path: "source.ts",
      content: "const value = 3;\n",
    }, ctx);
    assert.equal(unreadOverwrite.ok, false);
    assert.match(unreadOverwrite.content, /has not been read.*call read/);

    assert.equal((await callTool(executor, "read", { path: "source.ts" }, ctx)).ok, true);
    await writeFile(path, "const value = 4;\n");
    const staleEdit = await callTool(executor, "edit", {
      path: "source.ts",
      old_string: "4",
      new_string: "5",
    }, ctx);
    assert.equal(staleEdit.ok, false);
    assert.equal(staleEdit.errorCode, "policy_rejection");
    assert.equal(staleEdit.recoverable, true);
    assert.match(staleEdit.content, /changed since it was last read.*read again/);
    assert.match(staleEdit.suggestion ?? "", /Read .*again.*retry/);
    assert.equal(await readFile(path, "utf8"), "const value = 4;\n");

    assert.equal((await callTool(executor, "read", { path: "source.ts" }, ctx)).ok, true);
    const currentEdit = await callTool(executor, "edit", {
      path: "source.ts",
      old_string: "4",
      new_string: "5",
    }, ctx);
    assert.equal(currentEdit.ok, true);
    assert.equal(await readFile(path, "utf8"), "const value = 5;\n");
  });

  it("allows new files and tracks tool writes while rejecting external changes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "file-version-"));
    const path = join(cwd, "nested/new.ts");
    const ctx: ToolContext = { cwd, sessionId: "new-file-session" };
    const executor = new ToolExecutor([readTool, editTool, writeTool]);

    const created = await callTool(executor, "write", { path: "nested/new.ts", content: "export {};\n" }, ctx);
    assert.equal(created.ok, true);
    const overwriteAfterOwnWrite = await callTool(executor, "write", { path: "nested/new.ts", content: "owned change\n" }, ctx);
    assert.equal(overwriteAfterOwnWrite.ok, true);

    await writeFile(path, "external change\n");
    const staleOverwrite = await callTool(executor, "write", { path: "nested/new.ts", content: "changed\n" }, ctx);
    assert.equal(staleOverwrite.ok, false);
    assert.match(staleOverwrite.content, /changed since it was last read.*read again/);
    assert.equal(await readFile(path, "utf8"), "external change\n");

    assert.equal((await callTool(executor, "read", { path: "nested/new.ts" }, ctx)).ok, true);
    const overwrite = await callTool(executor, "write", { path: "nested/new.ts", content: "changed\n" }, ctx);
    assert.equal(overwrite.ok, true);
    assert.equal(await readFile(path, "utf8"), "changed\n");
  });

  it("keeps read snapshots isolated between sessions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "file-version-"));
    await writeFile(join(cwd, "source.txt"), "original\n");
    const executor = new ToolExecutor([readTool, editTool, writeTool]);

    assert.equal((await callTool(executor, "read", { path: "source.txt" }, { cwd, sessionId: "reader" })).ok, true);
    const otherSessionEdit = await callTool(executor, "edit", {
      path: "source.txt",
      old_string: "original",
      new_string: "changed",
    }, { cwd, sessionId: "other" });
    assert.equal(otherSessionEdit.ok, false);
    assert.match(otherSessionEdit.content, /has not been read.*call read/);
  });
});
