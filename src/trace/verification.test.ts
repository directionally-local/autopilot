import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyVerification } from "./verification.js";

describe("classifyVerification", () => {
  it("recognizes test runners", () => {
    for (const cmd of [
      "npm test",
      "npm run test -- --watch=false",
      "npx tsx --test src/trace/*.test.ts",
      "cd pkg && npx vitest run",
      "jest src/foo.test.ts",
      "pytest -q tests/",
      "go test ./...",
      "cargo test --all",
    ]) {
      assert.strictEqual(classifyVerification(cmd), "test", cmd);
    }
  });

  it("recognizes lint, typecheck, and build", () => {
    assert.strictEqual(classifyVerification("npx eslint src --max-warnings 0"), "lint");
    assert.strictEqual(classifyVerification("ruff check ."), "lint");
    assert.strictEqual(classifyVerification("golangci-lint run"), "lint");
    assert.strictEqual(classifyVerification("npx tsc --noEmit"), "typecheck");
    assert.strictEqual(classifyVerification("npm run typecheck"), "typecheck");
    assert.strictEqual(classifyVerification("mypy src"), "typecheck");
    assert.strictEqual(classifyVerification("pyright"), "typecheck");
    assert.strictEqual(classifyVerification("npm run build"), "build");
    assert.strictEqual(classifyVerification("tsup"), "build");
    assert.strictEqual(classifyVerification("cargo build --release"), "build");
    assert.strictEqual(classifyVerification("go build ./cmd/x"), "build");
  });

  it("prefers test over build when both appear", () => {
    assert.strictEqual(classifyVerification("npm run build && npm test"), "test");
  });

  it("returns null for ordinary commands and look-alikes", () => {
    for (const cmd of ["ls -la", "git status", "cat jest.config.js", "echo tsc", "npm install", "contest", ""]) {
      assert.strictEqual(classifyVerification(cmd), null, cmd);
    }
  });
});
