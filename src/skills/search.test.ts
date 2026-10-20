import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import Database from "better-sqlite3";
import { initSkillsSchema, insertSections, setSkillEmbeddingModel, upsertSkill } from "./db.js";
import { keywordSimilarity, searchSections } from "./search.js";
import type { ParsedSkill } from "./types.js";

const skill: ParsedSkill = {
  name: "release",
  description: "How to cut a release",
  filePath: "/skills/release.md",
  contentHash: "h",
  parserVersion: 1,
  sections: [
    { heading: "Publishing", body: "Run release-please and publish the npm package" },
    { heading: "Docs", body: "Deploy the documentation site to GitHub Pages" },
  ],
};

describe("keywordSimilarity", () => {
  it("scores the share of query terms found in the text", () => {
    assert.strictEqual(keywordSimilarity("publish npm package", "publish the npm package now"), 1);
    assert.strictEqual(keywordSimilarity("publish npm docker", "publish the npm package"), 2 / 3);
    assert.strictEqual(keywordSimilarity("the and", "anything"), 0);
  });
});

describe("searchSections", () => {
  let db: Database.Database;
  const originalFetch = globalThis.fetch;
  let embedCalls = 0;

  beforeEach(() => {
    db = new Database(":memory:");
    initSkillsSchema(db);
    embedCalls = 0;
    globalThis.fetch = (async () => {
      embedCalls++;
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    db.close();
  });

  it("falls back to keyword search on a provider without embeddings", async () => {
    const id = upsertSkill(db, skill);
    insertSections(db, id, skill.sections, []);
    setSkillEmbeddingModel(db, id, null);
    const deepseek = { providerId: "deepseek" as const, customEndpoint: { baseUrl: "https://api.deepseek.com", providerId: "deepseek" as const } };
    const results = await searchSections("publish the npm package", db, deepseek);
    assert.strictEqual(embedCalls, 0);
    assert.strictEqual(results[0]?.heading, "Publishing");
    assert.ok(results[0]!.similarity >= 0.3, "clears the router's similarity floor");
  });

  it("ranks sections embedded with the current model by cosine similarity", async () => {
    const id = upsertSkill(db, skill);
    insertSections(db, id, skill.sections, [new Float32Array([0, 1]), new Float32Array([1, 0])]);
    setSkillEmbeddingModel(db, id, "text-embedding-3-small");
    const openai = { providerId: "openai" as const, customEndpoint: { baseUrl: "https://api.openai.com/v1", providerId: "openai" as const } };
    const results = await searchSections("anything", db, openai);
    assert.strictEqual(embedCalls, 1);
    assert.strictEqual(results[0]?.heading, "Docs");
    assert.strictEqual(results[0]?.similarity, 1);
  });

  it("does not compare vectors from a different model", async () => {
    const id = upsertSkill(db, skill);
    insertSections(db, id, skill.sections, [new Float32Array([1, 0]), new Float32Array([1, 0])]);
    setSkillEmbeddingModel(db, id, "baai/bge-base-en-v1.5");
    const openai = { providerId: "openai" as const, customEndpoint: { baseUrl: "https://api.openai.com/v1", providerId: "openai" as const } };
    const results = await searchSections("documentation pages", db, openai);
    assert.strictEqual(embedCalls, 0, "no query embedding when nothing was embedded with this model");
    assert.strictEqual(results[0]?.heading, "Docs");
  });
});
