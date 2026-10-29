import { SqliteDatabase } from "../util/sqlite.js";
import { join, dirname } from "node:path";
import { mkdirSync, statSync } from "node:fs";
import type { Memory, MemoryInput, MemoryStats, MemoryCategory } from "./schema.js";
import { vectorFromBlob } from "./embeddings.js";

let dbInstance: SqliteDatabase | null = null;
let dbPathInstance: string | null = null;

function initSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB NOT NULL,
      category TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      repo_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      importance INTEGER NOT NULL DEFAULT 3,
      related_files TEXT NOT NULL DEFAULT '[]',
      topic_key TEXT,
      superseded_by TEXT,
      forgotten INTEGER NOT NULL DEFAULT 0,
      vectorized INTEGER NOT NULL DEFAULT 0,
      agent_role TEXT,
      embedding_model TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo_path);
    CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(accessed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_topic_key ON memories(topic_key);
    CREATE INDEX IF NOT EXISTS idx_memories_forgotten ON memories(forgotten);
    CREATE INDEX IF NOT EXISTS idx_memories_vectorized ON memories(vectorized);

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      category,
      repo_path,
      content='memories',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, category, repo_path)
      VALUES (new.rowid, new.content, new.category, new.repo_path);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, category, repo_path)
      VALUES ('delete', old.rowid, old.content, old.category, old.repo_path);
    END;

    CREATE TABLE IF NOT EXISTS memory_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function migrateV1(db: SqliteDatabase): void {
  // Add columns that may be missing from pre-v1 schema
  const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));
  if (!names.has("topic_key")) {
    db.exec("ALTER TABLE memories ADD COLUMN topic_key TEXT");
  }
  if (!names.has("superseded_by")) {
    db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
  }
  if (!names.has("forgotten")) {
    db.exec("ALTER TABLE memories ADD COLUMN forgotten INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("vectorized")) {
    db.exec("ALTER TABLE memories ADD COLUMN vectorized INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("agent_role")) {
    db.exec("ALTER TABLE memories ADD COLUMN agent_role TEXT");
  }
  if (!names.has("embedding_model")) {
    db.exec("ALTER TABLE memories ADD COLUMN embedding_model TEXT");
    // Rows written before models were recorded: OpenRouter/Workers AI used
    // bge-base-en-v1.5 (768 floats = 3072 bytes); Requesty used
    // text-embedding-3-small (1536 floats). Anything else stays unknown and
    // is re-embedded by the backfill.
    db.exec(`
      UPDATE memories SET embedding_model = CASE length(embedding)
        WHEN 3072 THEN 'baai/bge-base-en-v1.5'
        WHEN 6144 THEN 'openai/text-embedding-3-small'
        ELSE NULL END
      WHERE vectorized = 1 AND category != 'task'
    `);
  }
  // Create new indexes if missing
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_topic_key ON memories(topic_key);
    CREATE INDEX IF NOT EXISTS idx_memories_forgotten ON memories(forgotten);
    CREATE INDEX IF NOT EXISTS idx_memories_vectorized ON memories(vectorized);
  `);
}

export function openMemoryDb(dbPath: string): SqliteDatabase {
  if (dbInstance && dbPathInstance === dbPath) {
    return dbInstance;
  }
  if (dbInstance) {
    dbInstance.close();
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  dbInstance = new SqliteDatabase(dbPath);
  dbInstance.pragma("journal_mode = WAL");
  dbInstance.pragma("foreign_keys = ON");
  initSchema(dbInstance);
  migrateV1(dbInstance);
  dbPathInstance = dbPath;
  return dbInstance;
}

export function closeMemoryDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPathInstance = null;
  }
}

export function getMemoryDb(): SqliteDatabase | null {
  return dbInstance;
}

function rowToMemory(row: Record<string, unknown>): Memory {
  const embedding = vectorFromBlob(row.embedding as Buffer);
  return {
    id: row.id as string,
    content: row.content as string,
    embedding,
    category: row.category as MemoryCategory,
    sourceSessionId: row.source_session_id as string,
    repoPath: row.repo_path as string,
    createdAt: row.created_at as number,
    accessedAt: row.accessed_at as number,
    importance: row.importance as number,
    relatedFiles: JSON.parse(row.related_files as string) as string[],
    topicKey: (row.topic_key as string | null) ?? null,
    supersededBy: (row.superseded_by as string | null) ?? null,
    forgotten: (row.forgotten as number) === 1,
    vectorized: (row.vectorized as number) === 1,
    embeddingModel: (row.embedding_model as string | null) ?? null,
    agentRole: (row.agent_role as string | null) ?? null,
  };
}

/**
 * How a row's vector came about:
 * - `{ model }`: a real embedding from that model
 * - `{ pending: true }`: embedding failed or was unavailable; backfill retries
 * - omitted: no vector by design (plans and other topic-key-only rows)
 */
export interface VectorInfo {
  model?: string;
  pending?: boolean;
}

export function insertMemory(db: SqliteDatabase, mem: MemoryInput, embedding: Float32Array, vector: VectorInfo = {}): Memory {
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const memory: Memory = {
    id,
    content: mem.content,
    embedding,
    category: mem.category,
    sourceSessionId: mem.sourceSessionId,
    repoPath: mem.repoPath,
    createdAt: now,
    accessedAt: now,
    importance: mem.importance,
    relatedFiles: mem.relatedFiles ?? [],
    topicKey: mem.topicKey ?? null,
    supersededBy: null,
    forgotten: false,
    vectorized: !vector.pending,
    embeddingModel: vector.model ?? null,
    agentRole: mem.agentRole ?? null,
  };

  db.prepare(
    `INSERT INTO memories (id, content, embedding, category, source_session_id, repo_path, created_at, accessed_at, importance, related_files, topic_key, superseded_by, forgotten, vectorized, agent_role, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    memory.id,
    memory.content,
    Buffer.from(memory.embedding.buffer),
    memory.category,
    memory.sourceSessionId,
    memory.repoPath,
    memory.createdAt,
    memory.accessedAt,
    memory.importance,
    JSON.stringify(memory.relatedFiles),
    memory.topicKey,
    memory.supersededBy,
    memory.forgotten ? 1 : 0,
    memory.vectorized ? 1 : 0,
    memory.agentRole,
    memory.embeddingModel
  );

  return memory;
}

export function insertMemories(db: SqliteDatabase, items: { input: MemoryInput; embedding: Float32Array; vector?: VectorInfo }[]): Memory[] {
  const insert = db.prepare(
    `INSERT INTO memories (id, content, embedding, category, source_session_id, repo_path, created_at, accessed_at, importance, related_files, topic_key, superseded_by, forgotten, vectorized, agent_role, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const inserted: Memory[] = [];
  const insertMany = db.transaction((batch: typeof items) => {
    for (const { input, embedding, vector = {} } of batch) {
      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = Date.now();
      const memory: Memory = {
        id,
        content: input.content,
        embedding,
        category: input.category,
        sourceSessionId: input.sourceSessionId,
        repoPath: input.repoPath,
        createdAt: now,
        accessedAt: now,
        importance: input.importance,
        relatedFiles: input.relatedFiles ?? [],
        topicKey: input.topicKey ?? null,
        supersededBy: null,
        forgotten: false,
        vectorized: !vector.pending,
        embeddingModel: vector.model ?? null,
        agentRole: input.agentRole ?? null,
      };
      insert.run(
        memory.id,
        memory.content,
        Buffer.from(memory.embedding.buffer),
        memory.category,
        memory.sourceSessionId,
        memory.repoPath,
        memory.createdAt,
        memory.accessedAt,
        memory.importance,
        JSON.stringify(memory.relatedFiles),
        memory.topicKey,
        memory.supersededBy,
        memory.forgotten ? 1 : 0,
        memory.vectorized ? 1 : 0,
        memory.agentRole,
        memory.embeddingModel
      );
      inserted.push(memory);
    }
  });

  insertMany(items);
  return inserted;
}

export function updateAccessedAt(db: SqliteDatabase, ids: string[]): void {
  if (ids.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(`UPDATE memories SET accessed_at = ? WHERE id = ?`);
  const updateMany = db.transaction((memoryIds: string[]) => {
    for (const id of memoryIds) {
      stmt.run(now, id);
    }
  });
  updateMany(ids);
}

/** Escape a raw query string for safe use in FTS5 MATCH.
 *  Splits on whitespace, quotes each token, and adds a prefix wildcard.
 *  This prevents syntax errors from special characters like /, -, etc.
 */
function escapeFts5(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

export function searchMemoriesFts(
  db: SqliteDatabase,
  query: string,
  repoPath?: string,
  limit = 50,
  agentRole?: string
): Array<{ memory: Memory; rank: number }> {
  const conditions: string[] = ["memories_fts MATCH ?", "m.forgotten = 0", "m.superseded_by IS NULL", "m.category != 'task'"];
  const params: (string | number)[] = [escapeFts5(query)];

  if (repoPath) {
    conditions.push("m.repo_path = ?");
    params.push(repoPath);
  }
  if (agentRole) {
    conditions.push("m.agent_role = ?");
    params.push(agentRole);
  }

  const sql = `SELECT m.*, rank FROM memories m
     JOIN memories_fts fts ON m.rowid = fts.rowid
     WHERE ${conditions.join(" AND ")}
     ORDER BY rank
     LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    memory: rowToMemory(row as Record<string, unknown>),
    rank: row.rank as number,
  }));
}

