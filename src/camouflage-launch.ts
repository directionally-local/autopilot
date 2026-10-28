/**
 * Starting the Camouflage renderer, and what happens when it can't start or
 * dies mid-session. The interactive UI has no other renderer: when
 * camouflage-tui is unavailable autopilot says exactly why and how to fix it,
 * and when the renderer crashes the conversation is reopened in a fresh
 * renderer, a bounded number of times.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Platforms camouflage-tui publishes a prebuilt renderer for (its scripts/install.js). */
export const PREBUILT_PLATFORMS: Readonly<Record<string, string>> = {
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export interface RendererDiagnosis {
  platform: string;
  arch: string;
  /** camouflage-tui publishes a prebuilt renderer for this platform. */
  prebuilt: boolean;
  /** Root of the installed camouflage-tui package, or null when it isn't installed. */
  packageDir: string | null;
  packageVersion: string | null;
  /** The package-local renderer the SDK runs (`<packageDir>/bin/camouflage-tui`). */
  packageBin: string | null;
  packageBinExists: boolean;
  /** CAMOUFLAGE_BIN, when set. */
  envBin: string | null;
  /** CAMOUFLAGE_BIN resolved to an executable file. */
  envBinFound: boolean;
  /** Where camouflage-tui's installer saves why its download failed. */
  installErrorPath: string;
  installError: string | null;
}

export interface DiagnoseDeps {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  arch?: string;
  home?: string;
  /** Root of the camouflage-tui package, or null when it can't be resolved. */
  packageDir?: () => string | null;
  isExecutable?: (path: string) => boolean;
  readFile?: (path: string) => string;
}

function defaultPackageDir(): string | null {
  try {
    // The package's exports don't include package.json: resolve its entry
    // point and walk up to the package root.
    let dir = dirname(fileURLToPath(import.meta.resolve("camouflage-tui")));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    return existsSync(join(dir, "package.json")) ? dir : null;
  } catch {
    return null;
  }
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a CAMOUFLAGE_BIN value the way spawn() would: a path as-is, a bare name on PATH. */
function findOnPath(bin: string, env: NodeJS.ProcessEnv, platform: string, isExecutable: (p: string) => boolean): boolean {
  if (isAbsolute(bin) || bin.includes("/") || bin.includes(sep)) return isExecutable(resolve(bin));
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (isExecutable(join(dir, bin + ext))) return true;
  }
  return false;
}

/** Everything that decides whether the renderer can start, read straight from disk. */
export function diagnoseRenderer(deps: DiagnoseDeps = {}): RendererDiagnosis {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const packageDir = (deps.packageDir ?? defaultPackageDir)();
  let packageVersion: string | null = null;
  let packageBin: string | null = null;
  if (packageDir) {
    try {
      packageVersion = (JSON.parse(readFile(join(packageDir, "package.json"))) as { version?: string }).version ?? null;
    } catch {
      // unreadable package.json: the version is just unknown
    }
    packageBin = join(packageDir, "bin", platform === "win32" ? "camouflage-tui.exe" : "camouflage-tui");
  }
  const installErrorPath = join(deps.home ?? homedir(), ".camouflage", "install-error.txt");
  let installError: string | null = null;
  try {
    installError = readFile(installErrorPath).trim() || null;
  } catch {
    // no saved install failure
  }
  const envBin = env.CAMOUFLAGE_BIN || null;
  return {
    platform,
    arch,
    prebuilt: `${platform}-${arch}` in PREBUILT_PLATFORMS,
    packageDir,
    packageVersion,
    packageBin,
    packageBinExists: packageBin ? isExecutable(packageBin) : false,
    envBin,
    envBinFound: envBin ? findOnPath(envBin, env, platform, isExecutable) : false,
    installErrorPath,
    installError,
  };
}

/**
 * Why the renderer certainly can't start, without trying. Null when it can
 * start, or when only the package's own binary is missing on a platform with
 * a prebuilt one: the SDK then downloads it once before giving up.
 */
export function rendererBlocker(d: RendererDiagnosis): string | null {
  if (!d.packageDir) return "the camouflage-tui package is not installed (it may have been skipped as an optional dependency)";
  if (d.envBin) {
    return d.envBinFound ? null : `CAMOUFLAGE_BIN is set to ${d.envBin}, which is not an executable file`;
  }
  if (d.packageBinExists) return null;
  if (!d.prebuilt) return `camouflage-tui has no prebuilt renderer for ${d.platform}-${d.arch}, and none is installed at ${d.packageBin}`;
  return null;
}

/** The renderer couldn't start; nothing has been drawn. `message` is the full explanation for the user. */
export class CamouflageUnavailable extends Error {
  constructor(
    readonly reason: string,
    readonly diagnosis: RendererDiagnosis | null = null,
  ) {
    super(diagnosis ? formatUnavailable(diagnosis, reason) : reason);
  }
}

/** The multi-line error shown when the interactive UI can't start. */
export function formatUnavailable(d: RendererDiagnosis, reason: string): string {
  const platform = `${d.platform}-${d.arch}`;
  const lines = [
    "autopilot: the interactive UI can't start: its terminal renderer (camouflage-tui) is unavailable.",
    "",
    `  Why:       ${reason}`,
    `  Platform:  ${platform}${d.prebuilt ? "" : " (camouflage-tui ships no prebuilt renderer for it)"}`,
    `  Package:   ${d.packageDir ? `camouflage-tui ${d.packageVersion ?? "(unknown version)"} at ${d.packageDir}` : "camouflage-tui is not installed"}`,
  ];
  if (d.envBin) lines.push(`  Renderer:  CAMOUFLAGE_BIN=${d.envBin} (${d.envBinFound ? "found" : "not found or not executable"})`);
  else if (d.packageBin) lines.push(`  Renderer:  ${d.packageBin} (${d.packageBinExists ? "present" : "missing"})`);
  if (d.installError) {
    const attempts = (d.installError.split("\n").filter(Boolean).slice(-1)[0] ?? "").split("; ");
    const more = attempts.length > 1 ? ` (+${attempts.length - 1} more attempts)` : "";
    lines.push(`  Install:   last download failed: ${truncate(attempts[0] ?? "", 240)}${more}`, `             (details in ${d.installErrorPath})`);
  }
  lines.push("", "To fix it:");
  if (d.envBin) lines.push(`  - point CAMOUFLAGE_BIN at an existing camouflage-tui binary, or unset it to use the bundled one`);
  if (d.packageDir) {
    lines.push(
      `  - download the renderer again:  node "${join(d.packageDir, "scripts", "install.js")}"`,
      `    (or run \`npm rebuild camouflage-tui\` where autopilot-ai is installed; \`npm rebuild -g camouflage-tui\` for a global install)`,
    );
  }
  lines.push("  - reinstall autopilot:  npm install -g autopilot-ai");
  if (!d.prebuilt || !d.packageDir) {
    lines.push("  - build the renderer yourself and set CAMOUFLAGE_BIN to it:", "      cargo install --git https://github.com/sinameraji/camouflage camouflage-tui");
  } else if (!d.envBin) {
    lines.push("  - or set CAMOUFLAGE_BIN to a camouflage-tui binary you built (cargo install --git https://github.com/sinameraji/camouflage camouflage-tui)");
  }
  lines.push("", "Print mode works without the renderer:  autopilot -p \"...\"");
  return lines.join("\n") + "\n";
}

/** A one-line reason from a mount() failure; the full diagnosis is printed beside it. */
export function mountFailureReason(message: string): string {
  if (/bundled renderer is missing/.test(message)) {
    return "the renderer binary is missing and downloading it again failed";
  }
  return `the renderer failed to start: ${truncate(message.split("\n")[0] ?? message, 240)}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The renderer exited unexpectedly mid-session (not the user quitting). */
export class CamouflageCrashed extends Error {
  constructor(
    message: string,
    /** The session to reopen in a fresh renderer, if the App had started one. */
    readonly sessionId: string | null,
  ) {
    super(message);
  }
}

export interface RestartPolicy {
  /** Re-mounts allowed within `windowMs` (default 2). */
  maxRestarts?: number;
  /** Default one minute. */
  windowMs?: number;
  now?: () => number;
}

export type RestartOutcome =
  | { gaveUp: false; restarts: number }
  | { gaveUp: true; restarts: number; crashes: number; sessionId: string | null; lastError: CamouflageCrashed };

/**
 * Run the Camouflage view, re-mounting it on the saved session each time the
 * renderer crashes, up to `maxRestarts` times within `windowMs`. Errors other
 * than a crash propagate unchanged.
 */
export async function runWithCrashRestarts(
  run: (resumeSessionId: string | undefined) => Promise<void>,
  opts: RestartPolicy & { onRestart?: (info: { sessionId: string | null; restart: number; error: CamouflageCrashed }) => void } = {},
): Promise<RestartOutcome> {
  const maxRestarts = opts.maxRestarts ?? 2;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  let crashes: number[] = [];
  let sessionId: string | null = null;
  let restarts = 0;
  for (;;) {
    try {
      await run(sessionId ?? undefined);
      return { gaveUp: false, restarts };
    } catch (err) {
      if (!(err instanceof CamouflageCrashed)) throw err;
      // A renderer that dies before the reopened App saved anything still
      // leaves the earlier session to resume.
      sessionId = err.sessionId ?? sessionId;
      const t = now();
      crashes = [...crashes.filter((c) => t - c < windowMs), t];
      if (crashes.length > maxRestarts) {
        return { gaveUp: true, restarts, crashes: crashes.length, sessionId, lastError: err };
      }
      restarts++;
      opts.onRestart?.({ sessionId, restart: restarts, error: err });
    }
  }
}

/** What to tell the user when the renderer keeps crashing. */
export function crashGiveUpMessage(outcome: { crashes: number; sessionId: string | null }, windowMs = 60_000): string {
  const lines = [
    `autopilot: the Camouflage renderer crashed ${outcome.crashes} times within ${Math.round(windowMs / 1000)} seconds, so autopilot stopped restarting it.`,
    `Crash reports: ${join(homedir(), ".camouflage")} (crash-*.txt). Please attach one to an issue: https://github.com/directionally-local/autopilot/issues`,
  ];
  if (outcome.sessionId) {
    lines.push(
      "Your conversation is saved. To pick it up again:",
      `  autopilot            then type /resume and choose it (session ${outcome.sessionId})`,
      `  autopilot -S ${outcome.sessionId} -p "..."   to continue it in print mode`,
    );
  } else {
    lines.push("No conversation had started yet, so nothing was lost.");
  }
  return lines.join("\n") + "\n";
}
