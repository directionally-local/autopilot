import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, buildCoauthorTrailer, getShellCommand, guardGitPush, injectCoauthor, parsePushTarget } from "./bash.js";
import type { ToolContext } from "./registry.js";

describe("getShellCommand", () => {
  it("returns bash for explicit 'bash'", () => {
    const result = getShellCommand("bash");
    assert.strictEqual(result.shell, "bash");
    assert.deepStrictEqual(result.args, ["-lc"]);
    assert.strictEqual(result.isPosix, true);
  });

  it("returns cmd for explicit 'cmd'", () => {
    const result = getShellCommand("cmd");
    assert.ok(result.shell.toLowerCase().includes("cmd"));
    assert.deepStrictEqual(result.args, ["/c"]);
    assert.strictEqual(result.isPosix, false);
  });

  it("returns powershell for explicit 'powershell'", () => {
    const result = getShellCommand("powershell");
    assert.strictEqual(result.shell, "powershell");
    assert.deepStrictEqual(result.args, ["-Command"]);
    assert.strictEqual(result.isPosix, false);
  });

  it("returns bash for undefined (auto on non-Windows)", () => {
    const result = getShellCommand();
    // On non-Windows platforms this should be bash
    // On Windows it would be cmd.exe; we run tests on Unix CI
    if (process.platform !== "win32") {
      assert.strictEqual(result.shell, "bash");
      assert.deepStrictEqual(result.args, ["-lc"]);
      assert.strictEqual(result.isPosix, true);
    }
  });

  it("returns bash for 'auto' on non-Windows", () => {
    const result = getShellCommand("auto");
    if (process.platform !== "win32") {
      assert.strictEqual(result.shell, "bash");
      assert.deepStrictEqual(result.args, ["-lc"]);
      assert.strictEqual(result.isPosix, true);
    }
  });

  it("treats absolute paths to bash-like shells as POSIX", () => {
    const result = getShellCommand("/usr/bin/zsh");
    assert.strictEqual(result.shell, "/usr/bin/zsh");
    assert.deepStrictEqual(result.args, ["-lc"]);
    assert.strictEqual(result.isPosix, true);
  });

  it("treats absolute paths to cmd as non-POSIX", () => {
    const result = getShellCommand("C:\\Windows\\System32\\cmd.exe");
    assert.strictEqual(result.shell, "C:\\Windows\\System32\\cmd.exe");
    assert.deepStrictEqual(result.args, ["/c"]);
    assert.strictEqual(result.isPosix, false);
  });

  it("treats absolute paths to powershell as non-POSIX", () => {
    const result = getShellCommand("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.strictEqual(result.shell, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.deepStrictEqual(result.args, ["-Command"]);
    assert.strictEqual(result.isPosix, false);
  });

  it("is case-insensitive for named shells", () => {
    const bash = getShellCommand("BASH");
    assert.strictEqual(bash.shell, "bash");

    const cmd = getShellCommand("CMD");
    assert.ok(cmd.shell.toLowerCase().includes("cmd"));

    const ps = getShellCommand("PowerShell");
    assert.strictEqual(ps.shell, "powershell");
  });
});

describe("parsePushTarget", () => {
  it("detects current branch push", () => {
    assert.deepStrictEqual(parsePushTarget("git push"), { kind: "current" });
    assert.deepStrictEqual(parsePushTarget("git push origin"), { kind: "current" });
  });

  it("detects explicit branch push", () => {
    assert.deepStrictEqual(parsePushTarget("git push origin feat"), { kind: "ref", ref: "feat" });
  });

  it("detects --all", () => {
    assert.deepStrictEqual(parsePushTarget("git push --all origin"), { kind: "all" });
  });

  it("detects --mirror", () => {
    assert.deepStrictEqual(parsePushTarget("git push --mirror"), { kind: "mirror" });
  });

  it("parses refspec with dst", () => {
    assert.deepStrictEqual(parsePushTarget("git push origin feat:main"), { kind: "ref", ref: "main" });
  });

  it("ignores non-push commands", () => {
    assert.strictEqual(parsePushTarget("git status"), undefined);
  });
});

describe("guardGitPush", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bash-guard-"));
    execSync("git init -b main", { cwd: repo });
    execSync("git config user.email test@example.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "a");
    execSync("git add . && git commit -m init", { cwd: repo });
    const remote = join(repo, "remote.git");
    execSync(`git init --bare ${remote}`);
    execSync(`git remote add origin ${remote}`, { cwd: repo });
    execSync("git push origin main", { cwd: repo });
    execSync("git remote set-head origin main", { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("allows push when allowDirectPush is true", async () => {
    const ctx = { cwd: repo, allowDirectPush: true } as ToolContext;
    const result = await guardGitPush("git push origin main", ctx);
    assert.strictEqual(result, undefined);
  });

  it("blocks push to default branch", async () => {
    const ctx = { cwd: repo, allowDirectPush: false } as ToolContext;
    const result = await guardGitPush("git push origin main", ctx);
    assert.ok(result);
    assert.ok(result!.content.includes("Blocked"));
    assert.ok(result!.content.includes("github_create_pr"));
  });

  it("allows push to non-default branch", async () => {
    execSync("git checkout -b feat", { cwd: repo });
    const ctx = { cwd: repo, allowDirectPush: false } as ToolContext;
    const result = await guardGitPush("git push origin feat", ctx);
    assert.strictEqual(result, undefined);
  });

  it("blocks --all pushes", async () => {
    const ctx = { cwd: repo, allowDirectPush: false } as ToolContext;
    const result = await guardGitPush("git push --all origin", ctx);
    assert.ok(result);
    assert.ok(result!.content.includes("Blocked"));
  });
});

describe("co-author trailer injection", { skip: process.platform === "win32" }, () => {
  let repo: string;
  let marker: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bash-coauthor-"));
    marker = join(repo, "PWNED");
    execSync("git init -q -b main", { cwd: repo });
    execSync("git config user.email test@example.com", { cwd: repo });
    execSync("git config user.name Test", { cwd: repo });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  async function commitWith(coauthor: { name: string; email: string }, command = "git commit -q -m 'add file'"): Promise<string> {
    writeFileSync(join(repo, `f-${Math.random().toString(36).slice(2)}.txt`), "x");
    execSync("git add -A", { cwd: repo });
    const ctx = { cwd: repo, coauthor, signal: new AbortController().signal } as unknown as ToolContext;
    const out = await bashTool.run({ command }, ctx);
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /^exit=0/, content);
    return execSync("git log -1 --pretty=%B", { cwd: repo, encoding: "utf8" });
  }

  it("keeps shell metacharacters in configured values inert", async () => {
    const payloads = [
      { name: `Eve"; touch ${marker}; echo "`, email: "eve@example.com" },
      { name: "Eve $(touch " + marker + ")", email: "eve@example.com" },
      { name: "Eve `touch " + marker + "`", email: "eve@example.com" },
      { name: "Eve'; touch " + marker + "; '", email: "e;touch " + marker + "@example.com" },
      { name: "Ève Ünïcode 測試", email: "eve+tag@example.com" },
    ];
    for (const coauthor of payloads) {
      const message = await commitWith(coauthor);
      assert.equal(existsSync(marker), false, `payload executed: ${coauthor.name}`);
      const trailer = buildCoauthorTrailer(coauthor)!;
      assert.equal(message.split(trailer).length - 1, 1, `trailer written exactly once for ${coauthor.name}`);
    }
  });

  it("never splices configured values into the generated script", () => {
    const coauthor = { name: "Eve $(id)", email: "eve@example.com" };
    for (const command of ["git commit -m x", "make release && git log -1"]) {
      const { command: script, env } = injectCoauthor(command, coauthor);
      assert.ok(!script.includes("Eve"), "name absent from shell source");
      assert.ok(!script.includes("eve@example.com"), "email absent from shell source");
      assert.equal(env.KF_COAUTHOR_TRAILER, "Co-authored-by: Eve $(id) <eve@example.com>");
    }
  });

  it("rejects line breaks and control characters instead of adding extra trailers", async () => {
    assert.equal(buildCoauthorTrailer({ name: "Eve\nSigned-off-by: Mallory", email: "e@example.com" }), null);
    assert.equal(buildCoauthorTrailer({ name: "Eve", email: "e@example.com\r" }), null);
    assert.equal(buildCoauthorTrailer({ name: "Eve\u0007", email: "e@example.com" }), null);
    assert.equal(buildCoauthorTrailer({ name: "Eve", email: "e@example.com> x <" }), null);
    const message = await commitWith({ name: "Eve\nSigned-off-by: Mallory", email: "e@example.com" });
    assert.doesNotMatch(message, /Co-authored-by|Mallory/);
  });

  it("does not duplicate an existing trailer and leaves non-git commands alone", async () => {
    const coauthor = { name: "Pair", email: "pair@example.com" };
    const first = await commitWith(coauthor);
    assert.equal(first.split("Co-authored-by: Pair").length - 1, 1);
    const amended = await commitWith(coauthor, "git commit -q --amend --no-edit");
    assert.equal(amended.split("Co-authored-by: Pair").length - 1, 1);
    assert.deepEqual(injectCoauthor("ls -la", coauthor), { command: "ls -la", env: {} });
    assert.deepEqual(injectCoauthor("git commit -m x", undefined), { command: "git commit -m x", env: {} });
  });

  it("covers commits made indirectly and cleans up its temp file", async () => {
    await commitWith({ name: "Pair", email: "pair@example.com" }); // initial commit: the safety net needs a prior HEAD
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("kf-coauthor-")).length;
    writeFileSync(join(repo, "script.sh"), "git commit -q -m scripted\n");
    const message = await commitWith({ name: "Pair", email: "pair@example.com" }, "sh script.sh && echo git done");
    assert.match(message, /Co-authored-by: Pair <pair@example.com>/);
    const after = readdirSync(tmpdir()).filter((f) => f.startsWith("kf-coauthor-")).length;
    assert.ok(after <= before, "temp message file removed");
  });
});