export function listMemoriesForVectorSearch(
  db: SqliteDatabase,
  repoPath: string,
  since: number,
  limit = 2000,
  agentRole?: string,
  /** Only rows embedded by this model: vectors from different models are not comparable. */
  embeddingModel?: string
): Memory[] {
  const conditions = ["repo_path = ?", "created_at >= ?", "forgotten = 0", "superseded_by IS NULL", "category != 'task'"];
  const params: (string | number)[] = [repoPath, since];
  if (embeddingModel) {
    conditions.push("embedding_model = ?");
    params.push(embeddingModel);
  }

  if (agentRole) {
    conditions.push("agent_role = ?");
    params.push(agentRole);
  }

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE ${conditions.join(" AND ")}
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

export function getMemoryStats(db: SqliteDatabase): MemoryStats {
  const totalCount = (db.prepare("SELECT COUNT(*) as c FROM memories WHERE forgotten = 0 AND superseded_by IS NULL").get() as { c: number }).c;
  const dbPath = db.name;
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = statSync(dbPath).size;
  } catch {
    /* ignore */
  }

  const lastCleanup = db.prepare("SELECT value FROM memory_meta WHERE key = 'last_cleanup'").get() as
    | { value: string }
    | undefined;

  const categories = db.prepare("SELECT category, COUNT(*) as c FROM memories WHERE forgotten = 0 AND superseded_by IS NULL GROUP BY category").all() as Array<{
    category: MemoryCategory;
    c: number;
  }>;

  const byCategory: Record<MemoryCategory, number> = {
    fact: 0,
    event: 0,
    instruction: 0,
    task: 0,
    preference: 0,
  };
  for (const row of categories) {
    byCategory[row.category] = row.c;
  }

  return {
    totalCount,
    dbSizeBytes,
    lastCleanupAt: lastCleanup ? parseInt(lastCleanup.value, 10) : null,
    byCategory,
  };
}

