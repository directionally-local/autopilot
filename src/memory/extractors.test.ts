import { describe, it } from "node:test";
import assert from "node:assert";
import { EXTRACTORS, stripLineNumbers } from "./extractors.js";

function extractor(id: string) {
  const found = EXTRACTORS.find((e) => e.id === id);
  assert.ok(found, `missing extractor ${id}`);
  return found;
}

describe("stripLineNumbers", () => {
  it("removes the read tool's line-number prefix", () => {
    const raw = " 1\t{\n 2\t  \"name\": \"demo\"\n 3\t}";
    assert.strictEqual(stripLineNumbers(raw), "{\n  \"name\": \"demo\"\n}");
  });
});

describe("deterministic extractors", () => {
  it("parses line-numbered package.json output", async () => {
    const raw = [
      " 1\t{",
      " 2\t  \"name\": \"demo\",",
      " 3\t  \"dependencies\": { \"react\": \"19.0.0\" },",
      " 4\t  \"devDependencies\": { \"typescript\": \"5.7.0\" },",
      " 5\t  \"scripts\": { \"build\": \"tsup\" },",
      " 6\t  \"type\": \"module\"",
      " 7\t}",
    ].join("\n");
    const result = await extractor("package_json").extract(raw, "package.json");
    assert.ok(result);
    assert.match(result.content, /react/);
    assert.match(result.content, /typescript/);
    assert.strictEqual(result.topicKey, "project_dependencies");
  });

  it("parses line-numbered tsconfig output", async () => {
    const raw = [
      " 1\t{",
      " 2\t  \"compilerOptions\": { \"target\": \"ES2022\", \"strict\": true }",
      " 3\t}",
    ].join("\n");
    const result = await extractor("tsconfig").extract(raw, "tsconfig.json");
    assert.ok(result);
    assert.match(result.content, /target=ES2022/);
    assert.match(result.content, /strict=true/);
  });

  it("gives each entry point its own topic key", async () => {
    const a = await extractor("entry_point").extract("export const a = 1;", "src/index.ts", {
      cwd: "/repo",
    });
    const b = await extractor("entry_point").extract("export const b = 1;", "src/main.ts", {
      cwd: "/repo",
    });
    assert.ok(a && b);
    assert.notStrictEqual(a.topicKey, b.topicKey);
    assert.match(a.topicKey, /^project_entry_point_/);
  });

  it("normalizes absolute edit paths to repo-relative keys", async () => {
    const rel = await extractor("edit_event").extract("", "src/app.tsx", { cwd: "/repo" });
    const abs = await extractor("edit_event").extract("", "/repo/src/app.tsx", { cwd: "/repo" });
    assert.ok(rel && abs);
    assert.strictEqual(rel.topicKey, abs.topicKey);
    assert.deepStrictEqual(abs.relatedFiles, ["src/app.tsx"]);
  });
});
