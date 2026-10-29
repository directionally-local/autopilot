/**
 * Session worktrees (#962): an interactive session in a git repository makes
 * its code changes in a git worktree of its own, never in the user's
 * checkout. The worktree is created lazily, on the session's first mutating
 * tool call (write, edit, or a bash / job_start command that is not
 * provably read-only); from then on every tool call of the session runs
 * there. Read-only sessions never create one.
 *
 * Worktrees live outside the repository, next to the unattended-run
 * worktrees (src/runs/worktrees.ts): one nested in the checkout would show up
 * in the user's `git status` and in every tool that walks the tree (test
 * runners, linters, search).
 */
import { randomBytes, createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isReadOnlyBash } from "../mode.js";
import { defaultWorktreesDir, isWithin, runGit } from "./worktrees.js";

/** Where session worktrees are created, grouped per repository. */
export function defaultSessionWorktreesDir(): string {
  return join(defaultWorktreesDir(), "sessions");
}

/** Branches of session worktrees: `autopilot/<slug>`. */
export const SESSION_BRANCH_PREFIX = "autopilot/";

/** Metadata kept in the worktree's git admin dir (never in its working tree). */
const META_FILE = "autopilot-session.json";

/** Untracked files larger than this (in total) are not copied into a new worktree. */
const MAX_CARRY_BYTES = 50 * 1024 * 1024;

export interface SessionWorktreeInfo {
  /** Short name, also the last path segment: `20261029-a1b2c3`. */
  name: string;
  /** Root of the worktree. */
  path: string;
  /** The session's cwd inside the worktree (the source subdirectory, for monorepos). */
  cwd: string;
  branch: string;
  /** Top level of the user's checkout. */
  sourceRoot: string;
  /** Commit the branch started from. */
  baseCommit: string;
  /** Human description of the base, for the notices. */
  baseLabel: string;
  sessionId?: string;
}

