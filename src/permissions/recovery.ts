/**
 * Recovery points before destructive file and git actions (autopilot#1125).
 *
 * Before a recoverable or irreversible action runs, Autopilot
 * saves what it would lose, in its own state directory (never inside the
 * project):
 *   - a copy of files about to be deleted or overwritten that git can't
 *     restore (untracked, ignored, or with uncommitted changes), up to a size
 *     limit; above it there is no copy;
 *   - for `git reset --hard`: the old commit, plus a copy of changed files;
 *   - for `git branch -D`: where each branch pointed;
 *   - for a force push or a deleted remote branch: the remote branch's old
 *     commit as of the last fetch.
 *
 * `/undo` restores the latest recovery point for the project and says what
 * it restored. Each point is also a record of the action (what, when, where
 * the copy is), so a person can find it later.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stateDir } from "../util/app-dirs.js";
import type { Finding, RecoveryPlan } from "./destructive.js";

export interface RecoveryManifest {
  version: 1;
  id: string;
  at: string;
  /** Project the action ran in (git top level, or the working directory). */
  project: string;
  tool: string;
  /** The command or tool action. */
  action: string;
  losses: string[];
  /** Saved files: original absolute path → path inside this point's `files/`. */
  files: { path: string; stored: string }[];
  /** Files that couldn't be copied. */
  missed: string[];
  git: {
    head?: { repo: string; sha: string; branch: string | null };
    branches?: { repo: string; name: string; sha: string }[];
    remote?: { repo: string; remote: string; branch: string; sha: string };
  };
  undoneAt?: string;
}

const KEEP_POINTS = 50;
let sequence = 0;

export function recoveryRoot(): string {
  return process.env.AUTOPILOT_RECOVERY_DIR ?? join(stateDir(), "recovery");
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch {
    return null;
  }
}

function gitOrThrow(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } }).trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error((err.stderr || err.message).trim().split("\n").slice(-2).join(" "));
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Save a recovery point for the findings' plans. Returns null when there was
 * nothing to save. Never throws: a failed copy is listed in `missed`.
 */
