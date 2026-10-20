import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, symlink, writeFile, lstat, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool, replaceLiteral } from "./edit.js";
import type { ToolContext } from "./registry.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "edit-tool-"));
}

const FILLER = Array.from({ length: 1200 }, (_, i) => `fn filler_${i}() -> u32 { ${i} }`).join("\n");
const RUST = `${FILLER}
fn a() {
    ALPHA
}
fn b() {
    BETA
}
fn c() {
    GAMMA
}
fn d() {
    DELTA
}
#[cfg(test)]
mod tests {
    #[test]
    fn t() { assert!(true); }
}
`;

describe("edit tool", () => {
  it("replaces a single occurrence and reports it", async () => {
    const dir = await tmp();
    const file = join(dir, "a.txt");
    await writeFile(file, "hello world\n", "utf8");
    const ctx: ToolContext = { cwd: dir };
    const out = await editTool.run({ path: "a.txt", old_string: "world", new_string: "there" }, ctx);
    assert.strictEqual(out, "Replaced 1 occurrence(s) in a.txt.");
    assert.strictEqual(await readFile(file, "utf8"), "hello there\n");
  });

  it("fails on a missing or ambiguous old_string without touching the file", async () => {
    const dir = await tmp();
    const file = join(dir, "a.txt");
    await writeFile(file, "x y x\n", "utf8");
    const ctx: ToolContext = { cwd: dir };
    await assert.rejects(editTool.run({ path: "a.txt", old_string: "nope", new_string: "z" }, ctx), /not found/);
    await assert.rejects(editTool.run({ path: "a.txt", old_string: "x", new_string: "z" }, ctx), /appears 2 times/);
    assert.strictEqual(await readFile(file, "utf8"), "x y x\n");
    const out = await editTool.run({ path: "a.txt", old_string: "x", new_string: "z", replace_all: true }, ctx);
    assert.strictEqual(out, "Replaced 2 occurrence(s) in a.txt.");
    assert.strictEqual(await readFile(file, "utf8"), "z y z\n");
  });

  it("treats $-patterns in new_string literally", async () => {
    const dir = await tmp();
    const file = join(dir, "main.rs");
    await writeFile(file, "fn main() {\n    OLD\n}\n// end\n", "utf8");
    const ctx: ToolContext = { cwd: dir };
    await editTool.run({ path: file, old_string: "OLD", new_string: `let s = "price: $' $& $\` $$ $1";` }, ctx);
    assert.strictEqual(await readFile(file, "utf8"), `fn main() {\n    let s = "price: $' $& $\` $$ $1";\n}\n// end\n`);
  });

  it("keeps every edit when several run concurrently against the same file", async () => {
    const dir = await tmp();
    const file = join(dir, "big.rs");
    const ctx: ToolContext = { cwd: dir };
    const expected = RUST.replace("ALPHA", "let alpha = compute_alpha_value_with_a_very_long_expression_here(1, 2, 3, 4, 5);")
      .replace("BETA", "let b = 2;")
      .replace("GAMMA", 'let gamma = another_long_call("kimi-k2.6 · 18.4k tokens · $0.04", 80);')
      .replace("DELTA", "let d = 4;");
    for (let i = 0; i < 30; i++) {
      await writeFile(file, RUST, "utf8");
      const results = await Promise.all([
        editTool.run({ path: file, old_string: "ALPHA", new_string: "let alpha = compute_alpha_value_with_a_very_long_expression_here(1, 2, 3, 4, 5);" }, ctx),
        editTool.run({ path: file, old_string: "BETA", new_string: "let b = 2;" }, ctx),
        editTool.run({ path: file, old_string: "GAMMA", new_string: 'let gamma = another_long_call("kimi-k2.6 · 18.4k tokens · $0.04", 80);' }, ctx),
        editTool.run({ path: file, old_string: "DELTA", new_string: "let d = 4;" }, ctx),
      ]);
      assert.deepEqual(
        results,
        Array(4).fill(`Replaced 1 occurrence(s) in ${file}.`),
        `iteration ${i}: every call must succeed`,
      );
      assert.strictEqual(await readFile(file, "utf8"), expected, `iteration ${i}: all four edits must persist with no stray tail`);
    }
  });

  it("lets concurrent edits to different files proceed and persist", async () => {
    const dir = await tmp();
    const ctx: ToolContext = { cwd: dir };
    const files = ["one.txt", "two.txt", "three.txt"];
    await Promise.all(files.map((f) => writeFile(join(dir, f), `${f}: TOKEN\n`, "utf8")));
    await Promise.all(files.map((f) => editTool.run({ path: f, old_string: "TOKEN", new_string: "done" }, ctx)));
    for (const f of files) assert.strictEqual(await readFile(join(dir, f), "utf8"), `${f}: done\n`);
  });

  it("writes through a symlink to its target and preserves the file mode", async () => {
    const dir = await tmp();
    const target = join(dir, "real.sh");
    const link = join(dir, "link.sh");
    await writeFile(target, "#!/bin/sh\necho OLD\n", "utf8");
    await chmod(target, 0o755);
    await symlink(target, link);
    const ctx: ToolContext = { cwd: dir };
    await editTool.run({ path: "link.sh", old_string: "OLD", new_string: "NEW" }, ctx);
    assert.ok((await lstat(link)).isSymbolicLink(), "symlink must survive the edit");
    assert.strictEqual(await readFile(target, "utf8"), "#!/bin/sh\necho NEW\n");
    assert.strictEqual((await stat(target)).mode & 0o777, 0o755);
  });
});

