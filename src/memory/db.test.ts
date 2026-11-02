import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteDatabase } from "../util/sqlite.js";
import {
  openMemoryDb,
  closeMemoryDb,
  insertMemory,
  searchMemoriesFts,
  deleteOldMemories,
  deleteExpiredTasks,
  getMemoryById,
  supersedeMemory,
  getMemoryStats,
  recordRecall,
  getRecallStats,
  countLowImportanceMemories,
  listMemoriesForExport,
} from "./db.js";

const ZERO = new Float32Array(768);

describe("memory db", () => {
  let tmpDir: string;
  let db: SqliteDatabase;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-memory-db-test-"));
    db = openMemoryDb(join(tmpDir, "memory.db"));
  });

  after(async () => {
    closeMemoryDb();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("stores related_files instead of dropping them", () => {
    const mem = insertMemory(
      db,
      {
        content: "The app entry point is src/app.tsx.",
        category: "fact",
        sourceSessionId: "s1",
        repoPath: "/repo/alpha",
        importance: 4,
        relatedFiles: ["src/app.tsx"],
        topicKey: "entry_point",
      },
      ZERO,
    );
    assert.deepStrictEqual(mem.relatedFiles, ["src/app.tsx"]);
  });

  it("scopes FTS matches to content, not repo_path", () => {
    insertMemory(
      db,
      {
        content: "unrelated note about styling",
        category: "fact",
        sourceSessionId: "s1",
        repoPath: "/repo/beta",
        importance: 3,
        topicKey: "styling",
      },
      ZERO,
    );

    // The repo path appears only in the repo_path column. A content-scoped
    // match must not return this row.
    const byPath = searchMemoriesFts(db, "/repo/beta", "/repo/beta", 10);
    assert.strictEqual(byPath.length, 0);

    const byContent = searchMemoriesFts(db, "styling", "/repo/beta", 10);
    assert.strictEqual(byContent.length, 1);
  });

  it("protects high-signal memories from age cleanup", () => {
    const old = Date.now() - 120 * 24 * 60 * 60 * 1000;
    const low = insertMemory(
      db,
      {
        content: "File modified: src/old.ts.",
        category: "event",
        sourceSessionId: "s1",
        repoPath: "/repo/gamma",
        importance: 2,
        topicKey: "event_edit_src_old_ts",
      },
      ZERO,
    );
    const instruction = insertMemory(
      db,
      {
        content: "Always open PRs as drafts until they are mergeable.",
        category: "instruction",
        sourceSessionId: "s1",
        repoPath: "/repo/gamma",
        importance: 5,
        topicKey: "pr_draft_preference",
      },
      ZERO,
    );
    const fact = insertMemory(
      db,
      {
        content: "The service is hosted at api.example.com.",
        category: "fact",
        sourceSessionId: "s1",
        repoPath: "/repo/gamma",
        importance: 4,
        topicKey: "hosting",
      },
      ZERO,
    );

    const setOld = db.prepare("UPDATE memories SET created_at = ? WHERE id = ?");
    for (const id of [low.id, instruction.id, fact.id]) setOld.run(old, id);

    const deleted = deleteOldMemories(db, 90 * 24 * 60 * 60 * 1000);
    assert.strictEqual(deleted, 1);

    const remaining = db
      .prepare("SELECT id FROM memories WHERE repo_path = ? ORDER BY id")
      .all("/repo/gamma") as Array<{ id: string }>;
    const ids = remaining.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, [instruction.id, fact.id].sort());
  });

  it("scopes stats to one repo and reports the last write (#1077)", () => {
    const alpha = getMemoryStats(db, "/repo/alpha");
    const beta = getMemoryStats(db, "/repo/beta");
    const all = getMemoryStats(db);
    assert.strictEqual(alpha.totalCount, 1, "alpha has exactly its own row");
    assert.strictEqual(beta.totalCount, 1, "beta has exactly its own row");
    assert.ok(all.totalCount > alpha.totalCount, "unscoped stats count every repo");
    assert.strictEqual(alpha.byCategory.fact, 1);
    assert.strictEqual(beta.byCategory.fact, 1);
    assert.ok(typeof alpha.lastCreatedAt === "number" && alpha.lastCreatedAt > 0);
    assert.strictEqual(getMemoryStats(db, "/repo/never-written").lastCreatedAt, null);
  });

  it("tracks recall outcomes per repo for the doctor's hit rate (#1077)", () => {
    recordRecall(db, "/repo/alpha", 3);
    recordRecall(db, "/repo/alpha", 0);
    recordRecall(db, "/repo/beta", 1);
    const alpha = getRecallStats(db, "/repo/alpha");
    assert.deepStrictEqual(alpha, { total: 2, hits: 1 });
    assert.deepStrictEqual(getRecallStats(db, "/repo/beta"), { total: 1, hits: 1 });
    assert.deepStrictEqual(getRecallStats(db, "/repo/none"), { total: 0, hits: 0 });
  });

  it("counts low-importance live memories as the noise ratio input (#1077)", () => {
    // /repo/beta holds one importance-3 row; /repo/delta gets a noisy one.
    insertMemory(
      db,
      {
        content: "minor trivia",
        category: "event",
        sourceSessionId: "s1",
        repoPath: "/repo/delta",
        importance: 1,
        topicKey: "trivia",
      },
      ZERO,
    );
    assert.strictEqual(countLowImportanceMemories(db, "/repo/delta"), 1);
    assert.strictEqual(countLowImportanceMemories(db, "/repo/beta"), 0);
  });

  it("exports memories without their vector payloads (#1077)", () => {
    const rows = listMemoriesForExport(db, "/repo/alpha");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.id.length > 0, true);
    assert.strictEqual(rows[0]!.repoPath, "/repo/alpha");
    assert.ok(!("embedding" in rows[0]!), "export must not carry embeddings");
    assert.ok(listMemoriesForExport(db).length >= 4, "unscoped export covers the whole DB");
  });

  it("dedups identical content by hash and keeps categories separate (#1074)", () => {
    const base = {
      content: "Shared content for hash dedup.",
      sourceSessionId: "s1",
      repoPath: "/repo/hashdedup",
      importance: 3,
    };
    const first = insertMemory(db, { ...base, category: "fact" }, ZERO);
    const again = insertMemory(db, { ...base, category: "fact" }, ZERO);
    assert.strictEqual(again.id, first.id, "re-ingestion returns the stored row");

    const otherCategory = insertMemory(db, { ...base, category: "event" }, ZERO);
    assert.notStrictEqual(otherCategory.id, first.id, "category is part of the hash");

    const rows = db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE repo_path = ?")
      .get("/repo/hashdedup") as { n: number };
    assert.strictEqual(rows.n, 2, "one row per (content, category, repo)");
  });

  it("hashes absolute and relative paths to the same content (#1074)", () => {
    const input = {
      category: "event" as const,
      sourceSessionId: "s1",
      repoPath: "/repo/pathy",
      importance: 2,
    };
    const abs = insertMemory(db, { ...input, content: "File modified: /repo/pathy/src/a.ts." }, ZERO);
    const rel = insertMemory(db, { ...input, content: "File modified: src/a.ts." }, ZERO);
    assert.strictEqual(rel.id, abs.id, "repo root is stripped before hashing");
  });

  it("lets superseded content be written again (#1074)", () => {
    const input = {
      content: "Revivable content.",
      category: "fact" as const,
      sourceSessionId: "s1",
      repoPath: "/repo/revive",
      importance: 3,
    };
    const first = insertMemory(db, input, ZERO);
    supersedeMemory(db, first.id, "some-later-row");
    const second = insertMemory(db, input, ZERO);
    assert.notStrictEqual(second.id, first.id, "only live rows block re-ingestion");
  });

  it("expires task rows after their TTL (#1074)", () => {
    const stale = insertMemory(
      db,
      { content: "Stale plan", category: "task", sourceSessionId: "s1", repoPath: "/repo/taskttl", importance: 4, topicKey: "stale_plan" },
      ZERO,
    );
    const fresh = insertMemory(
      db,
      { content: "Fresh plan", category: "task", sourceSessionId: "s1", repoPath: "/repo/taskttl", importance: 4, topicKey: "fresh_plan" },
      ZERO,
    );
    db.prepare("UPDATE memories SET created_at = ? WHERE id = ?").run(Date.now() - 25 * 60 * 60 * 1000, stale.id);

    assert.strictEqual(deleteExpiredTasks(db), 1);
    assert.strictEqual(getMemoryById(db, stale.id), null, "stale task removed");
    assert.ok(getMemoryById(db, fresh.id), "recent task survives");
  });
});
