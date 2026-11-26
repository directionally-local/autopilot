import { describe, it } from "node:test";
import assert from "node:assert";
import { SessionStore, type StoredSession } from "./sessions.js";

function stub(id: string): StoredSession & { disposed: number } {
  return {
    id,
    disposed: 0,
    dispose() {
      this.disposed++;
    },
  };
}

describe("SessionStore", () => {
  it("stores, finds and deletes sessions; deleting disposes", () => {
    const store = new SessionStore();
    const a = stub("a");
    store.set(a);
    assert.strictEqual(store.get("a"), a);
    assert.strictEqual(store.get("b"), undefined);
    assert.strictEqual(store.delete("a"), true);
    assert.strictEqual(a.disposed, 1);
    assert.strictEqual(store.delete("a"), false);
  });

  it("closes the oldest session past the limit", () => {
    const store = new SessionStore(2);
    const [a, b, c] = [stub("a"), stub("b"), stub("c")];
    store.set(a);
    store.set(b);
    store.set(c);
    assert.strictEqual(store.size, 2);
    assert.strictEqual(store.get("a"), undefined);
    assert.strictEqual(a.disposed, 1);
    assert.strictEqual(b.disposed, 0);
  });

  it("replacing a session under the same id disposes the old one", () => {
    const store = new SessionStore();
    const first = stub("a");
    const second = stub("a");
    store.set(first);
    store.set(second);
    assert.strictEqual(first.disposed, 1);
    assert.strictEqual(store.get("a"), second);
    store.disposeAll();
    assert.strictEqual(second.disposed, 1);
    assert.strictEqual(store.size, 0);
  });
});
