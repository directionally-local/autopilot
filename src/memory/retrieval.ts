import type { SqliteDatabase } from "../util/sqlite.js";
import type { Memory, MemoryQuery, HybridResult } from "./schema.js";
import { searchMemoriesFts, listMemoriesForVectorSearch, updateAccessedAt } from "./db.js";
import { cosineSimilarity } from "./embeddings.js";

export interface RetrieveOpts {
  db: SqliteDatabase;
  query: MemoryQuery;
}

const RRF_K = 60;

function normalizeFtsRank(rank: number): number {
  // FTS5 rank is typically a small negative log value; normalize to 0-1
  // Lower rank = better match. Typical range: 0 to ~10
  const clamped = Math.max(0, Math.min(10, rank));
  return 1 - clamped / 10;
}

function normalizeVectorScore(score: number): number {
  // Cosine similarity range: -1 to 1; typically 0.5 to 1.0 for relevant matches
  return Math.max(0, (score - 0.5) * 2);
}

function computeExactScore(memory: Memory, queryText: string, cwd: string): number {
  let score = 0;
  const lowerQuery = queryText.toLowerCase();

  // File path matches
  for (const file of memory.relatedFiles) {
    const basename = file.split("/").pop() ?? file;
    if (lowerQuery.includes(basename.toLowerCase()) || basename.toLowerCase().includes(lowerQuery)) {
      score += 0.3;
    }
    if (cwd && file.startsWith(cwd)) {
      score += 0.1;
    }
  }

  // Content keyword overlap
  const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 3);
  const contentWords = new Set(memory.content.toLowerCase().split(/\s+/));
  let matches = 0;
  for (const qw of queryWords) {
    if (contentWords.has(qw)) matches++;
  }
  if (queryWords.length > 0) {
    score += (matches / queryWords.length) * 0.2;
  }

  return Math.min(1, score);
}

function computeTopicKeyScore(memory: Memory, queryText: string): number {
  if (!memory.topicKey) return 0;
  const lowerQuery = queryText.toLowerCase();
  const keyParts = memory.topicKey.split("_");
  let matches = 0;
  for (const part of keyParts) {
    if (part.length > 2 && lowerQuery.includes(part)) matches++;
  }
  return matches / Math.max(keyParts.length, 1);
}

function rrfScore(rank: number, k = RRF_K): number {
  if (rank <= 0) return 0;
  return 1 / (k + rank);
}

