import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQueueBatch } from "./agent/queue-batch.js";
import {
  buildFilePickerIgnoreList,
  replaceQueuedPrompt,
  replaceUserPromptEvent,
} from "./ui/app-helpers.js";
import type { ChatEvent } from "./ui/chat.js";
import {
  filterPickerItems,
  shouldOpenMentionPicker,
  shouldOpenSlashPicker,
  insertSlashCommand,
} from "./ui/use-picker-controller.js";
import type { FilePickerItem } from "./ui/file-picker.js";

describe("prompt editing", () => {
  it("replaces a queued prompt instead of adding another item", () => {
    const queue = [
      { key: "prompt-1", full: "original", display: "original" },
      { key: "prompt-2", full: "follow-up", display: "follow-up" },
    ];
    const edited = replaceQueuedPrompt(queue, "prompt-1", "amended", "amended");
    assert.deepStrictEqual(edited, [
      { key: "prompt-1", full: "amended", display: "amended" },
      { key: "prompt-2", full: "follow-up", display: "follow-up" },
    ]);
    assert.strictEqual(replaceQueuedPrompt(queue, "missing", "text", "text"), null);
  });

  it("rebuilds a grouped queue batch when one of its prompts is edited", () => {
    const batch = createQueueBatch([
      { key: "prompt-1", full: "first", display: "first" },
      { key: "prompt-2", full: "second", display: "second" },
    ])!;
    const edited = replaceQueuedPrompt([batch], "prompt-2", "amended second", "amended second");
    assert.deepStrictEqual(edited?.[0]?.batchPrompts, ["first", "amended second"]);
    assert.deepStrictEqual(edited?.[0]?.sourceKeys, ["prompt-1", "prompt-2"]);
  });

  it("replaces a submitted prompt and drops its old output while retaining queued follow-ups", () => {
    const events: ChatEvent[] = [
      { kind: "user", key: "prompt-1", text: "original" },
      { kind: "info", key: "turn-output", text: "old response metadata" },
      { kind: "user", key: "prompt-2", text: "follow-up", queued: true },
    ];
    const edited = replaceUserPromptEvent(events, "prompt-1", "amended", true);
    assert.deepStrictEqual(edited, [
      { kind: "user", key: "prompt-1", text: "amended", images: undefined },
      { kind: "user", key: "prompt-2", text: "follow-up", queued: true },
    ]);
  });
});

describe("buildFilePickerIgnoreList", () => {
  it("always includes hardcoded patterns", () => {
    const list = buildFilePickerIgnoreList("/fake");
    assert.ok(list.includes("**/node_modules/**"));
    assert.ok(list.includes("**/.git/**"));
    assert.ok(list.includes("**/dist/**"));
  });

  it("reads .gitignore and converts patterns", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-test-"));
    writeFileSync(join(dir, ".gitignore"), "*.log\nbuild/\n/dist\n", "utf-8");
    const list = buildFilePickerIgnoreList(dir);
    assert.ok(list.includes("**/*.log"));
    assert.ok(list.includes("**/build/**"));
    assert.ok(list.includes("dist"));
    unlinkSync(join(dir, ".gitignore"));
    rmdirSync(dir);
  });

  it("skips oversized .gitignore files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-test-"));
    // Write > 1 MB so the size guard triggers
    writeFileSync(join(dir, ".gitignore"), "a\n".repeat(600_000), "utf-8");
    const list = buildFilePickerIgnoreList(dir);
    // Should return only hardcoded patterns, not crash
    assert.ok(list.includes("**/node_modules/**"));
    assert.ok(!list.includes("**/a"));
    unlinkSync(join(dir, ".gitignore"));
    rmdirSync(dir);
  });

  it("ignores comments and negation patterns", () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-test-"));
    writeFileSync(join(dir, ".gitignore"), "# comment\n!important\n", "utf-8");
    const list = buildFilePickerIgnoreList(dir);
    assert.ok(!list.includes("# comment"));
    assert.ok(!list.includes("!important"));
    unlinkSync(join(dir, ".gitignore"));
    rmdirSync(dir);
  });
});

