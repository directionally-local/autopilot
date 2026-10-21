import { describe, it } from "node:test";
import assert from "node:assert";
import {
  decidePickerTransition,
  filterPickerItems,
  shouldOpenMentionPicker,
  shouldOpenSlashPicker,
  insertSlashCommand,
  type ActivePicker,
} from "./use-picker-controller.js";
import type { FilePickerItem } from "./view-types.js";

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
    assert.strictEqual(filterPickerItems(items, "").length, 3);
  });

  it("caps results at 50", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      name: `file${i}.ts`,
      isDirectory: false,
    }));
    assert.strictEqual(filterPickerItems(many, "").length, 50);
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
    const { value, cursor } = insertSlashCommand("/mod rest", 0, "model");
    assert.strictEqual(value, "/model rest");
    assert.strictEqual(cursor, "/model ".length);
  });
  it("does not duplicate spaces if a space already follows the token", () => {
    assert.strictEqual(insertSlashCommand("/m foo", 0, "model").value, "/model foo");
  });
  it("works with leading whitespace before the slash", () => {
    const { value, cursor } = insertSlashCommand("  /he arg", 2, "help");
    assert.strictEqual(value, "  /help arg");
    assert.strictEqual(cursor, "  /help ".length);
  });
  it("collapses multi-space tails to a single separator", () => {
    assert.strictEqual(insertSlashCommand("/m  foo", 0, "model").value, "/model foo");
  });
  it("normalizes tab/newline tails to a single space", () => {
    assert.strictEqual(insertSlashCommand("/m\tfoo", 0, "model").value, "/model foo");
  });
});

describe("decidePickerTransition", () => {
  describe("when no picker is active", () => {
    it("opens the file picker on a leading @", () => {
      const t = decidePickerTransition(null, "@", 1, null, true);
      assert.deepStrictEqual(t, {
        kind: "open",
        picker: { kind: "file", anchor: 0, selected: 0 },
        loadFiles: true,
      });
    });

    it("opens the slash picker on a leading /", () => {
      const t = decidePickerTransition(null, "/", 1, null, true);
      assert.deepStrictEqual(t, {
        kind: "open",
        picker: { kind: "slash", anchor: 0, selected: 0 },
        loadFiles: false,
      });
    });

    it("does NOT open the file picker when filePickerEnabled is false", () => {
      const t = decidePickerTransition(null, "@", 1, null, false);
      assert.deepStrictEqual(t, { kind: "none" });
    });

    it("still opens slash even when filePickerEnabled is false", () => {
      const t = decidePickerTransition(null, "/", 1, null, false);
      assert.strictEqual(t.kind, "open");
    });

    it("returns dropCancel when cursor returns to the cancel offset", () => {
      const t = decidePickerTransition(null, "hello ", 6, 6, true);
      assert.deepStrictEqual(t, { kind: "dropCancel" });
    });

    it("returns none when nothing relevant has changed", () => {
      const t = decidePickerTransition(null, "hello world", 11, null, true);
      assert.deepStrictEqual(t, { kind: "none" });
    });
  });

  describe("when a picker is active", () => {
    const fileActive: ActivePicker = { kind: "file", anchor: 0, selected: 0 };
    const slashActive: ActivePicker = { kind: "slash", anchor: 0, selected: 0 };

    it("keeps the picker open while typing query chars", () => {
      const t = decidePickerTransition(fileActive, "@src", 4, null, true);
      assert.deepStrictEqual(t, { kind: "none" });
    });

    it("closes when the cursor moves before the anchor", () => {
      const anchored: ActivePicker = { kind: "file", anchor: 5, selected: 0 };
      const t = decidePickerTransition(anchored, "abc @s", 3, null, true);
      assert.deepStrictEqual(t, { kind: "close" });
    });

    it("closes when the trigger char at the anchor was deleted", () => {
      const t = decidePickerTransition(fileActive, "src", 3, null, true);
      assert.deepStrictEqual(t, { kind: "close" });
    });

    it("closes when whitespace is typed inside the query", () => {
      const t = decidePickerTransition(fileActive, "@sr c", 5, null, true);
      assert.deepStrictEqual(t, { kind: "close" });
    });

    it("closes the slash picker when the anchor no longer holds /", () => {
      const t = decidePickerTransition(slashActive, "x", 1, null, true);
      assert.deepStrictEqual(t, { kind: "close" });
    });

    it("keeps the slash picker open while typing", () => {
      const t = decidePickerTransition(slashActive, "/hel", 4, null, true);
      assert.deepStrictEqual(t, { kind: "none" });
    });
  });
});
