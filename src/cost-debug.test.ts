import { describe, it } from "node:test";
import assert from "node:assert";
import { comparePromptPrefixes } from "./cost-debug.js";
import type { ChatMessage } from "./agent/messages.js";

describe("comparePromptPrefixes", () => {
  it("detects no change when prefixes are identical", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session" },
      { role: "user", content: "hello" },
    ];
    const diag = comparePromptPrefixes(msgs, msgs);
    assert.strictEqual(diag.changedSegment, "none");
    assert.strictEqual(diag.firstDiffByte, null);
  });

  it("detects static prefix change", () => {
    const prev: ChatMessage[] = [
      { role: "system", content: "static A" },
      { role: "system", content: "session" },
    ];
    const curr: ChatMessage[] = [
      { role: "system", content: "static B" },
      { role: "system", content: "session" },
    ];
    const diag = comparePromptPrefixes(prev, curr);
    assert.strictEqual(diag.changedSegment, "static");
    assert.ok(diag.firstDiffByte !== null);
  });

  it("detects session prefix change", () => {
    const prev: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session A" },
    ];
    const curr: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session B" },
    ];
    const diag = comparePromptPrefixes(prev, curr);
    assert.strictEqual(diag.changedSegment, "session");
    assert.ok(diag.firstDiffByte !== null);
  });

  it("measures prefix sizes correctly", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "static text" },
      { role: "system", content: "session text" },
      { role: "user", content: "dynamic" },
    ];
    const diag = comparePromptPrefixes(undefined, msgs);
    assert.strictEqual(diag.staticPrefixChars, 11); // "static text"
    assert.strictEqual(diag.sessionPrefixChars, 12);
    assert.strictEqual(diag.dynamicSuffixChars, 7);
  });
});
