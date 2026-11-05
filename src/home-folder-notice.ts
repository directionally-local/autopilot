/**
 * A one-line startup notice when a session starts in the person's home
 * folder: the agent works on whatever folder it starts in, and the home
 * folder is rarely the project they meant. Information only, never a
 * question; shown once per process (the TUI's startup tasks rerun when the
 * config changes) and never in print mode, which doesn't run them.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { launchedByDl, type EnvLike } from "./util/env.js";

export interface HomeFolderDeps {
  cwd?: string;
  home?: string;
  env?: EnvLike;
  realpath?: (p: string) => string;
}

function resolved(path: string, realpath: (p: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

/** The notice when the working folder is the home folder (symlinks resolved), else null. */
export function homeFolderNotice(deps: HomeFolderDeps = {}): string | null {
  const realpath = deps.realpath ?? realpathSync;
  const home = deps.home ?? homedir();
  if (!home) return null;
  const cwd = deps.cwd ?? process.cwd();
  if (resolved(cwd, realpath) !== resolved(home, realpath)) return null;
  const name = launchedByDl(deps.env ?? process.env) ? "dl" : "Autopilot";
  // The info row draws its own "· " bullet.
  return `You're in your home folder. ${name} works best inside a project: cd into one and run ${name} there.`;
}

let shown = false;

/** The notice the first time it applies in this process; null afterwards. */
export function homeFolderNoticeOnce(deps: HomeFolderDeps = {}): string | null {
  if (shown) return null;
  const notice = homeFolderNotice(deps);
  if (notice) shown = true;
  return notice;
}

/** Test hook. */
export function resetHomeFolderNotice(): void {
  shown = false;
}
