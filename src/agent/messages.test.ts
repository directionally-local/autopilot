import { describe, it } from "node:test";
import assert from "node:assert";
import { appendStoppedToolResults, mergeReasoningDetails, repairDanglingToolCalls, stableStringify, stripOldImages } from "./messages.js";
import type { ChatMessage } from "./messages.js";

describe("stableStringify", () => {
  it("produces identical strings for objects with different key insertion orders", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it("handles nested objects", () => {
    const a = { outer: { z: 1, a: 2 } };
    const b = { outer: { a: 2, z: 1 } };
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it("handles arrays consistently", () => {
    const a = [{ z: 1 }, { a: 2 }];
    const b = [{ z: 1 }, { a: 2 }];
    assert.strictEqual(stableStringify(a), stableStringify(b));
  });

  it("differs when values differ", () => {
    const a = { x: 1 };
    const b = { x: 2 };
    assert.notStrictEqual(stableStringify(a), stableStringify(b));
  });

  it("works with a replacer", () => {
    const obj = { a: "hello", b: 42 };
    const result = stableStringify(obj, (_k, v) => (typeof v === "string" ? v.toUpperCase() : v));
    assert.ok(result.includes("HELLO"));
  });

  it("works with indentation", () => {
    const obj = { a: 1 };
    const result = stableStringify(obj, undefined, 2);
    assert.ok(result.includes("\n"));
  });
});

describe("stripOldImages", () => {
  const img = (url: string) => ({ type: "image_url" as const, image_url: { url } });
  const txt = (text: string) => ({ type: "text" as const, text });

  it("keeps images in recent turns", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: [txt("old"), img("http://old")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [txt("new"), img("http://new")] },
    ];
    const result = stripOldImages(messages, 1);
    assert.deepStrictEqual((result[1]!.content as typeof messages[0]["content"])!, [txt("old")]);
    assert.deepStrictEqual((result[3]!.content as typeof messages[0]["content"])!, [txt("new"), img("http://new")]);
  });

  it("strips images from older turns while keeping text", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [txt("a"), img("http://a")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [txt("b"), img("http://b")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [txt("c"), img("http://c")] },
    ];
    const result = stripOldImages(messages, 2);
    assert.deepStrictEqual((result[0]!.content as typeof messages[0]["content"])!, [txt("a")]);
    assert.deepStrictEqual((result[2]!.content as typeof messages[0]["content"])!, [txt("b"), img("http://b")]);
    assert.deepStrictEqual((result[4]!.content as typeof messages[0]["content"])!, [txt("c"), img("http://c")]);
  });

  it("leaves string-only messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = stripOldImages(messages, 1);
    assert.strictEqual(result[0]!.content, "hello");
  });

  it("replaces image-only messages with fallback text", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [img("http://x")] },
      { role: "assistant", content: "ok" },
      { role: "user", content: [img("http://y")] },
    ];
    const result = stripOldImages(messages, 1);
    assert.strictEqual(result[0]!.content, "[image omitted]");
    assert.deepStrictEqual((result[2]!.content as typeof messages[0]["content"])!, [img("http://y")]);
  });

  it("does not mutate the original array", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [txt("a"), img("http://a")] },
    ];
    const original = JSON.stringify(messages);
    stripOldImages(messages, 0);
    assert.strictEqual(JSON.stringify(messages), original);
  });

  it("returns input unchanged when keepLastTurns is negative", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [img("http://a")] },
    ];
    const result = stripOldImages(messages, -1);
    assert.deepStrictEqual((result[0]!.content as typeof messages[0]["content"])!, [img("http://a")]);
  });

  it("keeps images when user message count is below keepLastTurns", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [txt("hello"), img("http://a")] },
      { role: "assistant", content: "ok" },
    ];
    const result = stripOldImages(messages, 2);
    assert.deepStrictEqual((result[0]!.content as typeof messages[0]["content"])!, [txt("hello"), img("http://a")]);
  });
});

describe("mergeReasoningDetails", () => {
  it("concatenates text fragments that share an index and keeps the latest signature", () => {
    let acc = mergeReasoningDetails([], [{ type: "reasoning.text", index: 0, text: "Let me " }]);
    acc = mergeReasoningDetails(acc, [{ type: "reasoning.text", index: 0, text: "think." }]);
    acc = mergeReasoningDetails(acc, [{ type: "reasoning.text", index: 0, text: "", signature: "sig-abc" }]);
    assert.deepStrictEqual(acc, [{ type: "reasoning.text", index: 0, text: "Let me think.", signature: "sig-abc" }]);
  });

  it("keeps distinct indexes as separate blocks, in order", () => {
    const acc = mergeReasoningDetails(
      [{ type: "reasoning.summary", index: 0, summary: "Plan" }],
      [{ type: "reasoning.encrypted", index: 1, data: "opaque" }],
    );
    assert.deepStrictEqual(acc.map((d) => d.type), ["reasoning.summary", "reasoning.encrypted"]);
  });

  it("appends items without an index and never mutates its input", () => {
    const start = [{ type: "reasoning.text", index: 0, text: "a" }];
    const out = mergeReasoningDetails(start, [{ type: "reasoning.encrypted", data: "x" }]);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(start.length, 1);
  });
});

describe("repairDanglingToolCalls", () => {
  const call = (id: string, name: string) => ({ id, type: "function" as const, function: { name, arguments: "{}" } });

  it("inserts (stopped) results for tool calls that have none, right after the assistant message", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "s" },
      { role: "user", content: "do it" },
      { role: "assistant", content: null, tool_calls: [call("a", "subagent"), call("b", "subagent")] },
      { role: "user", content: "go on" },
    ];
    assert.strictEqual(repairDanglingToolCalls(messages), 2);
    assert.deepStrictEqual(
      messages.map((m) => [m.role, m.tool_call_id ?? null]),
      [["system", null], ["user", null], ["assistant", null], ["tool", "a"], ["tool", "b"], ["user", null]],
    );
    assert.strictEqual(messages[3]!.content, "(stopped)");
    assert.strictEqual(messages[4]!.name, "subagent");
    // Already valid afterwards.
    assert.strictEqual(repairDanglingToolCalls(messages), 0);
  });

  it("fills only the missing result when some arrived", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a", "read"), call("b", "bash")] },
      { role: "tool", tool_call_id: "a", content: "ok", name: "read" },
      { role: "assistant", content: "done" },
    ];
    assert.strictEqual(repairDanglingToolCalls(messages), 1);
    assert.deepStrictEqual(messages.map((m) => m.tool_call_id ?? m.role), ["assistant", "a", "b", "assistant"]);
  });

  it("leaves a valid history untouched", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [call("a", "read")] },
      { role: "tool", tool_call_id: "a", content: "ok", name: "read" },
      { role: "assistant", content: "x" },
    ];
    const before = JSON.stringify(messages);
    assert.strictEqual(repairDanglingToolCalls(messages), 0);
    assert.strictEqual(JSON.stringify(messages), before);
  });
});

describe("appendStoppedToolResults", () => {
  it("appends once per call id and is idempotent", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }] },
    ];
    const pending = new Map([["a", "bash"], ["b", "read"]]);
    assert.strictEqual(appendStoppedToolResults(messages, pending), 2);
    assert.strictEqual(appendStoppedToolResults(messages, pending), 0);
    assert.strictEqual(messages.length, 3);
    assert.deepStrictEqual(messages.slice(1).map((m) => [m.tool_call_id, m.name, m.content]), [["a", "bash", "(stopped)"], ["b", "read", "(stopped)"]]);
  });
});
