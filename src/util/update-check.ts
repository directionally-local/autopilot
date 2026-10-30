import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserAgent, PACKAGE_NAME } from "./version.js";
import { configPath } from "./app-dirs.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const NPM_REGISTRY = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;

interface CacheEntry {
  checkedAt: number;
  latestVersion: string;
  /** Package the version belongs to — caches written for the old `kimiflare`
   *  package are ignored so they can't mask an autopilot-ai update. */
  name?: string;
}

export interface OptionalDepCheckResult {
  name: string;
  hasUpdate: boolean;
  localVersion: string | null;
  latestVersion: string | null;
}

function cachePath(): string {
  return configPath("update-check.json");
}

async function findPackageJson(startDir: string): Promise<{ path: string; version: string } | null> {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, "package.json");
    try {
      const raw = await readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === PACKAGE_NAME && parsed.version) {
        return { path: candidate, version: parsed.version };
      }
    } catch {
      /* not found or not ours */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function readLocalVersion(): Promise<string | null> {
  const here = dirname(fileURLToPath(import.meta.url));
  const found = await findPackageJson(here);
  return found?.version ?? null;
}

async function readCache(): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(cachePath(), "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.name === PACKAGE_NAME && Date.now() - parsed.checkedAt < CACHE_TTL_MS) {
      return parsed;
    }
  } catch {
    /* cache missing or expired */
  }
  return null;
}

async function writeCache(entry: CacheEntry): Promise<void> {
  const p = cachePath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(entry), "utf8");
}

async function fetchLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(NPM_REGISTRY, {
      headers: { "User-Agent": getUserAgent(), Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

function stripV(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

function isNewer(local: string, remote: string): boolean {
  const a = stripV(local).split(".").map(Number);
  const b = stripV(remote).split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return true;
    if (av > bv) return false;
  }
  return false;
}

async function readOptionalDepVersion(name: string): Promise<string | null> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = join(here, "..", "..", "node_modules", name, "package.json");
    const raw = await readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

async function fetchDistTagVersion(name: string, tag: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/${tag}`, {
      headers: { "User-Agent": getUserAgent(), Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

export async function checkOptionalDependency(
  name: string,
  tag: string,
): Promise<OptionalDepCheckResult> {
  const localVersion = await readOptionalDepVersion(name);
  if (!localVersion) {
    return { name, hasUpdate: false, localVersion: null, latestVersion: null };
  }
  const latestVersion = await fetchDistTagVersion(name, tag);
  if (!latestVersion) {
    return { name, hasUpdate: false, localVersion, latestVersion: null };
  }
  const hasUpdate = isNewer(localVersion, latestVersion);
  return { name, hasUpdate, localVersion, latestVersion };
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  localVersion: string | null;
  latestVersion: string | null;
}

export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
  const localVersion = await readLocalVersion();
  if (!localVersion) return { hasUpdate: false, localVersion: null, latestVersion: null };

  if (!force) {
    const cached = await readCache();
    if (cached) {
      const hasUpdate = isNewer(localVersion, cached.latestVersion);
      return { hasUpdate, localVersion, latestVersion: cached.latestVersion };
    }
  }

  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    return { hasUpdate: false, localVersion, latestVersion: null };
  }

  const hasUpdate = isNewer(localVersion, latestVersion);
  await writeCache({ checkedAt: Date.now(), latestVersion, name: PACKAGE_NAME });
  return { hasUpdate, localVersion, latestVersion };
}


