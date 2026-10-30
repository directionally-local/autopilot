/**
 * Every user-level directory Autopilot reads or writes, in one place.
 *
 *   configDir()  ${XDG_CONFIG_HOME:-~/.config}/autopilot      config.json, logs, caches
 *   dataDir()    ${XDG_DATA_HOME:-~/.local/share}/autopilot   sessions, traces, usage, memory
 *   stateDir()   ${XDG_STATE_HOME:-~/.local/state}/autopilot  runs/jobs databases, hook logs
 *   projectDir() <repo>/.autopilot                            per-project files
 *
 * Releases before the rename used `kimiflare` for each of these (and
 * `~/.kimiflare` in the home directory, folded into dataDir).
 * migrateLegacyDirs() moves the user-level ones once at startup and leaves
 * a symlink at the old path, so pinned older binaries keep using the same
 * files. Until that has happened (or when an entry could not be moved),
 * the *Path() helpers read new-then-legacy per entry: the new path when it
 * exists, else the legacy path that exists, else the new path. Nothing
 * here ever creates a legacy directory.
 *
 * Project `.kimiflare/` directories live in users' repositories and are
 * never moved: projectPath() reads `.autopilot/` first and falls back to
 * `.kimiflare/`; new files go to `.autopilot/`.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_DIR_NAME = "autopilot";
const LEGACY_DIR_NAME = "kimiflare";
export const PROJECT_DIR_NAME = ".autopilot";
export const LEGACY_PROJECT_DIR_NAME = ".kimiflare";

type Env = NodeJS.ProcessEnv;

function home(env: Env): string {
  return env.HOME || homedir();
}
function configHome(env: Env): string {
  return env.XDG_CONFIG_HOME?.trim() || join(home(env), ".config");
}
function dataHome(env: Env): string {
  return env.XDG_DATA_HOME?.trim() || join(home(env), ".local", "share");
}
function stateHome(env: Env): string {
  return env.XDG_STATE_HOME?.trim() || join(home(env), ".local", "state");
}

export function configDir(env: Env = process.env): string {
  return join(configHome(env), APP_DIR_NAME);
}
export function dataDir(env: Env = process.env): string {
  return join(dataHome(env), APP_DIR_NAME);
}
export function stateDir(env: Env = process.env): string {
  return join(stateHome(env), APP_DIR_NAME);
}

/** Pre-rename directories, in the order they are read and migrated. */
export function legacyConfigDirs(env: Env = process.env): string[] {
  return [join(configHome(env), LEGACY_DIR_NAME)];
}
export function legacyDataDirs(env: Env = process.env): string[] {
  return [join(dataHome(env), LEGACY_DIR_NAME), join(home(env), `.${LEGACY_DIR_NAME}`)];
}
export function legacyStateDirs(env: Env = process.env): string[] {
  return [join(stateHome(env), LEGACY_DIR_NAME)];
}

function resolveIn(dir: string, legacy: string[], segments: string[]): string {
  const preferred = join(dir, ...segments);
  if (segments.length === 0 || existsSync(preferred)) return preferred;
  for (const old of legacy) {
    const candidate = join(old, ...segments);
    if (existsSync(candidate)) return candidate;
  }
  return preferred;
}

/** A file or directory under configDir(), read new-then-legacy. */
export function configPath(...segments: string[]): string {
  return resolveIn(configDir(), legacyConfigDirs(), segments);
}
/** A file or directory under dataDir(), read new-then-legacy. */
export function dataPath(...segments: string[]): string {
  return resolveIn(dataDir(), legacyDataDirs(), segments);
}
/** A file or directory under stateDir(), read new-then-legacy. */
export function statePath(...segments: string[]): string {
  return resolveIn(stateDir(), legacyStateDirs(), segments);
}

/** `<root>/.autopilot`: where new project files are created. */
export function projectDir(root: string): string {
  return join(root, PROJECT_DIR_NAME);
}
/** `<root>/.kimiflare`: still read, never created. */
export function legacyProjectDir(root: string): string {
  return join(root, LEGACY_PROJECT_DIR_NAME);
}
/** A project file: `.autopilot/…` when it exists, else `.kimiflare/…`
 *  when that exists, else the `.autopilot/…` path (for creating it). */
export function projectPath(root: string, ...segments: string[]): string {
  return resolveIn(projectDir(root), [legacyProjectDir(root)], segments);
}
/** Both project directories that exist, `.autopilot` first. */
export function projectDirsToRead(root: string, ...segments: string[]): string[] {
  return [join(projectDir(root), ...segments), join(legacyProjectDir(root), ...segments)].filter((p) => existsSync(p));
}

// ── One-time migration ───────────────────────────────────────────────────