describe("replaceLiteral", () => {
  it("replaces first or all occurrences without interpreting $ patterns", () => {
    assert.strictEqual(replaceLiteral("a-b-a", "a", "$&$'", false), "$&$'-b-a");
    assert.strictEqual(replaceLiteral("a-b-a", "a", "$$", true), "$$-b-$$");
    assert.strictEqual(replaceLiteral("abc", "zzz", "y", false), "abc");
  });
});

describe("edit: edits[] (several replacements in one call)", () => {
  const ctxIn = (cwd: string) => ({ cwd, signal: new AbortController().signal }) as unknown as ToolContext;

  it("applies edits in order, each seeing the previous result", async () => {
    const dir = await tmp();
    const file = join(dir, "a.ts");
    await writeFile(file, "const a = 1;\nconst b = 2;\nconst c = a + b;\n");
    const out = await editTool.run(
      {
        path: "a.ts",
        edits: [
          { old_string: "const a = 1;", new_string: "const alpha = 1;" },
          { old_string: "a + b", new_string: "alpha + b" },
          { old_string: "const", new_string: "let", replace_all: true },
        ],
      },
      ctxIn(dir),
    );
    assert.strictEqual(await readFile(file, "utf8"), "let alpha = 1;\nlet b = 2;\nlet c = alpha + b;\n");
    assert.match(String(out), /Applied 3 edits \(5 replacement\(s\)\)/);
  });

  it("is all-or-nothing: a missing or ambiguous old_string writes nothing and names the edit", async () => {
    const dir = await tmp();
    const file = join(dir, "a.ts");
    const before = "x = 1\ny = 1\n";
    await writeFile(file, before);
    await assert.rejects(
      editTool.run({ path: "a.ts", edits: [{ old_string: "x = 1", new_string: "x = 2" }, { old_string: "zzz", new_string: "q" }] }, ctxIn(dir)),
      /edits\[1\]: old_string not found .*after applying the earlier edits.*no changes were written/,
    );
    await assert.rejects(
      editTool.run({ path: "a.ts", edits: [{ old_string: "x", new_string: "X" }, { old_string: "= 1", new_string: "= 3" }] }, ctxIn(dir)),
      /edits\[1\]: old_string appears 2 times/,
    );
    assert.strictEqual(await readFile(file, "utf8"), before);
  });

  it("tolerates schema-filled empty fields next to edits[], applies both real forms, rejects neither", async () => {
    const dir = await tmp();
    const file = join(dir, "a.ts");
    await writeFile(file, "a b c");
    await editTool.run({ path: "a.ts", old_string: "", new_string: "", edits: [{ old_string: "a", new_string: "A" }] }, ctxIn(dir));
    await editTool.run({ path: "a.ts", old_string: null, new_string: null, edits: [{ old_string: "b", new_string: "B" }] } as never, ctxIn(dir));
    await editTool.run({ path: "a.ts", old_string: "A", new_string: "x", edits: [{ old_string: "B", new_string: "y" }] }, ctxIn(dir));
    assert.strictEqual(await readFile(file, "utf8"), "x y c");
    await assert.rejects(editTool.run({ path: "a.ts" }, ctxIn(dir)), /non-empty edits/);
    await assert.rejects(editTool.run({ path: "a.ts", old_string: "", new_string: "z" }, ctxIn(dir)), /non-empty edits/);
  });

  it("renders one permission diff covering every edit", () => {
    const r = editTool.render!({ path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] });
    assert.match(r.title, /\(2 edits\)$/);
    assert.strictEqual(r.diff?.before, "a\n⋯\nc");
    assert.strictEqual(r.diff?.after, "b\n⋯\nd");
  });
});
