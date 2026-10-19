import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildInitPrompt } from "./context-generator.js";

const tempDirs: string[] = [];

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-init-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("buildInitPrompt", () => {
  it("creates AGENTS.md when no project context file exists", () => {
    const result = buildInitPrompt(makeProject());

    assert.equal(result.targetFilename, "AGENTS.md");
    assert.equal(result.isRefresh, false);
    assert.match(result.prompt, /Generate a `AGENTS\.md`/);
    assert.equal(result.tasks.length, 6);
    assert.equal(result.tasks[0]?.status, "in_progress");
    assert.equal(result.tasks[4]?.title, "Write or refresh AGENTS.md");
    assert.equal(result.tasks[5]?.title, "Re-read and verify AGENTS.md");
    assert.match(result.prompt, /visible task checklist is already initialized/i);
    assert.doesNotMatch(result.prompt, /Do not call `tasks_set`/);
  });

  it("refreshes an existing legacy context file in place", () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "KIMI.md"), "existing context");

    const result = buildInitPrompt(cwd);

    assert.equal(result.targetFilename, "KIMI.md");
    assert.equal(result.isRefresh, true);
    assert.equal(result.tasks[4]?.title, "Write or refresh KIMI.md");
    assert.match(result.prompt, /Regenerate `KIMI\.md`/);
  });

  it("prefers AGENTS.md if both standard and legacy files exist", () => {
    const cwd = makeProject();
    writeFileSync(join(cwd, "AGENTS.md"), "standard context");
    writeFileSync(join(cwd, "KIMI.md"), "legacy context");

    const result = buildInitPrompt(cwd);

    assert.equal(result.targetFilename, "AGENTS.md");
    assert.equal(result.isRefresh, true);
  });
});
