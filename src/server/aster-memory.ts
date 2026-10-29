import { SqliteDatabase } from "../util/sqlite.js";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openRouterHeaders, openRouterUrl } from "../models/openrouter.js";
import { defaultAsterDbPath } from "./aster-store.js";
import { containsLikelyProviderSecret } from "./aster-tools.js";

/**
 * Long-term memory shared by all of a user's Aster chats.
 *
 * Three kinds of items:
 * - person / project: a living profile card (keyed, rewritten as new information arrives),
 *   so "Sara" or "the Acme redesign" never has to be re-explained in a later chat;
 * - fact: one durable sentence about the user (preferences, circumstances, decisions);
 * - session: a short summary of each chat (what it was about, which repo, where it stands),
 *   which gives every new chat a high-level view of recent work.
 *
 * Writing is automatic: after each turn a small model reads the exchange and proposes
 * operations against the current memory (Mem0-style add/update/delete), and anything the
 * user explicitly asks to remember is pinned. Reading is budgeted: each chat starts with
 * a short brief, later turns add only newly relevant cards, and the full memory is
 * available to the agent as a file it can search.
 */

export type AsterMemoryKind = "fact" | "person" | "project" | "session";

export interface AsterMemoryItem {
  id: string;
  kind: AsterMemoryKind;
  key: string | null;
  title: string;
  content: string;
  pinned: boolean;
  sourceConversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AsterMemoryChange {
  id: string;
  kind: AsterMemoryKind;
  title: string;
  change: "added" | "updated" | "removed";
}

export interface AsterMemoryExchange {
  conversationId: string;
  project?: { kind: "chat" | "code"; repository?: string | null } | undefined;
  userText: string;
  assistantText: string;
}

interface ExtractionResult {
  upserts?: Array<{ kind?: string; key?: string | null; id?: string | null; title?: string; content?: string; pinned?: boolean }>;
  deletes?: string[];
  session?: { title?: string; summary?: string } | null;
}

const MAX_CARD_CHARS = 900;
const MAX_FACT_CHARS = 300;
const MAX_MEMORY_PROMPT_ITEMS = 150;
const BRIEF_FACTS = 15;
const BRIEF_RECENT_SESSIONS = 6;
const BRIEF_RECENT_CARDS = 3;
const KEY_RE = /^(person|project):[a-z0-9][a-z0-9-]{0,80}$/;

export class AsterMemory {
  private readonly db: SqliteDatabase;
  /** Card keys already shown to the agent per conversation, so later turns only add new ones. */
  private readonly shown = new Map<string, Set<string>>();

