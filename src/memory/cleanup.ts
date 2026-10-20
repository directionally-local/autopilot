import type Database from "better-sqlite3";
import {
  deleteOldMemories,
  deleteExcessMemories,
  setLastCleanup,
  getMemoryStats,
  supersedeMemory,
  deleteMemoriesByIds,
} from "./db.js";
import { cosineSimilarity } from "./embeddings.js";
import type { Memory } from "./schema.js";

export interface CleanupOpts {
  db: Database.Database;
  repoPath: string;
  maxAgeDays: number;
  maxEntries: number;
  deduplicate?: boolean;
  /** Only rows embedded by this model are compared; null skips vector dedup. */
  embeddingModel?: string | null;
}

export interface CleanupResult {
  oldDeleted: number;
  excessDeleted: number;
  duplicatesMerged: number;
}

function findDuplicates(memories: Memory[], threshold = 0.95): Array<[string, string]> {
  const duplicates: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]!;
    if (seen.has(a.id)) continue;

    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]!;
      if (seen.has(b.id)) continue;
      if (a.category !== b.category) continue;

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim >= threshold) {
        duplicates.push([a.id, b.id]);
        seen.add(b.id);
      }
    }
  }

  return duplicates;
}

export async function runCleanup(opts: CleanupOpts): Promise<CleanupResult> {
  const result: CleanupResult = { oldDeleted: 0, excessDeleted: 0, duplicatesMerged: 0 };

  // 1. Delete old memories
  const maxAgeMs = opts.maxAgeDays * 24 * 60 * 60 * 1000;
  result.oldDeleted = deleteOldMemories(opts.db, maxAgeMs);

  // 2. Deduplicate if requested
  if (opts.deduplicate !== false && opts.embeddingModel !== null) {
    const { listMemoriesForVectorSearch } = await import("./db.js");
    const since = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
    const candidates = listMemoriesForVectorSearch(opts.db, opts.repoPath, since, 5000, undefined, opts.embeddingModel);
    const duplicates = findDuplicates(candidates);

    if (duplicates.length > 0) {
      const toSupersede: Array<[string, string]> = [];
      const toDelete: string[] = [];

      for (const [olderId, newerId] of duplicates) {
        // Prefer supersession over hard-delete so the chain is preserved
        toSupersede.push([olderId, newerId]);
      }

      for (const [oldId, newId] of toSupersede) {
        supersedeMemory(opts.db, oldId, newId);
      }

      if (toDelete.length > 0) {
        deleteMemoriesByIds(opts.db, toDelete);
      }

      result.duplicatesMerged = toSupersede.length;
    }
  }

  // 3. Enforce max entries per repo
  result.excessDeleted = deleteExcessMemories(opts.db, opts.repoPath, opts.maxEntries);

  setLastCleanup(opts.db);
  return result;
}

export function shouldCleanup(db: Database.Database, intervalMs = 24 * 60 * 60 * 1000): boolean {
  const row = db.prepare("SELECT value FROM memory_meta WHERE key = 'last_cleanup'").get() as
    | { value: string }
    | undefined;
  if (!row) return true;
  const lastCleanup = parseInt(row.value, 10);
  return Number.isNaN(lastCleanup) || Date.now() - lastCleanup > intervalMs;
}
