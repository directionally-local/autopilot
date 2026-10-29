import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_TOOLS, ToolExecutor } from "../tools/executor.js";
import { dispatchSlashCommand, type SlashContext } from "../ui/slash-commands.js";
import {
  asksToWorkInPlace,
  isMutatingToolCall,
  listSessionWorktrees,
  removeSessionWorktree,
  SessionWorktree,
  type SessionWorktreeInfo,
} from "./session-worktrees.js";

const tempDirs: string[] = [];
const controllers: SessionWorktree[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) c.dispose();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const allowAll = async () => "allow" as const;

interface Fixture {
  root: string;
  repo: string;
  /** A second clone used to advance origin/main behind the user's back. */
  other: string;
  worktrees: string;
}

/** origin (bare) ← repo (the user's checkout, on main, clean) and other. */
async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-session-wt-")));
  tempDirs.push(root);
  const seed = join(root, "seed");
  await mkdir(join(seed, "packages", "app"), { recursive: true });
  git(["init", "--quiet", "--initial-branch=main"], seed);
  configure(seed);
  await writeFile(join(seed, "README.md"), "tracked\n");
  await writeFile(join(seed, "packages", "app", "index.txt"), "app\n");
  await writeFile(join(seed, ".gitignore"), ".env\nnode_modules/\n");
  git(["add", "."], seed);
  git(["commit", "--quiet", "-m", "initial"], seed);
  git(["clone", "--quiet", "--bare", seed, join(root, "origin.git")], root);
  git(["clone", "--quiet", join(root, "origin.git"), join(root, "repo")], root);
  git(["clone", "--quiet", join(root, "origin.git"), join(root, "other")], root);
  configure(join(root, "repo"));
  configure(join(root, "other"));
  return { root, repo: join(root, "repo"), other: join(root, "other"), worktrees: join(root, "state", "worktrees") };
}