  constructor(
    dbPath = defaultAsterDbPath(),
    private readonly options: {
      model?: string;
      apiKey?: string;
      fetchImpl?: typeof fetch;
      enabled?: boolean;
    } = {},
  ) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new SqliteDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aster_memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        key TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source_conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_aster_memories_key ON aster_memories(key) WHERE key IS NOT NULL AND deleted = 0;
      CREATE INDEX IF NOT EXISTS idx_aster_memories_kind ON aster_memories(kind, deleted, updated_at);
    `);
    try { chmodSync(dbPath, 0o600); } catch { /* managed by the service account */ }
  }

  get enabled(): boolean {
    return this.options.enabled !== false && Boolean(this.apiKey);
  }

  private get apiKey(): string | undefined {
    return this.options.apiKey ?? process.env.OPENROUTER_API_KEY;
  }

  private get model(): string {
    return this.options.model ?? process.env.AUTOPILOT_ASTER_MEMORY_MODEL ?? "google/gemini-3.8-flash";
  }

  close(): void {
    this.db.close();
  }

  list(kind?: AsterMemoryKind): AsterMemoryItem[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM aster_memories WHERE deleted = 0 AND kind = ? ORDER BY updated_at DESC").all(kind)
      : this.db.prepare("SELECT * FROM aster_memories WHERE deleted = 0 ORDER BY updated_at DESC").all();
    return (rows as MemoryRow[]).map(rowToItem);
  }

  get(id: string): AsterMemoryItem | undefined {
    const row = this.db.prepare("SELECT * FROM aster_memories WHERE id = ? AND deleted = 0").get(id) as MemoryRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  /** Soft delete; the user removed it, so extraction must not silently recreate it from this item. */
  delete(id: string): boolean {
    return this.db.prepare("UPDATE aster_memories SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0").run(Date.now(), id).changes === 1;
  }

  /** Write or merge one item. person/project/session are keyed; facts are by id. */
  upsert(input: {
    kind: AsterMemoryKind;
    key?: string | null;
    id?: string | null;
    title: string;
    content: string;
    pinned?: boolean;
    sourceConversationId?: string | null;
  }): { item: AsterMemoryItem; change: "added" | "updated" } {
    const now = Date.now();
    const limit = input.kind === "fact" ? MAX_FACT_CHARS : MAX_CARD_CHARS;
    const title = input.title.trim().slice(0, 120);
    const content = input.content.trim().slice(0, limit);
    const existing = input.key
      ? this.db.prepare("SELECT * FROM aster_memories WHERE key = ? AND deleted = 0").get(input.key) as MemoryRow | undefined
      : input.id
        ? this.db.prepare("SELECT * FROM aster_memories WHERE id = ? AND deleted = 0").get(input.id) as MemoryRow | undefined
        : undefined;
    if (existing) {
      this.db.prepare("UPDATE aster_memories SET title = ?, content = ?, pinned = ?, updated_at = ? WHERE id = ?")
        .run(title, content, existing.pinned || input.pinned ? 1 : 0, now, existing.id);
      return { item: this.get(existing.id)!, change: "updated" };
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO aster_memories (id, kind, key, title, content, pinned, source_conversation_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.kind, input.key ?? null, title, content, input.pinned ? 1 : 0, input.sourceConversationId ?? null, now, now);
    return { item: this.get(id)!, change: "added" };
  }

  /**
   * The memory note for a turn: a full brief on a conversation's first turn, afterwards only
   * person/project cards the user's message newly brings up. Empty when there is nothing new.
   */
  brief(conversationId: string, userText: string): string {
    const items = this.list();
    if (items.length === 0) return "";
    const shown = this.shown.get(conversationId);
    const cards = items.filter((item) => item.kind === "person" || item.kind === "project");
    const mentioned = cards.filter((card) => mentions(userText, card));
    if (shown) {
      const fresh = mentioned.filter((card) => !shown.has(card.id));
      if (fresh.length === 0) return "";
      fresh.forEach((card) => shown.add(card.id));
      return `[Aster memory — relevant to this message]\n${fresh.map(formatCard).join("\n")}`;
    }

    const shownNow = new Set<string>();
    const facts = items.filter((item) => item.kind === "fact")
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, BRIEF_FACTS);
    const featured = [...mentioned, ...cards.filter((card) => !mentioned.includes(card)).slice(0, BRIEF_RECENT_CARDS)];
    featured.forEach((card) => shownNow.add(card.id));
    const others = cards.filter((card) => !shownNow.has(card.id));
    const sessions = items.filter((item) => item.kind === "session" && item.key !== conversationId).slice(0, BRIEF_RECENT_SESSIONS);
    this.shown.set(conversationId, shownNow);

    const sections = [
      "[Aster memory — what you know about the user from earlier chats. Use it naturally and don't recite it. " +
      "The full memory is in /workspace/.aster/memory.md; grep it when the user mentions someone or something you don't recognize.]",
    ];
    if (facts.length) sections.push("About the user:\n" + facts.map((fact) => `- ${fact.content}`).join("\n"));
    if (featured.length) sections.push("People and projects:\n" + featured.map(formatCard).join("\n"));
    if (others.length) sections.push("Also known (details in memory.md): " + others.map((card) => card.title).join(", "));
    if (sessions.length) sections.push("Recent chats:\n" + sessions.map((session) => `- ${session.title}: ${session.content}`).join("\n"));
    return sections.join("\n\n");
  }

  /** All memory as Markdown, written into the cell so the agent can search it on demand. */
  snapshot(): string {
    const items = this.list();
    const group = (kind: AsterMemoryKind, heading: string, render: (item: AsterMemoryItem) => string) => {
      const entries = items.filter((item) => item.kind === kind);
      return entries.length ? `## ${heading}\n\n${entries.map(render).join("\n")}\n` : "";
    };
    return [
      "# Aster memory\n\nWhat the user's assistant remembers across chats. Read-only here; it is updated automatically after each turn.\n",
      group("fact", "About the user", (item) => `- ${item.content}`),
      group("person", "People", (item) => `### ${item.title}\n${item.content}\n`),
      group("project", "Projects", (item) => `### ${item.title}\n${item.content}\n`),
      group("session", "Chats", (item) => `- **${item.title}** (${new Date(item.updatedAt).toISOString().slice(0, 10)}): ${item.content}`),
    ].filter(Boolean).join("\n");
  }

  /** Read one exchange and update memory. Returns what changed (for the app's "memory updated" chip). */
  async remember(exchange: AsterMemoryExchange): Promise<AsterMemoryChange[]> {
    if (!this.enabled) return [];
    const result = await this.extract(exchange);
    if (!result) return [];
    const changes: AsterMemoryChange[] = [];
    const known = new Map(this.list().filter((item) => item.kind !== "session").map((item) => [item.id, item]));

    for (const id of result.deletes ?? []) {
      const item = known.get(id);
      if (item && !item.pinned && this.delete(id)) changes.push({ id, kind: item.kind, title: item.title, change: "removed" });
    }
    for (const upsert of result.upserts ?? []) {
      const kind = upsert.kind === "person" || upsert.kind === "project" || upsert.kind === "fact" ? upsert.kind : undefined;
      const title = upsert.title?.trim();
      const content = upsert.content?.trim();
      if (!kind || !title || !content || containsLikelyProviderSecret(content)) continue;
      const key = kind === "fact" ? null : normalizeKey(kind, upsert.key ?? title);
      if (kind !== "fact" && !key) continue;
      const id = kind === "fact" && upsert.id && known.has(upsert.id) ? upsert.id : null;
      const { item, change } = this.upsert({ kind, key, id, title, content, pinned: upsert.pinned === true, sourceConversationId: exchange.conversationId });
      changes.push({ id: item.id, kind, title: item.title, change });
    }
    const session = result.session;
    if (session?.title?.trim() && session.summary?.trim()) {
      const repo = exchange.project?.kind === "code" && exchange.project.repository ? ` [${exchange.project.repository}]` : "";
      this.upsert({
        kind: "session",
        key: exchange.conversationId,
        title: session.title.trim().slice(0, 80) + repo,
        content: session.summary.trim(),
        sourceConversationId: exchange.conversationId,
      });
    }
    return changes;
  }

  private async extract(exchange: AsterMemoryExchange): Promise<ExtractionResult | undefined> {
    const items = this.list().filter((item) => item.kind !== "session")
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
      .slice(0, MAX_MEMORY_PROMPT_ITEMS);
    const currentSession = this.list("session").find((item) => item.key === exchange.conversationId);
    const memory = items.length
      ? items.map((item) => JSON.stringify({ id: item.id, kind: item.kind, key: item.key, title: item.title, content: item.content, pinned: item.pinned })).join("\n")
      : "(empty)";
    const context = exchange.project?.kind === "code" && exchange.project.repository
      ? `Code chat in GitHub repository ${exchange.project.repository}.`
      : "General chat.";
    const user = [
      `CURRENT MEMORY (one JSON object per line):\n${memory}`,
      `THIS CHAT: ${context}${currentSession ? ` Summary so far: ${currentSession.content}` : ""}`,
      `LATEST USER MESSAGE:\n${exchange.userText.slice(0, 6000)}`,
      `ASSISTANT REPLY:\n${exchange.assistantText.slice(0, 4000)}`,
    ].join("\n\n");

    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(openRouterUrl("chat/completions"), {
        method: "POST",
        headers: { ...openRouterHeaders(this.apiKey!), "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: EXTRACTION_PROMPT }, { role: "user", content: user }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      return undefined;
    }
    if (!response.ok) return undefined;
    const body = await response.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: string } }> } | undefined;
    const text = body?.choices?.[0]?.message?.content;
    if (!text) return undefined;
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as ExtractionResult;
    } catch {
      return undefined;
    }
  }
}

