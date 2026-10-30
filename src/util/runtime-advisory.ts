import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./app-dirs.js";

/**
 * CVE-2026-111497 ("Node2Shell"): an out-of-bounds write in the Brotli
 * decoder bundled with Node.js and Bun. Node's fetch() decodes a
 * `Content-Encoding: br` response with it, so a malicious server can run
 * code in the process that fetches from it. web_fetch fetches URLs the model
 * picks, which a prompt injection can point anywhere.
 *
 * Fixed in Node 22.23.4, 24.22.1 and 26.12.1 and in Bun 1.4.4. Node 20 and
 * older, 23 and 25 are end of life and get no fix.
 */
const NODE_FIXED: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const BUN_FIXED: [number, number, number] = [1, 4, 4];

export const ALLOW_VULNERABLE_RUNTIME_ENV = "AUTOPILOT_ALLOW_VULNERABLE_RUNTIME";

function parse(version: string): number[] {
  return version.replace(/^v/, "").split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
}

function below(version: number[], fixed: number[]): boolean {
  for (let i = 0; i < fixed.length; i++) {
    const a = version[i] ?? 0;
    const b = fixed[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/**
 * Why this runtime is exposed to CVE-2026-111497, or null when it is fixed.
 * Node lines newer than the newest fixed one (27+) are treated as fixed.
 */
export function brotliRuntimeAdvisory(versions: NodeJS.ProcessVersions = process.versions): string | null {
  const bun = (versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  if (bun) {
    return below(parse(bun), BUN_FIXED)
      ? `Bun ${bun} has the Brotli decoder bug CVE-2026-111497 (remote code execution via a compressed response). Upgrade to Bun 1.4.4 or later.`
      : null;
  }
  const [major = 0, minor = 0, patch = 0] = parse(versions.node);
  const fixed = NODE_FIXED[major];
  const newest = Math.max(...Object.keys(NODE_FIXED).map(Number));
  if (major > newest) return null;
  if (fixed && !below([minor, patch], fixed)) return null;
  const upgrade = fixed
    ? `Upgrade to Node ${major}.${fixed[0]}.${fixed[1]} or later.`
    : `Node ${major} gets no fix; upgrade to Node 22.23.4, 24.22.1 or 26.12.1 or later.`;
  return `Node ${versions.node} has the Brotli decoder bug CVE-2026-111497 (remote code execution via a compressed response). ${upgrade}`;
}

/**
 * Throws before a tool fetches from a server the model chose, on a runtime
 * that is exposed. Setting AUTOPILOT_ALLOW_VULNERABLE_RUNTIME=1 accepts the risk.
 */
export function assertSafeRuntimeForUntrustedFetch(tool: string): void {
  if (process.env[ALLOW_VULNERABLE_RUNTIME_ENV] === "1") return;
  const advisory = brotliRuntimeAdvisory();
  if (!advisory) return;
  throw new Error(`${tool} is disabled on this runtime. ${advisory} (Set ${ALLOW_VULNERABLE_RUNTIME_ENV}=1 to fetch anyway.)`);
}

/** Warn at most once a day, so a long-lived shell does not repeat it every run. */
const WARN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function warnCachePath(): string {
  return configPath("runtime-advisory.json");
}

export interface WarnRuntimeAdvisoryOptions {
  now?: number;
  /** Override the cache file (tests). */
  cachePath?: string;
  /** Where the warning goes. Default: stderr. */
  write?: (text: string) => void;
}

/**
 * Print the startup advisory once per day. The fetch guard still throws on
 * every call; only the startup notice is rate-limited.
 */
export async function warnRuntimeAdvisoryOncePerDay(
  advisory: string | null = brotliRuntimeAdvisory(),
  opts: WarnRuntimeAdvisoryOptions = {},
): Promise<void> {
  if (!advisory) return;
  const now = opts.now ?? Date.now();
  const path = opts.cachePath ?? warnCachePath();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { warnedAt?: number; advisory?: string };
    if (parsed.advisory === advisory && typeof parsed.warnedAt === "number" && now - parsed.warnedAt < WARN_CACHE_TTL_MS) {
      return;
    }
  } catch {
    /* no cache yet */
  }
  (opts.write ?? ((text) => process.stderr.write(text)))(`warning: ${advisory} web_fetch is disabled until then.\n`);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ warnedAt: now, advisory }), "utf8");
  } catch {
    /* best-effort: a read-only config dir must not break startup */
  }
}
