import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolArtifactStore } from "./artifact-store.js";
import {
  reduceToolOutput,
  DEFAULT_REDUCER_CONFIG,
  reducerConfigForContextWindow,
  toolOutputCapForContextWindow,
  type ReducerConfig,
} from "./reducer.js";

describe("ToolArtifactStore", () => {
  it("stores and retrieves artifacts", () => {
    const store = new ToolArtifactStore();
    const id = store.store("hello world");
    assert.strictEqual(store.retrieve(id), "hello world");
    assert.strictEqual(store.size(), 1);
  });

  it("evicts oldest when maxArtifacts reached", () => {
    const store = new ToolArtifactStore({ maxArtifacts: 2, maxTotalChars: 10_000 });
    const id1 = store.store("a");
    const id2 = store.store("b");
    const id3 = store.store("c");
    assert.strictEqual(store.retrieve(id1), undefined);
    assert.strictEqual(store.retrieve(id2), "b");
    assert.strictEqual(store.retrieve(id3), "c");
    assert.strictEqual(store.size(), 2);
  });

  it("evicts when total chars exceed maxTotalChars", () => {
    const store = new ToolArtifactStore({ maxArtifacts: 10, maxTotalChars: 5 });
    const id1 = store.store("123");
    const id2 = store.store("45678");
    assert.strictEqual(store.retrieve(id1), undefined);
    assert.strictEqual(store.retrieve(id2), "45678");
  });

  it("clears all artifacts", () => {
    const store = new ToolArtifactStore();
    store.store("x");
    store.clear();
    assert.strictEqual(store.size(), 0);
  });

  it("produces unique IDs", () => {
    const store = new ToolArtifactStore();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(store.store("x"));
    }
    assert.strictEqual(ids.size, 100);
  });
});

