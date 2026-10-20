export type MemoryCategory = "fact" | "event" | "instruction" | "task" | "preference";

export interface Memory {
  id: string;
  content: string;
  embedding: Float32Array;
  category: MemoryCategory;
  sourceSessionId: string;
  repoPath: string;
  createdAt: number;
  accessedAt: number;
  importance: number;
  relatedFiles: string[];
  topicKey: string | null;
  supersededBy: string | null;
  forgotten: boolean;
  vectorized: boolean;
  /**
   * Embedding model that produced `embedding`. Vectors are only compared with
   * vectors from the same model; null for rows with no real vector (plans and
   * other topic-key-only rows, or rows written before models were recorded
   * and not recognisable by size).
   */
  embeddingModel: string | null;
  /** Agent role that created this memory (plan, build, general). */
  agentRole: string | null;
}

export interface MemoryInput {
  content: string;
  category: MemoryCategory;
  sourceSessionId: string;
  repoPath: string;
  importance: number;
  relatedFiles?: string[];
  topicKey?: string;
  /** Agent role that created this memory (plan, build, general). */
  agentRole?: string;
}

export interface MemoryQuery {
  text: string;
  embedding?: Float32Array;
  repoPath?: string;
  category?: MemoryCategory;
  limit?: number;
  maxAgeDays?: number;
  /** Filter recalled memories by the agent role that created them. */
  agentRole?: string;
  /** Model that produced `embedding`; only rows from the same model are vector-compared. */
  embeddingModel?: string;
}

export interface HybridResult {
  memory: Memory;
  ftsScore: number;
  vectorScore: number;
  exactScore: number;
  topicKeyScore: number;
  combinedScore: number;
}

export interface MemoryStats {
  totalCount: number;
  dbSizeBytes: number;
  lastCleanupAt: number | null;
  byCategory: Record<MemoryCategory, number>;
}

export const DEFAULT_EMBEDDING_DIM = 768;
export { DEFAULT_EMBEDDING_MODEL } from "./embeddings.js";