const EXTRACTION_PROMPT = `You maintain the long-term memory of one person (the user) for their AI assistant, Aster. The user has many separate chats; memory is how a new chat already knows their world. Read the latest exchange against the current memory and return JSON operations.

Remember what will matter in future, unrelated chats:
- PEOPLE the user deals with: name, role, organization, relationship to the user, which projects they are part of, anything the user said about working with them.
- PROJECTS: name, what it is, client or owner, goals, scope, stack, repository, status, key decisions, and ideas the user brainstormed or chose.
- FACTS about the user: durable preferences, circumstances (job, freelance work, location if stated), ways of working, tools they use.

Do not store: one-off task details, things only relevant inside this chat, general knowledge, the assistant's own suggestions the user did not adopt, credentials or secrets, and sensitive personal details (health, finances, etc.) unless the user explicitly asks you to remember them.

Rules:
- If the user explicitly asks to remember something, you MUST store it, with "pinned": true.
- Prefer updating an existing card over creating a new one. To update a person or project, reuse its exact "key" and write the complete new content, merging old and new information (max ~120 words).
- Keys: "person:<first-last>" or "project:<short-name>", lowercase with hyphens.
- Facts are one sentence. To change a fact, return it with its "id" and new content; to remove an outdated or contradicted fact, put its id in "deletes".
- Most exchanges contain nothing worth remembering: return empty "upserts" then. Never invent details.
- Always write "session": a short title (max 8 words) and a 1-2 sentence summary of what this chat is about and where it stands, updated with the latest exchange.

Return only JSON:
{"upserts":[{"kind":"person|project|fact","key":"person:...|project:...|null","id":"existing fact id|null","title":"Display name","content":"...","pinned":false}],"deletes":["id"],"session":{"title":"...","summary":"..."}}`;