export interface MigrationReport {
  /** Legacy entries moved into the new directories. */
  moved: Array<{ from: string; to: string }>;
  /** Legacy entries left in place because the new directory already had one. */
  conflicts: Array<{ from: string; to: string }>;
  /** Legacy entries that could not be moved (cross-device, permissions, …). */
  failed: Array<{ from: string; error: string }>;
  /** Legacy directories replaced with a symlink to the new directory. */
  linked: Array<{ from: string; to: string }>;
  /** Legacy directories that had at least one entry moved out. */
  dirs: Array<{ from: string; to: string }>;
}

const LOCK_NAME = ".migrate.lock";
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Create `dir` (mode copied from `like`) and take its migration lock.
 *  Returns a release function, or null when another process holds it. */
function acquireLock(dir: string, like: string): (() => void) | null {
  if (!existsSync(dir)) {
    const mode = statSync(like).mode & 0o777;
    mkdirSync(dir, { recursive: true, mode });
  }
  const lock = join(dir, LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if (code(err) !== "EEXIST") throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) return null;
    sleepSync(25);
  }
}

/** Move each entry of `from` into `to`, recursing into directories both
 *  sides have. Never overwrites: an entry already in `to` stays in `from`. */
function mergeInto(from: string, to: string, report: MigrationReport): void {
  let names: string[];
  try {
    names = readdirSync(from);
  } catch (err) {
    if (code(err) !== "ENOENT") report.failed.push({ from, error: String((err as Error).message) });
    return;
  }
  for (const name of names) {
    const src = join(from, name);
    const dst = join(to, name);
    let dstExists = true;
    try {
      lstatSync(dst);
    } catch {
      dstExists = false;
    }
    if (dstExists) {
      if (isRealDir(src) && isRealDir(dst)) {
        mergeInto(src, dst, report);
        try {
          rmdirSync(src);
        } catch {
          /* not empty: its conflicts are reported */
        }
      } else if (existsSync(src)) {
        report.conflicts.push({ from: src, to: dst });
      }
      continue;
    }
    try {
      renameSync(src, dst);
      report.moved.push({ from: src, to: dst });
    } catch (err) {
      if (code(err) === "ENOENT") continue; // another process moved it
      report.failed.push({ from: src, error: String((err as Error).message) });
    }
  }
}

function migrateOne(legacy: string, target: string, report: MigrationReport): void {
  if (!isRealDir(legacy)) return; // absent, or already a symlink
  const release = acquireLock(target, legacy);
  if (!release) return; // another process is migrating; reads fall back meanwhile
  try {
    if (!isRealDir(legacy)) return;
    const before = report.moved.length;
    mergeInto(legacy, target, report);
    if (report.moved.length > before) report.dirs.push({ from: legacy, to: target });
    if (readdirSync(legacy).length > 0) return; // keep reading new-then-old
    try {
      rmdirSync(legacy);
      symlinkSync(target, legacy, "dir");
      report.linked.push({ from: legacy, to: target });
    } catch {
      /* an older binary recreated it; the next start migrates again */
    }
  } finally {
    release();
  }
}

/**
 * Move every legacy user-level directory into its autopilot counterpart.
 * Cheap and silent when there is nothing to do; never throws.
 */
export function migrateLegacyDirs(env: Env = process.env): MigrationReport {
  const report: MigrationReport = { moved: [], conflicts: [], failed: [], linked: [], dirs: [] };
  const pairs: Array<[string[], string]> = [
    [legacyConfigDirs(env), configDir(env)],
    [legacyDataDirs(env), dataDir(env)],
    [legacyStateDirs(env), stateDir(env)],
  ];
  for (const [legacyDirs, target] of pairs) {
    for (const legacy of legacyDirs) {
      try {
        migrateOne(legacy, target, report);
      } catch (err) {
        report.failed.push({ from: legacy, error: String((err as Error).message) });
      }
    }
  }
  return report;
}

/** The one-time notice for a migration that did something, or null. */
export function migrationNoticeText(report: MigrationReport): string | null {
  if (report.dirs.length === 0 && report.linked.length === 0) return null;
  const pairs = report.dirs.length > 0 ? report.dirs : report.linked;
  const lines = [
    `autopilot: moved ${pairs.map((d) => `${d.from} -> ${d.to}`).join(", ")}` +
      (report.linked.length > 0 ? " (old paths link to the new ones)." : "."),
  ];
  const left = [...report.conflicts.map((c) => c.from), ...report.failed.map((f) => f.from)];
  if (left.length > 0) {
    lines.push(`  Left in place (already present in the new folder, or could not be moved): ${left.join(", ")}`);
  }
  return lines.join("\n");
}
