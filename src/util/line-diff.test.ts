import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { structuredPatch, splitLines, type PatchHunk } from "./line-diff.js";

/** Apply hunks to old text's lines; the round trip proves the patch is correct. */
function apply(oldText: string, hunks: PatchHunk[]): string[] {
  const out: string[] = [];
  const old = splitLines(oldText);
  let at = 0; // 0-based index into old
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    while (at < start) out.push(old[at++]!);
    for (const line of h.lines) {
      if (line[0] === " ") {
        assert.equal(old[at], line.slice(1), "context matches");
        out.push(old[at++]!);
      } else if (line[0] === "-") {
        assert.equal(old[at], line.slice(1), "removed line matches");
        at++;
      } else out.push(line.slice(1));
    }
  }
  while (at < old.length) out.push(old[at++]!);
  return out;
}

describe("structuredPatch (Claude Code's hunk shape)", () => {
  it("one changed line in the middle of a file: real line numbers and 3 lines of context", () => {
    const old = "a\nb\nc\nd\ne\nf\ng\nh\ni\n";
    const next = "a\nb\nc\nd\nE\nf\ng\nh\ni\n";
    assert.deepEqual(structuredPatch(old, next), [
      { oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [" b", " c", " d", "-e", "+E", " f", " g", " h"] },
    ]);
  });

  it("matches `diff -U3` for an edit on the first line", () => {
    assert.deepEqual(structuredPatch("hello\nworld\n", "hello beacon\nworld\n"), [
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: ["-hello", "+hello beacon", " world"] },
    ]);
  });

  it("splits far-apart changes into separate hunks and merges near ones", () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    const far = old.replace("l2\n", "L2\n").replace("l25\n", "L25\n");
    const hunks = structuredPatch(old, far);
    assert.equal(hunks.length, 2);
    assert.deepEqual(hunks.map((h) => [h.oldStart, h.oldLines]), [[1, 5], [22, 7]]);
    const near = old.replace("l2\n", "L2\n").replace("l8\n", "L8\n");
    assert.equal(structuredPatch(old, near).length, 1);
  });

  it("insertions and deletions use jsdiff's start convention, and every patch round-trips", () => {
    assert.deepEqual(structuredPatch("", "x\ny\n"), [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] }]);
    assert.deepEqual(structuredPatch("x\ny\n", ""), [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ["-x", "-y"] }]);
    const cases: Array<[string, string]> = [
      ["a\nb\nc\n", "a\nc\n"],
      ["a\nb\nc\n", "x\na\nb\nc\ny\n"],
      ["1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n", "1\n3\n4\nfour\n5\n6\n8\n9\n10\n11\n"],
      ["same\n", "same\n"],
    ];
    for (const [a, b] of cases) assert.deepEqual(apply(a, structuredPatch(a, b)), splitLines(b), `${a} -> ${b}`);
    assert.deepEqual(structuredPatch("same\n", "same\n"), []);
  });

  it("stays correct (one replaced block) when the middle is too big for Myers", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const hunks = structuredPatch(a, b);
    assert.deepEqual(apply(a, hunks), splitLines(b));
  });
});