export function deleteMemoriesByIds(db: SqliteDatabase, ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids);
  return result.changes;
}

export function deleteOldMemories(db: SqliteDatabase, maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare("DELETE FROM memories WHERE created_at < ?").run(cutoff);
  return result.changes;
}

export function deleteExcessMemories(db: SqliteDatabase, repoPath: string, keep: number): number {
  const result = db
    .prepare(
      `DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE repo_path = ?
        ORDER BY accessed_at DESC
        LIMIT -1 OFFSET ?
      )`
    )
    .run(repoPath, keep);
  return result.changes;
}

export function setLastCleanup(db: SqliteDatabase): void {
  db.prepare(
    `INSERT INTO memory_meta (key, value) VALUES ('last_cleanup', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(Date.now()));
}

export function clearMemoriesForRepo(db: SqliteDatabase, repoPath: string): number {
  const result = db.prepare("DELETE FROM memories WHERE repo_path = ?").run(repoPath);
  return result.changes;
}

export function listTopicKeys(db: SqliteDatabase, repoPath: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT topic_key FROM memories
       WHERE repo_path = ? AND topic_key IS NOT NULL AND forgotten = 0 AND superseded_by IS NULL`
    )
    .all(repoPath) as Array<{ topic_key: string }>;
  return rows.map((r) => r.topic_key);
}

