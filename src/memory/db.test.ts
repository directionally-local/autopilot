import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import {
  openMemoryDb,
  closeMemoryDb,
  insertMemory,
  searchMemoriesFts,
  deleteOldMemories,
} from "./db.js";

const ZERO = new Float32Array(768);

describe("memory db", () => {
  let tmpDir: string;
  let db: Database.Database;

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
});
