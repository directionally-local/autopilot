/**
 * Re-key memories after a repository is moved or renamed.
 *
 * Recall filters by `repo_path`, so rows written under an old checkout path
 * are invisible in the current checkout until they are migrated. (The
 * kimiflare → autopilot rename left 269 of them keyed to
 * `/Users/sinameraji/kimiflare`.) This module plans and applies that move:
 *
 * - `migrateRepoPath` is a dry run by default — it reports the row count and
 *   sample content and writes nothing. A write needs `apply`, and `merge` on
 *   top of that whenever the destination already has rows, so two different
 *   repos are never merged without explicit confirmation.
 * - `detectMigrationCandidates` finds orphaned paths that look like this repo
 *   before a move (same directory name) or a rename (same parent directory),
 *   which `/memory doctor` reports with the exact command to run.
 * - Absolute paths inside `related_files` are rewritten along with
 *   `repo_path`, and the external-content FTS index is re-synced by hand —
 *   updating `memories` does not reindex it.
 */
import { basename, dirname, sep } from "node:path";
import type { SqliteDatabase } from "../util/sqlite.js";
import { computeContentHash, findLiveMemoryByContentHash } from "./db.js";
import type { MemoryCategory } from "./schema.js";

export interface RepoPathCount {
  path: string;
  rows: number;
}

export type MigrationReason = "same-basename" | "same-parent";

export interface MigrationCandidate extends RepoPathCount {
  reason: MigrationReason;
}

export interface RepoMigrationPlan {
  from: string;
  to: string;
  /** Rows keyed to `from` that a write would move. */
  rows: number;
  /** Rows already keyed to `to`; a write would merge into them. */
  targetRows: number;
  /** Sample content from the rows that would move (dry-run preview). */
  samples: string[];
  /** Absolute paths inside `related_files` that start with `from`. */
  relatedFileRewrites: number;
  /** True only after a write actually happened. */
  applied: boolean;
  /** Why a requested write was refused, when it was. */
  blocked?: string;
}

export interface MigrateRepoOptions {
  /** Write the migration. Without it the call is a dry run. */
  apply?: boolean;
  /** Confirm merging into rows the destination already has. */
  merge?: boolean;
  /** How many sample contents the plan reports. Defaults to 5. */
  sampleLimit?: number;
}

const SAMPLE_LIMIT = 5;

interface RawRow {
  rid: number;
  content: string;
  category: string;
  related_files: string;
}

/** Trim whitespace and trailing separators so prefix matching is exact. */
function normalizePath(p: string): string {
  const s = p.trim();
  if (s.length <= 1) return s;
  return s.replace(/[\\/]+$/, "") || s;
}

/** Every `repo_path` in the database with its row count, largest first. */
export function listRepoPaths(db: SqliteDatabase): RepoPathCount[] {
  const rows = db
    .prepare(`SELECT repo_path AS path, COUNT(*) AS n FROM memories GROUP BY repo_path ORDER BY n DESC, path`)
    .all() as Array<{ path: string; n: number }>;
  return rows.map((r) => ({ path: r.path, rows: r.n }));
}

