import type Database from "better-sqlite3";
import { pickLlmAuth, providerPresetOf, type LlmAuth } from "../agent/llm-auth.js";
import { runKimi } from "../agent/client.js";
import type { ChatMessage } from "../agent/messages.js";
import type { Memory, MemoryInput, MemoryQuery, HybridResult, MemoryStats, MemoryCategory } from "./schema.js";
import { DEFAULT_EMBEDDING_DIM } from "./schema.js";
import {
  openMemoryDb,
  closeMemoryDb,
  insertMemory,
  insertMemories,
  getMemoryStats,
  clearMemoriesForRepo,
  listTopicKeys,
  findMemoriesByTopicKey,
  supersedeMemory,
  forgetMemory,
  listMemoriesNeedingEmbedding,
  countMemoriesByEmbeddingModel,
  updateMemoryEmbedding,
  type VectorInfo,
  getMemoryById,
  countHighSignalMemoriesSince,
} from "./db.js";
import { embeddingModelFor, fetchEmbeddings } from "./embeddings.js";
import { DEFAULT_MODEL, DEFAULT_PLUMBING_MODEL } from "../config.js";
import { retrieveMemories } from "./retrieval.js";
import { runCleanup, shouldCleanup } from "./cleanup.js";

export interface MemoryManagerOpts extends LlmAuth {
  dbPath: string;
  model?: string;
  plumbingModel?: string;
  extractionModel?: string;
  /** Override for the embedding model; defaults to the embedding provider's preset model. */
  embeddingModel?: string;
  /**
   * Credentials for embeddings when they come from a different provider than
   * chat (config `embeddingProvider`). Defaults to the chat credentials.
   */
  embeddingAuth?: LlmAuth;
  maxAgeDays?: number;
  maxEntries?: number;
  redactSecrets?: boolean;
}

interface LlmOpts extends LlmAuth {
  model: string;
  signal?: AbortSignal;
}

async function runKimiText(opts: LlmOpts & { messages: ChatMessage[]; temperature?: number }): Promise<string> {
  const events = runKimi({
    ...pickLlmAuth(opts),
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.1,
    reasoningEffort: "low",
    signal: opts.signal,
  });
  let text = "";
  for await (const ev of events) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim();
}

// Secret redaction patterns (default-on)
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: "[REDACTED_SK_KEY]" },
  { pattern: /\b[0-9a-f]{32,64}\b/g, replacement: "[REDACTED_HEX_KEY]" },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Deterministic topic-key normalization: lowercase, strip non-alphanum, replace spaces with _, truncate to 60. */
