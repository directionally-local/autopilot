import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deterministicTopicKey, pickTopicKey, MemoryManager } from "./manager.js";

describe("deterministicTopicKey", () => {
  it("lowercases and snake_cases a simple phrase", () => {
    assert.strictEqual(deterministicTopicKey("Project uses tsup"), "project_uses_tsup");
  });

  it("strips non-alphanumeric characters", () => {
    assert.strictEqual(
      deterministicTopicKey("User prefers single-quotes & semicolons!"),
      "user_prefers_singlequotes_semicolons"
    );
  });

  it("collapses multiple spaces into a single underscore", () => {
    assert.strictEqual(deterministicTopicKey("  lots   of    spaces  "), "lots_of_spaces");
  });

  it("truncates to 60 characters", () => {
    const long = "a".repeat(100);
    const result = deterministicTopicKey(long);
    assert.strictEqual(result.length, 60);
  });

  it("returns empty string for empty input", () => {
    assert.strictEqual(deterministicTopicKey(""), "");
  });

  it("returns empty string for input with only special chars", () => {
    assert.strictEqual(deterministicTopicKey("!!!@@@###"), "");
  });
});

describe("pickTopicKey", () => {
  it("returns a new key when no existing keys match", () => {
    const result = pickTopicKey("new topic here", ["old_topic"]);
    assert.strictEqual(result, "new_topic_here");
  });

  it("reuses an existing key when it is a substring of the new key", () => {
    const result = pickTopicKey("project uses tsup for bundling", ["project_uses_tsup"]);
    assert.strictEqual(result, "project_uses_tsup");
  });

  it("reuses an existing key when the new key is a substring of it", () => {
    const result = pickTopicKey("project uses", ["project_uses_tsup"]);
    assert.strictEqual(result, "project_uses_tsup");
  });

  it("returns null for empty content", () => {
    const result = pickTopicKey("", ["existing"]);
    assert.strictEqual(result, null);
  });

  it("picks the first matching existing key", () => {
    const result = pickTopicKey("project uses tsup", ["project", "project_uses_tsup"]);
    assert.strictEqual(result, "project");
  });
});

describe("MemoryManager plan storage", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-memory-test-"));
    manager = new MemoryManager({
      dbPath: join(tmpDir, "memory.db"),
      openrouterApiKey: "sk-or-test",
      model: "moonshotai/kimi-k2.7-code",
      plumbingModel: "moonshotai/kimi-k2.5",
      embeddingModel: "baai/bge-base-en-v1.5",
    });
    manager.open();
  });

  afterEach(async () => {
    manager.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rememberPlan stores a plan under the default topic key", async () => {
    const result = await manager.rememberPlan("Build a login page", "/repo", "session-1");
    assert.ok(result.id);

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "Build a login page");
    assert.strictEqual(stored?.topicKey, "current_dev_plan");
    assert.strictEqual(stored?.category, "task");
  });

  it("rememberPlan supersedes the previous plan under the same key", async () => {
    await manager.rememberPlan("Old plan", "/repo", "session-1");
    const result = await manager.rememberPlan("New plan", "/repo", "session-2");

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "New plan");
    assert.ok(result.superseded);
    assert.strictEqual(result.superseded?.length, 1);
  });

  it("rememberPlan supports a custom topic key", async () => {
    await manager.rememberPlan("Custom plan", "/repo", "session-1", "my_topic");
    const stored = manager.getByTopicKey("/repo", "my_topic");
    assert.strictEqual(stored?.content, "Custom plan");
  });

  it("getByTopicKey returns null when no memory exists", () => {
    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored, null);
  });

  it("getByTopicKey returns the latest memory for the key", async () => {
    await manager.rememberPlan("First", "/repo", "session-1");
    await manager.rememberPlan("Second", "/repo", "session-2");
    await manager.rememberPlan("Third", "/repo", "session-3");

    const stored = manager.getByTopicKey("/repo", "current_dev_plan");
    assert.strictEqual(stored?.content, "Third");
  });
});

