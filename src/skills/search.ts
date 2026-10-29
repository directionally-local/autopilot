import type { SqliteDatabase } from "../util/sqlite.js";
import type { LlmAuth } from "../agent/llm-auth.js";
import { embeddingModelFor, fetchEmbeddings, cosineSimilarity, vectorFromBlob } from "../memory/embeddings.js";
import { hasAnySections, listAllSectionRows, rowToSectionResult } from "./db.js";
import type { SectionResult } from "./types.js";

export interface SearchOpts extends LlmAuth {
  model?: string;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "how", "what", "when", "you", "can", "are", "use", "our", "your"]);

function terms(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

/** Share of the query's terms that appear in the section (0–1); used when vectors are unavailable. */
export function keywordSimilarity(query: string, text: string): number {
  const q = terms(query);
  if (q.size === 0) return 0;
  const t = terms(text);
  let hit = 0;
  for (const term of q) if (t.has(term)) hit++;
  return hit / q.size;
}

/**
 * Rank all skill sections against the query. Sections embedded with the
 * current embedding model are ranked by cosine similarity; the rest — and
 * everything when the provider has no embeddings or the query embedding
 * fails — by keyword overlap, so skill routing keeps working on every
 * provider. Returns results sorted by similarity descending.
 */
export async function searchSections(
  query: string,
  db: SqliteDatabase,
  opts: SearchOpts
): Promise<SectionResult[]> {
  if (!hasAnySections(db)) return [];

  const rows = listAllSectionRows(db);
  const model = embeddingModelFor(opts, opts.model);
  let queryEmbedding: Float32Array | undefined;
  if (model && rows.some((r) => r.embedding_model === model)) {
    try {
      queryEmbedding = (await fetchEmbeddings({ ...opts, model, texts: [query] }))[0];
    } catch {
      queryEmbedding = undefined;
    }
  }

  const scored: SectionResult[] = [];
  for (const row of rows) {
    const similarity =
      queryEmbedding && row.embedding_model === model
        ? cosineSimilarity(queryEmbedding, vectorFromBlob(row.embedding))
        : keywordSimilarity(query, `${row.name} ${row.description} ${row.heading} ${row.body}`);
    scored.push({
      ...rowToSectionResult(row),
      similarity,
    });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  return scored;
}