interface SessionMeta {
  sessionId?: string;
  sourceRoot: string;
  baseCommit: string;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * True for a tool call that can change files in the workspace. Conservative
 * for shell commands: anything the permission system would not call
 * read-only counts as mutating. File tools count only when the target is
 * inside `root` (writing a scratch file in /tmp needs no worktree).
 */
export function isMutatingToolCall(name: string, args: Record<string, unknown>, cwd: string, root: string): boolean {
  if (name === "write" || name === "edit") {
    if (typeof args.path !== "string") return false;
    return isWithin(root, resolve(cwd, args.path));
  }
  if (name === "bash" || name === "job_start") {
    return typeof args.command === "string" && args.command.trim() !== "" && !isReadOnlyBash(args.command);
  }
  return false;
}

/**
 * True when the user's message asks to work directly in their checkout
 * ("work in place", "don't use a worktree", "edit my working copy").
 */
export function asksToWorkInPlace(text: string): boolean {
  return (
    // "work in place", "edit it in-place" — not "fix the in-place sort".
    /\b(?:work|edit|chang|fix|do|make|apply|commit|stay)\w*\b[^.?!\n]{0,40}?\bin[- ]place\b(?![- ](?:sort|update|edit|mutation|algorithm|operation|replace)s?\b)/i.test(text) ||
    /\b(?:no|without(?: a| using a)?|don'?t use(?: a)?|do not use(?: a)?|skip(?: the)?)\s+worktrees?\b/i.test(text) ||
    /\b(?:in|on) (?:this|the current|my) (?:checkout|working (?:tree|copy|directory))\b/i.test(text)
  );
}

export interface SessionWorktreeOptions {
  /** Directory the session was started in. */
  sourceCwd: string;
  /** Read on every call, so a /settings change applies to the next session's first mutation. */
  enabled: () => boolean;
  /** Current session id; a worktree belongs to one session (resuming it reattaches). */
  sessionId?: () => string | null | undefined;
  /** Shown to the user in the transcript. */
  onNotice?: (text: string) => void;
  /** Override the worktree root (tests). */
  rootDir?: string;
  /** Upper bound for refreshing the default branch from origin. Default 20 s. */
  fetchTimeoutMs?: number;
}

export interface RoutedCall {
  cwd: string;
  args: Record<string, unknown>;
  /** One-time note for the model, prepended to the tool result that created the worktree. */
  notice?: string;
}

const live = new Set<SessionWorktree>();

/** Per-session controller. Hosts create one and hand it to every tool call via ToolContext. */
export class SessionWorktree {
  private info: SessionWorktreeInfo | null = null;
  /** Why this session works in place, once decided (not a repo, setting off, asked, failed). */
  private inPlace: string | null = null;
  private creating: Promise<void> | null = null;
  private lastTouch = 0;
  private prNoticeShown = false;

  constructor(private readonly opts: SessionWorktreeOptions) {
    live.add(this);
  }

  get active(): SessionWorktreeInfo | null {
    this.dropIfOtherSession();
    return this.info;
  }

  get rootDir(): string {
    return resolve(this.opts.rootDir ?? defaultSessionWorktreesDir());
  }

  /** Keep this session in the user's checkout. No effect once a worktree is in use. */
  workInPlace(reason: string): boolean {
    if (this.active) return false;
    this.inPlace = reason;
    return true;
  }

  /** Let a session that was kept in place use a worktree again. */
  allowWorktree(): void {
    if (!this.info) this.inPlace = null;
  }

  /** Inspect a user message before its turn: honour "work in place" requests. */
  noteUserMessage(text: string): void {
    if (this.active || this.inPlace) return;
    if (asksToWorkInPlace(text) && this.workInPlace("asked to work in place")) {
      this.opts.onNotice?.(`Working in place in ${this.opts.sourceCwd} for this session, as asked (no worktree).`);
    }
  }

  /**
   * Map a tool call onto the session worktree: create it when this is the
   * first mutating call, then rewrite the cwd and any absolute paths that
   * point into the user's checkout.
   */
  async route(name: string, args: Record<string, unknown>, cwd: string): Promise<RoutedCall> {
    let notice: string | undefined;
    if (!this.active && !this.inPlace && this.opts.enabled()) {
      this.sourceRoot ??= gitTopLevel(this.opts.sourceCwd);
      const sourceRoot = await this.sourceRoot;
      if (!sourceRoot) {
        this.inPlace = "not a git repository";
      } else if (isMutatingToolCall(name, args, cwd, sourceRoot)) {
        if (!this.creating) this.creating = this.create(sourceRoot).finally(() => (this.creating = null));
        await this.creating;
        notice = this.pendingModelNotice ?? undefined;
        this.pendingModelNotice = null;
      }
    }
    const info = this.info;
    if (!info) return { cwd, args };
    this.touch(info);
    return { cwd: remapPath(cwd, info), args: remapArgs(name, args, info), ...(notice ? { notice } : {}) };
  }

  /**
   * Files read in the checkout before the switch count as read in the
   * worktree: the edit/write staleness check compares content hashes, so a
   * file whose worktree copy differs is still caught.
   */
  carryReadSnapshots(snapshots: Map<string, string>): void {
    const info = this.info;
    if (!info) return;
    for (const [key, hash] of [...snapshots]) {
      const mapped = remapPath(key, info);
      if (mapped !== key && !snapshots.has(mapped)) snapshots.set(mapped, hash);
    }
  }

  /** After a tool ran: point at cleanup once a PR has been opened from the worktree. */
  afterTool(name: string, args: Record<string, unknown>, ok: boolean): void {
    const info = this.info;
    if (!info || !ok || this.prNoticeShown) return;
    const opensPr =
      name === "github_create_pr" ||
      (name === "bash" && typeof args.command === "string" && /\bgh\s+pr\s+create\b/.test(args.command));
    if (!opensPr) return;
    this.prNoticeShown = true;
    this.opts.onNotice?.(
      `PR opened from worktree ${info.path} (branch ${info.branch}). It is kept for follow-up changes; ` +
        `when you are done, remove it with /worktrees remove ${info.name} (or /worktrees clean for every clean one).`,
    );
  }

  /**
   * End of the session (/clear, exit): detach and return a cleanup offer for
   * the worktree it used, or null when it used none. Never deletes anything.
   */
  async release(): Promise<string | null> {
    const info = this.info;
    this.info = null;
    this.inPlace = null;
    this.boundSession = undefined;
    this.prNoticeShown = false;
    if (!info) return null;
    return cleanupOffer(info, this.rootDir);
  }

  /** Forget the worktree without touching it (it was removed, or the session changed). */
  detach(): void {
    this.info = null;
    this.prNoticeShown = false;
  }

  /** Stop tracking this controller for exit notes. */
  dispose(): void {
    live.delete(this);
  }

  /** Session the current decision (worktree or in place) was made for. */
  private boundSession: string | undefined;
  private pendingModelNotice: string | null = null;
  private sourceRoot: Promise<string | null> | undefined;

  /** A resumed or new session starts over: its own worktree, or none yet. */
  private dropIfOtherSession(): void {
    const current = this.opts.sessionId?.() ?? undefined;
    if (!current || current === this.boundSession) return;
    if (this.boundSession !== undefined) {
      this.detach();
      this.inPlace = null;
    }
    this.boundSession = current;
  }

  private touch(info: SessionWorktreeInfo): void {
    const now = Date.now();
    if (now - this.lastTouch < 30_000) return;
    this.lastTouch = now;
    void updateMeta(info.path, { lastUsedAt: now }).catch(() => undefined);
  }

  private async create(sourceRoot: string): Promise<void> {
    const sessionId = this.opts.sessionId?.() ?? undefined;
    try {
      const reused = sessionId ? await this.findForSession(sourceRoot, sessionId) : null;
      if (reused) {
        this.info = reused;
        this.pendingModelNotice =
          `[autopilot] This session works in its git worktree ${reused.cwd} (branch ${reused.branch}); ` +
          `the user's checkout at ${sourceRoot} stays untouched. Every tool call runs there.`;
        this.opts.onNotice?.(`Continuing in worktree ${reused.path} (branch ${reused.branch}); your checkout at ${sourceRoot} is not modified.`);
        return;
      }
      const skip = await this.skipReason(sourceRoot);
      if (skip) {
        this.inPlace = skip;
        this.opts.onNotice?.(`Working in place in ${this.opts.sourceCwd}: ${skip}.`);
        return;
      }
      const { info, carried } = await createSessionWorktree({
        sourceCwd: this.opts.sourceCwd,
        sourceRoot,
        rootDir: this.rootDir,
        sessionId,
        fetchTimeoutMs: this.opts.fetchTimeoutMs ?? 20_000,
      });
      this.info = info;
      this.pendingModelNotice = modelNotice(info, carried);
      this.opts.onNotice?.(userNotice(info, carried));
    } catch (error) {
      this.inPlace = "worktree creation failed";
      const message = error instanceof Error ? error.message : String(error);
      this.opts.onNotice?.(`Could not create an isolated worktree (${message}); working in place in ${this.opts.sourceCwd}.`);
    }
  }

  private async skipReason(sourceRoot: string): Promise<string | null> {
    const source = await realpath(this.opts.sourceCwd);
    for (const root of [this.rootDir, defaultWorktreesDir()]) {
      if (isWithin(await realpathOr(root), source)) return "this directory is already an Autopilot worktree";
    }
    if (isWithin(sourceRoot, this.rootDir)) return "the worktree directory would be inside this repository";
    if (!(await gitOk(["rev-parse", "--verify", "--quiet", "HEAD"], sourceRoot))) return "the repository has no commits yet";
    const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], sourceRoot);
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-merge", "rebase-apply"]) {
      if (await exists(join(gitDir, marker))) return "a merge, rebase, cherry-pick or bisect is in progress in your checkout";
    }
    return null;
  }

  private async findForSession(sourceRoot: string, sessionId: string): Promise<SessionWorktreeInfo | null> {
    const listed = await listSessionWorktrees(sourceRoot, this.rootDir);
    const match = listed.find((w) => w.sessionId === sessionId && !w.missing);
    if (!match) return null;
    const meta = await readMeta(match.path);
    const rel = relative(sourceRoot, await realpath(this.opts.sourceCwd));
    return {
      name: match.name,
      path: match.path,
      cwd: rel ? join(match.path, rel) : match.path,
      branch: match.branch,
      sourceRoot,
      baseCommit: meta?.baseCommit ?? "",
      baseLabel: "an earlier turn of this session",
      sessionId,
    };
  }
}

