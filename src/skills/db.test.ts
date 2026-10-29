import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { SqliteDatabase } from "../util/sqlite.js";
import {
  initSkillsSchema,
  upsertSkill,
  insertSections,
  deleteOrphanedSkills,
  getSkillByPath,
  listAllSectionRows,
} from "./db.js";
import type { ParsedSkill } from "./types.js";

function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: "test-skill",
    description: "A test skill",
    filePath: "/tmp/test.md",
    contentHash: "abc123",
    parserVersion: 1,
    sections: [
      { heading: "Section 1", body: "Body 1" },
      { heading: "Section 2", body: "Body 2" },
    ],
    ...overrides,
  };
}

describe("initSkillsSchema", () => {
  it("creates tables without error", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("skill_index"));
    assert.ok(names.includes("skill_sections"));
    db.close();
  });
});

describe("upsertSkill", () => {
  it("inserts a new skill", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const skill = makeSkill();
    const id = upsertSkill(db, skill);
    assert.ok(id > 0);

    const row = getSkillByPath(db, skill.filePath);
    assert.ok(row);
    assert.strictEqual(row!.contentHash, "abc123");
    db.close();
  });

  it("updates an existing skill and clears old sections", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const skill = makeSkill();
    const id1 = upsertSkill(db, skill);

    insertSections(db, id1, skill.sections, [
      new Float32Array(768),
      new Float32Array(768),
    ]);

    const updated = makeSkill({ contentHash: "def456", sections: [{ heading: "New", body: "New body" }] });
    const id2 = upsertSkill(db, updated);
    assert.strictEqual(id1, id2);

    const sections = listAllSectionRows(db);
    assert.strictEqual(sections.length, 0); // cleared by upsert
    db.close();
  });
});

describe("insertSections", () => {
  it("inserts sections with embeddings", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const skill = makeSkill();
    const id = upsertSkill(db, skill);

    insertSections(db, id, skill.sections, [new Float32Array(768), new Float32Array(768)]);

    const rows = listAllSectionRows(db);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0]!.heading, "Section 1");
    assert.strictEqual(rows[1]!.heading, "Section 2");
    assert.strictEqual(rows[0]!.embedding.length, 768 * 4); // float32 = 4 bytes
    db.close();
  });
});

describe("deleteOrphanedSkills", () => {
  it("removes skills whose files no longer exist", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const skill1 = makeSkill({ filePath: "/tmp/a.md" });
    const skill2 = makeSkill({ filePath: "/tmp/b.md" });
    upsertSkill(db, skill1);
    upsertSkill(db, skill2);

    const removed = deleteOrphanedSkills(db, ["/tmp/a.md"]);
    assert.strictEqual(removed, 1);

    const rows = db.prepare("SELECT file_path FROM skill_index").all() as Array<{ file_path: string }>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0]!.file_path, "/tmp/a.md");
    db.close();
  });

  it("removes all skills when no paths provided", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    upsertSkill(db, makeSkill());
    const removed = deleteOrphanedSkills(db, []);
    assert.strictEqual(removed, 1);
    db.close();
  });
});

describe("getSkillByPath", () => {
  it("returns null for missing skill", () => {
    const db = new SqliteDatabase(":memory:");
    initSkillsSchema(db);
    const row = getSkillByPath(db, "/tmp/missing.md");
    assert.strictEqual(row, null);
    db.close();
  });
});
