import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** The repo root, two levels up from src/util. */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readPackageJson(): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
}

test("camouflage-tui is pinned to the exact audited version", () => {
  assert.equal(readPackageJson().dependencies?.["camouflage-tui"], "2.12.0");
});

test("camouflage-tui's declaration carries no range operator", () => {
  const spec = readPackageJson().dependencies?.["camouflage-tui"] ?? "";
  assert.match(spec, /^\d+\.\d+\.\d+$/, `expected an exact version, got ${JSON.stringify(spec)}`);
});
