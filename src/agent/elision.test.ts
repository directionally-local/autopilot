import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { elideStaleObservations } from "./elision.js";
import { estimatePromptTokens } from "./artifact-compaction.js";
import type { ChatMessage } from "./messages.js";

function turn(i: number, payloadChars: number, artifactId?: string): ChatMessage[] {
  const footer = artifactId ? `\n[output reduced — full raw stored as artifact ${artifactId}]` : "";
  return [
    { role: "user", content: `question ${i}` },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: `src/f${i}.ts` }) },
        },
      ],
    },
    { role: "tool", tool_call_id: `c${i}`, name: "read", content: "x".repeat(payloadChars) + footer },
    { role: "assistant", content: `answer ${i}` },
  ];
}

function history(turns: number, payloadChars: number, artifactId?: string): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < turns; i++) out.push(...turn(i, payloadChars, artifactId));
  return out;
}

describe("elideStaleObservations", () => {
  it("leaves a history below the soft threshold untouched", () => {
    const messages = history(2, 10_000);
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });
    assert.equal(result.elidedCount, 0);
    assert.deepEqual(result.messages, messages);
    assert.equal(result.tokensAfter, result.tokensBefore);
  });

  it("elides bulky middle tool output and keeps the recent window verbatim", () => {
    const messages = history(20, 35_000);
    const recent = messages.slice(-8); // last two turns
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });

    assert.ok(result.elidedCount > 0, "elided something");
    assert.ok(result.tokensAfter < result.tokensBefore, "shrinks the prompt");
    assert.equal(result.messages[0]!.content, "system prompt");
    assert.deepEqual(result.messages.slice(-8), recent, "recent turns untouched");

    // Tool pairing survives: every tool message still has its call id.
    const callIds = new Set(result.messages.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []));
    for (const m of result.messages.filter((m) => m.role === "tool")) {
      assert.ok(callIds.has(m.tool_call_id!));
    }
  });

  it("stops eliding once the history reaches the target", () => {
    const messages = history(20, 35_000);
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });
    // Target is 0.85 × 100k; elision stops as soon as it is under it.
    assert.ok(result.tokensAfter <= 85_000, `under target: ${result.tokensAfter}`);
    assert.ok(result.elidedCount < 17, "did not elide the whole middle region");
  });

  it("keeps the artifact id in the stub so expand_artifact still works", () => {
    const messages = history(20, 35_000, "read_123_0");
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });
    const stubs = result.messages.filter(
      (m) => m.role === "tool" && typeof m.content === "string" && m.content.startsWith("[tool output elided:"),
    );
    assert.ok(stubs.length > 0);
    assert.ok(stubs.some((m) => String(m.content).includes("read_123_0")));
  });

  it("does not elide small tool outputs", () => {
    const messages = history(500, 500);
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });
    assert.equal(result.elidedCount, 0);
    assert.deepEqual(result.messages, messages);
  });

  it("returns unchanged when there is no middle region", () => {
    const messages = history(2, 200_000);
    const result = elideStaleObservations(messages, { budgetTokens: 100_000 });
    assert.equal(result.elidedCount, 0);
    assert.equal(estimatePromptTokens(result.messages), result.tokensBefore);
  });
});
