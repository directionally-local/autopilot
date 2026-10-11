import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, ToolDef } from "../agent/messages.js";
import {
  isLlmDumpEnabled,
  dumpDir,
  computeBreakdown,
  writeLlmDump,
  type LlmDumpRecord,
} from "./llm-dump.js";

let dir: string;
const prevFlag = process.env.KIMIFLARE_DUMP_LLM;
const prevDir = process.env.KIMIFLARE_DUMP_LLM_DIR;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-dump-test-"));
  process.env.KIMIFLARE_DUMP_LLM_DIR = dir;
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevFlag === undefined) delete process.env.KIMIFLARE_DUMP_LLM;
  else process.env.KIMIFLARE_DUMP_LLM = prevFlag;
  if (prevDir === undefined) delete process.env.KIMIFLARE_DUMP_LLM_DIR;
  else process.env.KIMIFLARE_DUMP_LLM_DIR = prevDir;
});

beforeEach(() => {
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
});

function sampleRecord(): LlmDumpRecord {
  const messages: ChatMessage[] = [
    { role: "system", content: "you are a helpful agent" },
    { role: "user", content: "hello world" },
  ];
  const tools: ToolDef[] = [
    { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object" } } },
  ];
  return {
    meta: {
      requestId: "req-123",
      sessionId: "sess-abc",
      turnId: "turn-1",
      model: "@cf/moonshotai/kimi-k2.7-code",
      url: "https://example.invalid/compat",
      ts: "2026-06-20T00:00:00.000Z",
    },
    request: {
      system: messages.filter((m) => m.role === "system"),
      messages,
      tools,
      params: { temperature: 0.2, max_completion_tokens: 16384, stream: true },
      rawSerialized: JSON.stringify({ messages, tools }),
    },
    breakdown: computeBreakdown(messages, tools),
    response: { text: "hi", reasoning: "", reasoningDetails: [], toolCalls: [], finishReason: "stop", usage: null },
  };
}

describe("isLlmDumpEnabled", () => {
  it("is off by default", () => {
    delete process.env.KIMIFLARE_DUMP_LLM;
    assert.equal(isLlmDumpEnabled(), false);
  });
  it("respects 1/true", () => {
    process.env.KIMIFLARE_DUMP_LLM = "1";
    assert.equal(isLlmDumpEnabled(), true);
    process.env.KIMIFLARE_DUMP_LLM = "true";
    assert.equal(isLlmDumpEnabled(), true);
    process.env.KIMIFLARE_DUMP_LLM = "0";
    assert.equal(isLlmDumpEnabled(), false);
  });
});

describe("computeBreakdown", () => {
  it("splits chars by system/tools/history and totals", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "abcd" }, // 4
      { role: "user", content: "ef" }, // 2
      { role: "assistant", content: "g" }, // 1
    ];
    const tools: ToolDef[] = [
      { type: "function", function: { name: "n", description: "d", parameters: {} } },
    ];
    const b = computeBreakdown(messages, tools);
    assert.equal(b.systemChars, 4);
    assert.equal(b.historyChars, 3);
    // toolsChars = name(1) + desc(1) + JSON.stringify({})=="{}"(2) = 4
    assert.equal(b.toolsChars, 4);
    assert.equal(b.totalChars, 11);
    assert.equal(b.messageCount, 3);
    assert.equal(b.toolCount, 1);
    assert.equal(b.perMessage.length, 3);
    assert.equal(b.perMessage[0]!.role, "system");
  });
});

describe("writeLlmDump", () => {
  it("writes a per-call JSON file + index.jsonl when enabled", () => {
    process.env.KIMIFLARE_DUMP_LLM = "1";
    writeLlmDump(sampleRecord());

    const sessionDir = dumpDir("sess-abc");
    const files = readdirSync(sessionDir);
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    assert.equal(jsonFiles.length, 1, "one per-call JSON file");
    assert.ok(files.includes("index.jsonl"), "index.jsonl present");

    const record = JSON.parse(readFileSync(join(sessionDir, jsonFiles[0]!), "utf8"));
    assert.equal(record.meta.requestId, "req-123");
    assert.equal(record.request.messages.length, 2);
    assert.equal(record.request.tools.length, 1);
    assert.ok(record.request.rawSerialized.length > 0);
    assert.equal(record.response.text, "hi");
    assert.ok(record.breakdown.totalChars > 0);

    const indexLine = JSON.parse(readFileSync(join(sessionDir, "index.jsonl"), "utf8").trim());
    assert.equal(indexLine.requestId, "req-123");
    assert.equal(indexLine.messageCount, 2);
    assert.equal(indexLine.perMessage, undefined, "index stays thin (no perMessage)");
  });

  it("appends one index line per call", () => {
    process.env.KIMIFLARE_DUMP_LLM = "1";
    writeLlmDump(sampleRecord());
    const r2 = sampleRecord();
    r2.meta.requestId = "req-456";
    r2.meta.ts = "2026-06-20T00:00:01.000Z";
    writeLlmDump(r2);

    const sessionDir = dumpDir("sess-abc");
    const lines = readFileSync(join(sessionDir, "index.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(readdirSync(sessionDir).filter((f) => f.endsWith(".json")).length, 2);
  });

  it("writes nothing when disabled", () => {
    delete process.env.KIMIFLARE_DUMP_LLM;
    writeLlmDump(sampleRecord());
    const sessionDir = dumpDir("sess-abc");
    assert.throws(() => readdirSync(sessionDir), "session dir should not exist");
  });
});
