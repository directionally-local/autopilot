import { describe, it, beforeEach, afterEach } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashTool, buildCoauthorTrailer, getShellCommand, guardGitCommit, guardGitPush, guardSweep, injectCoauthor, isFileReadCommand, parsePushTarget } from "./bash.js";
import type { ToolContext } from "./registry.js";

describe("isFileReadCommand", () => {
  it("matches plain file readers", () => {
    for (const cmd of [
      "cat src/index.ts",
      "head -n 40 src/index.ts",
      "tail -20 README.md",
      "nl -ba src/index.ts",
      "bat src/index.ts",
      "sed -n '1,40p' src/index.ts",
      "sed -n 1,40p src/index.ts",
      "awk 'NR>=1 && NR<=120' src/index.ts",
      "cat src/index.ts | head -20",
    ]) {
      assert.strictEqual(isFileReadCommand(cmd), true, cmd);
    }
  });

  it("does not match searches, writes, or compound commands", () => {
    for (const cmd of [
      "grep -n foo src/index.ts",
      "find . -name '*.ts'",
      "ls -la",
      "echo hi",
      "cat src/index.ts > out.txt",
      "cat src/index.ts && rm out.txt",
      "cat src/index.ts; echo done",
      "sed -i 's/a/b/' src/index.ts",
      "awk '{print $1}' src/index.ts",
      "cat $(echo file)",
      "",
    ]) {
      assert.strictEqual(isFileReadCommand(cmd), false, cmd);
    }
  });
});

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

  it("finds the push in a compound command", () => {
    assert.deepStrictEqual(parsePushTarget("cd sub && git push origin main"), { kind: "ref", ref: "main" });
    assert.deepStrictEqual(parsePushTarget("git add -A; git push"), { kind: "current" });
    assert.deepStrictEqual(parsePushTarget("(cd sub && git push --all)"), { kind: "all" });
    assert.deepStrictEqual(parsePushTarget("git -C sub push origin main"), { kind: "ref", ref: "main" });
  });

  it("does not treat a non-push git command as a push", () => {
    assert.strictEqual(parsePushTarget("git commit -m 'push the button'"), undefined);
    assert.strictEqual(parsePushTarget("echo git push"), undefined);
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

describe("guardGitCommit", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "bash-commit-guard-"));
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

  it("blocks a commit on the default branch", async () => {
    const ctx = { cwd: repo } as ToolContext;
    const result = await guardGitCommit("git commit -m 'change'", ctx);
    assert.ok(result);
    assert.match(result!.content, /Blocked/);
    assert.match(result!.content, /git switch -c/);
    assert.match(result!.content, /github_create_pr/);
  });

  it("blocks a commit chained after other commands", async () => {
    const ctx = { cwd: repo } as ToolContext;
    const result = await guardGitCommit("git add -A && git commit -m 'change'", ctx);
    assert.ok(result);
  });

  it("blocks reset --hard on the default branch", async () => {
    const ctx = { cwd: repo } as ToolContext;
    const result = await guardGitCommit("git reset --hard HEAD~1", ctx);
    assert.ok(result);
    assert.match(result!.content, /reset --hard/);
  });

  it("allows a commit on a feature branch", async () => {
    execSync("git checkout -b feat", { cwd: repo });
    const ctx = { cwd: repo } as ToolContext;
    assert.strictEqual(await guardGitCommit("git commit -m 'change'", ctx), undefined);
  });

  it("allows a commit after switching to a new branch in the same command", async () => {
    const ctx = { cwd: repo } as ToolContext;
    assert.strictEqual(await guardGitCommit("git switch -c feat && git commit -m 'change'", ctx), undefined);
  });

  it("allows abort/continue forms that do not create commits", async () => {
    const ctx = { cwd: repo } as ToolContext;
    assert.strictEqual(await guardGitCommit("git rebase --abort", ctx), undefined);
    assert.strictEqual(await guardGitCommit("git merge --abort", ctx), undefined);
  });

  it("allows commits when allowDirectPush is true", async () => {
    const ctx = { cwd: repo, allowDirectPush: true } as ToolContext;
    assert.strictEqual(await guardGitCommit("git commit -m 'change'", ctx), undefined);
  });

  it("allows commits when preferPullRequests is false", async () => {
    const ctx = { cwd: repo, preferPullRequests: false } as ToolContext;
    assert.strictEqual(await guardGitCommit("git commit -m 'change'", ctx), undefined);
  });

  it("ignores commands that do not touch git history", async () => {
    const ctx = { cwd: repo } as ToolContext;
    assert.strictEqual(await guardGitCommit("npm test", ctx), undefined);
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
    const ctx = { cwd: repo, coauthor, allowDirectPush: true, signal: new AbortController().signal } as unknown as ToolContext;
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

describe("process tree kill", { skip: process.platform === "win32" }, () => {
  let dir: string;
  let marker: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bash-kill-"));
    marker = join(dir, "orphan-survived");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The marker is only written if the backgrounded subshell outlives the
  // kill: with a working process-tree kill it never appears.
  const orphanCommand = () => `(sleep 3; touch "${marker.replace(/"/g, '\\"')}") & sleep 300`;

  it("kills backgrounded children on timeout", async () => {
    const ctx = { cwd: dir, signal: new AbortController().signal } as unknown as ToolContext;
    const out = await bashTool.run({ command: orphanCommand(), timeout_ms: 1000 }, ctx);
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /timed out/, content);
    await delay(4000);
    assert.equal(existsSync(marker), false, "orphaned child survived the timeout");
  });

  it("kills backgrounded children on abort", async () => {
    const controller = new AbortController();
    const ctx = { cwd: dir, signal: controller.signal } as unknown as ToolContext;
    const promise = bashTool.run({ command: orphanCommand(), timeout_ms: 60_000 }, ctx);
    setTimeout(() => controller.abort(), 500);
    const out = await promise;
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /aborted/, content);
    await delay(4000);
    assert.equal(existsSync(marker), false, "orphaned child survived the abort");
  });
});

describe("guardSweep", () => {
  it("blocks recursive grep on the bare home directory", () => {
    const result = guardSweep("grep -rln some-token ~");
    assert.ok(result);
    assert.match(result!.content, /Blocked/);
    assert.match(result!.content, /AUTOPILOT_ALLOW_HOME_SWEEP/);
  });

  it("blocks grep with long --recursive flag and $HOME", () => {
    assert.ok(guardSweep("grep --recursive pattern $HOME"));
  });

  it("blocks ripgrep on home even when piped to head", () => {
    assert.ok(guardSweep("rg secret ~ | head -20"));
  });

  it("blocks find over home; -maxdepth 4 is not shallow enough (measured timeout)", () => {
    assert.ok(guardSweep("find ~ -maxdepth 4 -name '*.json'"));
  });

  it("blocks a search of the filesystem root", () => {
    assert.ok(guardSweep("grep -rn pattern /"));
  });

  it("blocks a recursive search after cd-ing into home", () => {
    assert.ok(guardSweep("cd ~ && grep -rn pattern ."));
  });

  it("allows a shallow find over home", () => {
    assert.strictEqual(guardSweep("find ~ -maxdepth 2 -name '.git'"), undefined);
  });

  it("allows recursive search of a specific subdirectory of home", () => {
    assert.strictEqual(guardSweep("grep -rn pattern ~/.config/autopilot"), undefined);
  });

  it("allows recursive search of the project and the working directory", () => {
    assert.strictEqual(guardSweep("grep -rn pattern ."), undefined);
    assert.strictEqual(guardSweep("rg pattern src/"), undefined);
    assert.strictEqual(guardSweep("find . -name '*.ts'"), undefined);
  });

  it("allows non-recursive grep, even on a home-relative file", () => {
    assert.strictEqual(guardSweep("grep pattern ~/.zshrc"), undefined);
  });

  it("allows unrelated commands that mention home", () => {
    assert.strictEqual(guardSweep("cat ~/.config/autopilot/config.json"), undefined);
    assert.strictEqual(guardSweep("ls ~"), undefined);
    assert.strictEqual(guardSweep("echo $HOME"), undefined);
  });

  it("does not treat an option value that is `~` as a search target", () => {
    assert.strictEqual(guardSweep("grep -rn -e '~' src/"), undefined);
  });

  it("can be disabled with AUTOPILOT_ALLOW_HOME_SWEEP=1", () => {
    process.env.AUTOPILOT_ALLOW_HOME_SWEEP = "1";
    try {
      assert.strictEqual(guardSweep("grep -rln token ~"), undefined);
    } finally {
      delete process.env.AUTOPILOT_ALLOW_HOME_SWEEP;
    }
  });

  it("the bash tool refuses a home sweep before spawning", async () => {
    const out = await bashTool.run({ command: "grep -rln token ~" }, { cwd: "." } as ToolContext);
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /Blocked/);
  });
});