export async function retrieveMemories(opts: RetrieveOpts): Promise<HybridResult[]> {
  const { db, query } = opts;
  const limit = query.limit ?? 10;
  const repoPath = query.repoPath ?? process.cwd();
  const maxAgeDays = query.maxAgeDays ?? 90;
  const since = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  // 1. FTS5 search
  const ftsResults = searchMemoriesFts(db, query.text, repoPath, limit * 3, query.agentRole);

  // 2. Vector search candidates (recent memories in repo)
  let vectorCandidates: Memory[] = [];
  if (query.embedding) {
    vectorCandidates = listMemoriesForVectorSearch(db, repoPath, since, 2000, query.agentRole, query.embeddingModel);
  }

  // 3. Combine and score using RRF across channels
  // Channel weights: topic-key > FTS = vector > exact > raw-message
  const CHANNEL_WEIGHTS = {
    topicKey: 0.35,
    fts: 0.20,
    vector: 0.20,
    exact: 0.15,
    rawMessage: 0.10,
  };

  // Build per-channel rankings
  const topicKeyScores = new Map<string, number>();
  const ftsRanks = new Map<string, number>();
  const vectorScores = new Map<string, number>();
  const exactScores = new Map<string, number>();

  // FTS channel
  for (let i = 0; i < ftsResults.length; i++) {
    const { memory, rank } = ftsResults[i]!;
    ftsRanks.set(memory.id, i + 1);
    exactScores.set(memory.id, computeExactScore(memory, query.text, repoPath));
    topicKeyScores.set(memory.id, computeTopicKeyScore(memory, query.text));
  }

  // Vector channel
  if (query.embedding) {
    const scoredVectors = vectorCandidates
      .map((memory) => ({
        memory,
        score: normalizeVectorScore(cosineSimilarity(query.embedding!, memory.embedding)),
      }))
      .filter((s) => s.score >= 0.05)
      .sort((a, b) => b.score - a.score);

    for (let i = 0; i < scoredVectors.length; i++) {
      const { memory, score } = scoredVectors[i]!;
      if (!vectorScores.has(memory.id)) {
        vectorScores.set(memory.id, score);
      }
      if (!exactScores.has(memory.id)) {
        exactScores.set(memory.id, computeExactScore(memory, query.text, repoPath));
      }
      if (!topicKeyScores.has(memory.id)) {
        topicKeyScores.set(memory.id, computeTopicKeyScore(memory, query.text));
      }
    }
  }

  // Collect all candidate IDs
  const allIds = new Set<string>([
    ...ftsRanks.keys(),
    ...vectorScores.keys(),
  ]);

  // Compute RRF scores
  const scored = new Map<string, HybridResult>();
  for (const id of allIds) {
    const memory =
      ftsResults.find((r) => r.memory.id === id)?.memory ??
      vectorCandidates.find((m) => m.id === id);
    if (!memory) continue;

    const ftsRank = ftsRanks.get(id) ?? Infinity;
    const vectorRank = query.embedding
      ? Array.from(vectorScores.entries())
          .sort((a, b) => b[1] - a[1])
          .findIndex(([mid]) => mid === id) + 1 || Infinity
      : Infinity;
    const exactRank = exactScores.has(id)
      ? Array.from(exactScores.entries())
          .sort((a, b) => b[1] - a[1])
          .findIndex(([mid]) => mid === id) + 1 || Infinity
      : Infinity;
    const topicKeyRank = topicKeyScores.has(id)
      ? Array.from(topicKeyScores.entries())
          .sort((a, b) => b[1] - a[1])
          .findIndex(([mid]) => mid === id) + 1 || Infinity
      : Infinity;

    const ftsScore = normalizeFtsRank(ftsResults.find((r) => r.memory.id === id)?.rank ?? 10);
    const vectorScore = vectorScores.get(id) ?? 0;
    const exactScore = exactScores.get(id) ?? 0;
    const topicKeyScore = topicKeyScores.get(id) ?? 0;

    const combined =
      rrfScore(topicKeyRank) * CHANNEL_WEIGHTS.topicKey +
      rrfScore(ftsRank) * CHANNEL_WEIGHTS.fts +
      rrfScore(vectorRank) * CHANNEL_WEIGHTS.vector +
      rrfScore(exactRank) * CHANNEL_WEIGHTS.exact;

    scored.set(id, {
      memory,
      ftsScore,
      vectorScore,
      exactScore,
      topicKeyScore,
      combinedScore: combined,
    });
  }

  // 4. Sort by combined score, then recency tie-break
  const results = Array.from(scored.values())
    .sort((a, b) => {
      if (b.combinedScore !== a.combinedScore) {
        return b.combinedScore - a.combinedScore;
      }
      return b.memory.accessedAt - a.memory.accessedAt;
    })
    .slice(0, limit);

  // 5. Update accessed_at for recalled memories
  if (results.length > 0) {
    updateAccessedAt(db, results.map((r) => r.memory.id));
  }

  return results;
}

export function formatRecalledMemories(results: HybridResult[]): string {
  if (results.length === 0) return "";
  const lines = results.map((r) => {
    const files = r.memory.relatedFiles.length > 0 ? ` [${r.memory.relatedFiles.join(", ")}]` : "";
    return `- [${r.memory.category}] ${r.memory.content}${files}`;
  });
  return `Recalled memories from previous sessions:\n${lines.join("\n")}`;
}
