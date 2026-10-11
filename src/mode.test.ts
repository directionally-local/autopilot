import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isReadOnlyBash,
  isBlockedInPlanMode,
  isAllowedInPlanMode,
  requiresApprovalInAutoMode,
  systemPromptForMode,
  nextMode,
  modeDescription,
  MODES,
} from "./mode.js";

describe("isReadOnlyBash", () => {
  it("allows simple read commands", () => {
    assert.strictEqual(isReadOnlyBash("ls"), true);
    assert.strictEqual(isReadOnlyBash("cat file.txt"), true);
    assert.strictEqual(isReadOnlyBash("pwd"), true);
    assert.strictEqual(isReadOnlyBash("git log"), true);
    assert.strictEqual(isReadOnlyBash("git diff HEAD~1"), true);
  });

  it("allows piped read commands", () => {
    assert.strictEqual(isReadOnlyBash("cat file.txt | grep foo"), true);
    assert.strictEqual(isReadOnlyBash("ps | grep node"), true);
    assert.strictEqual(isReadOnlyBash("git log | head -n 5"), true);
  });

  it("allows chained read commands with &&", () => {
    assert.strictEqual(isReadOnlyBash("git status && git diff"), true);
    assert.strictEqual(isReadOnlyBash("ls && cat file.txt"), true);
  });

  it("blocks chained commands with a mutating one", () => {
    assert.strictEqual(isReadOnlyBash("git status && rm file.txt"), false);
    assert.strictEqual(isReadOnlyBash("cat file.txt | rm -"), false);
  });

  it("blocks commands with dangerous patterns", () => {
    assert.strictEqual(isReadOnlyBash("echo hello > file.txt"), false);
    assert.strictEqual(isReadOnlyBash("cat file < input.txt"), false);
    assert.strictEqual(isReadOnlyBash("echo $(rm -rf /)"), false);
    assert.strictEqual(isReadOnlyBash("echo `rm -rf /`"), false);
    assert.strictEqual(isReadOnlyBash("echo $HOME"), false);
    assert.strictEqual(isReadOnlyBash("git status || echo fail"), false);
    assert.strictEqual(isReadOnlyBash("git status ; echo done"), false);
  });

  it("handles quoted strings correctly", () => {
    assert.strictEqual(isReadOnlyBash('echo "hello world"'), true);
    assert.strictEqual(isReadOnlyBash("echo 'hello world'"), true);
    assert.strictEqual(isReadOnlyBash('git log --format="foo | bar"'), true);
    assert.strictEqual(isReadOnlyBash('echo "a && b"'), true);
    // pipe inside quotes should not split
    assert.strictEqual(isReadOnlyBash('echo "a | b"'), true);
  });

  it("blocks mutating commands", () => {
    assert.strictEqual(isReadOnlyBash("rm file.txt"), false);
    assert.strictEqual(isReadOnlyBash("mv a b"), false);
    assert.strictEqual(isReadOnlyBash("cp a b"), false);
    assert.strictEqual(isReadOnlyBash("touch file.txt"), false);
    assert.strictEqual(isReadOnlyBash("mkdir dir"), false);
  });

  it("blocks empty commands", () => {
    assert.strictEqual(isReadOnlyBash(""), false);
    assert.strictEqual(isReadOnlyBash("   "), false);
  });

  it("validates find with deny-list of mutating primaries", () => {
    assert.strictEqual(isReadOnlyBash("find . -name '*.ts'"), true);
    assert.strictEqual(isReadOnlyBash("find node_modules/camouflage -type f"), true);
    assert.strictEqual(isReadOnlyBash("find . -type f | head"), true);
    assert.strictEqual(isReadOnlyBash("find . -name '*.tmp' -delete"), false);
    assert.strictEqual(isReadOnlyBash("find . -exec rm {} +"), false);
    assert.strictEqual(isReadOnlyBash("find . -execdir touch x \\;"), false);
    assert.strictEqual(isReadOnlyBash("find . -ok rm {} \\;"), false);
    assert.strictEqual(isReadOnlyBash("find . -fprint /tmp/out"), false);
  });

  it("validates git subcommands", () => {
    assert.strictEqual(isReadOnlyBash("git branch"), true);
    assert.strictEqual(isReadOnlyBash("git branch -d foo"), false);
    assert.strictEqual(isReadOnlyBash("git stash list"), true);
    assert.strictEqual(isReadOnlyBash("git stash push"), false);
    assert.strictEqual(isReadOnlyBash("git remote -v"), true);
    assert.strictEqual(isReadOnlyBash("git remote add origin foo"), false);
    assert.strictEqual(isReadOnlyBash("git tag -l"), true);
    assert.strictEqual(isReadOnlyBash("git tag v1.0"), false);
    assert.strictEqual(isReadOnlyBash("git config --list"), true);
    assert.strictEqual(isReadOnlyBash("git config user.name foo"), false);
  });
});

describe("isBlockedInPlanMode", () => {
  it("blocks mutating tools", () => {
    assert.strictEqual(isBlockedInPlanMode("write"), true);
    assert.strictEqual(isBlockedInPlanMode("edit"), true);
    assert.strictEqual(isBlockedInPlanMode("bash"), true);
    assert.strictEqual(isBlockedInPlanMode("mcp_fs"), true);
    assert.strictEqual(isBlockedInPlanMode("lsp_rename"), true);
    assert.strictEqual(isBlockedInPlanMode("browser_fetch"), true);
    for (const tool of ["github_create_pr", "memory_remember", "memory_forget", "job_start", "job_cancel", "subagent", "changelog_image"]) {
      assert.strictEqual(isBlockedInPlanMode(tool), true, tool);
    }
  });

  it("allows read-only tools", () => {
    assert.strictEqual(isBlockedInPlanMode("read"), false);
    assert.strictEqual(isBlockedInPlanMode("grep"), false);
    assert.strictEqual(isBlockedInPlanMode("glob"), false);
    assert.strictEqual(isBlockedInPlanMode("web_fetch"), false);
  });

  it("fails closed for plan-mode permissions and allows only safe reads", () => {
    assert.equal(isAllowedInPlanMode("read"), true);
    assert.equal(isAllowedInPlanMode("tasks_set"), true);
    assert.equal(isAllowedInPlanMode("bash", { command: "git status && git diff" }), true);
    assert.equal(isAllowedInPlanMode("bash", { command: "git push origin feature" }), false);
    assert.equal(isAllowedInPlanMode("github_create_pr", {}), false);
    assert.equal(isAllowedInPlanMode("unknown_mutator", {}), false);
    assert.match(systemPromptForMode("plan"), /numbered plan/);
  });

  it("requires auto-mode approval before recognized external actions", () => {
    assert.equal(requiresApprovalInAutoMode("github_create_pr", {}), true);
    assert.equal(requiresApprovalInAutoMode("bash", { command: "git push origin feature" }), true);
    assert.equal(requiresApprovalInAutoMode("bash", { command: "curl -X DELETE http://proxy/api/repos/o/r" }), true);
    assert.equal(requiresApprovalInAutoMode("bash", { command: "git status" }), false);
    assert.equal(requiresApprovalInAutoMode("write", {}), false);
  });
});

describe("nextMode", () => {
  it("cycles through modes", () => {
    assert.strictEqual(nextMode("edit"), "plan");
    assert.strictEqual(nextMode("plan"), "auto");
    assert.strictEqual(nextMode("auto"), "edit");
  });
});

describe("modeDescription", () => {
  it("returns descriptions for all modes", () => {
    for (const mode of MODES) {
      assert.ok(modeDescription(mode).length > 0);
    }
  });
});