describe("bash foreground→background handoff (#1101)", { concurrency: 1 }, () => {
  const isWindows = process.platform === "win32";
  let dir: string;
  let dbPath: string;
  let savedBudget: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bash-handoff-"));
    dbPath = join(dir, "state", "jobs.db");
    savedBudget = process.env.AUTOPILOT_BASH_FOREGROUND_MS;
  });
  afterEach(() => {
    if (savedBudget === undefined) delete process.env.AUTOPILOT_BASH_FOREGROUND_MS;
    else process.env.AUTOPILOT_BASH_FOREGROUND_MS = savedBudget;
    rmSync(dir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ cwd: dir, jobsDbPath: dbPath, sessionId: "handoff-test" } as ToolContext);

  it("foregroundBudgetMs parses the env override", async () => {
    const { foregroundBudgetMs } = await import("./bash.js");
    assert.strictEqual(foregroundBudgetMs({}), 30_000);
    assert.strictEqual(foregroundBudgetMs({ AUTOPILOT_BASH_FOREGROUND_MS: "0" }), 0);
    assert.strictEqual(foregroundBudgetMs({ AUTOPILOT_BASH_FOREGROUND_MS: "5000" }), 5000);
    assert.strictEqual(foregroundBudgetMs({ AUTOPILOT_BASH_FOREGROUND_MS: "nonsense" }), 30_000);
  });

  it("returns a fast command like the direct path", { skip: isWindows }, async () => {
    process.env.AUTOPILOT_BASH_FOREGROUND_MS = "10000";
    const out = await bashTool.run({ command: "echo quick-done" }, ctx());
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /exit=0/);
    assert.match(content, /quick-done/);
    assert.doesNotMatch(content, /moved to background/);
  });

  it("moves a slow command to a durable job and delivers its completion", { skip: isWindows }, async () => {
    process.env.AUTOPILOT_BASH_FOREGROUND_MS = "400";
    const out = await bashTool.run({ command: "sleep 1; echo late-output" }, ctx());
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /moved to background after 400ms/);
    const jobId = (out as { meta?: { jobId?: string } }).meta?.jobId;
    assert.ok(jobId, "handoff result should carry the job id");
    assert.match(content, new RegExp(jobId!));

    const { drainFinishedHandoffs, renderHandoffCompletion, untrackSession } = await import("../jobs/handoff.js");
    try {
      const deadline = Date.now() + 8000;
      let drained: import("../jobs/manager.js").JobRecord[] = [];
      while (Date.now() < deadline && drained.length === 0) {
        await delay(150);
        drained = drainFinishedHandoffs("handoff-test", dbPath);
      }
      assert.strictEqual(drained.length, 1, "the handed-off job should be drained exactly once");
      assert.strictEqual(drained[0]!.status, "completed");
      const notice = renderHandoffCompletion(drained[0]!, dbPath);
      assert.match(notice, /late-output/);
    } finally {
      untrackSession("handoff-test");
    }
  });

  it("keeps kill-at-timeout when the timeout is shorter than the budget", { skip: isWindows }, async () => {
    process.env.AUTOPILOT_BASH_FOREGROUND_MS = "60000";
    const out = await bashTool.run({ command: "sleep 10", timeout_ms: 1000 }, ctx());
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /timed out after 1000ms/);
    assert.doesNotMatch(content, /moved to background/);
  });

  it("0 disables the handoff path entirely", { skip: isWindows }, async () => {
    process.env.AUTOPILOT_BASH_FOREGROUND_MS = "0";
    const out = await bashTool.run({ command: "sleep 10", timeout_ms: 1000 }, ctx());
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /timed out after 1000ms/);
  });

  it("an explicit timeout_ms stays the kill deadline of the backgrounded job", { skip: isWindows }, async () => {
    process.env.AUTOPILOT_BASH_FOREGROUND_MS = "300";
    const out = await bashTool.run({ command: "sleep 30", timeout_ms: 1200 }, ctx());
    const { untrackSession } = await import("../jobs/handoff.js");
    untrackSession("handoff-test");
    const jobId = (out as { meta?: { jobId?: string } }).meta?.jobId;
    assert.ok(jobId);
    const { JobManager } = await import("../jobs/manager.js");
    const jobs = new JobManager(dbPath);
    try {
      const deadline = Date.now() + 8000;
      let status: string | undefined;
      while (Date.now() < deadline) {
        status = jobs.get(jobId!)?.status;
        if (status === "timed_out") break;
        await delay(150);
      }
      assert.strictEqual(status, "timed_out");
    } finally {
      jobs.close();
    }
  });
});
