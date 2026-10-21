import { describe, it } from "node:test";
import assert from "node:assert";
import { createQueueBatch } from "./agent/queue-batch.js";
import { replaceQueuedPrompt, replaceUserPromptEvent } from "./ui/app-helpers.js";
import type { ChatEvent } from "./ui/view-types.js";

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