/** Cleanup offers for every session worktree still attached at exit. */
export async function sessionWorktreeExitNotes(): Promise<string[]> {
  const notes: string[] = [];
  for (const controller of live) {
    const note = await controller.release().catch(() => null);
    // A renderer restart remounts the app: two controllers can hold one worktree.
    if (note && !notes.includes(note)) notes.push(note);
  }
  return notes;
}

// ── Creation ─────────────────────────────────────────────────────────────

interface CarryOver {
  trackedChanges: boolean;
  /** Untracked (not ignored) files copied over. */
  untracked: number;
  /** Untracked files left behind because of the size cap. */
  skipped: number;
  /** Ignored `.env` files copied over. */
  envFiles: string[];
  /** Set when the uncommitted tracked changes could not be applied. */
  applyError?: string;
}

function emptyCarryOver(): CarryOver {
  return { trackedChanges: false, untracked: 0, skipped: 0, envFiles: [] };
}

export interface CreateSessionWorktreeOptions {
  sourceCwd: string;
  sourceRoot: string;
  rootDir: string;
  sessionId?: string;
  fetchTimeoutMs: number;
}

/**
 * Create the worktree and its branch. The base is the latest default branch
 * when the checkout is clean and on it; otherwise (a feature branch, a
 * detached HEAD, or uncommitted work the task may depend on) it is the
 * checkout's HEAD, and the uncommitted changes are copied in. The user's
 * checkout is only read: its working tree, index, HEAD and branches are left
 * as they were.
 */
