import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRecorder } from "./recorder.js";
import { beginGitDelta, detectGitRevert, diffNumstat, _resetGitDeltaMemoryForTests } from "./git-delta.js";
import { gitNumstat, parseNumstat } from "../cost-attribution/git-diff.js";

let scratch: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kimiflare-trace-git-delta-"));
  repo = join(scratch, "repo");
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "a.txt"), "one\ntwo\n", "utf8");
  git("add", ".");
  git("commit", "-q", "-m", "init");
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(() => _resetGitDeltaMemoryForTests());

describe("diffNumstat / parseNumstat", () => {
  it("reports only files whose counts moved", () => {
    const before = parseNumstat("3\t1\tsrc/a.ts\n0\t2\tsrc/b.ts\n");
    const after = parseNumstat("5\t1\tsrc/a.ts\n0\t2\tsrc/b.ts\n4\t0\tsrc/c.ts\n-\t-\timg.png\n");
    assert.deepStrictEqual(diffNumstat(before, after), { files_changed: 2, insertions: 6, deletions: 0, files: ["src/a.ts", "src/c.ts"] });
  });
});

describe("beginGitDelta", () => {
  it("emits git_delta for a scripted edit with the numstat and patch blobs", async () => {
    const rec = createMemoryRecorder("s");
    const tracker = await beginGitDelta({ trace: rec, turnId: "t1", sessionId: "s", cwd: repo });
    assert.ok(tracker);
    await appendFile(join(repo, "a.txt"), "three\n", "utf8");
    await writeFile(join(repo, "new.txt"), "x\ny\n", "utf8");
    await tracker!.finish();
    const [ev] = rec.ofType("outcome");
    assert.ok(ev && ev.payload.kind === "git_delta");
    if (ev.payload.kind !== "git_delta") return;
    assert.strictEqual(ev.turn_id, "t1");
    assert.strictEqual(ev.payload.files_changed, 2);
    assert.strictEqual(ev.payload.insertions, 3);
    assert.strictEqual(ev.payload.deletions, 0);
    assert.match(rec.blobText(ev.payload.numstat_blob) ?? "", /1\t0\ta\.txt/);
    assert.match(rec.blobText(ev.payload.numstat_blob) ?? "", /2\t0\tnew\.txt/);
    assert.match(rec.blobText(ev.payload.patch_blob) ?? "", /\+three/);
    // A later revert of that file is attributed to the turn.
    assert.deepStrictEqual(detectGitRevert("s", "git checkout -- a.txt"), { turnId: "t1" });
    assert.deepStrictEqual(detectGitRevert("s", "git restore new.txt"), { turnId: "t1" });
    assert.deepStrictEqual(detectGitRevert("s", "git stash"), { turnId: "t1" });
    assert.strictEqual(detectGitRevert("s", "git checkout -- other.txt"), null);
    assert.strictEqual(detectGitRevert("s", "git stash pop"), null);
    assert.strictEqual(detectGitRevert("other-session", "git stash"), null);
    // Clean up the working tree for the next test.
    git("checkout", "--", "a.txt");
    await rm(join(repo, "new.txt"), { force: true });
  });

  it("emits a zero delta when the turn changed nothing, and nothing outside a repo or when disabled", async () => {
    const rec = createMemoryRecorder("s");
    const tracker = await beginGitDelta({ trace: rec, turnId: "t2", sessionId: "s", cwd: repo });
    await tracker!.finish();
    const [ev] = rec.ofType("outcome");
    assert.ok(ev && ev.payload.kind === "git_delta" && ev.payload.files_changed === 0 && !("patch_blob" in ev.payload));
    assert.strictEqual(detectGitRevert("s", "git stash"), null, "an empty delta is not remembered");

    assert.strictEqual(await beginGitDelta({ trace: rec, turnId: "t3", sessionId: "s", cwd: scratch }), null);
    const { createNoopRecorder } = await import("./recorder.js");
    assert.strictEqual(await beginGitDelta({ trace: createNoopRecorder(), turnId: "t4", sessionId: "s", cwd: repo }), null);
  });

  it("gitNumstat falls back to the index diff in a repository without commits", async () => {
    const empty = join(scratch, "empty");
    execFileSync("git", ["init", "-q", empty]);
    await writeFile(join(empty, "f.txt"), "1\n2\n3\n", "utf8");
    const stat = await gitNumstat(empty, { againstHead: true, includeUntracked: true });
    assert.deepStrictEqual(stat?.entries, [{ file: "f.txt", insertions: 3, deletions: 0 }]);
  });
});
