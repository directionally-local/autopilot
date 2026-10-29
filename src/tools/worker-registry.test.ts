import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { WorkerRegistry } from "./worker-registry.js";

describe("WorkerRegistry", () => {
  it("numbers running workers and restarts numbering when idle", () => {
    const registry = new WorkerRegistry();
    const a = registry.start("research A", "m");
    const b = registry.start("research B", "m");
    assert.deepEqual(registry.list().map((w) => w.index), [1, 2]);
    a.finish();
    b.finish();
    b.finish(); // idempotent
    assert.equal(registry.list().length, 0);
    assert.equal(registry.start("research C", "m").index, 1);
  });

  it("removes parent abort listeners when workers finish (#967)", () => {
    const registry = new WorkerRegistry();
    const turn = new AbortController();
    const handles = Array.from({ length: 50 }, (_, i) => registry.start(`task ${i}`, "m", turn.signal));
    assert.equal(getEventListeners(turn.signal, "abort").length, 50);
    for (const handle of handles) {
      handle.complete({ status: "done", output: "ok" });
      handle.finish();
    }
    assert.equal(getEventListeners(turn.signal, "abort").length, 0);
  });

  it("cancels one worker without touching the others or the parent", () => {
    const registry = new WorkerRegistry();
    const turn = new AbortController();
    const a = registry.start("A", "m", turn.signal);
    const b = registry.start("B", "m", turn.signal);
    assert.equal(registry.cancel(2)?.task, "B");
    assert.equal(b.signal.aborted, true);
    assert.equal(b.cancelledByUser, true);
    assert.equal(a.signal.aborted, false);
    assert.equal(turn.signal.aborted, false);
    assert.equal(registry.list().find((w) => w.index === 2)?.status, "cancelling");
    assert.equal(registry.cancel(2), null, "already cancelling");
    assert.equal(registry.cancel("#1")?.task, "A", "accepts #n strings");
    assert.equal(registry.cancel(9), null);
  });

  it("follows the turn's abort without marking it a user cancel", () => {
    const registry = new WorkerRegistry();
    const turn = new AbortController();
    const a = registry.start("A", "m", turn.signal);
    turn.abort();
    assert.equal(a.signal.aborted, true);
    assert.equal(a.cancelledByUser, false);
  });

  it("cancels all and notifies subscribers", () => {
    const registry = new WorkerRegistry();
    const seen: number[] = [];
    const unsubscribe = registry.subscribe((workers) => seen.push(workers.length));
    registry.start("A", "m");
    registry.start("B", "m");
    assert.equal(registry.cancelAll(), 2);
    assert.equal(registry.cancelAll(), 0);
    unsubscribe();
    registry.start("C", "m");
    assert.deepEqual(seen, [1, 2, 2]);
  });
});
