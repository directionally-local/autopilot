import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockKeyFor, pendingLockCount, withFileLock } from "./file-lock.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withFileLock", () => {
  it("runs callers for the same path strictly one after another", async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock("/tmp/same", async () => {
        order.push("a:start");
        await sleep(20);
        order.push("a:end");
      }),
      withFileLock("/tmp/same", async () => {
        order.push("b:start");
        await sleep(5);
        order.push("b:end");
      }),
    ]);
    assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
    assert.strictEqual(pendingLockCount(), 0);
  });

  it("lets different paths overlap", async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock("/tmp/one", async () => {
        order.push("a:start");
        await sleep(20);
        order.push("a:end");
      }),
      withFileLock("/tmp/two", async () => {
        order.push("b:start");
        await sleep(5);
        order.push("b:end");
      }),
    ]);
    // Acquisition order between independent callers is not promised; overlap is.
    assert.ok(order.indexOf("b:start") < order.indexOf("a:end"), `b must start before a ends: ${order.join(",")}`);
    assert.ok(order.indexOf("b:end") < order.indexOf("a:end"), `b must finish before a ends: ${order.join(",")}`);
  });

  it("keeps serving the queue after a caller throws", async () => {
    const results: string[] = [];
    await Promise.allSettled([
      withFileLock("/tmp/throws", async () => {
        throw new Error("boom");
      }),
      withFileLock("/tmp/throws", async () => {
        results.push("second ran");
      }),
    ]);
    assert.deepEqual(results, ["second ran"]);
    assert.strictEqual(pendingLockCount(), 0);
  });

  it("shares one key between a symlink and its target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "file-lock-"));
    const target = join(dir, "real.txt");
    const link = join(dir, "link.txt");
    await writeFile(target, "x", "utf8");
    await symlink(target, link);
    assert.strictEqual(await lockKeyFor(link), await lockKeyFor(target));
    assert.strictEqual(await lockKeyFor(join(dir, "missing.txt")), join(dir, "missing.txt"));
  });
});
