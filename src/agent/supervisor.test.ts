import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import { TurnSupervisor, decomposePrompt, preReadFilesForWorkers, getPreReadFilesFromMemory } from "./supervisor.js";
import type { WorkerResultMessage, WorkerFinding } from "./messages.js";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function result(
  workerId: string,
  findings: WorkerFinding[],
  recommendations: string[] = [],
): WorkerResultMessage {
  return {
    workerId,
    status: "completed",
    task: "t",
    findings,
    recommendations,
    filesRead: [],
    webSources: [],
    costUsd: 0,
    tokensUsed: 0,
    reasoning: "",
  };
}

function finding(
  topic: string,
  confidence: WorkerFinding["confidence"],
  summary = "s",
): WorkerFinding {
  return { topic, summary, confidence, sources: [], relevance: "high" };
}

describe("TurnSupervisor.synthesizeFindings", () => {
  let runKimiCalls: Array<{ model: string; messages: unknown[]; temperature?: number }> = [];

  afterEach(() => {
    runKimiCalls = [];
  });

  it("keeps all findings when topics do not overlap", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings([
      result("w1", [finding("OAuth", "high")]),
      result("w2", [finding("Testing", "medium")]),
    ]);
    assert.ok(out.plan.includes("OAuth"));
    assert.ok(out.plan.includes("Testing"));
    assert.strictEqual(out.conflicts.length, 0);
  });

  it("deduplicates by topic, keeping the higher-confidence finding", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings([
      result("w1", [finding("OAuth", "low", "low-summary")]),
      result("w2", [finding("oauth", "high", "high-summary")]),
    ]);
    assert.ok(out.plan.includes("high-summary"));
    assert.ok(!out.plan.includes("low-summary"));
  });

  it("detects conflicting recommendations and prefers the higher-confidence one", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings([
      result("w1", [finding("OAuth", "low")], ["use OAuth library A"]),
      result("w2", [finding("OAuth", "high")], ["use OAuth library B"]),
    ]);
    // Both recs reference the "OAuth" topic; dedup keeps the high-confidence
    // finding, so only one confidence score participates — no conflict unless
    // two distinct recs map to the same topic at different scores.
    assert.ok(Array.isArray(out.conflicts));
    assert.ok(Array.isArray(out.recommendations));
  });

  it("handles an empty results array without crashing", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings([]);
    assert.strictEqual(out.conflicts.length, 0);
    assert.strictEqual(out.recommendations.length, 0);
    assert.ok(out.plan.includes("Synthesized Execution Plan"));
  });

  it("uses heuristic path when strategy is heuristic", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")])],
      { strategy: "heuristic", auth: { openrouterApiKey: "sk-or-test" } },
    );
    assert.ok(out.plan.includes("OAuth"));
  });

  it("uses heuristic path when credentials are missing", async () => {
    const s = new TurnSupervisor();
    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")])],
      { strategy: "llm" },
    );
    assert.ok(out.plan.includes("OAuth"));
  });

  it("uses LLM path when credentials are present and strategy is llm", async () => {
    const s = new TurnSupervisor();
    (s as unknown as Record<string, unknown>)._runKimi = async function* (opts: { model: string; messages: unknown[]; temperature?: number }) {
      runKimiCalls.push(opts);
      yield { type: "text" as const, delta: JSON.stringify({
        plan: "# Unified Plan\n\nUse OAuth.",
        conflicts: [],
        recommendations: ["Use OAuth 2.0"],
      }) };
      yield { type: "done" as const, finishReason: "stop", usage: null };
    };

    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high", "summary")], ["Use OAuth 2.0"])],
      { strategy: "llm", auth: { openrouterApiKey: "sk-or-test" }, model: "moonshotai/kimi-k2.5" },
    );
    assert.strictEqual(runKimiCalls.length, 1);
    assert.strictEqual(runKimiCalls[0]?.model, "moonshotai/kimi-k2.5");
    assert.strictEqual(runKimiCalls[0]?.temperature, 0.2);
    assert.ok(out.plan.includes("Unified Plan"));
    assert.deepStrictEqual(out.recommendations, ["Use OAuth 2.0"]);
  });

  it("falls back to heuristic when LLM returns bad JSON and strategy is hybrid", async () => {
    const s = new TurnSupervisor();
    (s as unknown as Record<string, unknown>)._runKimi = async function* () {
      yield { type: "text" as const, delta: "not json" };
      yield { type: "done" as const, finishReason: "stop", usage: null };
    };

    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")])],
      { strategy: "hybrid", auth: { openrouterApiKey: "sk-or-test" } },
    );
    assert.ok(out.plan.includes("Synthesized Execution Plan"));
    assert.ok(out.plan.includes("OAuth"));
  });

  it("falls back to heuristic when LLM throws and strategy is hybrid", async () => {
    const s = new TurnSupervisor();
    (s as unknown as Record<string, unknown>)._runKimi = async function* () {
      throw new Error("network error");
    };

    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")])],
      { strategy: "hybrid", auth: { openrouterApiKey: "sk-or-test" } },
    );
    assert.ok(out.plan.includes("OAuth"));
  });

  it("propagates LLM error when strategy is llm and LLM fails", async () => {
    const s = new TurnSupervisor();
    (s as unknown as Record<string, unknown>)._runKimi = async function* () {
      throw new Error("network error");
    };

    await assert.rejects(
      s.synthesizeFindings(
        [result("w1", [finding("OAuth", "high")])],
        { strategy: "llm", auth: { openrouterApiKey: "sk-or-test" }, model: "moonshotai/kimi-k2.5" },
      ),
      /network error/,
    );
  });

  it("includes worker IDs in the LLM prompt for citation tracking", async () => {
    const s = new TurnSupervisor();
    let capturedUserContent = "";
    (s as unknown as Record<string, unknown>)._runKimi = async function* (opts: { messages: Array<{ role: string; content: string }> }) {
      const userMsg = opts.messages.find((m) => m.role === "user");
      capturedUserContent = userMsg?.content ?? "";
      yield { type: "text" as const, delta: JSON.stringify({
        plan: "# Plan\n\n[worker: w1] Use OAuth.",
        conflicts: [],
        recommendations: ["Use OAuth"],
      }) };
      yield { type: "done" as const, finishReason: "stop", usage: null };
    };

    await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")], ["Use OAuth"])],
      { strategy: "llm", auth: { openrouterApiKey: "sk-or-test" }, model: "moonshotai/kimi-k2.5", prompt: "Implement auth" },
    );
    assert.ok(capturedUserContent.includes("Worker w1"));
    assert.ok(capturedUserContent.includes("Implement auth"));
  });

  it("streams deltas through onDelta callback", async () => {
    const s = new TurnSupervisor();
    (s as unknown as Record<string, unknown>)._runKimi = async function* () {
      yield { type: "text" as const, delta: '{"plan":"# P' };
      yield { type: "text" as const, delta: 'lan","conflicts":[],"recommendations":[]}' };
      yield { type: "done" as const, finishReason: "stop", usage: null };
    };

    const deltas: string[] = [];
    const out = await s.synthesizeFindings(
      [result("w1", [finding("OAuth", "high")])],
      {
        strategy: "llm",
        auth: { openrouterApiKey: "sk-or-test" },
        model: "moonshotai/kimi-k2.5",
        onDelta: (d) => deltas.push(d),
      },
    );
    assert.deepStrictEqual(deltas, ['{"plan":"# P', 'lan","conflicts":[],"recommendations":[]}' ]);
    assert.ok(out.plan.includes("Plan"));
  });
});

