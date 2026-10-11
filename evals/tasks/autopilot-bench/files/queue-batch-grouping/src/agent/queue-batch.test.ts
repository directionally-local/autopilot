import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createQueueBatch, type QueuedPrompt } from "./queue-batch.js";

const prompt = (key: string, full: string): QueuedPrompt => ({ full, display: full, key });

describe("createQueueBatch", () => {
  it("combines ordinary follow-ups and preserves their source keys", () => {
    const batch = createQueueBatch([
      prompt("q1", "Fix the key validation message"),
      prompt("q2", "Make the setup panel narrower"),
    ]);

    assert.ok(batch);
    assert.deepEqual(batch.sourceKeys, ["q1", "q2"]);
    assert.match(batch.full, /1\. Fix the key validation message/);
    assert.match(batch.full, /2\. Make the setup panel narrower/);
    assert.match(batch.full, /normal user permission/);
    assert.match(batch.display, /Coordinate 2 queued follow-ups/);
  });

  it("flattens prompts from a previously grouped item", () => {
    const firstBatch = createQueueBatch([
      prompt("q1", "First follow-up"),
      prompt("q2", "Second follow-up"),
    ]);
    assert.ok(firstBatch);

    const batch = createQueueBatch([firstBatch, prompt("q3", "Third follow-up")]);

    assert.deepEqual(batch?.sourceKeys, ["q1", "q2", "q3"]);
    assert.equal(batch?.batchPrompts?.length, 3);
    assert.match(batch?.full ?? "", /The user chose to group 3 queued follow-ups/);
    assert.doesNotMatch(batch?.full ?? "", /The user chose to group 2 queued follow-ups/);
  });

  it("requires at least two prompts", () => {
    assert.equal(createQueueBatch([prompt("q1", "One item")]), null);
  });

  it("refuses slash commands and shell commands", () => {
    assert.equal(createQueueBatch([prompt("q1", "First item"), prompt("q2", "/compact")]), null);
    assert.equal(createQueueBatch([prompt("q1", "First item"), prompt("q2", "!echo hello")]), null);
  });
});