describe("MemoryManager embeddings follow the provider", () => {
  let tmpDir: string;
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const deepseek = { providerId: "deepseek" as const, customEndpoint: { baseUrl: "https://api.deepseek.com", apiKey: "k", providerId: "deepseek" as const } };
  const openai = { providerId: "openai" as const, customEndpoint: { baseUrl: "https://api.openai.com/v1", apiKey: "k", providerId: "openai" as const } };

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-memory-embed-test-"));
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/embeddings")) {
        const n = (body.input as string[]).length;
        return new Response(JSON.stringify({ data: Array.from({ length: n }, (_, index) => ({ index, embedding: [1, 0, 0] })) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      const chunk = { choices: [{ index: 0, delta: { content: '{"valid":true,"corrected_content":null}' }, finish_reason: "stop" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tmpDir, { recursive: true, force: true });
  });

  function open(auth: object, extra: Record<string, unknown> = {}): MemoryManager {
    const m = new MemoryManager({ dbPath: join(tmpDir, "memory.db"), model: "m", ...auth, ...extra });
    m.open();
    return m;
  }

  it("saves memories on a provider without embeddings and recalls them by text", async () => {
    const m = open(deepseek);
    try {
      assert.strictEqual(m.embeddingModel, null);
      await m.remember("The build uses tsup for bundling", "fact", 3, "/repo", "s1");
      assert.ok(!calls.some((c) => c.url.endsWith("/embeddings")), "no embeddings request on DeepSeek");
      const results = await m.recall({ text: "tsup bundling", repoPath: "/repo" });
      assert.ok(results.some((r) => r.memory.content.includes("tsup")));
      assert.deepStrictEqual(m.embeddingStatus("/repo"), { model: null, provider: "DeepSeek", current: 0, stale: 1 });
    } finally {
      m.close();
    }
  });

  it("embeds with the provider's model and only compares vectors from that model", async () => {
    const m = open(openai);
    try {
      await m.remember("Deploys run on Fridays", "fact", 3, "/repo", "s1");
      const embedCall = calls.find((c) => c.url.endsWith("/embeddings"));
      assert.strictEqual(embedCall?.url, "https://api.openai.com/v1/embeddings");
      assert.strictEqual(embedCall?.body.model, "text-embedding-3-small");
      const results = await m.recall({ text: "unrelated words", repoPath: "/repo" });
      assert.ok(results.some((r) => r.vectorScore > 0), "vector channel matches a same-model vector");
    } finally {
      m.close();
    }
  });

  it("re-embeds memories from a previous provider's model on backfill", async () => {
    const before = open(openai, { embeddingModel: "old-model" });
    await before.remember("Use pnpm, not npm", "preference", 3, "/repo", "s1");
    before.close();

    const after = open(openai);
    try {
      assert.deepStrictEqual(after.embeddingStatus("/repo").stale, 1);
      calls.length = 0;
      assert.strictEqual(await after.backfill("/repo"), 1);
      assert.strictEqual(calls.find((c) => c.url.endsWith("/embeddings"))?.body.model, "text-embedding-3-small");
      assert.deepStrictEqual(after.embeddingStatus("/repo"), { model: "text-embedding-3-small", provider: "OpenAI", current: 1, stale: 0 });
    } finally {
      after.close();
    }
  });
});

describe("memory DB migration", () => {
  it("tags rows written before embedding models were recorded by their vector size", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "kimiflare-memory-migrate-test-"));
    const dbPath = join(tmpDir, "memory.db");
    const { SqliteDatabase } = await import("../util/sqlite.js");
    const legacy = new SqliteDatabase(dbPath);
    legacy.exec(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding BLOB NOT NULL, category TEXT NOT NULL,
      source_session_id TEXT NOT NULL, repo_path TEXT NOT NULL, created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL, importance INTEGER NOT NULL DEFAULT 3, related_files TEXT NOT NULL DEFAULT '[]',
      topic_key TEXT, superseded_by TEXT, forgotten INTEGER NOT NULL DEFAULT 0, vectorized INTEGER NOT NULL DEFAULT 0, agent_role TEXT)`);
    const insert = legacy.prepare(
      "INSERT INTO memories (id, content, embedding, category, source_session_id, repo_path, created_at, accessed_at, vectorized) VALUES (?, ?, ?, ?, 's', '/repo', 1, 1, 1)",
    );
    insert.run("bge", "a", Buffer.from(new Float32Array(768).buffer), "fact");
    insert.run("oai", "b", Buffer.from(new Float32Array(1536).buffer), "fact");
    insert.run("plan", "c", Buffer.from(new Float32Array(768).buffer), "task");
    legacy.close();

    const { openMemoryDb, closeMemoryDb, getMemoryById } = await import("./db.js");
    const db = openMemoryDb(dbPath);
    try {
      assert.strictEqual(getMemoryById(db, "bge")?.embeddingModel, "baai/bge-base-en-v1.5");
      assert.strictEqual(getMemoryById(db, "bge")?.embedding.length, 768);
      assert.strictEqual(getMemoryById(db, "oai")?.embeddingModel, "openai/text-embedding-3-small");
      assert.strictEqual(getMemoryById(db, "plan")?.embeddingModel, null);
    } finally {
      closeMemoryDb();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