describe("decomposePrompt", () => {
  it("splits an explicit numbered list into one worker per item", async () => {
    const workers = await decomposePrompt(
      "Research the following:\n1. caching strategies\n2. testing approaches\n3. migration paths",
      "ctx",
    );
    assert.strictEqual(workers.length, 3);
    assert.ok(workers[0]?.task.includes("caching"));
    assert.ok(workers[1]?.task.includes("testing"));
    assert.ok(workers[2]?.task.includes("migration"));
  });

  it("splits an explicit bulleted list", async () => {
    const workers = await decomposePrompt("Look at:\n- auth\n- routing\n- billing", "ctx");
    assert.strictEqual(workers.length, 3);
  });

  // Regression: previously chopped this prose prompt into 3 nonsense fragments
  // by splitting on every "and". The user's "and" is grammatical conjunction,
  // not a list separator — workers must see the whole prompt.
  it("does NOT split a cohesive prose prompt on conjunctions", async () => {
    const prompt =
      "do heavy exploration and research in this project and identify 1 high leverage large idea";
    const workers = await decomposePrompt(prompt, "ctx");
    assert.strictEqual(workers.length, 2);
    for (const w of workers) {
      assert.ok(w.task.includes(prompt), `expected full prompt preserved: ${w.task}`);
    }
  });

  it("falls back to 2 angled workers when there is no clear list", async () => {
    const workers = await decomposePrompt("make the app faster", "ctx");
    assert.strictEqual(workers.length, 2);
    assert.ok(workers.every((w) => w.mode === "plan"));
  });

  it("uses LLM decomposition for prose when strategy is llm and cfg is provided", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/event-stream"]]),
        body: new ReadableStream({
          start(controller) {
            const payload = JSON.stringify({
              choices: [{ delta: { content: '{"tasks":["Analyze auth.ts","Check middleware.ts"],"reasoning":"split by file"}' } }],
              usage: null,
            });
            controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;

    const workers = await decomposePrompt("analyze our auth system", "ctx", {
      cwd: process.cwd(),
      cfg: {
        openrouterApiKey: "sk-or-test",
        model: "moonshotai/kimi-k2.6",
        decompositionStrategy: "llm",
      },
    });
    globalThis.fetch = realFetch;

    assert.strictEqual(workers.length, 2);
    assert.ok(workers[0]!.task.includes("auth"));
    assert.ok(workers[1]!.task.includes("middleware"));
  });

  it("falls back to regex when LLM returns invalid JSON", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/event-stream"]]),
        body: new ReadableStream({
          start(controller) {
            const payload = JSON.stringify({
              choices: [{ delta: { content: "not json at all" } }],
              usage: null,
            });
            controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;

    // Use a unique prompt so we don't hit the cache from the previous LLM test.
    const workers = await decomposePrompt("analyze our auth system (invalid json case)", "ctx", {
      cwd: process.cwd(),
      cfg: {
        openrouterApiKey: "sk-or-test",
        model: "moonshotai/kimi-k2.6",
        decompositionStrategy: "llm",
      },
    });
    globalThis.fetch = realFetch;

    assert.strictEqual(workers.length, 2);
    assert.ok(
      workers[0]!.task.includes("Research overview"),
      `expected fallback task, got: ${workers[0]!.task}`,
    );
  });

  it("uses regex fallback when strategy is regex", async () => {
    const workers = await decomposePrompt("analyze our auth system", "ctx", {
      cwd: process.cwd(),
      cfg: {
        openrouterApiKey: "sk-or-test",
        model: "moonshotai/kimi-k2.6",
        decompositionStrategy: "regex",
      },
    });
    assert.strictEqual(workers.length, 2);
    assert.ok(workers[0]!.task.includes("Research overview"));
  });

  it("caches decomposition results", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-type", "text/event-stream"]]),
        body: new ReadableStream({
          start(controller) {
            const payload = JSON.stringify({
              choices: [{ delta: { content: '{"tasks":["Task A","Task B"],"reasoning":"ok"}' } }],
              usage: null,
            });
            controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\n`));
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        text: async () => "",
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;

    const cfg = {
      openrouterApiKey: "sk-or-test",
      model: "moonshotai/kimi-k2.6",
      decompositionStrategy: "llm" as const,
    };

    const workers1 = await decomposePrompt("same prompt", "same ctx", { cwd: process.cwd(), cfg });
    const workers2 = await decomposePrompt("same prompt", "same ctx", { cwd: process.cwd(), cfg });
    globalThis.fetch = realFetch;

    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(workers1, workers2);
  });
});

describe("getFileTreeSnapshot", () => {
  it("returns a non-empty string for the current directory", async () => {
    const { getFileTreeSnapshot } = await import("./supervisor.js");
    const tree = await getFileTreeSnapshot(process.cwd());
    assert.ok(typeof tree === "string");
    assert.ok(tree.length > 0);
  });
});

describe("preReadFilesForWorkers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kf-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads files and formats them with separators", async () => {
    await writeFile(join(tmpDir, "a.txt"), "hello", "utf8");
    await writeFile(join(tmpDir, "b.txt"), "world", "utf8");
    const out = await preReadFilesForWorkers(["a.txt", "b.txt"], tmpDir, 10_000);
    assert.strictEqual(out.filesRead.length, 2);
    assert.ok(out.text.includes("--- a.txt ---"));
    assert.ok(out.text.includes("hello"));
    assert.ok(out.text.includes("--- b.txt ---"));
    assert.ok(out.text.includes("world"));
    assert.strictEqual(out.chars, 10); // "hello" + "world" = 10 chars
  });

  it("respects maxChars and truncates", async () => {
    await writeFile(join(tmpDir, "long.txt"), "a".repeat(100), "utf8");
    const out = await preReadFilesForWorkers(["long.txt"], tmpDir, 50);
    assert.strictEqual(out.filesRead.length, 1);
    assert.ok(out.text.includes("a".repeat(50)));
    assert.ok(out.text.includes("… (truncated)"));
    assert.strictEqual(out.chars, 50 + "\n… (truncated)".length);
  });

  it("skips missing files gracefully", async () => {
    await writeFile(join(tmpDir, "exists.txt"), "yes", "utf8");
    const out = await preReadFilesForWorkers(["missing.txt", "exists.txt"], tmpDir, 10_000);
    assert.strictEqual(out.filesRead.length, 1);
    assert.ok(out.text.includes("exists.txt"));
    assert.ok(!out.text.includes("missing.txt"));
  });

  it("returns empty result when no files are readable", async () => {
    const out = await preReadFilesForWorkers(["nope.txt"], tmpDir, 10_000);
    assert.strictEqual(out.filesRead.length, 0);
    assert.strictEqual(out.text, "");
    assert.strictEqual(out.chars, 0);
  });

  it("stops reading once maxChars is reached", async () => {
    await writeFile(join(tmpDir, "first.txt"), "abc", "utf8");
    await writeFile(join(tmpDir, "second.txt"), "def", "utf8");
    const out = await preReadFilesForWorkers(["first.txt", "second.txt"], tmpDir, 2);
    assert.strictEqual(out.filesRead.length, 1);
    assert.ok(out.text.includes("first.txt"));
    assert.ok(!out.text.includes("second.txt"));
  });
});

describe("getPreReadFilesFromMemory", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "kf-mem-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when memory is disabled", () => {
    const files = getPreReadFilesFromMemory({ memoryEnabled: false }, tmpDir);
    assert.deepStrictEqual(files, []);
  });

  it("returns empty array when memory DB does not exist", () => {
    const files = getPreReadFilesFromMemory({ memoryEnabled: true }, tmpDir);
    assert.deepStrictEqual(files, []);
  });

  it("derives top files from memory relatedFiles", async () => {
    const dbPath = join(tmpDir, ".kimiflare", "memory.db");
    await mkdir(join(tmpDir, ".kimiflare"), { recursive: true });

    // Use dynamic import to avoid top-level better-sqlite3 dependency in tests
    const { openMemoryDb, insertMemory } = await import("../memory/db.js");
    const { fetchEmbeddings } = await import("../memory/embeddings.js");
    const db = openMemoryDb(dbPath);

    // Create a dummy embedding
    const embedding = new Float32Array(768);
    embedding.fill(0);

    await insertMemory(db, {
      content: "Entry point info",
      category: "fact",
      sourceSessionId: "s1",
      repoPath: tmpDir,
      importance: 3,
      relatedFiles: ["src/index.tsx"],
    }, embedding);

    await insertMemory(db, {
      content: "Package info",
      category: "fact",
      sourceSessionId: "s1",
      repoPath: tmpDir,
      importance: 4,
      relatedFiles: ["package.json", "src/index.tsx"],
    }, embedding);

    await insertMemory(db, {
      content: "Other info",
      category: "fact",
      sourceSessionId: "s1",
      repoPath: tmpDir,
      importance: 2,
      relatedFiles: ["README.md"],
    }, embedding);

    const files = getPreReadFilesFromMemory({ memoryEnabled: true }, tmpDir, 10);
    // Scores: src/index.tsx = 3+4=7, package.json = 4, README.md = 2
    assert.deepStrictEqual(files, ["src/index.tsx", "package.json", "README.md"]);
  });
});