interface MemoryRow {
  id: string;
  kind: string;
  key: string | null;
  title: string;
  content: string;
  pinned: number;
  source_conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

function rowToItem(row: MemoryRow): AsterMemoryItem {
  return {
    id: row.id,
    kind: row.kind as AsterMemoryKind,
    key: row.key,
    title: row.title,
    content: row.content,
    pinned: row.pinned === 1,
    sourceConversationId: row.source_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeKey(kind: "person" | "project", value: string): string | null {
  const raw = value.toLowerCase().startsWith(`${kind}:`) ? value.slice(kind.length + 1) : value;
  const slug = raw.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  const key = `${kind}:${slug}`;
  return KEY_RE.test(key) ? key : null;
}

function formatCard(card: AsterMemoryItem): string {
  return `- ${card.title} (${card.kind}): ${card.content}`;
}

/** Whether a message refers to a card by its title or key words (e.g. "Sara" for "Sara Ahmadi"). */
function mentions(text: string, card: AsterMemoryItem): boolean {
  const haystack = ` ${text.toLowerCase()} `;
  const words = new Set<string>();
  for (const part of [card.title, card.key?.split(":")[1]?.replace(/-/g, " ") ?? ""]) {
    for (const word of part.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length >= 3 && !STOP_WORDS.has(word)) words.add(word);
    }
  }
  return [...words].some((word) => new RegExp(`[^\\p{L}\\p{N}]${escapeRegExp(word)}[^\\p{L}\\p{N}]`, "u").test(haystack));
}

const STOP_WORDS = new Set(["the", "and", "for", "app", "project", "new", "with", "website", "site"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
