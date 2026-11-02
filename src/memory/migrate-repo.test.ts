import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SqliteDatabase } from "../util/sqlite.js";
import { openMemoryDb, closeMemoryDb, insertMemory, searchMemoriesFts } from "./db.js";
import {
  buildDoctorReport,
  detectMigrationCandidates,
  formatMigrationPlan,
  listRepoPaths,
  migrateRepoPath,
} from "./migrate-repo.js";

const ZERO = new Float32Array(768);

function seed(db: SqliteDatabase, repoPath: string, contents: string[], relatedFiles?: string[]): void {
  for (const content of contents) {
    insertMemory(
      db,
      {
        content,
        category: "fact",
        sourceSessionId: "s1",
        repoPath,
        importance: 3,
        relatedFiles,
      },
      ZERO,
    );
  }
}

function count(db: SqliteDatabase, repoPath: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE repo_path = ?").get(repoPath) as { n: number }).n;
}

describe("memory repo migration", () => {
  let tmpDir: string;
  let db: SqliteDatabase;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "autopilot-migrate-repo-test-"));
    db = openMemoryDb(join(tmpDir, "memory.db"));
  });

  after(async () => {
    closeMemoryDb();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("dry-run reports row count and sample content without writing", () => {
    seed(db, "/dry/old", ["kimiflare stores the build cache here", "release runs on Fridays"]);

    const plan = migrateRepoPath(db, "/dry/old", "/dry/new");
    assert.strictEqual(plan.rows, 2);
    assert.strictEqual(plan.applied, false);
    assert.strictEqual(plan.blocked, undefined);
    assert.strictEqual(plan.samples.length, 2);
    assert.ok(plan.samples[0]!.includes("build cache"));

    // Nothing was written: both rows are still keyed to the old path.
    assert.strictEqual(count(db, "/dry/old"), 2);
    assert.strictEqual(count(db, "/dry/new"), 0);

    const text = formatMigrationPlan(plan);
    assert.ok(text.includes("dry run"));
    assert.ok(text.includes("--apply"), "the dry run tells the user how to write");
    assert.ok(text.includes("sample content"));
  });

  it("dry-run truncates samples to the sample limit", () => {
    seed(db, "/samples/old", ["one", "two", "three", "four", "five", "six"]);
    const plan = migrateRepoPath(db, "/samples/old", "/samples/new", { sampleLimit: 3 });
    assert.strictEqual(plan.rows, 6);
    assert.strictEqual(plan.samples.length, 3);
    assert.strictEqual(plan.applied, false);
    assert.strictEqual(count(db, "/samples/old"), 6);
  });

  it("apply moves rows and rewrites absolute related_files paths", () => {
    seed(db, "/apply/old", ["entry point lives in src/app.tsx"], [
      "/apply/old/src/app.tsx",
      "src/relative.ts",
      "/elsewhere/keep.ts",
    ]);

    const plan = migrateRepoPath(db, "/apply/old", "/apply/new", { apply: true });
    assert.strictEqual(plan.applied, true);
    assert.strictEqual(plan.rows, 1);
    assert.strictEqual(plan.relatedFileRewrites, 1);
    assert.strictEqual(count(db, "/apply/old"), 0);
    assert.strictEqual(count(db, "/apply/new"), 1);

    const row = db.prepare("SELECT repo_path, related_files FROM memories WHERE content = ?").get(
      "entry point lives in src/app.tsx",
    ) as { repo_path: string; related_files: string };
    assert.strictEqual(row.repo_path, "/apply/new");
    // Absolute path under the source moves; relative and unrelated ones stay.
    assert.deepStrictEqual(JSON.parse(row.related_files), [
      "/apply/new/src/app.tsx",
      "src/relative.ts",
      "/elsewhere/keep.ts",
    ]);
  });

  it("keeps FTS recall working and reindexes repo_path tokens", () => {
    seed(db, "/fts/oldside", ["the flibbertigibbet setting controls retries"]);
    const ftsMatch = (q: string) =>
      (db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").all(q) as Array<{ rowid: number }>).length;

    assert.strictEqual(searchMemoriesFts(db, "flibbertigibbet", "/fts/oldside", 10).length, 1);
    assert.strictEqual(ftsMatch('"oldside"*'), 1);
    assert.strictEqual(ftsMatch('"newside"*'), 0);

    migrateRepoPath(db, "/fts/oldside", "/fts/newside", { apply: true });

    // The external-content index is re-synced by hand: old tokens gone, new present.
    assert.strictEqual(ftsMatch('"oldside"*'), 0);
    assert.strictEqual(ftsMatch('"newside"*'), 1);
    assert.strictEqual(searchMemoriesFts(db, "flibbertigibbet", "/fts/newside", 10).length, 1);
    assert.strictEqual(searchMemoriesFts(db, "flibbertigibbet", "/fts/oldside", 10).length, 0);
  });

  it("refuses to merge into an occupied destination without explicit confirmation", () => {
    seed(db, "/merge/src", ["from the old checkout"]);
    seed(db, "/merge/dst", ["already here"]);

    const blocked = migrateRepoPath(db, "/merge/src", "/merge/dst", { apply: true });
    assert.strictEqual(blocked.applied, false);
    assert.ok(blocked.blocked?.includes("--merge"), "blocked message points at --merge");
    assert.strictEqual(count(db, "/merge/src"), 1, "source untouched");
    assert.strictEqual(count(db, "/merge/dst"), 1, "destination untouched");
    assert.ok(formatMigrationPlan(blocked).includes("blocked"));

    const merged = migrateRepoPath(db, "/merge/src", "/merge/dst", { apply: true, merge: true });
    assert.strictEqual(merged.applied, true);
    assert.strictEqual(merged.rows, 1);
    assert.strictEqual(merged.targetRows, 1);
    assert.strictEqual(count(db, "/merge/src"), 0);
    assert.strictEqual(count(db, "/merge/dst"), 2);
  });

  it("rejects empty and identical paths", () => {
    assert.throws(() => migrateRepoPath(db, "", "/x/new"), /source path is empty/);
    assert.throws(() => migrateRepoPath(db, "/x/old", "  "), /destination path is empty/);
    assert.throws(() => migrateRepoPath(db, "/x/same/", "/x/same"), /same path/);
  });

  it("reports nothing to migrate for an unknown source", () => {
    const plan = migrateRepoPath(db, "/never/existed", "/dry/new", { apply: true });
    assert.strictEqual(plan.rows, 0);
    assert.strictEqual(plan.applied, false);
    assert.strictEqual(plan.blocked, undefined);
    assert.ok(formatMigrationPlan(plan).includes("nothing to migrate"));
  });

  it("detects candidates by directory name and by parent directory", () => {
    seed(db, "/d/autopilot", ["current"]);
    seed(db, "/d/kimiflare", ["orphaned by the rename"]);
    seed(db, "/elsewhere/autopilot", ["moved checkout"]);
    seed(db, "/other/unrelated", ["a different project"]);

    const candidates = detectMigrationCandidates(db, "/d/autopilot");
    const byPath = new Map(candidates.map((c) => [c.path, c]));
    assert.strictEqual(byPath.get("/d/kimiflare")?.reason, "same-parent");
    assert.strictEqual(byPath.get("/elsewhere/autopilot")?.reason, "same-basename");
    assert.strictEqual(byPath.has("/other/unrelated"), false);
    assert.strictEqual(byPath.has("/d/autopilot"), false, "the current root is never a candidate");
  });

  it("builds a doctor report that suggests the exact migration command", () => {
    seed(db, "/dr/autopilot", ["current row"]);
    seed(db, "/dr/kimiflare", ["orphaned row"]);

    const report = buildDoctorReport(db, "/dr/autopilot", "/dr/autopilot/.autopilot/memory.db");
    assert.ok(report.includes("/dr/autopilot/.autopilot/memory.db"));
    assert.ok(report.includes("current repo: /dr/autopilot — 1 rows"));
    assert.ok(report.includes("/dr/kimiflare — 1 rows (same parent directory)"));
    // The destination already has rows, so the suggestion confirms the merge.
    assert.ok(report.includes("/memory migrate-repo /dr/kimiflare /dr/autopilot --apply --merge"));
    assert.ok(report.includes("other repo paths"), "unrelated paths are listed separately");
  });

  it("lists repo paths with row counts", () => {
    const paths = listRepoPaths(db);
    const old = paths.find((p) => p.path === "/dry/old");
    assert.ok(old && old.rows === 2);
    assert.ok(paths.every((p, i) => i === 0 || paths[i - 1]!.rows >= p.rows), "sorted by row count");
  });
});