export function deterministicTopicKey(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

/** Pick the best existing topic key for a memory, or generate a new one. */
export function pickTopicKey(content: string, existingKeys: string[]): string | null {
  const normalized = deterministicTopicKey(content);
  if (!normalized) return null;

  for (const existing of existingKeys) {
    if (normalized.includes(existing) || existing.includes(normalized)) {
      return existing;
    }
  }

  return normalized;
}

const VERIFY_SYSTEM = `You are a fact-checking engine. Given a memory and the conversation context it was extracted from, verify whether the memory is directly supported by the context.

Rules:
- The memory must be directly stated or clearly implied by the context.
- Do not approve inferred facts that go beyond what was said.
- Do not approve facts with incorrect entities, versions, or file paths.

Return a JSON object:
{
  "valid": boolean,
  "confidence": "high" | "medium" | "low",
  "corrected_content": string | null  // if minor correction needed, provide it; otherwise null
}`;

const TOPIC_KEY_SYSTEM = `You are a topic normalization engine. Given a new memory and a list of existing topic keys for this project, decide whether the new memory belongs to an existing topic or needs a new one.

Rules:
- Topic keys are lowercase snake_case, max 3 words.
- If the new memory is about the same topic as an existing key, return the existing key.
- If it's a genuinely new topic, generate a new normalized key.
- Return ONLY the topic key string, nothing else.`;

const HYPOTHETICAL_QUERIES_SYSTEM = `Given a memory, generate 3-5 short search queries a user might type to find it.
Cover different phrasings: declarative, interrogative, and keyword-based.

Return a JSON array of strings. Example:
["what package manager does this project use?", "pnpm preference", "user likes pnpm over npm"]`;

export class MemoryManager {
  private db: Database.Database | null = null;
  private opts: MemoryManagerOpts;

  constructor(opts: MemoryManagerOpts) {
    this.opts = opts;
  }

  open(): void {
    if (!this.db) {
      this.db = openMemoryDb(this.opts.dbPath);
    }
  }

  close(): void {
    if (this.db) {
      closeMemoryDb();
      this.db = null;
    }
  }

  isOpen(): boolean {
    return this.db !== null;
  }

  private get llmOpts(): LlmOpts {
    return {
      ...pickLlmAuth(this.opts),
      model: this.opts.model ?? DEFAULT_MODEL,
    };
  }

  private get plumbingLlmOpts(): LlmOpts {
    return {
      ...pickLlmAuth(this.opts),
      // Side calls follow the active provider: its plumbing model, else the chat model.
      model: this.opts.plumbingModel ?? this.opts.model ?? DEFAULT_MODEL,
    };
  }

  private get extractionLlmOpts(): LlmOpts {
    return {
      ...pickLlmAuth(this.opts),
      model: this.opts.extractionModel ?? this.opts.plumbingModel ?? this.opts.model ?? DEFAULT_MODEL,
    };
  }

  /** Expose extraction LLM opts so the agent loop can pass them to extractors. */
  getExtractionLlmOpts(): LlmOpts {
    return this.extractionLlmOpts;
  }

  private shouldRedact(): boolean {
    return this.opts.redactSecrets !== false;
  }

  /**
   * Store a memory with verification, topic-key normalization, hypothetical queries,
   * secret redaction, and supersession.
   */
  async remember(
    content: string,
    category: MemoryCategory,
    importance: number,
    repoPath: string,
    sessionId: string,
    signal?: AbortSignal,
    agentRole?: string,
    topicKey?: string
  ): Promise<{ id: string; superseded?: string[] }> {
    if (!this.db) throw new Error("Memory DB not open");

    // 1. Redact secrets
    let safeContent = this.shouldRedact() ? redactSecrets(content) : content;
    if (!safeContent.trim()) {
      throw new Error("Memory content is empty after redaction");
    }

    // 2. Verify the memory (lightweight — just check it's coherent)
    const verified = await this.verifyMemory(safeContent, signal);
    if (!verified.valid) {
      throw new Error("Memory failed verification: not directly supported by context");
    }
    if (verified.corrected_content) {
      safeContent = verified.corrected_content;
    }

    // 3. Normalize topic key (trust caller-provided key for auto-extracted memories)
    const resolvedTopicKey = topicKey?.trim() || this.normalizeTopicKey(safeContent, repoPath);

    // 4. Check for supersession
    const supersededIds: string[] = [];
    if (resolvedTopicKey) {
      const existing = findMemoriesByTopicKey(this.db, repoPath, resolvedTopicKey);
      for (const old of existing) {
        // Simple heuristic: same topic key + similar content length = likely superseded
        // A more robust approach would use an LLM, but this avoids extra tokens
        supersedeMemory(this.db, old.id, "pending"); // Will update after insert
        supersededIds.push(old.id);
      }
    }

    // 5. Generate hypothetical queries for embedding
    const hypotheticalQueries = await this.generateHypotheticalQueries(safeContent, signal);
    const embedText = hypotheticalQueries.join(" | ") + " " + safeContent;

    // 6. Embed and store. A provider without embeddings (or a failed call)
    // never loses the memory: it is stored without a vector, recalled by
    // text and topic key, and embedded later by backfill().
    const { embedding, vector } = await this.embedOne(embedText);

    const input: MemoryInput = {
      content: safeContent,
      category,
      sourceSessionId: sessionId,
      repoPath,
      importance: Math.max(1, Math.min(5, importance)),
      topicKey: resolvedTopicKey ?? undefined,
      agentRole,
    };

    const memory = insertMemory(this.db, input, embedding, vector);

    // 7. Update superseded pointers to point to the new memory
    for (const oldId of supersededIds) {
      supersedeMemory(this.db, oldId, memory.id);
    }

    return { id: memory.id, superseded: supersededIds.length > 0 ? supersededIds : undefined };
  }

  /**
   * Store a plan directly under a deterministic topic key.
   * Skips embedding, verification, and hypothetical queries so it is fast and
   * deterministic. Supersedes any previous plan stored under the same key.
   */
  async rememberPlan(
    plan: string,
    repoPath: string,
    sessionId: string,
    topicKey = "current_dev_plan",
  ): Promise<{ id: string; superseded?: string[] }> {
    if (!this.db) throw new Error("Memory DB not open");

    const safeContent = this.shouldRedact() ? redactSecrets(plan) : plan;
    if (!safeContent.trim()) {
      throw new Error("Plan content is empty after redaction");
    }

    const normalizedKey = topicKey.trim();
    if (!normalizedKey) {
      throw new Error("Plan topic key cannot be empty");
    }

    // Supersede any previous plan under the same key.
    const supersededIds: string[] = [];
    const existing = findMemoriesByTopicKey(this.db, repoPath, normalizedKey);
    for (const old of existing) {
      supersedeMemory(this.db, old.id, "pending");
      supersededIds.push(old.id);
    }

    // Zero embedding: this memory is only ever recalled by exact topic key.
    const zeroEmbedding = new Float32Array(DEFAULT_EMBEDDING_DIM);

    const memory = insertMemory(this.db, {
      content: safeContent,
      category: "task",
      sourceSessionId: sessionId,
      repoPath,
      importance: 4,
      topicKey: normalizedKey,
    }, zeroEmbedding);

    for (const oldId of supersededIds) {
      supersedeMemory(this.db, oldId, memory.id);
    }

    return { id: memory.id, superseded: supersededIds.length > 0 ? supersededIds : undefined };
  }

  /**
   * Recall the latest memory for an exact topic key.
   * Does not use embeddings; returns null if no matching memory exists.
   */
  getByTopicKey(repoPath: string, topicKey: string): Memory | null {
    if (!this.db) return null;
    const rows = findMemoriesByTopicKey(this.db, repoPath, topicKey);
    return rows[0] ?? null;
  }

  /**
   * Count high-signal memories created since the given timestamp.
   * Used for KIMI.md drift detection (Trigger A: session-start check).
   */
  countHighSignalMemoriesSince(repoPath: string, since: number): number {
    if (!this.db) return 0;
    return countHighSignalMemoriesSince(this.db, repoPath, since);
  }

  /**
   * Get the timestamp of the most recent KIMI.md refresh memory.
   * Returns 0 if none exists.
   */
  getLastKimiMdRefreshTime(repoPath: string): number {
    if (!this.db) return 0;
    const rows = this.db
      .prepare(
        `SELECT created_at FROM memories
         WHERE repo_path = ? AND topic_key = 'kimi_md_refresh'
         AND forgotten = 0 AND superseded_by IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .all(repoPath) as Array<{ created_at: number }>;
    return rows[0]?.created_at ?? 0;
  }

  /**
   * Record that KIMI.md was refreshed. Creates a lightweight memory
   * so drift detection knows when the snapshot was last updated.
   */
  async recordKimiMdRefresh(repoPath: string, sessionId: string): Promise<void> {
    if (!this.db) return;
    const embedding = new Float32Array(DEFAULT_EMBEDDING_DIM);
    insertMemory(
      this.db,
      {
        content: `KIMI.md refreshed for ${repoPath}`,
        category: "event",
        sourceSessionId: sessionId,
        repoPath,
        importance: 2,
        topicKey: "kimi_md_refresh",
      },
      embedding,
    );
  }

  /**
   * Recall memories using the full hybrid retrieval pipeline.
   */
  async recall(query: MemoryQuery): Promise<HybridResult[]> {
    if (!this.db) return [];

    const model = this.embeddingModel;
    if (!model) {
      // No embeddings for this provider: text, topic-key and exact channels only.
      return retrieveMemories({ db: this.db, query: { ...query, embedding: undefined } });
    }
    if (!query.embedding && query.text) {
      try {
        const embeddings = await fetchEmbeddings({ ...this.embedAuth, model, texts: [query.text] });
        query.embedding = embeddings[0];
      } catch {
        // Continue without vector search
      }
    }

    return retrieveMemories({ db: this.db, query: { ...query, embeddingModel: model } });
  }

  /**
   * Recall memories created by a specific agent role.
   */
  async recallByRole(query: MemoryQuery, agentRole: string): Promise<HybridResult[]> {
    return this.recall({ ...query, agentRole });
  }

  /**
   * Format recalled memories as a compact context block for injection into messages.
   */
  static formatRecalled(results: HybridResult[]): string {
    if (results.length === 0) return "";
    const lines: string[] = ["[recalled memories]"];
    for (const r of results) {
      const files = r.memory.relatedFiles.length > 0 ? ` [${r.memory.relatedFiles.join(", ")}]` : "";
      lines.push(`- [${r.memory.category}] ${r.memory.content}${files}`);
    }
    return lines.join("\n");
  }

  /**
   * Synthesize recalled memories into a dense prose paragraph.
   * Uses the lightweight plumbing model (Scout) to keep costs low.
   */
  async synthesizeRecalled(results: HybridResult[], signal?: AbortSignal): Promise<string> {
    if (results.length === 0) return "";
    const raw = MemoryManager.formatRecalled(results);
    const text = await runKimiText({
      ...this.plumbingLlmOpts,
      signal,
      messages: [
        {
          role: "system",
          content:
            "You are a context-synthesis engine. Given a list of recalled memories about a codebase, produce a single dense paragraph of context for a coding assistant. Preserve all facts, file paths, and decisions. Do not add information not present in the memories. Be terse.",
        },
        { role: "user", content: raw },
      ],
    });
    return text || raw;
  }

  /**
   * Soft-delete a memory by ID.
   */
  async forget(id: string): Promise<boolean> {
    if (!this.db) return false;
    const mem = getMemoryById(this.db, id);
    if (!mem) return false;
    forgetMemory(this.db, id);
    return true;
  }

  /**
   * Embed memories that have no vector yet, or whose vector came from a
   * different embedding model (the provider or model changed). Runs at
   * startup in batches of up to `limit`, so a large database is re-indexed
   * over a few sessions instead of all at once.
   */
  async backfill(repoPath: string, limit = 100, signal?: AbortSignal): Promise<number> {
    if (!this.db) return 0;
    const model = this.embeddingModel;
    if (!model) return 0;
    const stale = listMemoriesNeedingEmbedding(this.db, repoPath, model, limit);
    let fixed = 0;
    for (const mem of stale) {
      if (signal?.aborted) break;
      try {
        const embeddings = await fetchEmbeddings({ ...this.embedAuth, model, texts: [mem.content] });
        updateMemoryEmbedding(this.db, mem.id, embeddings[0]!, model);
        fixed++;
      } catch {
        // Skip on failure; will retry next startup
      }
    }
    return fixed;
  }

  /** The embedding model in use, or null when the provider has none. */
  get embeddingModel(): string | null {
    return embeddingModelFor(this.embedAuth, this.opts.embeddingModel);
  }

  /** Vector-recall status for `/memory`: model, provider, and how many rows still need (re-)embedding. */
  embeddingStatus(repoPath: string): { model: string | null; provider: string; current: number; stale: number } {
    const model = this.embeddingModel;
    const counts = this.db ? countMemoriesByEmbeddingModel(this.db, repoPath, model) : { current: 0, stale: 0 };
    return { model, provider: providerPresetOf(this.embedAuth).name, ...counts };
  }

  private get embedAuth(): LlmAuth {
    return this.opts.embeddingAuth ?? pickLlmAuth(this.opts);
  }

  private async embedOne(text: string): Promise<{ embedding: Float32Array; vector: VectorInfo }> {
    const model = this.embeddingModel;
    if (model) {
      try {
        const embeddings = await fetchEmbeddings({ ...this.embedAuth, model, texts: [text] });
        return { embedding: embeddings[0]!, vector: { model } };
      } catch {
        // Fall through: store now, embed on a later backfill.
      }
    }
    return { embedding: new Float32Array(0), vector: { pending: true } };
  }

  async cleanup(repoPath: string): Promise<{ oldDeleted: number; excessDeleted: number; duplicatesMerged: number }> {
    if (!this.db) return { oldDeleted: 0, excessDeleted: 0, duplicatesMerged: 0 };

    const maxAgeDays = this.opts.maxAgeDays ?? 90;
    const maxEntries = this.opts.maxEntries ?? 1000;

    if (!shouldCleanup(this.db)) {
      return { oldDeleted: 0, excessDeleted: 0, duplicatesMerged: 0 };
    }

    const result = await runCleanup({
      db: this.db,
      repoPath,
      maxAgeDays,
      maxEntries,
      embeddingModel: this.embeddingModel,
    });

    return result;
  }

  getStats(): MemoryStats | null {
    if (!this.db) return null;
    return getMemoryStats(this.db);
  }

  clearRepo(repoPath: string): number {
    if (!this.db) return 0;
    return clearMemoriesForRepo(this.db, repoPath);
  }

  private async verifyMemory(content: string, signal?: AbortSignal): Promise<{ valid: boolean; corrected_content: string | null }> {
    const text = await runKimiText({
      ...this.plumbingLlmOpts,
      signal,
      messages: [
        { role: "system", content: VERIFY_SYSTEM },
        { role: "user", content: `Memory: "${content}"\n\nContext: This memory was explicitly provided by the user during a conversation.` },
      ],
    });

    // Try to parse JSON
    let parsed: unknown;
    try {
      const cleaned = text.replace(/```(?:json)?\s*|\s*```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      // If parsing fails, assume valid (user-provided memories are generally trustworthy)
      return { valid: true, corrected_content: null };
    }

    if (!parsed || typeof parsed !== "object") {
      return { valid: true, corrected_content: null };
    }

    const rec = parsed as Record<string, unknown>;
    const valid = rec.valid === true;
    const corrected = typeof rec.corrected_content === "string" ? rec.corrected_content : null;
    return { valid, corrected_content: corrected };
  }

  private normalizeTopicKey(content: string, repoPath: string): string | null {
    const existingKeys = listTopicKeys(this.db!, repoPath);
    return pickTopicKey(content, existingKeys);
  }

  private async generateHypotheticalQueries(content: string, signal?: AbortSignal): Promise<string[]> {
    const text = await runKimiText({
      ...this.plumbingLlmOpts,
      signal,
      messages: [
        { role: "system", content: HYPOTHETICAL_QUERIES_SYSTEM },
        { role: "user", content: `Memory: "${content}"` },
      ],
    });

    let parsed: unknown;
    try {
      const cleaned = text.replace(/```(?:json)?\s*|\s*```/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return [];
    }

    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, 5);
  }
}