describe("reduceToolOutput — grep", () => {
  it("returns file paths and hit counts in discovery mode", () => {
    const store = new ToolArtifactStore();
    const raw = [
      "src/a.ts:10:export const foo = 1;",
      "src/a.ts:20:export const foo = 2;",
      "src/a.ts:30:export const foo = 3;",
      "src/b.ts:5:import { foo } from './a';",
      "src/b.ts:15:console.log(foo);",
    ].join("\n");

    const result = reduceToolOutput("grep", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("src/a.ts: 3 hit(s)"));
    assert.ok(result.content.includes("src/b.ts: 2 hit(s)"));
    assert.ok(result.content.includes("output reduced"));
    assert.ok(result.artifactId);
    // Artifact stores the full raw content
    assert.strictEqual(store.retrieve(result.artifactId), raw);
  });

  it("shows sample matches per file", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = [];
    for (let i = 0; i < 20; i++) {
      lines.push(`src/x.ts:${i + 1}:const x = ${i};`);
    }
    const raw = lines.join("\n");

    const result = reduceToolOutput("grep", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    // Should show at most 3 matches per file
    const matchCount = (result.content.match(/const x = /g) ?? []).length;
    assert.ok(matchCount <= 3, `expected <= 3 sample matches, got ${matchCount}`);
  });

  it("passes through files-only mode compactly", () => {
    const store = new ToolArtifactStore();
    const raw = "src/a.ts\nsrc/b.ts\nsrc/c.ts";
    const result = reduceToolOutput("grep", raw, { output_mode: "files" }, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("3 file(s) matched"));
    assert.ok(result.content.includes("src/a.ts"));
    assert.ok(result.content.includes("output reduced"));
    assert.ok(result.artifactId);
  });

  it("truncates malformed unparsed lines to the configured line limit", () => {
    const store = new ToolArtifactStore();
    const raw = "x".repeat(DEFAULT_REDUCER_CONFIG.grep.maxLineLength + 100);
    const result = reduceToolOutput("grep", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(Buffer.byteLength(result.content, "utf8") < raw.length);
    assert.ok(!result.content.includes("x".repeat(DEFAULT_REDUCER_CONFIG.grep.maxLineLength + 1)));
  });

  it("expansion restores full raw content", () => {
    const store = new ToolArtifactStore();
    const raw = "line1\nline2\nline3\nline4\nline5";
    const result = reduceToolOutput("grep", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    const restored = store.retrieve(result.artifactId);
    assert.strictEqual(restored, raw);
  });
});

describe("reduceToolOutput — read", () => {
  it("returns structure outline for full file reads", () => {
    const store = new ToolArtifactStore();
    const raw = [
      "  1\timport { x } from 'x';",
      "  2\timport { y } from 'y';",
      "  3\t",
      "  4\texport const FOO = 1;",
      "  5\texport function bar() { return 1; }",
      "  6\texport class Baz {",
      "  7\t  run() {}",
      "  8\t}",
      "  9\t",
      " 10\tfunction helper() {}",
    ].join("\n");

    const config: ReducerConfig = {
      ...DEFAULT_REDUCER_CONFIG,
      read: { ...DEFAULT_REDUCER_CONFIG.read, maxOutputChars: 20 },
    };
    const result = reduceToolOutput("read", raw, {}, store, config);
    assert.ok(result.content.includes("10 lines total"));
    assert.ok(result.content.includes("Imports (2):"));
    assert.ok(result.content.includes("Exports (2):"));
    assert.ok(result.content.includes("Functions (1):"));
    assert.ok(result.content.includes("Classes (1):"));
    assert.ok(result.content.includes("Preview (lines 1–"));
    assert.ok(result.content.includes("output reduced"));
    assert.ok(result.content.includes("offset=11, limit=1"));
  });

  it("outlines declarations in languages the JS patterns miss", () => {
    const store = new ToolArtifactStore();
    const raw = [
      "  1\tuse crate::blocks::{Block, GroupBlock};",
      "  2\t",
      "  3\tpub struct Session {",
      "  4\t    open_group: Option<u64>,",
      "  5\t}",
      "  6\t",
      "  7\timpl Session {",
      "  8\t    pub fn open_group(&mut self) {}",
      "  9\t}",
      " 10\t",
      " 11\tfn helper() {}",
    ].join("\n");

    const config: ReducerConfig = {
      ...DEFAULT_REDUCER_CONFIG,
      read: { ...DEFAULT_REDUCER_CONFIG.read, maxOutputChars: 20 },
    };
    const result = reduceToolOutput("read", raw, {}, store, config);
    assert.ok(result.content.includes("Imports (1):"));
    assert.ok(result.content.includes("1: use crate::blocks"));
    assert.ok(result.content.includes("Declarations (4):"));
    assert.ok(result.content.includes("3: pub struct Session {"));
    assert.ok(result.content.includes("7: impl Session {"));
    assert.ok(result.content.includes("8: pub fn open_group"));
    assert.ok(result.content.includes("11: fn helper() {}"));
  });

  it("returns a full file verbatim when it fits the configured context cap", () => {
    const store = new ToolArtifactStore();
    const raw = "  1\\t" + "x".repeat(1_000);
    const result = reduceToolOutput("read", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.strictEqual(result.content, raw);
    assert.strictEqual(result.reducedBytes, result.rawBytes);
  });

  it("scales read output caps with model context windows", () => {
    assert.strictEqual(toolOutputCapForContextWindow(32_000), 4_000);
    assert.strictEqual(toolOutputCapForContextWindow(128_000), 7_680);
    assert.strictEqual(toolOutputCapForContextWindow(1_000_000), 60_000);
    assert.strictEqual(reducerConfigForContextWindow(1_000_000).read.maxOutputChars, 60_000);
    assert.strictEqual(toolOutputCapForContextWindow(Number.NaN), DEFAULT_REDUCER_CONFIG.defaultMaxChars);
  });

  it("returns slice directly when offset/limit provided", () => {
    const store = new ToolArtifactStore();
    const raw = "  1\tline1\n  2\tline2\n  3\tline3";
    const result = reduceToolOutput("read", raw, { offset: 1, limit: 2 }, store, DEFAULT_REDUCER_CONFIG);
    assert.strictEqual(result.content, raw);
    assert.strictEqual(result.rawBytes, result.reducedBytes);
  });

  it("caps large slices", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = [];
    for (let i = 0; i < 300; i++) {
      lines.push(`  ${i + 1}\tline ${i + 1}`);
    }
    const raw = lines.join("\n");
    const result = reduceToolOutput("read", raw, { offset: 1, limit: 300 }, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("more lines omitted"));
    assert.ok(result.reducedBytes < result.rawBytes);
  });
});

describe("reduceToolOutput — bash", () => {
  it("passes through short outputs unchanged", () => {
    const store = new ToolArtifactStore();
    const raw = "exit=0\n--- stdout ---\nhello world";
    const result = reduceToolOutput("bash", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.strictEqual(result.content, raw);
  });

  it("returns compact failure summary for errors", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = ["exit=1"];
    lines.push("--- stdout ---");
    for (let i = 0; i < 100; i++) {
      lines.push(`passing test ${i}`);
    }
    lines.push("Error: something broke");
    lines.push("  at /path/to/file.ts:10:5");
    lines.push("  at /path/to/file.ts:20:5");
    lines.push("FAIL test-foo");
    for (let i = 0; i < 50; i++) {
      lines.push(`more noise ${i}`);
    }
    const raw = lines.join("\n");

    const result = reduceToolOutput("bash", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("exit=1"));
    assert.ok(result.content.includes("error block"));
    assert.ok(result.content.includes("Error: something broke"));
    assert.ok(result.content.includes("failing tests"));
    assert.ok(result.content.includes("test-foo"));
    assert.ok(result.content.includes("last lines"));
    assert.ok(result.content.includes("output reduced"));
    assert.ok(result.reducedBytes < result.rawBytes);
  });

  it("deduplicates repeated lines", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = ["exit=1", "--- stdout ---"];
    for (let i = 0; i < 50; i++) {
      lines.push("same line over and over");
    }
    lines.push("final line");
    const raw = lines.join("\n");

    const result = reduceToolOutput("bash", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("identical lines omitted"));
  });

  it("preserves stack trace frames in error block", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = ["exit=1", "--- stdout ---"];
    for (let i = 0; i < 50; i++) {
      lines.push(`  at frame${i} (/path/file.ts:${i}:1)`);
    }
    const raw = lines.join("\n");

    const result = reduceToolOutput("bash", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("at frame0"));
    assert.ok(result.content.includes("error block"));
    assert.ok(result.content.includes("output reduced"));
  });
});

