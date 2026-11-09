import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, classifyToolCall, type ClassifyContext } from "./destructive.js";
import { createRecoveryPoint, describeRecoveryPoint, latestRecoveryPoint, undoLatest } from "./recovery.js";

let T: string;
let R: string;
let ctx: ClassifyContext;
const savedDir = process.env.AUTOPILOT_RECOVERY_DIR;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function point(command: string) {
  const a = classifyCommand(command, ctx);
  assert.notStrictEqual(a.verdict, "safe", command);
  const m = createRecoveryPoint(a.findings, { project: R, tool: "bash" });
  assert.ok(m, `a recovery point for ${command}`);
  return m!;
}

before(() => {
  // Resolve the temp root once: git reports the /private/var realpath on macOS.
  T = realpathSync(mkdtempSync(join(tmpdir(), "ap-recovery-")));
  process.env.AUTOPILOT_RECOVERY_DIR = join(T, "state");
});

after(() => {
  if (savedDir === undefined) delete process.env.AUTOPILOT_RECOVERY_DIR;
  else process.env.AUTOPILOT_RECOVERY_DIR = savedDir;
  rmSync(T, { recursive: true, force: true });
});

beforeEach(() => {
  R = mkdtempSync(join(T, "repo-"));
  git(R, "init", "-q");
  writeFileSync(join(R, "a.txt"), "one\n");
  git(R, "add", ".");
  git(R, "commit", "-qm", "one");
  ctx = { cwd: R, env: {}, scratchDirs: [T, realpathSync(T)] };
});

describe("recovery points and /undo", () => {
  it("restores deleted files that git can't", () => {
    mkdirSync(join(R, "data", "deep"), { recursive: true });
    writeFileSync(join(R, "data", "x.csv"), "1,2\n");
    writeFileSync(join(R, "data", "deep", "y.csv"), "3,4\n");
    const m = point("rm -rf data");
    assert.match(describeRecoveryPoint(m), /a copy of 2 files/);
    rmSync(join(R, "data"), { recursive: true });
    const msg = undoLatest(R);
    assert.match(msg, /^Undid `rm -rf data` .*restored 2 files/);
    assert.strictEqual(readFileSync(join(R, "data", "deep", "y.csv"), "utf8"), "3,4\n");
    assert.strictEqual(undoLatest(R), "Nothing to undo: Autopilot has no recovery point for this project.");
  });

  it("restores an overwritten file", () => {
    writeFileSync(join(R, "notes.md"), "my notes\n");
    const a = classifyToolCall("write", { path: "notes.md", content: "replaced" }, ctx);
    assert.strictEqual(a.verdict, "recoverable");
    assert.ok(createRecoveryPoint(a.findings, { project: R, tool: "write" }));
    writeFileSync(join(R, "notes.md"), "replaced");
    assert.match(undoLatest(R), /restored 1 file \(notes\.md\)/);
    assert.strictEqual(readFileSync(join(R, "notes.md"), "utf8"), "my notes\n");
  });

  it("undoes reset --hard: the old commit and the uncommitted changes", () => {
    writeFileSync(join(R, "a.txt"), "two\n");
    git(R, "commit", "-qam", "two");
    const two = git(R, "rev-parse", "HEAD");
    writeFileSync(join(R, "a.txt"), "three, not committed\n");
    point("git reset --hard HEAD~1");
    git(R, "reset", "-q", "--hard", "HEAD~1");
    assert.strictEqual(readFileSync(join(R, "a.txt"), "utf8"), "one\n");
    const msg = undoLatest(R);
    assert.match(msg, new RegExp(`moved main back to ${two.slice(0, 7)}`));
    assert.match(msg, /restored 1 file \(a\.txt\)/);
    assert.strictEqual(git(R, "rev-parse", "HEAD"), two);
    assert.strictEqual(readFileSync(join(R, "a.txt"), "utf8"), "three, not committed\n");
  });

  it("undoes a force push by pushing the old commit back", () => {
    const remote = join(T, `remote-${Date.now()}.git`);
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(R, "remote", "add", "origin", remote);
    git(R, "push", "-q", "-u", "origin", "main");
    const old = git(R, "rev-parse", "HEAD");
    writeFileSync(join(R, "a.txt"), "rewritten\n");
    git(R, "commit", "-q", "-a", "--amend", "-m", "rewritten");
    const m = point("git push --force origin main");
    assert.strictEqual(m.git.remote?.sha, old);
    git(R, "push", "-q", "--force", "origin", "main");
    assert.notStrictEqual(execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), old);
    assert.match(undoLatest(R), new RegExp(`pushed origin/main back to ${old.slice(0, 7)}`));
    assert.strictEqual(execFileSync("git", ["-C", remote, "rev-parse", "main"], { encoding: "utf8" }).trim(), old);
  });

  it("recreates a branch deleted with -D", () => {
    git(R, "checkout", "-q", "-b", "wip");
    writeFileSync(join(R, "b.txt"), "unmerged\n");
    git(R, "add", ".");
    git(R, "commit", "-qm", "unmerged");
    const sha = git(R, "rev-parse", "HEAD");
    git(R, "checkout", "-q", "main");
    point("git branch -D wip");
    git(R, "branch", "-q", "-D", "wip");
    assert.match(undoLatest(R), /recreated branch wip/);
    assert.strictEqual(git(R, "rev-parse", "wip"), sha);
  });

  it("keeps points per project and restores the latest first", () => {
    writeFileSync(join(R, "f1.txt"), "first");
    point("rm f1.txt");
    writeFileSync(join(R, "f2.txt"), "second");
    point("rm f2.txt");
    rmSync(join(R, "f1.txt"));
    rmSync(join(R, "f2.txt"));
    assert.match(undoLatest(R), /f2\.txt/);
    assert.ok(existsSync(join(R, "f2.txt")) && !existsSync(join(R, "f1.txt")));
    assert.match(undoLatest(R), /f1\.txt/);
    assert.strictEqual(latestRecoveryPoint(join(T, "elsewhere")), null);
  });

  it("makes no point when nothing needs saving", () => {
    const a = classifyCommand("rm a.txt", ctx);
    assert.strictEqual(a.verdict, "recoverable"); // committed: git restores it
    assert.strictEqual(createRecoveryPoint(a.findings, { project: R, tool: "bash" }), null);
  });
});
