import type { SqliteDatabase } from "../util/sqlite.js";
import type { ParsedSkill, ParsedSkillSection, SectionResult } from "./types.js";

export function initSkillsSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_index (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parser_version INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id INTEGER NOT NULL,
      heading TEXT NOT NULL,
      body TEXT NOT NULL,
      embedding BLOB NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES skill_index(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_skill_path ON skill_index(file_path);
  `);
  // Embedding model the sections were embedded with (null: no vectors, keyword search only).
  const cols = db.prepare("PRAGMA table_info(skill_index)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "embedding_model")) {
    db.exec("ALTER TABLE skill_index ADD COLUMN embedding_model TEXT");
    // Indexed before models were recorded: OpenRouter's bge-base (768 floats) or unknown.
    db.exec(`
      UPDATE skill_index SET embedding_model = 'baai/bge-base-en-v1.5'
      WHERE id IN (SELECT skill_id FROM skill_sections WHERE length(embedding) = 3072)
    `);
  }
}

export function getSkillByPath(
  db: SqliteDatabase,
  filePath: string
): { id: number; contentHash: string; parserVersion: number; embeddingModel: string | null } | null {
  const row = db
    .prepare("SELECT id, content_hash, parser_version, embedding_model FROM skill_index WHERE file_path = ?")
    .get(filePath) as { id: number; content_hash: string; parser_version: number; embedding_model: string | null } | undefined;
  if (!row) return null;
  return { id: row.id, contentHash: row.content_hash, parserVersion: row.parser_version, embeddingModel: row.embedding_model ?? null };
}

/** Record which embedding model a skill's sections were embedded with (null: none). */
export function setSkillEmbeddingModel(db: SqliteDatabase, skillId: number, model: string | null): void {
  db.prepare("UPDATE skill_index SET embedding_model = ? WHERE id = ?").run(model, skillId);
}

export function upsertSkill(db: SqliteDatabase, skill: ParsedSkill): number {
  const existing = getSkillByPath(db, skill.filePath);
  const now = Date.now();

  if (existing) {
    // Update
    db.prepare(
      `UPDATE skill_index
       SET name = ?, description = ?, content_hash = ?, parser_version = ?, updated_at = ?
       WHERE id = ?`
    ).run(skill.name, skill.description, skill.contentHash, skill.parserVersion, now, existing.id);

    // Delete old sections (CASCADE would work if we deleted the skill row,
    // but since we're updating in place, manually delete sections)
    db.prepare("DELETE FROM skill_sections WHERE skill_id = ?").run(existing.id);
    return existing.id;
  }

  // Insert
  const result = db
    .prepare(
      `INSERT INTO skill_index (name, description, file_path, content_hash, parser_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(skill.name, skill.description, skill.filePath, skill.contentHash, skill.parserVersion, now);
  return Number(result.lastInsertRowid);
}

export function insertSections(
  db: SqliteDatabase,
  skillId: number,
  sections: ParsedSkillSection[],
  /** One vector per section, or empty when the sections are stored without vectors. */
  embeddings: Float32Array[]
): void {
  const insert = db.prepare(
    `INSERT INTO skill_sections (skill_id, heading, body, embedding)
     VALUES (?, ?, ?, ?)`
  );
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const embedding = embeddings[i] ?? new Float32Array(0);
    insert.run(skillId, section.heading, section.body, Buffer.from(embedding.buffer));
  }
}

export function deleteOrphanedSkills(db: SqliteDatabase, existingPaths: string[]): number {
  if (existingPaths.length === 0) {
    const result = db.prepare("DELETE FROM skill_index").run();
    return Number(result.changes);
  }

  const placeholders = existingPaths.map(() => "?").join(",");
  const result = db
    .prepare(`DELETE FROM skill_index WHERE file_path NOT IN (${placeholders})`)
    .run(...existingPaths);
  return Number(result.changes);
}

export function hasAnySections(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT 1 FROM skill_sections LIMIT 1")
    .get() as { 1: number } | undefined;
  return row !== undefined;
}

export function listAllSectionRows(
  db: SqliteDatabase
): Array<{
  id: number;
  heading: string;
  body: string;
  embedding: Buffer;
  name: string;
  description: string;
  file_path: string;
  embedding_model: string | null;
}> {
  return db
    .prepare(
      `SELECT s.id, s.heading, s.body, s.embedding, i.name, i.description, i.file_path, i.embedding_model
       FROM skill_sections s
       JOIN skill_index i ON s.skill_id = i.id`
    )
    .all() as Array<{
    id: number;
    heading: string;
    body: string;
    embedding: Buffer;
    name: string;
    description: string;
    file_path: string;
    embedding_model: string | null;
  }>;
}

export function rowToSectionResult(
  row: ReturnType<typeof listAllSectionRows>[number]
): Omit<SectionResult, "similarity"> {
  return {
    id: row.id,
    heading: row.heading,
    body: row.body,
    name: row.name,
    description: row.description,
    filePath: row.file_path,
  };
}
