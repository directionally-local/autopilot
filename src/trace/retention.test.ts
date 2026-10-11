import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTraceSessions, pruneTraces } from "./retention.js";

let root: string;
const savedEnv = process.env.KIMIFLARE_TRACE_DIR;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "kimiflare-trace-retention-"));
  // The env override would win over the explicit roots used below.
  delete process.env.KIMIFLARE_TRACE_DIR;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedEnv !== undefined) process.env.KIMIFLARE_TRACE_DIR = savedEnv;
});

const DAY = 24 * 60 * 60 * 1000;

async function makeSession(base: string, id: string, ageDays: number, bytes: number): Promise<void> {
  const dir = join(base, id);
  await mkdir(join(dir, "blobs"), { recursive: true });
  await writeFile(join(dir, "blobs", "b"), "x".repeat(Math.max(0, bytes - 10)), "utf8");
  await writeFile(join(dir, "trace.jsonl"), "y".repeat(10), "utf8");
  const when = new Date(Date.now() - ageDays * DAY);
  await utimes(join(dir, "trace.jsonl"), when, when);
}

describe("pruneTraces", () => {
  it("removes the oldest sessions until the total byte cap holds", async () => {
    const base = join(root, "bytes");
    await makeSession(base, "oldest", 3, 100);
    await makeSession(base, "middle", 2, 100);
    await makeSession(base, "newest", 1, 100);
    const before = await listTraceSessions(base);
    assert.deepStrictEqual(
      before.map((s) => s.sessionId),
      ["newest", "middle", "oldest"],
    );

    const res = await pruneTraces({ root: base, maxTotalBytes: 250, maxAgeDays: 90, maxSessionBytes: 1000 });
    assert.deepStrictEqual(res.removed, ["oldest"]);
    assert.strictEqual(res.keptBytes, 200);
    assert.deepStrictEqual((await readdir(base)).sort(), ["middle", "newest"]);
  });

  it("removes sessions past the age cap and sessions over the per-session cap", async () => {
    const base = join(root, "age");
    await makeSession(base, "ancient", 120, 50);
    await makeSession(base, "huge", 1, 5000);
    await makeSession(base, "fine", 1, 50);
    const res = await pruneTraces({ root: base, maxAgeDays: 90, maxSessionBytes: 1000, maxTotalBytes: 1_000_000 });
    assert.deepStrictEqual(res.removed.sort(), ["ancient", "huge"]);
    assert.deepStrictEqual(await readdir(base), ["fine"]);
  });

  it("is a no-op on a missing root and ignores stray files", async () => {
    const res = await pruneTraces({ root: join(root, "does-not-exist") });
    assert.deepStrictEqual(res, { removed: [], keptBytes: 0 });
    const base = join(root, "stray");
    await mkdir(base, { recursive: true });
    await writeFile(join(base, "README"), "x", "utf8");
    assert.deepStrictEqual(await pruneTraces({ root: base }), { removed: [], keptBytes: 0 });
  });
});
