import { describe, it } from "node:test";
import assert from "node:assert";
import { cutAtWord, displaySessionTitle } from "./session-title.js";
import { generateSessionTitle } from "./sessions.js";
import { buildResumeReplay } from "./ui/resume-replay.js";

describe("conversation titles", () => {
  it("leaves questions unlabelled and cuts at a word boundary with an ellipsis", () => {
    assert.strictEqual(generateSessionTitle("explain what this project does and how to use it", "qa"), "explain what this project does…");
    assert.strictEqual(generateSessionTitle("what is this?", "qa"), "what is this?");
    assert.strictEqual(generateSessionTitle("fix the flaky clear test in attach session", "diagnose"), "Bug: fix the flaky clear test…");
    assert.strictEqual(generateSessionTitle("rename   the\nfunction", "small_edit"), "Edit: rename the function");
    for (const t of [generateSessionTitle("a ".repeat(50), "qa"), generateSessionTitle("x".repeat(80), "default")]) assert.ok(t.length <= 40, t);
  });

  it("cuts long text without splitting words", () => {
    assert.strictEqual(cutAtWord("one two three four", 12), "one two…");
    assert.strictEqual(cutAtWord("one two three", 13), "one two three");
    assert.strictEqual(cutAtWord("supercalifragilistic", 8), "superca…");
  });

  it("shows titles saved by earlier versions without their Q&A label", () => {
    assert.strictEqual(displaySessionTitle("Q&A: explain what this project does and"), "explain what this project does…");
    assert.strictEqual(displaySessionTitle("Q&A: what is this?"), "what is this?");
    assert.strictEqual(displaySessionTitle("Bug: the clear test fails sometimes on..."), "Bug: the clear test fails sometimes on…");
    const r = buildResumeReplay({ title: "Q&A: explain what this project does and", messages: [], updatedAt: "2026-11-03T01:29:00.000Z" }, { now: Date.parse("2026-11-03T02:00:00.000Z"), timeZone: "Asia/Tokyo" });
    assert.strictEqual(r.line, "Continuing “explain what this project does…” from today at 10:29");
  });
});