export async function createSessionWorktree(
  opts: CreateSessionWorktreeOptions,
): Promise<{ info: SessionWorktreeInfo; carried: CarryOver }> {
  const { sourceRoot } = opts;
  const sourceRel = relative(sourceRoot, await realpath(opts.sourceCwd));

  await mkdir(opts.rootDir, { recursive: true, mode: 0o700 });
  const commonDir = await realpath(resolve(sourceRoot, await runGit(["rev-parse", "--git-common-dir"], sourceRoot)));
  const repoDir = join(await realpath(opts.rootDir), `${slugPart(basename(sourceRoot))}-${shortHash(commonDir)}`);
  await mkdir(repoDir, { recursive: true, mode: 0o700 });

  const name = `${datePart(new Date())}-${randomBytes(3).toString("hex")}`;
  const path = join(repoDir, name);
  const branch = `${SESSION_BRANCH_PREFIX}${name}`;

  const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], sourceRoot, { maxBuffer: 16 * 1024 * 1024 });
  const dirty = status.length > 0;
  const current = await runGit(["symbolic-ref", "--short", "--quiet", "HEAD"], sourceRoot).catch(() => "");
  const defaultBranch = await resolveDefaultBranch(sourceRoot);
  const head = await runGit(["rev-parse", "HEAD"], sourceRoot);

  let baseCommit = head;
  let baseLabel = current ? `your current branch ${current}` : "your checked-out commit";
  let tempRef: string | null = null;
  if (!dirty && defaultBranch && current === defaultBranch) {
    const latest = await latestDefaultCommit(sourceRoot, defaultBranch, name, opts.fetchTimeoutMs);
    tempRef = latest.tempRef;
    // Local commits on the default branch that origin does not have yet: keep them.
    if (latest.commit && (await gitOk(["merge-base", "--is-ancestor", head, latest.commit], sourceRoot))) {
      baseCommit = latest.commit;
      baseLabel = `${latest.label} (latest ${defaultBranch})`;
    } else {
      baseLabel = `your local ${defaultBranch}`;
    }
  }

  try {
    await runGit(["worktree", "add", "--quiet", "-b", branch, path, baseCommit], sourceRoot, { timeoutMs: 120_000 });
  } finally {
    if (tempRef) await runGit(["update-ref", "-d", tempRef], sourceRoot).catch(() => undefined);
  }
  const worktreePath = await realpath(path);
  const now = Date.now();
  await writeMeta(worktreePath, { sessionId: opts.sessionId, sourceRoot, baseCommit, createdAt: now, lastUsedAt: now });

  const carried = dirty ? await carryOver(sourceRoot, worktreePath) : emptyCarryOver();
  const envFiles = await copyEnvFiles(sourceRoot, worktreePath);
  carried.envFiles = envFiles;

  return {
    info: {
      name,
      path: worktreePath,
      cwd: sourceRel ? join(worktreePath, sourceRel) : worktreePath,
      branch,
      sourceRoot,
      baseCommit,
      baseLabel,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    },
    carried,
  };
}

