import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCommandCollapsed, previewCommand } from "./command-preview.js";

/** A 15-line benchmark loop like the one that filled the transcript. */
const LONG_SCRIPT = [
  "for r in 1 2 3; do",
  '  echo "=== light rep $r"',
  '  node dist/bench.js --profile light --json 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(json.dumps({\\"rep\\":$r}))"',
  ...Array.from({ length: 11 }, (_, i) => `  echo step ${i}`),
  "done",
].join("\n");

describe("previewCommand", () => {
  it("keeps short single-line commands unchanged", () => {
    assert.equal(previewCommand("npm test"), "npm test");
    assert.equal(previewCommand("  git status  "), "git status");
  });

  it("collapses a multi-line script to its first line and a +N lines marker", () => {
    assert.equal(LONG_SCRIPT.split("\n").length, 15);
    const preview = previewCommand(LONG_SCRIPT);
    assert.equal(preview, "for r in 1 2 3; do … +14 lines");
    assert.equal(preview.includes("\n"), false);
    assert.equal(previewCommand("make build\nmake test"), "make build … +1 line");
  });

  it("collapses whitespace and skips leading blank lines", () => {
    assert.equal(previewCommand("\n\n  echo   a\t b\n echo c"), "echo a b … +1 line");
    assert.equal(previewCommand("a\r\nb\r\nc"), "a … +2 lines");
  });

  it("truncates very long lines to the width, marker included", () => {
    const long = `echo ${"x".repeat(300)}`;
    const preview = previewCommand(long, 80);
    assert.equal(Array.from(preview).length, 80);
    assert.match(preview, /^echo x+…$/);
    const multi = previewCommand(`${long}\necho done`, 80);
    assert.equal(Array.from(multi).length, 80);
    assert.match(multi, /^echo x+… … \+1 line$/);
  });

  it("never cuts in the middle of a multi-byte character", () => {
    const preview = previewCommand(`echo ${"😀".repeat(50)}`, 20);
    assert.equal(Array.from(preview).length, 20);
    assert.equal(preview, `echo ${"😀".repeat(14)}…`);
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(preview), false);
  });

  it("reports when a command was collapsed", () => {
    assert.equal(isCommandCollapsed("npm test"), false);
    assert.equal(isCommandCollapsed(LONG_SCRIPT), true);
    assert.equal(isCommandCollapsed("x".repeat(121)), true);
  });
});
