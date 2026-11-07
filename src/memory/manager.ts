import type { SqliteDatabase } from "../util/sqlite.js";
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
  computeContentHash,
  findLiveMemoryByContentHash,
  deleteExpiredTasks,
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
  deleteMemoriesByIds,
  recordRecall,
  getRecallStats,
  countLowImportanceMemories,
  listMemoriesForExport,
  type ExportedMemory,
} from "./db.js";
import { embeddingModelFor, fetchEmbeddings } from "./embeddings.js";
import { DEFAULT_MODEL, DEFAULT_PLUMBING_MODEL, type MemoryExtractionPolicy } from "../config.js";
import { retrieveMemories } from "./retrieval.js";
import { runCleanup, shouldCleanup } from "./cleanup.js";
import { redactSecrets } from "./redact.js";
import { resolveRepoRoot } from "./repo-root.js";
import { logger } from "../util/logger.js";
import {
  buildDoctorReport,
  detectMigrationCandidates,
  listRepoPaths,
  migrateRepoPath,
  type MigrationCandidate,
  type MigrateRepoOptions,
  type RepoMigrationPlan,
  type RepoPathCount,
} from "./migrate-repo.js";
import { observeSessionEnd } from "../hooks/session-lifecycle.js";

export { redactSecrets } from "./redact.js";

/** What `/memory doctor` reports about a repo's memory store (#1077). */
export interface MemoryDoctorReport {
  dbPath: string;
  open: boolean;
  dbSizeBytes: number;
  /** Live (not forgotten, not superseded) memories for the repo. */
  live: number;
  byCategory: Record<MemoryCategory, number>;
  lastCreatedAt: number | null;
  lastCleanupAt: number | null;
  embedding: { model: string | null; provider: string; current: number; stale: number };
  /** Recalls that returned at least one memory, over all recorded recalls. */
  recalls: { total: number; hits: number; hitRate: number | null };
  /** Low-importance (≤2) share of live memories: how much is noise. */
  noise: { lowImportance: number; ratio: number | null };
}

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
  /** When LLM-based extraction runs. Default: "session" (#1073). */
  extraction?: MemoryExtractionPolicy;
}

/** An edit buffered under the "session" policy, waiting for the batched flush. */
export interface PendingSessionEdit {
  /** Repo-relative (or absolute) path of the edited file. */
  file: string;
  /** Tool that made the edit (edit | write). */
  tool: string;
  /** Tail of the assistant message that drove the edit (redacted on buffer). */
  intent: string;
  /** Working directory of the edit; used as repoPath when the batch is stored. */
  repoPath: string;
  /** Epoch ms when the edit was recorded. */
  at: number;
}

interface SessionEditMemory {
  content: string;
  category: MemoryCategory;
  importance: number;
  relatedFiles?: string[];
}

/** Cap on buffered edits per session; the oldest are dropped past this. */
const MAX_PENDING_EDITS = 200;

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

const SESSION_EDIT_SYSTEM = `You are given the code edits made during one coding session. Write 1 to 3 durable memories a future session should know.

Rules:
- Capture decisions, conventions, and outcomes — not a per-edit changelog.
- Each memory is ONE sentence, max 25 words, with concrete names (files, tools, facts).
- Skip mechanical or trivial changes. If nothing durable was learned, return [].
- Use ONLY the edit list below.

Return ONLY a JSON array:
[{"content": "...", "category": "fact" | "event" | "preference" | "instruction" | "task", "importance": 1-5, "relatedFiles": ["path"]}]`;

/** Parse the batched session-edit synthesis response into 1–3 memories. */
export function parseSessionEditMemories(text: string): SessionEditMemory[] {
  const cleaned = text.replace(/```(?:json)?\s*|\s*```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: SessionEditMemory[] = [];
  const categories: readonly string[] = ["fact", "event", "instruction", "task", "preference"];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (!content) continue;
    const category = typeof rec.category === "string" && categories.includes(rec.category)
      ? (rec.category as MemoryCategory)
      : "event";
    const importance = typeof rec.importance === "number" && Number.isFinite(rec.importance)
      ? Math.max(1, Math.min(5, Math.round(rec.importance)))
      : 3;
    const relatedFiles = Array.isArray(rec.relatedFiles)
      ? rec.relatedFiles.filter((f): f is string => typeof f === "string").slice(0, 10)
      : undefined;
    out.push({ content, category, importance, ...(relatedFiles && relatedFiles.length > 0 ? { relatedFiles } : {}) });
    if (out.length >= 3) break;
  }
  return out;
}

