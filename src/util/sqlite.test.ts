import { describe, it } from "node:test";
import assert from "node:assert";
import { SqliteDatabase } from "./sqlite.js";

function db(): SqliteDatabase {
  const d = new SqliteDatabase(":memory:");
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  return d;
}

describe("SqliteDatabase (node:sqlite wrapper)", () => {
  it("binds undefined as NULL and returns plain-object rows", () => {
    const d = db();
    const r = d.prepare("INSERT INTO t (v) VALUES (?)").run(undefined);
    assert.deepStrictEqual(r, { changes: 1, lastInsertRowid: 1 });
    assert.deepStrictEqual(d.prepare("SELECT id, v FROM t").get(), { id: 1, v: null });
    assert.deepStrictEqual(d.prepare("SELECT id, v FROM t").all(), [{ id: 1, v: null }]);
    assert.strictEqual(d.prepare("SELECT id FROM t WHERE id = ?").get(99), undefined);
    d.close();
    d.close();
    assert.strictEqual(d.open, false);
  });

  it("transaction commits, rolls back on throw, and nests with savepoints", () => {
    const d = db();
    const insert = d.prepare("INSERT INTO t (v) VALUES (?)");
    const count = () => (d.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c;
    d.transaction((v: string) => insert.run(v))("a");
    assert.strictEqual(count(), 1);
    assert.throws(() => d.transaction(() => { insert.run("b"); throw new Error("boom"); }).immediate(), /boom/);
    assert.strictEqual(count(), 1);
    assert.strictEqual(d.inTransaction, false);
    const inner = d.transaction(() => { insert.run("inner"); throw new Error("inner"); });
    d.transaction(() => {
      insert.run("outer");
      assert.throws(() => inner(), /inner/);
    }).exclusive();
    assert.deepStrictEqual(d.prepare("SELECT v FROM t ORDER BY id").all(), [{ v: "a" }, { v: "outer" }]);
  });

  it("pragma sets and reads; foreign keys are off unless enabled", () => {
    const d = db();
    assert.strictEqual(d.pragma("foreign_keys", { simple: true }), 0);
    d.pragma("foreign_keys = ON");
    assert.strictEqual(d.pragma("foreign_keys", { simple: true }), 1);
    assert.strictEqual(new SqliteDatabase(":memory:", { foreignKeys: true }).pragma("foreign_keys", { simple: true }), 1);
    assert.strictEqual(d.pragma("busy_timeout", { simple: true }), 5000);
  });

  it("round-trips blobs as Uint8Array", () => {
    const d = new SqliteDatabase(":memory:");
    d.exec("CREATE TABLE b (x BLOB)");
    const vec = new Float32Array([1.5, -2]);
    d.prepare("INSERT INTO b VALUES (?)").run(Buffer.from(vec.buffer));
    const row = d.prepare("SELECT x FROM b").get() as { x: Uint8Array };
    assert.ok(row.x instanceof Uint8Array);
    assert.deepStrictEqual([...new Float32Array(row.x.buffer, row.x.byteOffset, 2)], [1.5, -2]);
    // An empty vector is an empty blob, not NULL (Node 22 bound it as NULL).
    d.prepare("INSERT INTO b VALUES (?)").run(Buffer.from(new Float32Array(0).buffer));
    assert.deepStrictEqual(d.prepare("SELECT typeof(x) AS t FROM b WHERE rowid = 2").get(), { t: "blob" });
  });
});
