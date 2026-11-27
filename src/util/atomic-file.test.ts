import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverJsonPrefix, withFileLock, writeFileAtomic } from "./atomic-file.js";

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temp files behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    try {
      const p = join(dir, "usage.json");
      await writeFileAtomic(p, '{"a":1}');
      await writeFileAtomic(p, '{"a":2}');
      assert.equal(await readFile(p, "utf8"), '{"a":2}');
      assert.deepEqual(await readdir(dir), ["usage.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("withFileLock", () => {
  it("runs critical sections one at a time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lock-"));
    try {
      const lock = join(dir, "usage.json.lock");
      let inside = 0;
      let maxInside = 0;
      await Promise.all(
        Array.from({ length: 8 }, () =>
          withFileLock(lock, async () => {
            inside++;
            maxInside = Math.max(maxInside, inside);
            await new Promise((r) => setTimeout(r, 10));
            inside--;
          }),
        ),
      );
      assert.equal(maxInside, 1);
      assert.deepEqual(await readdir(dir), [], "the lock is released");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("recoverJsonPrefix", () => {
  it("salvages a document followed by the tail of an interleaved write", () => {
    const good = JSON.stringify({ version: 2, sessions: [{ id: "s1", turns: [{ cost: 0.1 }] }] }, null, 2);
    const corrupt = good + '\n        }\n      ]\n    }\n  ]\n}\n';
    assert.deepEqual(recoverJsonPrefix(corrupt), JSON.parse(good));
  });

  it("returns undefined when nothing parses", () => {
    assert.equal(recoverJsonPrefix("not json"), undefined);
  });
});