export class MemoryManager {
  private db: SqliteDatabase | null = null;
  private opts: MemoryManagerOpts;
  /** Buffered edit events per session, flushed in one LLM call (#1073). */
  private pendingEdits = new Map<string, PendingSessionEdit[]>();
  private offSessionEnd: (() => void) | null = null;

  constructor(opts: MemoryManagerOpts) {
    this.opts = opts;
  }

  open(): void {
    if (!this.db) {
      this.db = openMemoryDb(this.opts.dbPath);
      // Session end (exit or /clear) is a flush point for buffered edit events.
      // Failures are logged, never thrown — but NEVER silently: dropped edits
      // are exactly the "memory learned nothing" failure mode.
      this.offSessionEnd = observeSessionEnd((sessionId) =>
        this.flushSessionEdits(sessionId).then(
          (stored) => {
            if (stored > 0) logger.debug("memory:session_flush", { sessionId, stored });
          },
          (err) => {
            logger.warn("memory:flush_error", { sessionId, error: err instanceof Error ? err.message : String(err) });
          },
        ),
      );
    }
  }

  close(): void {
    this.offSessionEnd?.();
    this.offSessionEnd = null;
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

  /** The active memory-extraction policy (#1073). Default: "session". */
  get extractionPolicy(): MemoryExtractionPolicy {
    return this.opts.extraction ?? "session";
  }

  /**
   * Buffer one edit under the "session" policy — no LLM call, no row (#1073).
   * The batch is synthesized once at compaction or session end.
   */
  recordEdit(sessionId: string, edit: PendingSessionEdit): void {
    if (this.extractionPolicy !== "session") return;
    const list = this.pendingEdits.get(sessionId) ?? [];
    if (list.length >= MAX_PENDING_EDITS) list.shift();
    list.push({ ...edit, intent: this.shouldRedact() ? redactSecrets(edit.intent) : edit.intent });
    this.pendingEdits.set(sessionId, list);
  }

  /** How many edits are buffered for a session (0 unless the policy is "session"). */
  pendingEditCount(sessionId: string): number {
    return this.pendingEdits.get(sessionId)?.length ?? 0;
  }

  /**
   * Flush buffered edit events with ONE synthesis call and store the 1–3
   * durable memories it returns (#1073). Returns the number stored.
   * Called at compaction and at session end; safe to call concurrently — the
   * buffer drains synchronously, so a second flush sees it empty.
   */
  async flushSessionEdits(sessionId: string, signal?: AbortSignal): Promise<number> {
    const edits = this.pendingEdits.get(sessionId);
    if (!edits || edits.length === 0) return 0;
    this.pendingEdits.delete(sessionId);
    if (!this.db || this.extractionPolicy !== "session") return 0;

    let memories: SessionEditMemory[];
    try {
      memories = await this.synthesizeSessionEdits(edits, signal);
    } catch (err) {
      // Keep the batch for the next flush (compaction or session end) — but
      // log it: an always-failing synthesis is otherwise indistinguishable
      // from "nothing to learn".
      logger.warn("memory:flush_synthesis_error", { sessionId, error: err instanceof Error ? err.message : String(err) });
      const newer = this.pendingEdits.get(sessionId);
      this.pendingEdits.set(sessionId, newer ? [...edits, ...newer] : edits);
      return 0;
    }

    let stored = 0;
    const repoPath = edits[0]!.repoPath;
    for (const memory of memories) {
      try {
        await this.remember(
          memory.content,
          memory.category,
          memory.importance,
          repoPath,
          sessionId,
          signal,
          undefined,
          undefined,
          memory.relatedFiles,
        );
        stored++;
      } catch {
        // Best-effort: one failed memory never blocks the rest of the batch.
      }
    }
    return stored;
  }

  /** The single LLM call behind flushSessionEdits: all buffered edits → 1–3 memories. */
  private async synthesizeSessionEdits(edits: PendingSessionEdit[], signal?: AbortSignal): Promise<SessionEditMemory[]> {
    const lines = edits
      .map((e, i) => `${i + 1}. ${e.tool} ${e.file}${e.intent ? `\n   intent: ${e.intent}` : ""}`)
      .join("\n");
    const user = redactSecrets(
      `Code edits made during this session:\n\n${lines}\n\nRespond with a JSON array of 1 to 3 durable memories.`,
    );
    const text = await runKimiText({
      ...this.extractionLlmOpts,
      signal,
      temperature: 0.2,
      messages: [
        { role: "system", content: SESSION_EDIT_SYSTEM },
        { role: "user", content: user },
      ],
    });
    return parseSessionEditMemories(text);
  }

  private shouldRedact(): boolean {
    return this.opts.redactSecrets !== false;
  }

  /** Resolve a stable repo identity so subdirectories, worktrees, and clones
   *  share one memory namespace instead of fragmenting by absolute cwd. */
  private repo(repoPath: string): string {
    return resolveRepoRoot(repoPath);
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
    topicKey?: string,
    relatedFiles?: string[]
  ): Promise<{ id: string; superseded?: string[] }> {
    if (!this.db) throw new Error("Memory DB not open");
    const repo = this.repo(repoPath);

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

    // 2b. Content-addressed dedup (#1074): identical live content is already
    // stored — return it instead of re-verifying, re-embedding, or churning
    // supersession pointers.
    const duplicate = findLiveMemoryByContentHash(
      this.db,
      computeContentHash(safeContent, category, repo),
    );
    if (duplicate) {
      return { id: duplicate.id };
    }

    // 3. Normalize topic key (trust caller-provided key for auto-extracted memories)
    const resolvedTopicKey = topicKey?.trim() || this.normalizeTopicKey(safeContent, repo);

    // 4. Supersede durable knowledge on the same topic. Events accumulate:
    //    a later edit must never hide an earlier one (#1074).
    const supersededIds: string[] = [];
    if (resolvedTopicKey && category !== "event") {
      const existing = findMemoriesByTopicKey(this.db, repo, resolvedTopicKey);
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
      repoPath: repo,
      importance: Math.max(1, Math.min(5, importance)),
      topicKey: resolvedTopicKey ?? undefined,
      agentRole,
      relatedFiles,
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
    const repo = this.repo(repoPath);

    const safeContent = this.shouldRedact() ? redactSecrets(plan) : plan;
    if (!safeContent.trim()) {
      throw new Error("Plan content is empty after redaction");
    }

    const normalizedKey = topicKey.trim();
    if (!normalizedKey) {
      throw new Error("Plan topic key cannot be empty");
    }

    // Idempotent: the same plan content stored twice is one row (#1074).
    const duplicate = findLiveMemoryByContentHash(
      this.db,
      computeContentHash(safeContent, "task", repo),
    );
    if (duplicate) {
      return { id: duplicate.id };
    }

    // Supersede any previous plan under the same key.
    const supersededIds: string[] = [];
    const existing = findMemoriesByTopicKey(this.db, repo, normalizedKey);
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
      repoPath: repo,
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
    const rows = findMemoriesByTopicKey(this.db, this.repo(repoPath), topicKey);
    return rows[0] ?? null;
  }

  /**
   * Count high-signal memories created since the given timestamp.
   * Used for KIMI.md drift detection (Trigger A: session-start check).
   */
  countHighSignalMemoriesSince(repoPath: string, since: number): number {
    if (!this.db) return 0;
    return countHighSignalMemoriesSince(this.db, this.repo(repoPath), since);
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
      .all(this.repo(repoPath)) as Array<{ created_at: number }>;
    return rows[0]?.created_at ?? 0;
  }

  /**
   * Record that KIMI.md was refreshed. Creates a lightweight memory
   * so drift detection knows when the snapshot was last updated.
   */
  async recordKimiMdRefresh(repoPath: string, sessionId: string): Promise<void> {
    if (!this.db) return;
    const repo = this.repo(repoPath);
    const content = `KIMI.md refreshed for ${repo}`;
    // Content-addressed dedup would freeze the refresh timestamp on the first
    // write, so an existing row is touched instead of re-inserted (#1074).
    const existing = findLiveMemoryByContentHash(this.db, computeContentHash(content, "event", repo));
    if (existing) {
      const now = Date.now();
      this.db
        .prepare(`UPDATE memories SET created_at = ?, accessed_at = ? WHERE id = ?`)
        .run(now, now, existing.id);
      return;
    }
    const embedding = new Float32Array(DEFAULT_EMBEDDING_DIM);
    insertMemory(
      this.db,
      {
        content,
        category: "event",
        sourceSessionId: sessionId,
        repoPath: repo,
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
    let results: HybridResult[];
    if (!model) {
      // No embeddings for this provider: text, topic-key and exact channels only.
      results = await retrieveMemories({ db: this.db, query: { ...query, embedding: undefined } });
    } else {
      if (!query.embedding && query.text) {
        try {
          const embeddings = await fetchEmbeddings({ ...this.embedAuth, model, texts: [query.text] });
          query.embedding = embeddings[0];
        } catch {
          // Continue without vector search
        }
      }
      results = await retrieveMemories({ db: this.db, query: { ...query, embeddingModel: model, repoPath: this.repo(query.repoPath ?? process.cwd()) } });
    }
    // Feed `/memory doctor`'s recall hit rate. Best-effort: a stats write
    // must never fail a recall.
    try {
      recordRecall(this.db, this.repo(query.repoPath ?? process.cwd()), results.length);
    } catch {
      /* non-fatal */
    }
    return results;
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

  /** Per-memory delete: remove one row outright (#1077). */
  remove(id: string): boolean {
    if (!this.db) return false;
    return deleteMemoriesByIds(this.db, [id]) > 0;
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
    const stale = listMemoriesNeedingEmbedding(this.db, this.repo(repoPath), model, limit);
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
    const counts = this.db ? countMemoriesByEmbeddingModel(this.db, this.repo(repoPath), model) : { current: 0, stale: 0 };
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

  async cleanup(repoPath: string): Promise<{ oldDeleted: number; excessDeleted: number; duplicatesMerged: number; tasksExpired: number }> {
    if (!this.db) return { oldDeleted: 0, excessDeleted: 0, duplicatesMerged: 0, tasksExpired: 0 };

    const maxAgeDays = this.opts.maxAgeDays ?? 90;
    const maxEntries = this.opts.maxEntries ?? 1000;

    if (!shouldCleanup(this.db)) {
      return { oldDeleted: 0, excessDeleted: 0, duplicatesMerged: 0, tasksExpired: 0 };
    }

    const result = await runCleanup({
      db: this.db,
      repoPath: this.repo(repoPath),
      maxAgeDays,
      maxEntries,
      embeddingModel: this.embeddingModel,
    });

    return result;
  }

  getStats(repoPath?: string): MemoryStats | null {
    if (!this.db) return null;
    return getMemoryStats(this.db, repoPath ? this.repo(repoPath) : undefined);
  }

  /** All memories (optionally one repo) without vectors, for `/memory export`. */
  list(repoPath?: string): ExportedMemory[] {
    if (!this.db) return [];
    return listMemoriesForExport(this.db, repoPath ? this.repo(repoPath) : undefined);
  }

  /** Health, recall hit rate and noise ratio for `/memory doctor` (#1077). */
  doctor(repoPath: string): MemoryDoctorReport | null {
    if (!this.db) return null;
    const repo = this.repo(repoPath);
    const stats = getMemoryStats(this.db, repo);
    const recalls = getRecallStats(this.db, repo);
    const lowImportance = countLowImportanceMemories(this.db, repo);
    return {
      dbPath: this.opts.dbPath,
      open: true,
      dbSizeBytes: stats.dbSizeBytes,
      live: stats.totalCount,
      byCategory: stats.byCategory,
      lastCreatedAt: stats.lastCreatedAt,
      lastCleanupAt: stats.lastCleanupAt,
      embedding: this.embeddingStatus(repoPath),
      recalls: {
        total: recalls.total,
        hits: recalls.hits,
        hitRate: recalls.total > 0 ? recalls.hits / recalls.total : null,
      },
      noise: {
        lowImportance,
        ratio: stats.totalCount > 0 ? lowImportance / stats.totalCount : null,
      },
    };
  }

  clearRepo(repoPath: string): number {
    if (!this.db) return 0;
    return clearMemoriesForRepo(this.db, this.repo(repoPath));
  }

  /** Path the memory DB was opened with (for `/memory doctor`). */
  get dbPath(): string {
    return this.opts.dbPath;
  }

  /** Every `repo_path` in the DB with its row count (for `/memory doctor`). */
  repoPaths(): RepoPathCount[] {
    if (!this.db) return [];
    return listRepoPaths(this.db);
  }

  /** Orphaned paths that look like this repo before a move or rename. */
  migrationCandidates(repoPath: string): MigrationCandidate[] {
    if (!this.db) return [];
    return detectMigrationCandidates(this.db, this.repo(repoPath));
  }

  /**
   * Plan (dry run by default) or apply a `repo_path` migration, e.g. rows
   * left behind by the kimiflare → autopilot rename. Paths resolve to their
   * repo roots, so a subdirectory argument still re-keys to the same identity
   * recall uses.
   */
  migrateRepo(from: string, to: string, opts: MigrateRepoOptions = {}): RepoMigrationPlan {
    if (!this.db) throw new Error("Memory DB not open");
    return migrateRepoPath(this.db, this.repo(from), this.repo(to), opts);
  }

  /** The `/memory doctor` report: DB path, current repo, orphaned candidates. */
  doctorReport(repoPath: string): string {
    if (!this.db) throw new Error("Memory DB not open");
    return buildDoctorReport(this.db, this.repo(repoPath), this.opts.dbPath);
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
