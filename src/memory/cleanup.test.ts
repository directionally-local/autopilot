import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteDatabase } from "../util/sqlite.js";
import { openMemoryDb, closeMemoryDb, insertMemory, getMemoryById } from "./db.js";
import { runCleanup } from "./cleanup.js";

const ZERO = new Float32Array(768);
const VEC = new Float32Array([1, 0, 0]);

describe("memory cleanup lifecycle (#1074)", () => {
  let tmpDir: string;
  let db: SqliteDatabase;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autopilot-cleanup-test-"));
    db = openMemoryDb(join(tmpDir, "memory.db"));
  });

  after(async () => {
    closeMemoryDb();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("expires stale tasks and leaves fresh ones", async () => {
    const stale = insertMemory(
      db,
      { content: "Stale plan", category: "task", sourceSessionId: "s1", repoPath: "/repo/c", importance: 4, topicKey: "stale_plan" },
      ZERO,
    );
    const fresh = insertMemory(
      db,
      { content: "Fresh plan", category: "task", sourceSessionId: "s1", repoPath: "/repo/c", importance: 4, topicKey: "fresh_plan" },
      ZERO,
    );
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(Date.now() - 25 * 60 * 60 * 1000, stale.id);

    const result = await runCleanup({ db, repoPath: "/repo/c", maxAgeDays: 90, maxEntries: 100, embeddingModel: null });
    assert.strictEqual(result.tasksExpired, 1);
    assert.strictEqual(getMemoryById(db, stale.id), null, "stale task removed");
    assert.ok(getMemoryById(db, fresh.id), "recent task survives");
  });

  it("never supersedes events by vector similarity", async () => {
    const eventA = insertMemory(db, { content: "Edited src/a.ts", category: "event", sourceSessionId: "s1", repoPath: "/repo/c", importance: 3 }, VEC, { model: "m" });
    const eventB = insertMemory(db, { content: "Edited src/a.ts again", category: "event", sourceSessionId: "s1", repoPath: "/repo/c", importance: 3 }, VEC, { model: "m" });
    const factA = insertMemory(db, { content: "Fact one", category: "fact", sourceSessionId: "s1", repoPath: "/repo/c", importance: 3 }, VEC, { model: "m" });
    const factB = insertMemory(db, { content: "Fact two", category: "fact", sourceSessionId: "s1", repoPath: "/repo/c", importance: 3 }, VEC, { model: "m" });

    const result = await runCleanup({ db, repoPath: "/repo/c", maxAgeDays: 90, maxEntries: 100, embeddingModel: "m" });
    assert.strictEqual(result.duplicatesMerged, 1, "only the fact pair merges");
    assert.strictEqual(getMemoryById(db, eventA.id)?.supersededBy, null, "events accumulate");
    assert.strictEqual(getMemoryById(db, eventB.id)?.supersededBy, null, "events accumulate");
    assert.ok(
      getMemoryById(db, factA.id)?.supersededBy || getMemoryById(db, factB.id)?.supersededBy,
      "the fact pair dedups by similarity",
    );
  });
});