export function createRecoveryPoint(findings: Finding[], meta: { project: string; tool: string; now?: Date }): RecoveryManifest | null {
  const plans = findings.map((f) => f.plan).filter((p): p is RecoveryPlan => !!p);
  if (plans.length === 0) return null;
  const at = meta.now ?? new Date();
  // Sortable: time, then order within this process, then a random suffix.
  const id = `${at.toISOString().replace(/[:.]/g, "-")}-${String(++sequence).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
  const dir = join(recoveryRoot(), id);
  const m: RecoveryManifest = {
    version: 1,
    id,
    at: at.toISOString(),
    project: meta.project,
    tool: meta.tool,
    action: findings[0]!.action,
    losses: findings.map((f) => f.loss),
    files: [],
    missed: [],
    git: {},
  };
  const seen = new Set<string>();
  const copy = (path: string) => {
    if (seen.has(path)) return;
    seen.add(path);
    const stored = join("files", String(m.files.length));
    try {
      const st = lstatSync(path);
      mkdirSync(join(dir, "files"), { recursive: true, mode: 0o700 });
      if (st.isSymbolicLink()) cpSync(path, join(dir, stored), { verbatimSymlinks: true });
      else if (st.isFile()) copyFileSync(path, join(dir, stored));
      else return;
      m.files.push({ path, stored });
    } catch {
      m.missed.push(path);
    }
  };
  for (const p of plans) {
    switch (p.kind) {
      case "files":
        p.files.forEach(copy);
        break;
      case "git-head": {
        const sha = git(p.repo, ["rev-parse", "HEAD"]);
        if (sha) m.git.head = { repo: p.repo, sha, branch: git(p.repo, ["symbolic-ref", "--short", "-q", "HEAD"]) || null };
        p.files.forEach(copy);
        break;
      }
      case "git-branch":
        for (const name of p.branches) {
          const sha = git(p.repo, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
          if (sha) (m.git.branches ??= []).push({ repo: p.repo, name, sha });
        }
        break;
      case "git-remote": {
        const sha = git(p.repo, ["rev-parse", "--verify", "-q", `refs/remotes/${p.remote}/${p.branch}`]);
        if (sha) m.git.remote = { repo: p.repo, remote: p.remote, branch: p.branch, sha };
        break;
      }
    }
  }
  if (m.files.length === 0 && !m.git.head && !m.git.branches?.length && !m.git.remote) return null;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, "manifest.json.tmp");
    writeFileSync(tmp, JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, join(dir, "manifest.json"));
    prune();
  } catch {
    return null;
  }
  return m;
}

/** One line for the model and the person: what was saved. */
export function describeRecoveryPoint(m: RecoveryManifest): string {
  const parts: string[] = [];
  if (m.files.length) parts.push(`a copy of ${m.files.length === 1 ? "1 file" : `${m.files.length} files`}`);
  if (m.git.head) parts.push(`the previous commit ${shortSha(m.git.head.sha)}`);
  for (const b of m.git.branches ?? []) parts.push(`branch ${b.name} at ${shortSha(b.sha)}`);
  if (m.git.remote) parts.push(`${m.git.remote.remote}/${m.git.remote.branch} at ${shortSha(m.git.remote.sha)}`);
  const missed = m.missed.length ? ` (${m.missed.length} could not be copied)` : "";
  return `Autopilot saved ${parts.join(", ")}${missed} before this ran; /undo puts it back.`;
}

export function listRecoveryPoints(): RecoveryManifest[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(recoveryRoot());
  } catch {
    return [];
  }
  const out: RecoveryManifest[] = [];
  for (const id of ids) {
    try {
      out.push(JSON.parse(readFileSync(join(recoveryRoot(), id, "manifest.json"), "utf8")) as RecoveryManifest);
    } catch {
      /* incomplete or foreign */
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

/** The latest point for `project` that hasn't been undone. */
export function latestRecoveryPoint(project: string): RecoveryManifest | null {
  const root = resolve(project);
  return listRecoveryPoints().find((m) => !m.undoneAt && resolve(m.project) === root) ?? null;
}

function prune(): void {
  const all = listRecoveryPoints();
  for (const m of all.slice(KEEP_POINTS)) {
    try {
      rmSync(join(recoveryRoot(), m.id), { recursive: true, force: true });
    } catch {
      /* next time */
    }
  }
}

function shown(path: string, project: string): string {
  const rel = relative(project, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

/**
 * Restore the latest recovery point for `project`. Returns what was restored,
 * in plain words, or says there is nothing to undo.
 */
export function undoLatest(project: string): string {
  const m = latestRecoveryPoint(project);
  if (!m) return "Nothing to undo: Autopilot has no recovery point for this project.";
  const dir = join(recoveryRoot(), m.id);
  const done: string[] = [];
  const failed: string[] = [];

  // Git first: moving HEAD back must happen before changed files are restored over it.
  if (m.git.head) {
    const { repo, sha, branch } = m.git.head;
    const now = git(repo, ["rev-parse", "HEAD"]);
    const nowBranch = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]) || null;
    if (branch && nowBranch !== branch) failed.push(`didn't move ${branch} back to ${shortSha(sha)}: you're on ${nowBranch ?? "a detached HEAD"} now`);
    else if (now !== sha) {
      try {
        // --keep refuses rather than overwrite local changes made since.
        gitOrThrow(repo, ["reset", "--keep", sha]);
        done.push(`moved ${branch ?? "HEAD"} back to ${shortSha(sha)}`);
      } catch (e) {
        failed.push(`couldn't move ${branch ?? "HEAD"} back to ${shortSha(sha)}: ${(e as Error).message}`);
      }
    }
  }
  for (const b of m.git.branches ?? []) {
    if (git(b.repo, ["rev-parse", "--verify", "-q", `refs/heads/${b.name}`])) {
      failed.push(`branch ${b.name} exists again, so it was left alone (it was at ${shortSha(b.sha)})`);
      continue;
    }
    try {
      gitOrThrow(b.repo, ["branch", b.name, b.sha]);
      done.push(`recreated branch ${b.name} at ${shortSha(b.sha)}`);
    } catch (e) {
      failed.push(`couldn't recreate branch ${b.name}: ${(e as Error).message}`);
    }
  }
  if (m.git.remote) {
    const { repo, remote, branch, sha } = m.git.remote;
    const now = git(repo, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${branch}`]) ?? "";
    try {
      // Only if the remote branch is still what the destructive push left there.
      gitOrThrow(repo, ["push", `--force-with-lease=refs/heads/${branch}:${now}`, remote, `${sha}:refs/heads/${branch}`]);
      done.push(`pushed ${remote}/${branch} back to ${shortSha(sha)}`);
    } catch (e) {
      failed.push(`couldn't push ${remote}/${branch} back to ${shortSha(sha)}: ${(e as Error).message}`);
    }
  }
  let restored = 0;
  for (const f of m.files) {
    try {
      mkdirSync(dirname(f.path), { recursive: true });
      if (existsSync(f.path) || isLink(f.path)) {
        if (lstatSync(f.path).isDirectory()) {
          failed.push(`${shown(f.path, m.project)} is a folder now, so the file wasn't restored`);
          continue;
        }
        rmSync(f.path, { force: true });
      }
      cpSync(join(dir, f.stored), f.path, { verbatimSymlinks: true });
      restored++;
    } catch (e) {
      failed.push(`couldn't restore ${shown(f.path, m.project)}: ${(e as Error).message}`);
    }
  }
  if (restored) {
    const names = m.files.slice(0, 5).map((f) => shown(f.path, m.project)).join(", ");
    done.push(`restored ${restored === 1 ? "1 file" : `${restored} files`} (${names}${m.files.length > 5 ? `, and ${m.files.length - 5} more` : ""})`);
  }
  if (done.length > 0 || failed.length === 0) {
    m.undoneAt = new Date().toISOString();
    try {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n", { mode: 0o600 });
    } catch {
      /* the point stays current */
    }
  }
  const when = new Date(m.at).toLocaleString();
  const head = done.length ? `Undid \`${m.action}\` (${when}): ${done.join("; ")}.` : `Couldn't undo \`${m.action}\` (${when}).`;
  return failed.length ? `${head} Not restored: ${failed.join("; ")}.` : head;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