function configure(repo: string): void {
  git(["config", "user.name", "Autopilot test"], repo);
  git(["config", "user.email", "autopilot-test@example.invalid"], repo);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Everything about the user's checkout a session must leave alone. */
function snapshot(repo: string): string {
  return [
    git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored"], repo),
    git(["rev-parse", "HEAD"], repo),
    git(["branch", "--show-current"], repo),
    git(["rev-parse", "refs/remotes/origin/main"], repo),
    git(["rev-parse", "refs/heads/main"], repo),
  ].join("\n--\n");
}

function controller(sourceCwd: string, worktrees: string, overrides: Partial<ConstructorParameters<typeof SessionWorktree>[0]> = {}) {
  const notices: string[] = [];
  const c = new SessionWorktree({
    sourceCwd,
    enabled: () => true,
    sessionId: () => "session-1",
    onNotice: (text) => notices.push(text),
    rootDir: worktrees,
    fetchTimeoutMs: 10_000,
    ...overrides,
  });
  controllers.push(c);
  return { c, notices };
}

async function run(exec: ToolExecutor, sw: SessionWorktree, cwd: string, name: string, args: Record<string, unknown>) {
  return exec.run({ id: randomUUID(), name, arguments: JSON.stringify(args) }, allowAll, {
    cwd,
    sessionId: "session-1",
    sessionWorktree: sw,
    postEditDiagnostics: false,
  });
}

describe("SessionWorktree", () => {
  it("creates a worktree on the first mutating call and runs later calls there", async () => {
    const f = await fixture();
    // origin/main moves ahead after the user's last fetch.
    await writeFile(join(f.other, "LATEST.md"), "newer\n");
    git(["add", "."], f.other);
    git(["commit", "--quiet", "-m", "newer"], f.other);
    git(["push", "--quiet", "origin", "main"], f.other);
    const before = snapshot(f.repo);
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c, notices } = controller(f.repo, f.worktrees);

    const read = await run(exec, c, f.repo, "read", { path: "README.md" });
    assert.equal(read.ok, true);
    assert.equal(c.active, null, "a read-only call creates no worktree");
    const ls = await run(exec, c, f.repo, "bash", { command: "git status --short" });
    assert.equal(ls.ok, true);
    assert.equal(c.active, null, "a read-only bash call creates no worktree");

    const write = await run(exec, c, f.repo, "write", { path: "NEW.txt", content: "from the agent\n" });
    assert.equal(write.ok, true, write.content);
    const wt = c.active as SessionWorktreeInfo | null;
    assert.ok(wt, "the first write creates a worktree");
    assert.match(write.content, /isolated git worktree/);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, new RegExp(`${wt.path}.*branch ${wt.branch}`));
    assert.match(wt.branch, /^autopilot\/\d{8}-[0-9a-f]{6}$/);
    assert.equal(git(["branch", "--show-current"], wt.path), wt.branch);
    assert.equal(await readFile(join(wt.path, "NEW.txt"), "utf8"), "from the agent\n");
    // Based on the latest origin/main, which the user's checkout has not fetched.
    assert.equal(await readFile(join(wt.path, "LATEST.md"), "utf8"), "newer\n");

    const pwd = await run(exec, c, f.repo, "bash", { command: "pwd" });
    assert.ok(pwd.content.split("\n").includes(wt.path), pwd.content);
    assert.doesNotMatch(pwd.content, /isolated git worktree/, "the model is told once");
    const edit = await run(exec, c, f.repo, "edit", { path: "README.md", old_string: "tracked", new_string: "edited" });
    assert.equal(edit.ok, true, edit.content);
    const commit = await run(exec, c, f.repo, "bash", { command: "git add -A && git commit --quiet -m 'agent work'" });
    assert.equal(commit.ok, true, commit.content);

    await assert.rejects(access(join(f.repo, "NEW.txt")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.repo, "README.md"), "utf8"), "tracked\n");
    assert.equal(snapshot(f.repo), before, "the user's checkout is unchanged");
    assert.equal(git(["for-each-ref", "refs/autopilot"], f.repo), "", "the private fetch ref is cleaned up");
    assert.equal(notices.length, 1, "the user is told once");
  });

  it("redirects absolute paths and commands that point into the checkout", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const sub = join(f.repo, "packages", "app");
    const { c } = controller(sub, f.worktrees);

    const first = await run(exec, c, sub, "bash", { command: `cd ${f.repo} && touch made-by-bash.txt` });
    assert.equal(first.ok, true, first.content);
    const wt = c.active!;
    assert.equal(wt.cwd, join(wt.path, "packages", "app"), "a monorepo subdirectory maps into the worktree");
    await access(join(wt.path, "made-by-bash.txt"));
    const write = await run(exec, c, sub, "write", { path: join(f.repo, "abs.txt"), content: "x\n" });
    assert.equal(write.ok, true, write.content);
    await access(join(wt.path, "abs.txt"));
    const pwd = await run(exec, c, sub, "bash", { command: "pwd" });
    assert.ok(pwd.content.split("\n").includes(wt.cwd), pwd.content);
    assert.equal(git(["status", "--porcelain"], f.repo), "");
  });

  it("works in place outside a git repository", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "autopilot-no-git-")));
    tempDirs.push(dir);
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c, notices } = controller(dir, join(dir, "..", `wt-${randomUUID()}`));

    const write = await run(exec, c, dir, "write", { path: "file.txt", content: "here\n" });
    assert.equal(write.ok, true, write.content);
    assert.equal(c.active, null);
    assert.equal(await readFile(join(dir, "file.txt"), "utf8"), "here\n");
    assert.deepEqual(notices, []);
  });

  it("works in place when the setting is off", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c } = controller(f.repo, f.worktrees, { enabled: () => false });

    await run(exec, c, f.repo, "write", { path: "in-place.txt", content: "x\n" });
    assert.equal(c.active, null);
    assert.equal(await readFile(join(f.repo, "in-place.txt"), "utf8"), "x\n");
  });

  it("stays in place when the user asks for it", async () => {
    assert.equal(asksToWorkInPlace("fix the typo in place please"), true);
    assert.equal(asksToWorkInPlace("don't use a worktree for this"), true);
    assert.equal(asksToWorkInPlace("edit it in my working copy"), true);
    assert.equal(asksToWorkInPlace("open a PR that fixes the worktree listing"), false);
    assert.equal(asksToWorkInPlace("fix the in-place sort bug in a PR"), false);

    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c, notices } = controller(f.repo, f.worktrees);
    c.noteUserMessage("work in place, no PR needed");
    await run(exec, c, f.repo, "write", { path: "asked.txt", content: "x\n" });
    assert.equal(c.active, null);
    await access(join(f.repo, "asked.txt"));
    assert.match(notices[0]!, /Working in place/);
  });

  it("gives parallel sessions their own worktrees", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const a = controller(f.repo, f.worktrees, { sessionId: () => "session-a" }).c;
    const b = controller(f.repo, f.worktrees, { sessionId: () => "session-b" }).c;

    await Promise.all([
      run(exec, a, f.repo, "write", { path: "a.txt", content: "a\n" }),
      run(exec, b, f.repo, "write", { path: "b.txt", content: "b\n" }),
    ]);
    assert.ok(a.active && b.active);
    assert.notEqual(a.active.path, b.active.path);
    assert.notEqual(a.active.branch, b.active.branch);
    await access(join(a.active.path, "a.txt"));
    await assert.rejects(access(join(a.active.path, "b.txt")), { code: "ENOENT" });
    const listed = await listSessionWorktrees(f.repo, f.worktrees);
    assert.deepEqual(new Set(listed.map((w) => w.sessionId)), new Set(["session-a", "session-b"]));
  });

  it("carries uncommitted work into the worktree without touching the checkout", async () => {
    const f = await fixture();
    await writeFile(join(f.repo, "README.md"), "user edit\n");
    await writeFile(join(f.repo, "untracked.txt"), "user file\n");
    await writeFile(join(f.repo, ".env"), "TOKEN=test\n");
    const before = snapshot(f.repo);
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c, notices } = controller(f.repo, f.worktrees);

    await run(exec, c, f.repo, "write", { path: "agent.txt", content: "x\n" });
    const wt = c.active!;
    assert.equal(await readFile(join(wt.path, "README.md"), "utf8"), "user edit\n");
    assert.equal(await readFile(join(wt.path, "untracked.txt"), "utf8"), "user file\n");
    assert.equal(await readFile(join(wt.path, ".env"), "utf8"), "TOKEN=test\n");
    assert.equal(wt.baseCommit, git(["rev-parse", "HEAD"], f.repo), "uncommitted work is based on the user's HEAD");
    assert.match(notices[0]!, /uncommitted changes were copied/);
    assert.equal(snapshot(f.repo), before);
  });

  it("reattaches a resumed session to its worktree", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const first = controller(f.repo, f.worktrees).c;
    await run(exec, first, f.repo, "write", { path: "one.txt", content: "1\n" });
    const path = first.active!.path;

    const resumed = controller(f.repo, f.worktrees).c;
    await run(exec, resumed, f.repo, "write", { path: "two.txt", content: "2\n" });
    assert.equal(resumed.active!.path, path);
    assert.equal((await listSessionWorktrees(f.repo, f.worktrees)).length, 1);
  });

  it("calls onActivate once the worktree is in use", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const activated: string[] = [];
    const { c } = controller(f.repo, f.worktrees, { onActivate: (info) => activated.push(info.path) });

    await run(exec, c, f.repo, "write", { path: "a.txt", content: "a\n" });
    assert.deepEqual(activated, [c.active!.path]);

    // Later mutating calls reuse the worktree; they do not re-activate it.
    await run(exec, c, f.repo, "write", { path: "b.txt", content: "b\n" });
    assert.equal(activated.length, 1);
  });

  it("offers cleanup at session end without deleting", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c } = controller(f.repo, f.worktrees);
    await run(exec, c, f.repo, "write", { path: "x.txt", content: "x\n" });
    const path = c.active!.path;

    const offer = await c.release();
    assert.match(offer!, /1 uncommitted file.*\/worktrees remove/);
    assert.equal(c.active, null);
    await access(join(path, "x.txt"));
  });
});

