import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserAgent, PACKAGE_NAME } from "./version.js";
import { configPath } from "./app-dirs.js";
import { launchedByDl, type EnvLike } from "./env.js";
import { DL_PACKAGE_NAME, dlUpdateCommand, dlVersion } from "./dl-identity.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
/** A registry that doesn't answer in this long counts as "couldn't check". */
const FETCH_TIMEOUT_MS = 5000;

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

function cachePath(name: string = PACKAGE_NAME): string {
  // dl's latest version is cached on its own, so the two never mask each other.
  return configPath(name === PACKAGE_NAME ? "update-check.json" : "update-check-dl.json");
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

async function readCache(name: string = PACKAGE_NAME): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(cachePath(name), "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.name === name && Date.now() - parsed.checkedAt < CACHE_TTL_MS) {
      return parsed;
    }
  } catch {
    /* cache missing or expired */
  }
  return null;
}

async function writeCache(entry: CacheEntry): Promise<void> {
  const p = cachePath(entry.name);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(entry), "utf8");
}

async function fetchLatestVersion(name: string = PACKAGE_NAME): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
      headers: { "User-Agent": getUserAgent(), Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  /** Which product the versions belong to: "dl" when dl started this process. Absent means autopilot. */
  product?: "autopilot" | "dl";
}

export interface UpdateCheckDeps {
  env?: EnvLike;
  /** The running dl's version (tests replace it). */
  dlVersion?: () => string | null;
  /** npm's latest version of a package, null when it can't be read (tests replace it). */
  fetchLatest?: (name: string) => Promise<string | null>;
}

/**
 * Started by dl, the update that matters is dl's: it pins Autopilot, so a newer
 * autopilot-ai on npm means nothing to this person. Compares the running dl with
 * npm's latest `directionallylocal`; an unknown dl version never reports one.
 */
async function checkForDlUpdate(force: boolean, deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const env = deps.env ?? process.env;
  const localVersion = (deps.dlVersion ?? (() => dlVersion({ env })))();
  if (!localVersion) return { hasUpdate: false, localVersion: null, latestVersion: null, product: "dl" };
  if (!force) {
    const cached = await readCache(DL_PACKAGE_NAME);
    if (cached) return { hasUpdate: isNewer(localVersion, cached.latestVersion), localVersion, latestVersion: cached.latestVersion, product: "dl" };
  }
  const latestVersion = await (deps.fetchLatest ?? fetchLatestVersion)(DL_PACKAGE_NAME);
  if (!latestVersion) return { hasUpdate: false, localVersion, latestVersion: null, product: "dl" };
  await writeCache({ checkedAt: Date.now(), latestVersion, name: DL_PACKAGE_NAME }).catch(() => undefined);
  return { hasUpdate: isNewer(localVersion, latestVersion), localVersion, latestVersion, product: "dl" };
}

export async function checkForUpdate(force = false, deps: UpdateCheckDeps = {}): Promise<UpdateCheckResult> {
  if (launchedByDl(deps.env ?? process.env)) return checkForDlUpdate(force, deps);
  const localVersion = await readLocalVersion();
  if (!localVersion) return { hasUpdate: false, localVersion: null, latestVersion: null };

  if (!force) {
    const cached = await readCache();
    if (cached) {
      const hasUpdate = isNewer(localVersion, cached.latestVersion);
      return { hasUpdate, localVersion, latestVersion: cached.latestVersion };
    }
  }

  const latestVersion = await (deps.fetchLatest ?? fetchLatestVersion)(PACKAGE_NAME);
  if (!latestVersion) {
    return { hasUpdate: false, localVersion, latestVersion: null };
  }

  const hasUpdate = isNewer(localVersion, latestVersion);
  await writeCache({ checkedAt: Date.now(), latestVersion, name: PACKAGE_NAME });
  return { hasUpdate, localVersion, latestVersion };
}

/**
 * The lines an update check shows. `explicit` is `/update` (asked for), which
 * always answers; the startup and periodic checks show something only when
 * there is an update.
 */
export function updateNotice(result: UpdateCheckResult, o: { explicit?: boolean; env?: EnvLike; updateCommand?: () => string } = {}): string[] {
  if (result.product === "dl") {
    const cmd = (o.updateCommand ?? (() => dlUpdateCommand({ env: o.env ?? process.env })))();
    if (result.hasUpdate) return [`dl ${result.latestVersion} is out (this is ${result.localVersion}) · run:  ${cmd}`];
    if (!o.explicit) return [];
    if (!result.localVersion) return [`To get the latest dl, run:  ${cmd}`];
    if (!result.latestVersion) return [`couldn't check for a newer dl · to update dl, run:  ${cmd}`];
    return [`dl ${result.localVersion} is up to date`];
  }
  if (result.hasUpdate) {
    return [`update available: ${result.localVersion} → ${result.latestVersion}`, "run:  npm i -g autopilot-ai@latest  then restart"];
  }
  return o.explicit ? ["no update available"] : [];
}