describe("filterPickerItems", () => {
  const items: FilePickerItem[] = [
    { name: "src/app.tsx", isDirectory: false },
    { name: "src", isDirectory: true },
    { name: "README.md", isDirectory: false },
  ];

  it("filters by substring case-insensitively", () => {
    const result = filterPickerItems(items, "app");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0]!.name, "src/app.tsx");
  });

  it("returns all items when query is empty", () => {
    const result = filterPickerItems(items, "");
    assert.strictEqual(result.length, 3);
  });

  it("caps results at 50", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      name: `file${i}.ts`,
      isDirectory: false,
    }));
    const result = filterPickerItems(many, "");
    assert.strictEqual(result.length, 50);
  });
});

describe("shouldOpenMentionPicker", () => {
  it("opens when @ is typed at start", () => {
    assert.strictEqual(shouldOpenMentionPicker("@", 1, null), true);
  });

  it("opens when @ follows whitespace", () => {
    assert.strictEqual(shouldOpenMentionPicker("hello @", 7, null), true);
  });

  it("does not open when @ follows a non-whitespace character", () => {
    assert.strictEqual(shouldOpenMentionPicker("hello@", 6, null), false);
  });

  it("does not open immediately after cancel at same offset", () => {
    assert.strictEqual(shouldOpenMentionPicker("hello ", 6, 6), false);
  });

  it("does not open when cursor is at 0", () => {
    assert.strictEqual(shouldOpenMentionPicker("", 0, null), false);
  });
});

describe("shouldOpenSlashPicker", () => {
  it("opens when / is the first char", () => {
    assert.strictEqual(shouldOpenSlashPicker("/", 1, null), true);
  });

  it("opens when / follows leading whitespace", () => {
    assert.strictEqual(shouldOpenSlashPicker("  /", 3, null), true);
  });

  it("does not open when / is mid-message", () => {
    assert.strictEqual(shouldOpenSlashPicker("hello /", 7, null), false);
    assert.strictEqual(shouldOpenSlashPicker("path/to", 5, null), false);
  });

  it("does not open immediately after cancel at same offset", () => {
    assert.strictEqual(shouldOpenSlashPicker("/", 1, 1), false);
  });

  it("does not open when cursor is at 0", () => {
    assert.strictEqual(shouldOpenSlashPicker("", 0, null), false);
  });

  it("does not open when char before cursor isn't /", () => {
    assert.strictEqual(shouldOpenSlashPicker("hello", 5, null), false);
  });
});

describe("insertSlashCommand", () => {
  it("inserts and appends a trailing space when input ends at the token", () => {
    const { value, cursor } = insertSlashCommand("/mod", 0, "model");
    assert.strictEqual(value, "/model ");
    assert.strictEqual(cursor, "/model ".length);
  });

  it("preserves args past the typed command token", () => {
    // user typed `/m|od rest` (cursor mid-token) and picked "model"
    const { value, cursor } = insertSlashCommand("/mod rest", 0, "model");
    assert.strictEqual(value, "/model rest");
    assert.strictEqual(cursor, "/model ".length);
  });

  it("does not duplicate spaces if a space already follows the token", () => {
    const { value } = insertSlashCommand("/m foo", 0, "model");
    assert.strictEqual(value, "/model foo");
  });

  it("works with leading whitespace before the slash", () => {
    const { value, cursor } = insertSlashCommand("  /he arg", 2, "help");
    assert.strictEqual(value, "  /help arg");
    assert.strictEqual(cursor, "  /help ".length);
  });

  it("collapses multi-space tails to a single separator", () => {
    const { value } = insertSlashCommand("/m  foo", 0, "model");
    assert.strictEqual(value, "/model foo");
  });

  it("normalizes tab/newline tails to a single space", () => {
    const { value } = insertSlashCommand("/m\tfoo", 0, "model");
    assert.strictEqual(value, "/model foo");
  });
});
