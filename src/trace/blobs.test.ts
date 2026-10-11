import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, sha256Hex, truncateUtf8 } from "./blobs.js";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "kimiflare-trace-blobs-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("BlobStore", () => {
  it("writes once per sha and returns the same sha for identical content", async () => {
    const store = new BlobStore(join(root, "dedupe"));
    const a = store.put("hello world");
    const b = store.put("hello world");
    assert.strictEqual(a.sha256, sha256Hex("hello world"));
    assert.strictEqual(a.sha256, b.sha256);
    assert.strictEqual(a.truncated, false);
    assert.strictEqual(a.bytes, 11);
    assert.strictEqual(a.written, 11);
    assert.strictEqual(b.written, 0);
    assert.deepStrictEqual(await readdir(store.dir), [a.sha256]);
    assert.strictEqual(await readFile(store.pathFor(a.sha256), "utf8"), "hello world");
    assert.ok(store.has(a.sha256));
  });

  it("does not create the directory until the first put", () => {
    const dir = join(root, "lazy");
    const store = new BlobStore(dir);
    assert.ok(!existsSync(dir));
    store.put("x");
    assert.ok(existsSync(dir));
  });

  it("truncates at the cap and appends the marker; the sha is of the stored bytes", async () => {
    const store = new BlobStore(join(root, "trunc"), { maxBlobBytes: 16 });
    const content = "a".repeat(100);
    const res = store.put(content);
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.bytes, 100);
    const stored = await readFile(store.pathFor(res.sha256), "utf8");
    assert.strictEqual(stored, "a".repeat(16) + "\n[truncated: 100 bytes total]");
    assert.strictEqual(res.sha256, sha256Hex(stored));
    // Same oversized content maps to the same blob.
    assert.strictEqual(store.put(content).written, 0);
  });

  it("never splits a multi-byte code point when truncating", () => {
    // "é" is 2 bytes; cap of 3 bytes fits one "é" plus one dangling byte.
    assert.strictEqual(truncateUtf8("ééé", 3), "é");
    assert.strictEqual(truncateUtf8("abc", 3), "abc");
    assert.strictEqual(truncateUtf8("日本語", 7), "日本");
  });
});
