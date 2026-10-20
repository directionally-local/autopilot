import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "../util/logger.js";
import { LEGACY_RECOMMENDED_COMMANDS } from "./recommended.js";
import {
  HOOK_EVENTS,
  type HookConfig,
  type HookEvent,
  type KimiflareSettings,
} from "./types.js";

// ── Where hook settings live ─────────────────────────────────────────────
//
// Canonical (#887): `~/.config/autopilot/settings.json` (global) and
// `<project>/.autopilot/settings.json`. The pre-rename kimiflare paths are
// still read, never dropped, so existing setups keep working. All four are
// merged, in HOOK_SETTINGS_MERGE_ORDER; a later entry with the same id (per
// event) replaces an earlier one. New hooks are written to the autopilot
// paths; enabling/disabling an existing hook edits the file it lives in.

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

/** Canonical global settings file (`$XDG_CONFIG_HOME/autopilot/settings.json`,
 *  default `~/.config/autopilot/settings.json`). New global hooks go here. */
export function globalSettingsPath(): string {
  return join(configHome(), "autopilot", "settings.json");
}

/** Canonical per-project settings file (`<cwd>/.autopilot/settings.json`).
 *  New project hooks go here. */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".autopilot", "settings.json");
}

/** Legacy global settings file (`$XDG_CONFIG_HOME/kimiflare/settings.json`).
 *  Still read; existing hooks in it are edited in place. */
export function legacyGlobalSettingsPath(): string {
  return join(configHome(), "kimiflare", "settings.json");
}

/** Legacy per-project settings file (`<cwd>/.kimiflare/settings.json`). */
export function legacyProjectSettingsPath(cwd: string): string {
  return join(cwd, ".kimiflare", "settings.json");
}

export interface HookSettingsLocation {
  scope: "global" | "project";
  /** True for the pre-rename kimiflare paths. */
  legacy: boolean;
  path: string;
}

/**
 * Every settings file hooks are read from, in merge order (lowest
 * precedence first): global kimiflare, global autopilot, project kimiflare,
 * project autopilot.
 */
export function hookSettingsLocations(cwd: string): HookSettingsLocation[] {
  return [
    { scope: "global", legacy: true, path: legacyGlobalSettingsPath() },
    { scope: "global", legacy: false, path: globalSettingsPath() },
    { scope: "project", legacy: true, path: legacyProjectSettingsPath(cwd) },
    { scope: "project", legacy: false, path: projectSettingsPath(cwd) },
  ];
}

function readSettingsFile(path: string): KimiflareSettings | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as KimiflareSettings;
    logger.warn("hooks:settings_not_object", { path });
    return null;
  } catch (e) {
    logger.warn("hooks:settings_invalid_json", { path, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Thrown when a settings file exists but can't be safely rewritten. */
export class SettingsFileError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`Refusing to modify ${path}: ${detail}. Fix or move the file, then try again.`);
    this.name = "SettingsFileError";
  }
}

/**
 * Read a settings file we are about to rewrite. Missing → `{}`. Present but
 * not a JSON object → throw instead of returning `{}`, so a hand-edited file
 * with a typo (or one holding other tools' settings) is never silently
 * replaced by a hooks-only file.
 */
