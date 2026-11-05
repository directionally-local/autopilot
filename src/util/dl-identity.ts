import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchedByDl, type EnvLike } from "./env.js";
import { getAppVersion } from "./version.js";

/**
 * What the person sees when `dl` started this process (AUTOPILOT_LAUNCHED_BY=dl).
 * dl users only know the product as dl: it installs a pinned Autopilot privately
 * and runs it, so headers name dl and its version, and update advice names the
 * command that updates dl (never `npm i -g autopilot-ai`, a copy dl wouldn't use).
 */

/** dl's npm package. */
export const DL_PACKAGE_NAME = "directionallylocal";

/** dl's own update commands, by how dl was installed (mirrors installer src/install-method.ts). */
export const DL_SCRIPT_UPDATE = "curl -fsSL https://directionallylocal.run | sh";
export const DL_SERVER_UPDATE = "curl -fsSL https://directionallylocal.run | sudo sh";
export const DL_NPM_UPDATE = "npm install -g directionallylocal";
const DL_SERVER_STATE = "/etc/directionallylocal/state.json";

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** dl's package directory and version, when Autopilot is installed inside (or beside) it. */
export interface DlPackage {
  root: string;
  version: string;
}

function readDlManifest(path: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
    return pkg.name === DL_PACKAGE_NAME && typeof pkg.version === "string" && VERSION_RE.test(pkg.version) ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Walks up from `startDir` (Autopilot's own files) to dl's package.json:
 * nested (`…/directionallylocal/node_modules/autopilot-ai/…`: a parent dir is
 * dl's package) or hoisted (`…/node_modules/autopilot-ai/…`: a sibling
 * `node_modules/directionallylocal`).
 */
export function findDlPackage(startDir: string = dirname(fileURLToPath(import.meta.url))): DlPackage | null {
  let dir = startDir;
  for (;;) {
    const own = readDlManifest(join(dir, "package.json"));
    if (own) return { root: dir, version: own };
    const siblingRoot = join(dir, "node_modules", DL_PACKAGE_NAME);
    const sibling = readDlManifest(join(siblingRoot, "package.json"));
    if (sibling) return { root: siblingRoot, version: sibling };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

let cachedPackage: DlPackage | null | undefined;

function dlPackage(): DlPackage | null {
  if (cachedPackage === undefined) cachedPackage = findDlPackage();
  return cachedPackage;
}

/** Test hook: forget the resolved dl package. */
export function resetDlPackageCache(): void {
  cachedPackage = undefined;
}

export interface DlLookup {
  env?: EnvLike;
  /** Replaces the package lookup (tests). */
  findPackage?: () => DlPackage | null;
}

/** The running dl's version: DL_VERSION when dl sets it, else dl's package.json; null when neither is found. */
export function dlVersion(o: DlLookup = {}): string | null {
  const env = o.env ?? process.env;
  const fromEnv = env.DL_VERSION?.trim();
  if (fromEnv && VERSION_RE.test(fromEnv)) return fromEnv.replace(/^v/, "");
  return (o.findPackage ?? dlPackage)()?.version ?? null;
}

/** The product name the person knows: "dl" under dl, else "autopilot". */
export function productName(env: EnvLike = process.env): string {
  return launchedByDl(env) ? "dl" : "autopilot";
}

/** The header's first line: "dl 0.14.1" (or "dl") under dl, "autopilot 3.9.0" otherwise. */
export function headerTitle(autopilotVersion: string = getAppVersion(), o: DlLookup = {}): string {
  const env = o.env ?? process.env;
  if (!launchedByDl(env)) return `autopilot ${autopilotVersion}`;
  const v = dlVersion(o);
  return v ? `dl ${v}` : "dl";
}

/** `--version`: "dl 0.14.1 (autopilot 3.9.0)" under dl, the bare Autopilot version otherwise. */
export function versionText(autopilotVersion: string = getAppVersion(), o: DlLookup = {}): string {
  const env = o.env ?? process.env;
  if (!launchedByDl(env)) return autopilotVersion;
  const v = dlVersion(o);
  return `${v ? `dl ${v}` : "dl"} (autopilot ${autopilotVersion})`;
}

export interface DlInstallFacts {
  env: EnvLike;
  packageRoot: string | null;
  platform: NodeJS.Platform;
  uid: number | undefined;
  exists: (path: string) => boolean;
}

/**
 * The command that updates dl itself. `dl update` doesn't: it reinstalls the
 * Autopilot the current dl pins. DL_UPDATE_COMMAND (set by dl) wins; otherwise
 * it's worked out the way dl does: the install script's layout, a server, or npm.
 */
export function dlUpdateCommand(facts: Partial<DlInstallFacts> = {}): string {
  const env = facts.env ?? process.env;
  const fromEnv = env.DL_UPDATE_COMMAND?.trim();
  if (fromEnv && !/[\n\r]/.test(fromEnv)) return fromEnv;
  const root = facts.packageRoot !== undefined ? facts.packageRoot : (dlPackage()?.root ?? null);
  // Not found: the install script is how dl is installed.
  if (root === null) return DL_SCRIPT_UPDATE;
  if (/\/dl\/lib\/node_modules\/directionallylocal\/?$/.test(root)) return DL_SCRIPT_UPDATE;
  const platform = facts.platform ?? process.platform;
  const uid = facts.uid !== undefined ? facts.uid : process.getuid?.();
  const exists = facts.exists ?? existsSync;
  if (platform === "linux" && (uid === 0 || exists(DL_SERVER_STATE))) return DL_SERVER_UPDATE;
  return DL_NPM_UPDATE;
}
