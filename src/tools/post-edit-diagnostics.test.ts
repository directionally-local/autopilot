import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LspManager } from "../lsp/manager.js";
import type { Diagnostic } from "../lsp/protocol.js";
import { collectPostEditDiagnostics } from "./post-edit-diagnostics.js";

function fakeLsp(diagnostics: Diagnostic[]): LspManager {
  return {
    resolveClientForPath: () => ({ id: "fake", client: { getDiagnostics: () => diagnostics } }),
  } as unknown as LspManager;
}

function diagnostic(severity: number, message: string, line = 0): Diagnostic {
  return {
    severity,
    message,
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
  };
}

describe("collectPostEditDiagnostics", () => {
  it("reports LSP errors and hides warnings by default", async () => {
    const lsp = fakeLsp([diagnostic(1, "Type 'string' is not assignable", 11), diagnostic(2, "unused variable", 3)]);
    const block = await collectPostEditDiagnostics("/repo/src/a.ts", { lsp, cwd: "/repo", lspWaitMs: 0 });
    assert.ok(block);
    assert.match(block!, /<diagnostics path="src\/a\.ts">/);
    assert.match(block!, /error — line 12: Type 'string' is not assignable/);
    assert.doesNotMatch(block!, /unused variable/);
  });

  it("includes warnings when asked", async () => {
    const lsp = fakeLsp([diagnostic(2, "unused variable", 3)]);
    const block = await collectPostEditDiagnostics("/repo/src/a.ts", {
      lsp,
      cwd: "/repo",
      includeWarnings: true,
      lspWaitMs: 0,
    });
    assert.ok(block);
    assert.match(block!, /warning — line 4: unused variable/);
  });

  it("returns undefined when the language server is clean", async () => {
    const lsp = fakeLsp([]);
    assert.equal(await collectPostEditDiagnostics("/repo/src/a.ts", { lsp, lspWaitMs: 0 }), undefined);
  });

  it("caps the number of reported diagnostics", async () => {
    const lsp = fakeLsp(Array.from({ length: 30 }, (_, i) => diagnostic(1, `error ${i}`, i)));
    const block = await collectPostEditDiagnostics("/repo/src/a.ts", { lsp, maxItems: 5, lspWaitMs: 0 });
    assert.ok(block);
    assert.match(block!, /… 25 more/);
    assert.equal(block!.split("\n").filter((l) => l.startsWith("error")).length, 5);
  });

  describe("syntax-check fallback", () => {
    let dir: string;

    it("reports invalid JSON", async () => {
      dir = await mkdtemp(join(tmpdir(), "post-edit-diag-"));
      try {
        const file = join(dir, "bad.json");
        await writeFile(file, "{ nope");
        const block = await collectPostEditDiagnostics(file, { cwd: dir });
        assert.ok(block);
        assert.match(block!, /<diagnostics path="bad\.json">/);
        assert.match(block!, /error —/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("stays quiet for valid JSON", async () => {
      dir = await mkdtemp(join(tmpdir(), "post-edit-diag-"));
      try {
        const file = join(dir, "ok.json");
        await writeFile(file, '{"ok":true}');
        assert.equal(await collectPostEditDiagnostics(file, { cwd: dir }), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("reports JavaScript syntax errors via node --check", async () => {
      dir = await mkdtemp(join(tmpdir(), "post-edit-diag-"));
      try {
        const file = join(dir, "bad.js");
        await writeFile(file, "const x = ;\n");
        const block = await collectPostEditDiagnostics(file, { cwd: dir });
        assert.ok(block);
        assert.match(block!, /SyntaxError/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("stays quiet for valid JavaScript", async () => {
      dir = await mkdtemp(join(tmpdir(), "post-edit-diag-"));
      try {
        const file = join(dir, "ok.js");
        await writeFile(file, "export const x = 1;\n");
        assert.equal(await collectPostEditDiagnostics(file, { cwd: dir }), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("skips languages without a dependency-free checker", async () => {
      dir = await mkdtemp(join(tmpdir(), "post-edit-diag-"));
      try {
        const file = join(dir, "a.ts");
        await writeFile(file, "const x: = 1;\n");
        assert.equal(await collectPostEditDiagnostics(file, { cwd: dir }), undefined);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
