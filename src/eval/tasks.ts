/**
 * Eval task format (plan §4.1) and loader.
 *
 * `evals/tasks/<set>/<task_id>.json`, one task per file. Paths in `files`
 * are relative to the task set directory and are copied into the worktree
 * before the agent runs and again before `test` runs, so the agent can read
 * them but cannot change what is verified.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { matchGlob } from "../util/glob.js";

export interface EvalTask {
  id: string;
  /** git URL or absolute path of the repository. */
  repo: string;
  base_commit: string;
  /** What the agent is asked to do. */
  prompt: string;
  /** Shell, run once in the worktree before the agent (install deps). */
  setup?: string;
  /** Shell; exit 0 = pass. Run after the agent, in the worktree. */
  test: string;
  /** Default 1800. */
  timeout_s?: number;
  tags?: string[];
  /** Files to place in the worktree: `{ "<path in worktree>": "<path relative to the task set dir>" }`. */
  files?: Record<string, string>;
}

export interface LoadedEvalTask extends EvalTask {
  /** Absolute path of the task file. */
  file: string;
  /** Absolute paths of the `files` sources, keyed by their worktree path. */
  resolvedFiles: Record<string, string>;
}

export const DEFAULT_TASK_TIMEOUT_S = 1800;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** Validate a parsed task object; throws with a specific message. */
export function validateTask(raw: unknown, source: string): EvalTask {
  if (!raw || typeof raw !== "object") throw new Error(`${source}: task must be a JSON object`);
  const t = raw as Record<string, unknown>;
  for (const key of ["id", "repo", "base_commit", "prompt", "test"] as const) {
    if (!isNonEmptyString(t[key])) throw new Error(`${source}: "${key}" must be a non-empty string`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.id as string)) throw new Error(`${source}: "id" may only contain letters, digits, dots, underscores, hyphens`);
  if (t.setup !== undefined && typeof t.setup !== "string") throw new Error(`${source}: "setup" must be a string`);
  if (t.timeout_s !== undefined && (typeof t.timeout_s !== "number" || !(t.timeout_s > 0))) throw new Error(`${source}: "timeout_s" must be a positive number`);
  if (t.tags !== undefined && (!Array.isArray(t.tags) || !t.tags.every((x) => typeof x === "string"))) throw new Error(`${source}: "tags" must be an array of strings`);
  if (t.files !== undefined) {
    if (!t.files || typeof t.files !== "object" || Array.isArray(t.files)) throw new Error(`${source}: "files" must be an object`);
    for (const [dest, src] of Object.entries(t.files as Record<string, unknown>)) {
      if (!isNonEmptyString(src)) throw new Error(`${source}: files["${dest}"] must be a path`);
      if (dest.startsWith("/") || dest.split(/[\\/]/).includes("..")) throw new Error(`${source}: files["${dest}"] must be a relative path inside the worktree`);
    }
  }
  return t as unknown as EvalTask;
}

/** Load every `*.json` task in `dir`, optionally keeping only ids matching `filter` (glob). */
export async function loadTasks(dir: string, filter?: string): Promise<LoadedEvalTask[]> {
  const root = resolve(dir);
  const names = (await readdir(root)).filter((n) => n.endsWith(".json")).sort();
  const tasks: LoadedEvalTask[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = join(root, name);
    const task = validateTask(JSON.parse(await readFile(file, "utf8")), name);
    if (task.id !== basename(name, ".json")) throw new Error(`${name}: "id" (${task.id}) must match the file name`);
    if (seen.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
    seen.add(task.id);
    if (filter && !matchGlob(task.id, filter)) continue;
    const resolvedFiles: Record<string, string> = {};
    for (const [dest, src] of Object.entries(task.files ?? {})) {
      const abs = resolve(root, src);
      if (!abs.startsWith(root)) throw new Error(`${name}: files["${dest}"] escapes the task directory`);
      await stat(abs).catch(() => {
        throw new Error(`${name}: files["${dest}"] -> ${src} does not exist`);
      });
      resolvedFiles[dest] = abs;
    }
    tasks.push({ ...task, file, resolvedFiles });
  }
  return tasks;
}