/** How many rows (live or not) are keyed to `path`. */
export function countRepoRows(db: SqliteDatabase, path: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE repo_path = ?`).get(path) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Orphaned paths that look like `currentRoot` before a move or a rename:
 * the same directory name somewhere else, or a sibling under the same parent
 * (the kimiflare → autopilot rename). Candidates are only ever suggestions —
 * applying one still needs the explicit `/memory migrate-repo` command.
 */
export function detectMigrationCandidates(db: SqliteDatabase, currentRoot: string): MigrationCandidate[] {
  const base = basename(currentRoot);
  const parent = dirname(currentRoot);
  const out: MigrationCandidate[] = [];
  for (const { path, rows } of listRepoPaths(db)) {
    if (path === currentRoot) continue;
    if (basename(path) === base) out.push({ path, rows, reason: "same-basename" });
    else if (dirname(path) === parent) out.push({ path, rows, reason: "same-parent" });
  }
  return out;
}

/** Rewrite absolute `related_files` entries that live under `from`. */
function rewriteRelatedFiles(raw: string, from: string, to: string): { json: string; changed: number } {
  let files: unknown;
  try {
    files = JSON.parse(raw);
  } catch {
    return { json: raw, changed: 0 };
  }
  if (!Array.isArray(files)) return { json: raw, changed: 0 };
  const prefix = from.endsWith(sep) ? from : from + sep;
  let changed = 0;
  const next = files.map((f) => {
    if (typeof f !== "string" || !f) return f;
    if (f === from) {
      changed++;
      return to;
    }
    if (f.startsWith(prefix)) {
      changed++;
      return to + f.slice(from.length);
    }
    return f;
  });
  return { json: JSON.stringify(next), changed };
}

/**
 * Plan (and, with `apply`, perform) a `repo_path` migration.
 *
 * Dry run by default: nothing is written, and the plan reports the row count,
 * sample content, and how many `related_files` entries would be rewritten.
 * Throws when the paths are empty or identical.
 */
export function migrateRepoPath(
  db: SqliteDatabase,
  from: string,
  to: string,
  opts: MigrateRepoOptions = {},
): RepoMigrationPlan {
  const src = normalizePath(from);
  const dst = normalizePath(to);
  if (!src) throw new Error("migration source path is empty");
  if (!dst) throw new Error("migration destination path is empty");
  if (src === dst) throw new Error(`source and destination are the same path: ${src}`);

  const rows = db
    .prepare(`SELECT rowid AS rid, content, category, related_files FROM memories WHERE repo_path = ?`)
    .all(src) as RawRow[];

  const targetRows = countRepoRows(db, dst);
  const sampleLimit = opts.sampleLimit ?? SAMPLE_LIMIT;
  let relatedFileRewrites = 0;
  for (const row of rows) {
    relatedFileRewrites += rewriteRelatedFiles(row.related_files, src, dst).changed;
  }

  const plan: RepoMigrationPlan = {
    from: src,
    to: dst,
    rows: rows.length,
    targetRows,
    samples: rows.slice(0, sampleLimit).map((r) => r.content),
    relatedFileRewrites,
    applied: false,
  };

  if (!opts.apply || rows.length === 0) return plan;
  if (targetRows > 0 && !opts.merge) {
    plan.blocked =
      `${targetRows} rows already exist under ${dst}; ` +
      `re-run with --merge to merge them explicitly`;
    return plan;
  }

  applyMigration(db, src, dst, rows);
  plan.applied = true;
  return plan;
}

function applyMigration(db: SqliteDatabase, from: string, to: string, rows: RawRow[]): void {
  const ftsDelete = db.prepare(
    `INSERT INTO memories_fts(memories_fts, rowid, content, category, repo_path) VALUES ('delete', ?, ?, ?, ?)`,
  );
  const ftsInsert = db.prepare(
    `INSERT INTO memories_fts(rowid, content, category, repo_path) VALUES (?, ?, ?, ?)`,
  );
  const update = db.prepare(`UPDATE memories SET repo_path = ?, related_files = ?, content_hash = ? WHERE rowid = ?`);
  const supersede = db.prepare(`UPDATE memories SET superseded_by = ? WHERE rowid = ?`);

  db.transaction(() => {
    for (const row of rows) {
      const { json } = rewriteRelatedFiles(row.related_files, from, to);
      // The hash covers the repo, so re-keying must rehash (#1074). If the
      // destination already holds the same live content (merge), keep one row:
      // the migrating copy is superseded before it can violate the unique index.
      const hash = computeContentHash(row.content, row.category as MemoryCategory, to);
      const clash = findLiveMemoryByContentHash(db, hash);
      if (clash) {
        const clashRow = db.prepare(`SELECT rowid AS rid FROM memories WHERE id = ?`).get(clash.id) as { rid: number } | undefined;
        if (clashRow && clashRow.rid !== row.rid) {
          supersede.run(clash.id, row.rid);
        }
      }
      // `memories_fts` is external content: an UPDATE on `memories` does not
      // reindex it, so drop the old tokens and re-add them with the new path.
      ftsDelete.run(row.rid, row.content, row.category, from);
      update.run(to, json, hash, row.rid);
      ftsInsert.run(row.rid, row.content, row.category, to);
    }
  })();
}

const REASON_TEXT: Record<MigrationReason, string> = {
  "same-basename": "same directory name",
  "same-parent": "same parent directory",
};

/** The dry-run report for `/memory migrate-repo`. */
export function formatMigrationPlan(plan: RepoMigrationPlan): string {
  const lines = [
    `${plan.applied ? "migrated" : "dry run"}: ${plan.from} → ${plan.to}`,
    `  rows: ${plan.rows} keyed to source, ${plan.targetRows} already at destination`,
    `  related_files rewrites: ${plan.relatedFileRewrites}`,
  ];
  if (plan.samples.length > 0) {
    lines.push("  sample content:");
    for (const s of plan.samples) {
      const oneLine = s.replace(/\s+/g, " ").trim();
      lines.push(`    - ${oneLine.length > 100 ? `${oneLine.slice(0, 97)}…` : oneLine}`);
    }
  }
  if (plan.blocked) {
    lines.push(`  blocked: ${plan.blocked}`);
  } else if (!plan.applied) {
    if (plan.rows === 0) {
      lines.push(`  nothing to migrate: no rows under ${plan.from}`);
    } else {
      lines.push(`  run with --apply to write${plan.targetRows > 0 ? " (add --merge to merge into the existing rows)" : ""}`);
    }
  }
  return lines.join("\n");
}

/** The `/memory doctor` report: DB path, current repo, and orphaned candidates. */
export function buildDoctorReport(db: SqliteDatabase, currentRoot: string, dbPath: string): string {
  const currentRows = countRepoRows(db, currentRoot);
  const candidates = detectMigrationCandidates(db, currentRoot);
  const candidatePaths = new Set(candidates.map((c) => c.path));
  const others = listRepoPaths(db).filter((r) => r.path !== currentRoot && !candidatePaths.has(r.path));

  const lines = [
    `memory doctor`,
    `  db: ${dbPath}`,
    `  current repo: ${currentRoot} — ${currentRows} rows`,
  ];
  if (candidates.length > 0) {
    lines.push(`  orphaned candidates:`);
    for (const c of candidates) {
      const merge = currentRows > 0 ? " --merge" : "";
      lines.push(`    ${c.path} — ${c.rows} rows (${REASON_TEXT[c.reason]})`);
      lines.push(`      /memory migrate-repo ${c.path} ${currentRoot} --apply${merge}`);
    }
  } else {
    lines.push(`  no orphaned repo paths detected`);
  }
  if (others.length > 0) {
    lines.push(`  other repo paths in this db:`);
    for (const o of others) lines.push(`    ${o.path} — ${o.rows} rows`);
  }
  return lines.join("\n");
}