export function findMemoriesByTopicKey(
  db: SqliteDatabase,
  repoPath: string,
  topicKey: string
): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE repo_path = ? AND topic_key = ? AND forgotten = 0 AND superseded_by IS NULL
       ORDER BY created_at DESC`
    )
    .all(repoPath, topicKey) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

export function supersedeMemory(db: SqliteDatabase, oldId: string, newId: string): void {
  db.prepare(
    `UPDATE memories SET superseded_by = ? WHERE id = ?`
  ).run(newId, oldId);
}

export function forgetMemory(db: SqliteDatabase, id: string): void {
  db.prepare(
    `UPDATE memories SET forgotten = 1 WHERE id = ?`
  ).run(id);
}

export function listUnvectorizedMemories(db: SqliteDatabase, repoPath: string, limit = 100): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE repo_path = ? AND vectorized = 0
       LIMIT ?`
    )
    .all(repoPath, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

export function updateMemoryEmbedding(db: SqliteDatabase, id: string, embedding: Float32Array, embeddingModel: string | null = null): void {
  db.prepare(
    `UPDATE memories SET embedding = ?, vectorized = 1, embedding_model = ? WHERE id = ?`
  ).run(Buffer.from(embedding.buffer), embeddingModel, id);
}

/**
 * Rows that need (re-)embedding with `embeddingModel`: never embedded, or
 * embedded by a different model (the provider or embedding model changed).
 * Topic-key-only rows (tasks/plans) are left alone.
 */
export function listMemoriesNeedingEmbedding(db: SqliteDatabase, repoPath: string, embeddingModel: string, limit = 100): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE repo_path = ? AND forgotten = 0 AND superseded_by IS NULL AND category != 'task'
         AND (vectorized = 0 OR embedding_model IS NULL OR embedding_model != ?)
       ORDER BY accessed_at DESC
       LIMIT ?`
    )
    .all(repoPath, embeddingModel, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/** How many live rows are searchable with `embeddingModel` vs. waiting for (re-)embedding. */
export function countMemoriesByEmbeddingModel(db: SqliteDatabase, repoPath: string, embeddingModel: string | null): { current: number; stale: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN vectorized = 1 AND embedding_model IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END) AS current,
         SUM(CASE WHEN vectorized = 0 OR embedding_model IS NULL OR embedding_model != ? THEN 1 ELSE 0 END) AS stale
       FROM memories
       WHERE repo_path = ? AND forgotten = 0 AND superseded_by IS NULL AND category != 'task'`
    )
    .get(embeddingModel, embeddingModel, repoPath) as { current: number | null; stale: number | null };
  return { current: row.current ?? 0, stale: row.stale ?? 0 };
}

export function getMemoryById(db: SqliteDatabase, id: string): Memory | null {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | (Record<string, unknown>)
    | undefined;
  return row ? rowToMemory(row) : null;
}

/** Return the most frequently referenced files across memories for a repo.
 *  Scores by frequency × importance, limited to `limit` results. */
export function getTopRelatedFiles(
  db: SqliteDatabase,
  repoPath: string,
  limit = 10,
): string[] {
  const rows = db
    .prepare(
      `SELECT related_files, importance FROM memories
       WHERE repo_path = ? AND related_files != '[]'
         AND forgotten = 0 AND superseded_by IS NULL
       ORDER BY accessed_at DESC
       LIMIT 200`,
    )
    .all(repoPath) as Array<{ related_files: string; importance: number }>;

  const scores = new Map<string, number>();
  for (const row of rows) {
    const files = JSON.parse(row.related_files) as string[];
    for (const file of files) {
      if (!file) continue;
      scores.set(file, (scores.get(file) ?? 0) + row.importance);
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, limit).map(([file]) => file);
}

export function countHighSignalMemoriesSince(
  db: SqliteDatabase,
  repoPath: string,
  since: number,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE repo_path = ? AND created_at > ?
       AND forgotten = 0 AND superseded_by IS NULL
       AND (
         topic_key IN ('project_dependencies', 'project_tsconfig', 'project_entry_point')
         OR category IN ('instruction', 'preference')
         OR (category = 'event' AND importance >= 3)
       )`,
    )
    .get(repoPath, since) as { count: number } | undefined;
  return row?.count ?? 0;
}