describe("reduceToolOutput — web_fetch", () => {
  it("returns title, URL, headings, and excerpt", () => {
    const store = new ToolArtifactStore();
    const raw = "# Page Title\n\n## Section A\n\nSome content here.\n\n## Section B\n\nMore content.";
    const result = reduceToolOutput("web_fetch", raw, { url: "https://example.com" }, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.content.includes("Title: Page Title"));
    assert.ok(result.content.includes("URL: https://example.com"));
    assert.ok(result.content.includes("Sections:"));
    assert.ok(result.content.includes("Excerpt"));
    assert.ok(result.content.includes("output reduced"));
  });
});

describe("reduceToolOutput — lsp", () => {
  it("passes through short LSP outputs unchanged", () => {
    const store = new ToolArtifactStore();
    const raw = "src/index.ts:5:10\nsrc/lib.ts:20:5";
    const result = reduceToolOutput("lsp_definition", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.strictEqual(result.content, raw);
    assert.strictEqual(result.reducedBytes, result.rawBytes);
  });

  it("truncates long LSP outputs by line count", () => {
    const store = new ToolArtifactStore();
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`src/file${i}.ts:${i + 1}:1`);
    }
    const raw = lines.join("\n");
    const result = reduceToolOutput("lsp_references", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.reducedBytes < result.rawBytes);
    assert.ok(result.content.includes("LSP output truncated"));
    const outputLines = result.content.split("\n");
    assert.ok(outputLines.length <= DEFAULT_REDUCER_CONFIG.lsp.maxLines + 2); // +2 for hint lines
  });

  it("truncates long LSP outputs by char count", () => {
    const store = new ToolArtifactStore();
    const raw = "a".repeat(5000);
    const result = reduceToolOutput("lsp_hover", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.reducedBytes < result.rawBytes);
    assert.ok(result.content.length <= DEFAULT_REDUCER_CONFIG.lsp.maxOutputChars + 200);
  });

  it("stores artifact for truncated LSP output", () => {
    const store = new ToolArtifactStore();
    const raw = "line\n".repeat(100);
    const result = reduceToolOutput("lsp_documentSymbols", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.ok(result.artifactId);
    assert.strictEqual(store.retrieve(result.artifactId), raw);
  });
});

describe("reduceToolOutput — disabled", () => {
  it("returns raw content when enabled is false", () => {
    const store = new ToolArtifactStore();
    const raw = "a\n".repeat(1000);
    const config: ReducerConfig = { ...DEFAULT_REDUCER_CONFIG, enabled: false };
    const result = reduceToolOutput("bash", raw, {}, store, config);
    assert.strictEqual(result.content, raw);
    assert.ok(result.artifactId);
  });
});

describe("reduceToolOutput — unknown tool", () => {
  it("passes through unknown tools unchanged", () => {
    const store = new ToolArtifactStore();
    const raw = "some output";
    const result = reduceToolOutput("custom_tool", raw, {}, store, DEFAULT_REDUCER_CONFIG);
    assert.strictEqual(result.content, raw);
    assert.ok(result.artifactId);
  });
});
