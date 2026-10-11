/**
 * `outcome{git_delta}`: the workspace change a turn made, measured as the
 * difference between `git diff --numstat` (against HEAD, untracked files
 * included) before and after the turn. Also remembers which files the last
 * delta of a session touched, so a later `git checkout -- <file>` /
 * `git restore` / `git stash` can be recorded as `outcome{reverted}`.
 */

import { gitNumstat, gitPatch, type NumstatEntry } from "../cost-attribution/git-diff.js";
import type { TraceRecorder } from "./recorder.js";

/** Patches larger than this are not stored on the event. */
export const MAX_PATCH_BYTES = 512 * 1024;

export interface GitDeltaDiff {
  files_changed: number;
  insertions: number;
  deletions: number;
  files: string[];
}

function toMap(entries: NumstatEntry[]): Map<string, NumstatEntry> {
  return new Map(entries.map((e) => [e.file, e]));
}

/** Per-file difference of two numstat snapshots. Only files whose counts moved are reported. */
export function diffNumstat(before: NumstatEntry[], after: NumstatEntry[]): GitDeltaDiff {
  const b = toMap(before);
  const a = toMap(after);
  const files = new Set([...b.keys(), ...a.keys()]);
  let insertions = 0;
  let deletions = 0;
  const changed: string[] = [];
  for (const file of files) {
    const x = b.get(file) ?? { file, insertions: 0, deletions: 0 };
    const y = a.get(file) ?? { file, insertions: 0, deletions: 0 };
    const di = y.insertions - x.insertions;
    const dd = y.deletions - x.deletions;
    if (di === 0 && dd === 0) continue;
    changed.push(file);
    insertions += Math.max(0, di);
    deletions += Math.max(0, dd);
  }
  changed.sort();
  return { files_changed: changed.length, insertions, deletions, files: changed };
}

/** Files touched by the most recent git_delta per session (for revert detection). */
const lastDeltaBySession = new Map<string, { turnId: string; files: string[] }>();

export function rememberGitDelta(sessionId: string, turnId: string, files: string[]): void {
  if (files.length === 0) return;
  lastDeltaBySession.set(sessionId, { turnId, files });
}

export function _resetGitDeltaMemoryForTests(): void {
  lastDeltaBySession.clear();
}

const REVERT_COMMAND = /(^|[\s;&|(])git\s+(checkout\s+--|restore\b|stash\b)/;

/**
 * When `command` is a git revert of files the session's last delta changed,
 * return the turn that delta belonged to. `git stash` with no paths reverts
 * everything; `git checkout -- <paths>` / `git restore <paths>` must name one
 * of the changed files.
 */
export function detectGitRevert(sessionId: string, command: string): { turnId: string } | null {
  const last = lastDeltaBySession.get(sessionId);
  if (!last) return null;
  if (!REVERT_COMMAND.test(command)) return null;
  const isStash = /git\s+stash\b/.test(command) && !/git\s+stash\s+(pop|apply|list|show|drop)\b/.test(command);
  if (isStash) return { turnId: last.turnId };
  if (/git\s+(checkout\s+--|restore)\s*$/.test(command.trim())) return null;
  const hit = last.files.some((file) => {
    const base = file.slice(file.lastIndexOf("/") + 1);
    return command.includes(file) || (base && new RegExp(`(^|[\\s/'"])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(['"\\s]|$)`).test(command));
  });
  if (hit) return { turnId: last.turnId };
  if (/git\s+restore\s+(\.|--staged\s+\.)(\s|$)/.test(command) || /git\s+checkout\s+--\s+\.(\s|$)/.test(command)) return { turnId: last.turnId };
  return null;
}

export interface GitDeltaTracker {
  /** Measure again and emit `outcome{git_delta}` on `trace`. Safe to call once. */
  finish(): Promise<void>;
}

/**
 * Snapshot the workspace before a turn. Returns null (and does nothing)
 * when the recorder is disabled or `cwd` is not a git repository.
 */
export async function beginGitDelta(opts: {
  trace: TraceRecorder;
  turnId: string;
  sessionId: string | undefined;
  cwd: string;
}): Promise<GitDeltaTracker | null> {
  if (!opts.trace.enabled) return null;
  const before = await gitNumstat(opts.cwd, { againstHead: true, includeUntracked: true });
  if (!before) return null;
  let done = false;
  return {
    async finish(): Promise<void> {
      if (done) return;
      done = true;
      const after = await gitNumstat(opts.cwd, { againstHead: true, includeUntracked: true });
      if (!after || !opts.trace.enabled) return;
      const delta = diffNumstat(before.entries, after.entries);
      const patch = delta.files_changed > 0 ? await gitPatch(opts.cwd, MAX_PATCH_BYTES) : null;
      opts.trace.emit(
        "outcome",
        {
          kind: "git_delta",
          turn_id: opts.turnId,
          files_changed: delta.files_changed,
          insertions: delta.insertions,
          deletions: delta.deletions,
          numstat_blob: opts.trace.blob(after.raw) ?? "",
          ...(patch ? { patch_blob: opts.trace.blob(patch) ?? "" } : {}),
        },
        opts.turnId,
      );
      if (opts.sessionId) rememberGitDelta(opts.sessionId, opts.turnId, delta.files);
    },
  };
}