describe("session worktree cleanup", () => {
  it("refuses to remove dirty or unpushed worktrees without --force", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c } = controller(f.repo, f.worktrees);
    await run(exec, c, f.repo, "write", { path: "x.txt", content: "x\n" });
    const wt = c.active!;
    const find = async () => (await listSessionWorktrees(f.repo, f.worktrees)).find((w) => w.path === wt.path)!;

    const dirty = await find();
    assert.equal(dirty.uncommitted, 1);
    assert.deepEqual(await removeSessionWorktree(f.repo, dirty), { removed: false, reason: "1 uncommitted file" });

    git(["add", "-A"], wt.path);
    git(["commit", "--quiet", "-m", "agent"], wt.path);
    const unpushed = await find();
    assert.equal(unpushed.uncommitted, 0);
    assert.equal(unpushed.unpushed, 1);
    assert.deepEqual(await removeSessionWorktree(f.repo, unpushed), { removed: false, reason: "1 unpushed commit" });
    await access(wt.path);

    git(["push", "--quiet", "origin", wt.branch], wt.path);
    const pushed = await find();
    assert.equal(pushed.unpushed, 0);
    assert.deepEqual(await removeSessionWorktree(f.repo, pushed), { removed: true, branchKept: false });
    await assert.rejects(access(wt.path), { code: "ENOENT" });
    assert.equal(git(["branch", "--list", wt.branch], f.repo), "");
  });

  it("force-removes a dirty worktree but keeps a branch with unpushed commits", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const { c } = controller(f.repo, f.worktrees);
    await run(exec, c, f.repo, "write", { path: "x.txt", content: "x\n" });
    const wt = c.active!;
    git(["add", "-A"], wt.path);
    git(["commit", "--quiet", "-m", "agent"], wt.path);
    await writeFile(join(wt.path, "scratch.txt"), "y\n");

    const [target] = await listSessionWorktrees(f.repo, f.worktrees);
    assert.deepEqual(await removeSessionWorktree(f.repo, target!, { force: true }), { removed: true, branchKept: true });
    await assert.rejects(access(wt.path), { code: "ENOENT" });
    assert.notEqual(git(["branch", "--list", wt.branch], f.repo), "");
  });

  it("/worktrees lists, refuses dirty removals, and cleans only clean worktrees", async () => {
    const f = await fixture();
    const exec = new ToolExecutor(ALL_TOOLS);
    const dirty = controller(f.repo, f.worktrees, { sessionId: () => "dirty" }).c;
    const clean = controller(f.repo, f.worktrees, { sessionId: () => "clean" }).c;
    await run(exec, dirty, f.repo, "write", { path: "x.txt", content: "x\n" });
    await run(exec, clean, f.repo, "bash", { command: "touch t.txt && rm t.txt" });
    const dirtyPath = dirty.active!.path;
    const cleanPath = clean.active!.path;
    const current = controller(f.repo, f.worktrees, { sessionId: () => "other" }).c;

    const texts: string[] = [];
    const ctx = {
      busy: false,
      mkKey: () => randomUUID(),
      setEvents: (update: (e: { text: string }[]) => { text: string }[]) => {
        texts.push(...update([]).map((e) => e.text));
      },
      sessionWorktreeRef: { current },
    } as unknown as SlashContext;

    const cwd = process.cwd();
    process.chdir(f.repo);
    try {
      await dispatchSlashCommand(ctx, "/worktrees");
      assert.match(texts.at(-1)!, /Autopilot worktrees for this repository \(2\)/);
      assert.match(texts.at(-1)!, /1 uncommitted file/);

      await dispatchSlashCommand(ctx, `/worktrees remove ${dirty.active!.name}`);
      assert.match(texts.at(-1)!, /not removed: .*1 uncommitted file.*--force/);
      await access(dirtyPath);

      await dispatchSlashCommand(ctx, "/worktrees clean");
      assert.match(texts.at(-1)!, /removed 1 clean worktree/);
      assert.match(texts.at(-1)!, /kept 1/);
      await assert.rejects(access(cleanPath), { code: "ENOENT" });
      await access(dirtyPath);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("isMutatingToolCall", () => {
  it("treats file writes inside the repo and non-read-only shell commands as mutating", () => {
    const root = "/repo";
    assert.equal(isMutatingToolCall("write", { path: "a.ts" }, root, root), true);
    assert.equal(isMutatingToolCall("edit", { path: "/repo/src/a.ts" }, root, root), true);
    assert.equal(isMutatingToolCall("write", { path: "/tmp/scratch.txt" }, root, root), false);
    assert.equal(isMutatingToolCall("read", { path: "a.ts" }, root, root), false);
    assert.equal(isMutatingToolCall("bash", { command: "git log --oneline -5" }, root, root), false);
    assert.equal(isMutatingToolCall("bash", { command: "ls -la && cat README.md" }, root, root), false);
    assert.equal(isMutatingToolCall("bash", { command: "npm test" }, root, root), true);
    assert.equal(isMutatingToolCall("bash", { command: "echo x > a.txt" }, root, root), true);
    assert.equal(isMutatingToolCall("job_start", { command: "npm run build" }, root, root), true);
  });
});