/**
 * Refresh the default branch from origin into a private ref (so neither
 * the user's branches nor their remote-tracking refs move — `--refmap=`
 * turns off git's opportunistic origin/<branch> update — and parallel
 * sessions cannot race on FETCH_HEAD). Falls back to origin/<branch>, then
 * to nothing, when offline or there is no origin.
 */
async function latestDefaultCommit(
  root: string,
  branch: string,
  name: string,
  timeoutMs: number,
): Promise<{ commit: string | null; label: string; tempRef: string | null }> {
  const tempRef = `refs/autopilot/base/${name}`;
  try {
    await runGit(["fetch", "--quiet", "--no-tags", "--refmap=", "origin", `+refs/heads/${branch}:${tempRef}`], root, { timeoutMs });
    return { commit: await runGit(["rev-parse", tempRef], root), label: `origin/${branch}`, tempRef };
  } catch {
    await runGit(["update-ref", "-d", tempRef], root).catch(() => undefined);
  }
  const tracking = await runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], root).catch(() => "");
  return { commit: tracking || null, label: `origin/${branch} (not refreshed)`, tempRef: null };
}

async function resolveDefaultBranch(root: string): Promise<string | undefined> {
  const remoteHead = await runGit(["symbolic-ref", "--short", "--quiet", "refs/remotes/origin/HEAD"], root).catch(() => "");
  if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  for (const candidate of ["main", "master"]) {
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], root)) return candidate;
  }
  for (const candidate of ["main", "master"]) {
    if (await gitOk(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`], root)) return candidate;
  }
  return undefined;
}

/** Copy uncommitted tracked changes (as a patch) and untracked files into the worktree. */
async function carryOver(sourceRoot: string, worktree: string): Promise<CarryOver> {
  const carried = emptyCarryOver();
  const tmp = await mkdtemp(join(tmpdir(), "autopilot-carry-"));
  try {
    const patch = join(tmp, "changes.patch");
    await runGit(["diff", "--binary", "HEAD", `--output=${patch}`], sourceRoot, { timeoutMs: 60_000 });
    if ((await stat(patch)).size > 0) {
      try {
        await runGit(["apply", "--binary", "--whitespace=nowarn", patch], worktree, { timeoutMs: 60_000 });
        carried.trackedChanges = true;
      } catch (error) {
        carried.applyError = error instanceof Error ? error.message : String(error);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  const listed = await runGit(["ls-files", "--others", "--exclude-standard", "-z"], sourceRoot, { maxBuffer: 16 * 1024 * 1024 });
  let budget = MAX_CARRY_BYTES;
  for (const rel of listed.split("\0").filter(Boolean)) {
    const from = join(sourceRoot, rel);
    const size = await stat(from).then((s) => s.size).catch(() => 0);
    if (size > budget) {
      carried.skipped++;
      continue;
    }
    budget -= size;
    await mkdir(join(worktree, rel, ".."), { recursive: true });
    await cp(from, join(worktree, rel), { verbatimSymlinks: true, force: false, errorOnExist: false });
    carried.untracked++;
  }
  return carried;
}

/** Ignored `.env` / `.env.*` files: the task often needs them and git never has them. */
async function copyEnvFiles(sourceRoot: string, worktree: string): Promise<string[]> {
  const listed = await runGit(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], sourceRoot, {
    maxBuffer: 16 * 1024 * 1024,
  }).catch(() => "");
  const copied: string[] = [];
  for (const rel of listed.split("\0").filter(Boolean)) {
    if (rel.endsWith("/") || !/^\.env(?:\..+)?$/.test(basename(rel))) continue;
    await mkdir(join(worktree, rel, ".."), { recursive: true });
    await cp(join(sourceRoot, rel), join(worktree, rel), { force: false, errorOnExist: false });
    copied.push(rel);
  }
  return copied;
}

// ── Listing and cleanup (/worktrees) ─────────────────────────────────────

export interface ListedSessionWorktree {
  name: string;
  path: string;
  branch: string;
  sessionId?: string;
  lastUsedAt?: number;
  /** The directory is gone (git still has its admin entry). */
  missing: boolean;
  /** Changed or untracked files in the worktree. */
  uncommitted: number;
  /** Commits on the branch that are on no remote (and not in its base). */
  unpushed: number;
}

/** Session worktrees of the repository containing `cwd`, newest first. */
export async function listSessionWorktrees(cwd: string, rootDir = defaultSessionWorktreesDir()): Promise<ListedSessionWorktree[]> {
  const root = await realpathOr(resolve(rootDir));
  const porcelain = await runGit(["worktree", "list", "--porcelain"], cwd, { maxBuffer: 16 * 1024 * 1024 });
  const out: ListedSessionWorktree[] = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || path === root || !isWithin(root, path)) continue;
    const branchRef = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? "";
    const branch = branchRef.replace(/^refs\/heads\//, "") || "(detached)";
    const missing = !(await exists(path));
    const meta = missing ? null : await readMeta(path);
    let uncommitted = 0;
    let unpushed = 0;
    if (!missing) {
      const status = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], path, { maxBuffer: 16 * 1024 * 1024 });
      uncommitted = countStatusEntries(status);
      const not = ["--not", "--remotes", ...(meta?.baseCommit ? [meta.baseCommit] : [])];
      unpushed = Number(await runGit(["rev-list", "--count", "HEAD", ...not], path).catch(() => "0")) || 0;
    }
    out.push({
      name: basename(path),
      path,
      branch,
      ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
      ...(meta?.lastUsedAt ? { lastUsedAt: meta.lastUsedAt } : {}),
      missing,
      uncommitted,
      unpushed,
    });
  }
  return out.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
}

export type RemoveResult =
  | { removed: true; branchKept: boolean }
  | { removed: false; reason: string };

/**
 * Remove one session worktree. Refuses one with uncommitted or unpushed work
 * unless `force` (the explicit confirmation); a forced removal still keeps
 * the branch when it has unpushed commits, so they stay recoverable.
 */
export async function removeSessionWorktree(
  cwd: string,
  target: ListedSessionWorktree,
  opts: { force?: boolean } = {},
): Promise<RemoveResult> {
  if (target.missing) {
    await runGit(["worktree", "prune"], cwd);
    return { removed: true, branchKept: true };
  }
  if (!opts.force && (target.uncommitted > 0 || target.unpushed > 0)) {
    return { removed: false, reason: describeWork(target) };
  }
  await runGit(["worktree", "remove", ...(opts.force ? ["--force"] : []), target.path], cwd, { timeoutMs: 120_000 });
  const keepBranch = target.unpushed > 0 || !target.branch.startsWith(SESSION_BRANCH_PREFIX);
  if (!keepBranch) await runGit(["branch", "-D", "--quiet", target.branch], cwd).catch(() => undefined);
  return { removed: true, branchKept: keepBranch };
}

export function describeWork(w: Pick<ListedSessionWorktree, "uncommitted" | "unpushed" | "missing">): string {
  if (w.missing) return "directory missing";
  const parts: string[] = [];
  if (w.uncommitted > 0) parts.push(`${w.uncommitted} uncommitted file${w.uncommitted === 1 ? "" : "s"}`);
  if (w.unpushed > 0) parts.push(`${w.unpushed} unpushed commit${w.unpushed === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "clean";
}

async function cleanupOffer(info: SessionWorktreeInfo, rootDir: string): Promise<string> {
  const [listed] = (await listSessionWorktrees(info.sourceRoot, rootDir).catch(() => [])).filter(
    (w) => w.path === info.path,
  );
  const state = listed ? describeWork(listed) : "status unknown";
  const how =
    listed && state === "clean"
      ? `remove it with /worktrees remove ${info.name} or /worktrees clean`
      : `it is kept; review it there, then /worktrees remove ${info.name}`;
  return `This session's worktree: ${info.path} (branch ${info.branch}, ${state}) — ${how}.`;
}

// ── Notices ──────────────────────────────────────────────────────────────

function userNotice(info: SessionWorktreeInfo, carried: CarryOver): string {
  const extra: string[] = [];
  if (carried.trackedChanges || carried.untracked > 0) extra.push("your uncommitted changes were copied in");
  if (carried.applyError) extra.push("your uncommitted tracked changes could not be copied");
  if (carried.envFiles.length) extra.push(`copied ${carried.envFiles.join(", ")}`);
  return (
    `Working in an isolated worktree: ${info.path} (branch ${info.branch}, from ${info.baseLabel}). ` +
    `Your checkout at ${info.sourceRoot} is not modified.${extra.length ? ` ${capitalize(extra.join("; "))}.` : ""} ` +
    `/worktrees lists and cleans up worktrees; /settings worktrees off works in place.`
  );
}

function modelNotice(info: SessionWorktreeInfo, carried: CarryOver): string {
  const lines = [
    `[autopilot] This session now works in an isolated git worktree, so the user's checkout at ${info.sourceRoot} stays untouched.`,
    `  worktree: ${info.cwd}`,
    `  branch:   ${info.branch} (from ${info.baseLabel})`,
    `Every tool call now runs there, and paths under ${info.sourceRoot} are redirected to it; use the worktree path from now on.`,
    "Gitignored files (node_modules, build output, virtualenvs) are not in the worktree: install dependencies there before building or testing.",
    `Commit on ${info.branch} (rename it with \`git branch -m\` if you like) and open a pull request from it; do not switch the user's checkout.`,
  ];
  if (carried.trackedChanges || carried.untracked > 0) {
    lines.push("The user's uncommitted changes were copied into the worktree; they are not committed. Do not commit them unless they belong to the task.");
  }
  if (carried.applyError) lines.push(`The user's uncommitted tracked changes could not be copied (${carried.applyError}).`);
  if (carried.skipped > 0) lines.push(`${carried.skipped} large untracked file(s) were not copied.`);
  return lines.join("\n");
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

// ── Path rewriting ───────────────────────────────────────────────────────

function remapPath(path: string, info: SessionWorktreeInfo): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(info.sourceRoot, path);
  if (rel === "") return info.path;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return path;
  return join(info.path, rel);
}

const PATH_ARGS = ["path", "cwd", "sourcePath", "file", "directory"];

function remapArgs(name: string, args: Record<string, unknown>, info: SessionWorktreeInfo): Record<string, unknown> {
  let next: Record<string, unknown> | null = null;
  const set = (key: string, value: unknown) => {
    if (!next) next = { ...args };
    next[key] = value;
  };
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value === "string" && isAbsolute(value)) {
      const mapped = remapPath(value, info);
      if (mapped !== value) set(key, mapped);
    }
  }
  if (name === "glob" && typeof args.pattern === "string" && isAbsolute(args.pattern)) {
    const mapped = remapPath(args.pattern, info);
    if (mapped !== args.pattern) set("pattern", mapped);
  }
  if ((name === "bash" || name === "job_start") && typeof args.command === "string") {
    const mapped = remapCommand(args.command, info);
    if (mapped !== args.command) set("command", mapped);
  }
  return next ?? args;
}

/** Rewrite `/path/to/checkout` (as a whole path prefix) in a shell command to the worktree. */
function remapCommand(command: string, info: SessionWorktreeInfo): string {
  const escaped = info.sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command.replace(new RegExp(`${escaped}(?=$|[/\\s'"\`;&|)])`, "g"), info.path);
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Entries in `git status --porcelain=v1 -z` output; a rename/copy carries its source as an extra field. */
function countStatusEntries(status: string): number {
  const fields = status.split("\0").filter(Boolean);
  let count = 0;
  for (let i = 0; i < fields.length; i++) {
    count++;
    if (/^[RC]/.test(fields[i]!)) i++;
  }
  return count;
}

async function gitTopLevel(cwd: string): Promise<string | null> {
  try {
    return await realpath(await runGit(["rev-parse", "--show-toplevel"], cwd));
  } catch {
    return null;
  }
}

async function gitOk(args: string[], cwd: string): Promise<boolean> {
  return runGit(args, cwd).then(
    () => true,
    () => false,
  );
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function realpathOr(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

async function metaPath(worktree: string): Promise<string> {
  return join(await runGit(["rev-parse", "--absolute-git-dir"], worktree), META_FILE);
}

async function writeMeta(worktree: string, meta: SessionMeta): Promise<void> {
  await writeFile(await metaPath(worktree), JSON.stringify(meta), { mode: 0o600 });
}

async function readMeta(worktree: string): Promise<SessionMeta | null> {
  try {
    return JSON.parse(await readFile(await metaPath(worktree), "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

async function updateMeta(worktree: string, patch: Partial<SessionMeta>): Promise<void> {
  const meta = await readMeta(worktree);
  if (meta) await writeMeta(worktree, { ...meta, ...patch });
}

function slugPart(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 40) || "repo";
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

function datePart(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
