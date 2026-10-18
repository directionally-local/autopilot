import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canDrainQueue, createQueueBatch, type QueuedPrompt } from "./queue-batch.js";

const prompt = (key: string, full: string): QueuedPrompt => ({ full, display: full, key });

describe("canDrainQueue", () => {
  it("waits for the supervisor to become idle, then permits every remaining queued item", () => {
    const state = {
      busy: false,
      queuePlanOpen: false,
      supervisorIdle: false,
      hasPendingWork: true,
    };

    // Intermediate assistant/tool callbacks can clear busy before the turn is done.
    assert.equal(canDrainQueue(state), false);

    // Final cleanup wakes the effect after the supervisor has gone idle. The next
    // queued prompt can start, and a subsequent completion can drain the rest.
    assert.equal(canDrainQueue({ ...state, supervisorIdle: true, hasPendingWork: true }), true);
    assert.equal(canDrainQueue({ ...state, supervisorIdle: true, hasPendingWork: false }), false);
  });
});

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
