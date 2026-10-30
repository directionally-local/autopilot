import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HotcellProcessRunner } from "./hotcell-worker.js";
import { configPath } from "../util/app-dirs.js";

/**
 * Cache of the subagent runtime (the Autopilot CLI installed for Linux) as a
 * Hotcell workspace backup, one per npm package spec. Installing the CLI in
 * every sandbox costs ~2 minutes of native compilation; restoring a backup
 * takes about a second. Built once per version, on first use, entirely on
 * this machine.
 */

/** Where the cached runtime lives inside a sandbox's /workspace. */
export const CACHED_WORKER_DIR = "/workspace/.autopilot-worker";
const BUILD_TIMEOUT_MS = 600_000;

interface CacheFile {
  [packageSpec: string]: { backupId: string; createdAt: string };
}

export function workerCachePath(): string {
  return configPath("hotcell-worker-cache.json");
}

async function readCache(): Promise<CacheFile> {
  try {
    return JSON.parse(await readFile(workerCachePath(), "utf8")) as CacheFile;
  } catch {
    return {};
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  await mkdir(dirname(workerCachePath()), { recursive: true });
  await writeFile(workerCachePath(), JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
}

/** In-process: one build per package spec, shared by parallel subagents. */
const inflight = new Map<string, Promise<string | null>>();

export interface WorkerCacheOptions {
  packageSpec: string;
  command: string;
  execute: HotcellProcessRunner;
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Backup id of a sandbox workspace with the subagent runtime installed at
 * CACHED_WORKER_DIR, building it if needed. Returns null when it can't be
 * built; callers then install the runtime in the sandbox directly.
 */
export function ensureWorkerBackup(opts: WorkerCacheOptions): Promise<string | null> {
  const existing = inflight.get(opts.packageSpec);
  if (existing) return existing;
  const job = resolveBackup(opts).finally(() => inflight.delete(opts.packageSpec));
  inflight.set(opts.packageSpec, job);
  return job;
}

async function resolveBackup(opts: WorkerCacheOptions): Promise<string | null> {
  const { packageSpec, command, execute, cwd } = opts;
  const cache = await readCache();
  const cached = cache[packageSpec];
  if (cached) {
    const listed = await execute(command, ["backups"], { cwd, timeoutMs: 15_000 }).catch(() => null);
    if (listed && listed.code === 0 && listed.stdout.includes(cached.backupId)) return cached.backupId;
  }

  // Build: a scratch sandbox with only the runtime in /workspace, then back it up.
  let cellId: string | undefined;
  try {
    const created = await execute(command, ["create", "-n", "1", "--name", "autopilot-runtime-build", "--memory", "2048", "--cpus", "2"], {
      cwd, signal: opts.signal, timeoutMs: 120_000,
    });
    cellId = created.stdout.match(/\b[a-f0-9]{8,}(?:-[a-f0-9]{4,}){0,4}\b/gi)?.at(-1);
    if (created.code !== 0 || !cellId) return null;
    const install = await execute(command, [
      "exec", cellId,
      `npm install --prefix ${CACHED_WORKER_DIR} --no-audit --no-fund --loglevel=error '${packageSpec.replace(/'/g, "")}' 1>&2 && ${CACHED_WORKER_DIR}/node_modules/.bin/autopilot --version`,
      "--cwd", "/workspace",
    ], { cwd, signal: opts.signal, timeoutMs: BUILD_TIMEOUT_MS });
    if (install.code !== 0) return null;
    const backup = await execute(command, ["backup", cellId], { cwd, timeoutMs: 120_000 });
    const backupId = parseBackupId(backup.stdout);
    if (backup.code !== 0 || !backupId) return null;
    cache[packageSpec] = { backupId, createdAt: new Date().toISOString() };
    await writeCache(cache);
    return backupId;
  } catch {
    return null;
  } finally {
    if (cellId) await execute(command, ["rm", cellId], { cwd, timeoutMs: 30_000 }).catch(() => undefined);
  }
}

/** `hotcell backup` prints "Backed up <cell> -> <backupId> (<bytes> bytes)." */
export function parseBackupId(output: string): string | undefined {
  return output.match(/->\s*([A-Za-z0-9_-]{6,})/)?.[1];
}

export function _resetWorkerCacheForTests(): void {
  inflight.clear();
}