function readSettingsFileForWrite(path: string): KimiflareSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new SettingsFileError(path, `it is not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SettingsFileError(path, "it does not contain a JSON object");
  }
  const settings = parsed as KimiflareSettings;
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    throw new SettingsFileError(path, `its "hooks" key is not an object`);
  }
  return settings;
}

/** Stable id derived from `event + command` for hooks that didn't set
 *  one explicitly. Eight hex chars is plenty for hand-typed disambig
 *  while staying short enough to type into `/hooks enable`. */
function deriveHookId(event: HookEvent, command: string): string {
  const h = createHash("sha256").update(`${event}\0${command}`).digest("hex");
  return h.slice(0, 8);
}

/**
 * Validate + normalize a single hook entry. Drops anything that isn't
 * the right shape rather than throwing — a malformed entry in
 * settings.json should not crash the agent.
 */
function normalizeHook(
  event: HookEvent,
  raw: unknown,
  source: HookConfig["source"],
): HookConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.command !== "string" || !r.command.trim()) return null;
  const enabled = typeof r.enabled === "boolean" ? r.enabled : true;
  const matcher = typeof r.matcher === "string" ? r.matcher : undefined;
  const timeoutMs = typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? r.timeoutMs : undefined;
  const description = typeof r.description === "string" ? r.description : undefined;
  const id = typeof r.id === "string" && r.id.length > 0 ? r.id : deriveHookId(event, r.command);
  // Recommended guards written by older releases blocked with `exit 1`,
  // which now fails open; run the current `exit 2` version instead.
  const command = LEGACY_RECOMMENDED_COMMANDS.get(r.command) ?? r.command;
  return { id, matcher, command, timeoutMs, enabled, description, source, ...(r.failClosed === true ? { failClosed: true } : {}) };
}

/** Merge `hooks` blocks in order. Later blocks run later for a given
 *  event, and an entry whose id is already present replaces the earlier
 *  one (taking the later file's position), so a hook copied from the
 *  legacy file to the autopilot one runs once. */
function mergeHookMaps(...maps: KimiflareSettings["hooks"][]): KimiflareSettings["hooks"] {
  const out: KimiflareSettings["hooks"] = {};
  for (const ev of HOOK_EVENTS) {
    // normalizeHook always sets an id (explicit, or derived from event+command).
    const byId = new Map<string, HookConfig>();
    for (const m of maps) {
      for (const h of m?.[ev] ?? []) {
        const id = h.id ?? deriveHookId(ev, h.command);
        byId.delete(id);
        byId.set(id, h);
      }
    }
    if (byId.size > 0) out[ev] = [...byId.values()];
  }
  return out;
}

/**
 * Load + merge every hook settings file (see hookSettingsLocations).
 * Always returns a valid (possibly empty) `KimiflareSettings`. Hook
 * entries are normalized and stamped with their `source` scope.
 */
export function loadHooksSettings(cwd: string): KimiflareSettings {
  const normalized = (
    raw: KimiflareSettings | null,
    source: NonNullable<HookConfig["source"]>,
  ): KimiflareSettings["hooks"] => {
    const out: KimiflareSettings["hooks"] = {};
    for (const ev of HOOK_EVENTS) {
      const list = raw?.hooks?.[ev];
      if (!Array.isArray(list)) continue;
      const cleaned = list
        .map((h) => normalizeHook(ev, h, source))
        .filter((h): h is HookConfig => h !== null);
      if (cleaned.length > 0) out[ev] = cleaned;
    }
    return out;
  };

  const merged = mergeHookMaps(
    ...hookSettingsLocations(cwd).map((loc) => normalized(readSettingsFile(loc.path), loc.scope)),
  );
  return { hooks: merged };
}

/** True when the settings file at `path` declares at least one hook entry. */
function fileHasHooks(path: string): boolean {
  const hooks = readSettingsFile(path)?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return HOOK_EVENTS.some((ev) => Array.isArray(hooks[ev]) && hooks[ev]!.length > 0);
}

/**
 * Legacy settings files that hold hooks while their autopilot counterpart
 * (same scope) holds none: the "your hooks are only in the old path" case.
 * They keep working; callers show a one-time notice (see notices.ts).
 */
export function legacyOnlyHookPaths(cwd: string): string[] {
  const out: string[] = [];
  const locs = hookSettingsLocations(cwd);
  for (const legacy of locs.filter((l) => l.legacy)) {
    const current = locs.find((l) => !l.legacy && l.scope === legacy.scope)!;
    if (fileHasHooks(legacy.path) && !fileHasHooks(current.path)) out.push(legacy.path);
  }
  return out;
}

// ── Edit operations used by the `/hooks` slash command ───────────────────

/**
 * Idempotent upsert. Adds the hook to the chosen settings file
 * UNLESS another entry with the same id (or, if the id was
 * auto-derived, the same event+command) already exists — in which
 * case it updates the existing entry's `enabled` flag and its
 * other writable fields in place.
 *
 * Also dedupes any existing identical-id duplicates in the same
 * event list at write time (one-shot cleanup for users who hit
 * the pre-fix double-Enter bug).
 *
 * Always writes the canonical autopilot path for `scope` (never the
 * legacy kimiflare file). Returns the path that was written. Throws
 * `SettingsFileError` (and
 * writes nothing) if the file exists but isn't a valid JSON object.
 */
export function appendHook(
  scope: "global" | "project",
  cwd: string,
  event: HookEvent,
  hook: HookConfig,
): string {
  const path = scope === "global" ? globalSettingsPath() : projectSettingsPath(cwd);
  const existing = readSettingsFileForWrite(path);
  const hooks = existing.hooks ?? {};
  const rawList: unknown = hooks[event];
  if (rawList !== undefined && !Array.isArray(rawList)) {
    throw new SettingsFileError(path, `"hooks.${event}" is not an array`);
  }
  const list = (rawList ?? []) as HookConfig[];
  // Drop id/source before writing — source is internal-only. We keep
  // the (possibly auto-derived) id because that's what setHookEnabled
  // matches against later.
  const { source: _src, ...toWrite } = hook;
  const newId = toWrite.id ?? deriveHookId(event, toWrite.command);

  // Build a deduped list keyed by id: keep at most one entry per id,
  // and replace it with `toWrite` if its id matches the new one.
  // Entries that fail to parse are dropped (best-effort cleanup).
  const byId = new Map<string, HookConfig>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const h = raw as HookConfig;
    if (typeof h.command !== "string") continue;
    const id = h.id ?? deriveHookId(event, h.command);
    if (byId.has(id)) continue; // dedupe leftover dups from older bugs
    byId.set(id, h);
  }
  byId.set(newId, { ...toWrite, id: newId });

  hooks[event] = Array.from(byId.values()).map((h) => {
    // Don't write the auto-derived id back to disk if the user didn't
    // provide one — keeps their settings.json clean.
    if (hook.id) return h;
    const { id: _id, ...rest } = h;
    return rest as HookConfig;
  });
  existing.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
  return path;
}

/**
 * Flip `enabled` on a hook matched by its id, in the file it lives in
 * (autopilot or legacy kimiflare path; nothing is moved). Searches in
 * reverse merge order, so the entry that actually takes effect is the one
 * edited. Returns the file path that was modified, or null if no hook with
 * that id exists.
 */
export function setHookEnabled(cwd: string, id: string, enabled: boolean): string | null {
  for (const { path } of [...hookSettingsLocations(cwd)].reverse()) {
    const existing = readSettingsFile(path);
    if (!existing?.hooks) continue;
    let changed = false;
    for (const ev of HOOK_EVENTS) {
      const list = existing.hooks[ev];
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        if (!hook || typeof hook !== "object") continue;
        const h = hook as HookConfig;
        const hookId = h.id ?? deriveHookId(ev, h.command);
        if (hookId === id) {
          h.enabled = enabled;
          changed = true;
        }
      }
    }
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(existing, null, 2) + "\n", "utf8");
      return path;
    }
  }
  return null;
}

// Re-export for tests
export { deriveHookId };
