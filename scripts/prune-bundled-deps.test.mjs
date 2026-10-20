import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneBundledDeps } from "./prune-bundled-deps.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prune-bundled-"));
  const write = (rel, body = "") => {
    const file = join(root, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, body);
  };
  write(
    "package-lock.json",
    JSON.stringify({
      packages: {
        "": { name: "app" },
        "node_modules/runtime": { version: "1.0.0" },
        "node_modules/entry-in-test": { version: "1.0.0" },
        "node_modules/devonly": { version: "1.0.0", dev: true },
      },
    }),
  );
  write("node_modules/runtime/package.json", JSON.stringify({ main: "index.js" }));
  write("node_modules/runtime/index.js");
  write("node_modules/runtime/lib/test.js");
  write("node_modules/runtime/benchmark/bench.mjs", 'import "tinybench";');
  write("node_modules/runtime/test/a.test.js");
  write("node_modules/runtime/bench.js", 'require("fastbench");');
  write("node_modules/runtime/test.js");
  write("node_modules/runtime/src/v3/benchmarks/index.ts", 'import Benchmark from "benchmark";');
  write("node_modules/runtime/src/v3/types.ts");
  write("node_modules/entry-in-test/package.json", JSON.stringify({ main: "test/index.js" }));
  write("node_modules/entry-in-test/test/index.js");
  write("node_modules/devonly/package.json", "{}");
  write("node_modules/devonly/test/a.js");
  return root;
}

describe("pruneBundledDeps", () => {
  it("removes benchmark, test and example entries of production packages only", () => {
    const root = fixture();
    try {
      const removed = pruneBundledDeps(root);
      assert.deepEqual(removed.sort(), [
        "node_modules/runtime/bench.js",
        "node_modules/runtime/benchmark",
        "node_modules/runtime/src/v3/benchmarks",
        "node_modules/runtime/test",
        "node_modules/runtime/test.js",
      ]);
      assert.equal(existsSync(join(root, "node_modules/runtime/src/v3/types.ts")), true);
      assert.equal(existsSync(join(root, "node_modules/runtime/benchmark")), false);
      assert.equal(existsSync(join(root, "node_modules/runtime/index.js")), true);
      assert.equal(existsSync(join(root, "node_modules/runtime/lib/test.js")), true, "only top-level entries go");
      assert.equal(existsSync(join(root, "node_modules/entry-in-test/test/index.js")), true, "entry points are kept");
      assert.equal(existsSync(join(root, "node_modules/devonly/test/a.js")), true, "dev packages are not shipped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("only lists paths in dry-run mode", () => {
    const root = fixture();
    try {
      assert.equal(pruneBundledDeps(root, { dryRun: true }).length, 5);
      assert.equal(existsSync(join(root, "node_modules/runtime/benchmark")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
