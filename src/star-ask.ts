/**
 * The GitHub star ask: one line, once per person, after a win (an opened PR
 * or passing tests, the same as the free tier's invite tip), and only once
 * Autopilot has been used on 3 or more distinct days. Never in the same
 * session as the invite tip (App keeps that), never in headless runs or
 * `-p` (only the interactive App asks), and off with `/settings star-tip off`.
 *
 * Pressing s stars the repository with the GitHub CLI when `gh` is installed
 * and signed in; otherwise the page opens in the browser, or its URL is
 * printed. No network call is made unless gh is used.
 *
 * Renderer-free so it can be tested: the Camouflage view supplies the key
 * read, the browser and the lines it says.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./util/app-dirs.js";
import { launchedByDl } from "./util/env.js";
import { ghStatus, runGh, type GhRun } from "./util/gh-cli.js";

export const STAR_REPO = "directionally-local/autopilot";
export const STAR_URL = `https://github.com/${STAR_REPO}`;
export const STAR_API_PATH = `/user/starred/${STAR_REPO}`;
/** Distinct days of use before the ask can show. */
export const STAR_MIN_DAYS = 3;
/** How long the "already starred?" check may take. */
export const STAR_CHECK_TIMEOUT_MS = 1_000;
export const STAR_KEY_HINT = "(press s to star · any other key to dismiss)";
export const STARRED_LINE = "✓ Starred. Thank you!";

/** "⭐ Enjoying dl? Star it on GitHub: … (press s to star · any other key to dismiss)" */
export function starAskLine(env: NodeJS.ProcessEnv = process.env): string {
  return `⭐ Enjoying ${launchedByDl(env) ? "dl" : "Autopilot"}? Star it on GitHub: ${STAR_URL}  ${STAR_KEY_HINT}`;
}

// ── State: days of use, and whether it was shown ─────────────────────────

export interface StarTipState {
  /** Distinct local days Autopilot was used on. */
  days: number;
  /** The last of them, as YYYY-MM-DD. */
  lastDay?: string;
  /** When the ask was shown (it never shows again). */
  shownAt?: string;
  /** When gh said it was already starred (never asked then). */
  starredAt?: string;
}

export function starTipStatePath(): string {
  return statePath("star-tip.json");
}

export function readStarTipState(path = starTipStatePath()): StarTipState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<StarTipState>;
    return {
      days: typeof raw.days === "number" && raw.days >= 0 ? Math.floor(raw.days) : 0,
      ...(typeof raw.lastDay === "string" ? { lastDay: raw.lastDay } : {}),
      ...(typeof raw.shownAt === "string" ? { shownAt: raw.shownAt } : {}),
      ...(typeof raw.starredAt === "string" ? { starredAt: raw.starredAt } : {}),
    };
  } catch {
    return { days: 0 };
  }
}

function writeStarTipState(state: StarTipState, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state), "utf8");
  } catch {
    /* best effort */
  }
}

/** The local calendar day of `now`, as YYYY-MM-DD. */
export function localDay(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Count today as a day of use (once per day). Returns the state as saved. */
export function noteDayOfUse(path = starTipStatePath(), now = Date.now()): StarTipState {
  const state = readStarTipState(path);
  const day = localDay(now);
  if (state.lastDay === day) return state;
  const next = { ...state, days: state.days + 1, lastDay: day };
  writeStarTipState(next, path);
  return next;
}

function markStarTip(field: "shownAt" | "starredAt", path: string, now: number): void {
  writeStarTipState({ ...readStarTipState(path), [field]: new Date(now).toISOString() }, path);
}

/**
 * The star ask after a win, or undefined: the setting on, never shown (or
 * found starred) before, used on 3+ distinct days, and, when gh is installed
 * and signed in, not already starred (`gh api` with a 1 s timeout). Marks
 * it shown, so it never shows again.
 */
export async function starAskAfterWin(o: {
  enabled: boolean;
  statePath?: string;
  now?: number;
  gh?: GhRun;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  if (!o.enabled) return undefined;
  const path = o.statePath ?? starTipStatePath();
  const now = o.now ?? Date.now();
  const state = readStarTipState(path);
  if (state.shownAt || state.starredAt || state.days < STAR_MIN_DAYS) return undefined;
  const gh = o.gh ?? runGh;
  if ((await ghStatus(gh).catch(() => "missing" as const)) === "signed-in") {
    const r = await gh(["api", STAR_API_PATH], { timeoutMs: STAR_CHECK_TIMEOUT_MS }).catch(() => null);
    if (r?.code === 0) {
      markStarTip("starredAt", path, now);
      return undefined;
    }
  }
  markStarTip("shownAt", path, now);
  return starAskLine(o.env);
}

/** Which one-time tip this session showed after a win ("checking" while one is decided). */
export type WinTipState = "invite" | "star" | "checking" | null;

/**
 * After a win: the invite tip, else the star ask, at most one per session,
 * so the two never appear in the same session. Only the one-time invite tip
 * counts as "invite": the free tier's informational invite lines (after
 * sign-in, the header, /usage, the 80% notice) don't go through here.
 */
export async function winTipAfterWin(o: {
  get: () => WinTipState;
  set: (s: WinTipState) => void;
  inviteTip: () => Promise<string | undefined>;
  starAsk: () => Promise<string | undefined>;
}): Promise<{ kind: "invite" | "star"; line: string } | undefined> {
  if (o.get() !== null) return undefined;
  o.set("checking");
  const invite = await o.inviteTip().catch(() => undefined);
  if (invite) {
    o.set("invite");
    return { kind: "invite", line: invite };
  }
  const star = await o.starAsk().catch(() => undefined);
  if (star) {
    o.set("star");
    return { kind: "star", line: star };
  }
  o.set(null);
  return undefined;
}

// ── Asking ───────────────────────────────────────────────────────────────

/** s or S, as a raw byte or in the kitty keyboard protocol's CSI-u form. */
export function isStarKey(chunk: string): boolean {
  return chunk === "s" || chunk === "S" || /^\x1b\[(?:115|83)(?::\d+)*(?:;[12])?u$/.test(chunk);
}

export interface StarAskDeps {
  /** Show the line and read one key; null when the terminal can't be read directly. */
  readKey: (line: string) => Promise<string | null>;
  /** The fallback when no key can be read: a two-choice list. */
  select: (title: string, options: { value: string; label: string }[], subtitle?: string) => Promise<string | null>;
  say: (message: string) => void;
  /** Open the URL in a browser here; false when none can. */
  openBrowser: (url: string) => boolean;
  gh?: GhRun;
}

/** Star it with gh when installed and signed in; otherwise open (or print) the page. */
export async function starIt(deps: Pick<StarAskDeps, "say" | "openBrowser" | "gh">): Promise<"starred" | "opened" | "printed"> {
  const gh = deps.gh ?? runGh;
  if ((await ghStatus(gh).catch(() => "missing" as const)) === "signed-in") {
    const r = await gh(["api", "-X", "PUT", STAR_API_PATH], { timeoutMs: 10_000 }).catch(() => null);
    if (r?.code === 0) {
      deps.say(STARRED_LINE);
      return "starred";
    }
  }
  if (deps.openBrowser(STAR_URL)) {
    deps.say(`Opened ${STAR_URL} in your browser.`);
    return "opened";
  }
  deps.say(`Star it here: ${STAR_URL}`);
  return "printed";
}

/** Show the ask; s stars it, anything else dismisses it. */
export async function runStarAsk(line: string, deps: StarAskDeps): Promise<"starred" | "opened" | "printed" | "dismissed"> {
  const key = await deps.readKey(line).catch(() => null);
  let star: boolean;
  if (key === null) {
    const title = line.replace(STAR_KEY_HINT, "").trim();
    star = (await deps.select(title, [
      { value: "star", label: "Star it on GitHub" },
      { value: "dismiss", label: "Not now" },
    ], "Enter to choose · Esc to dismiss")) === "star";
  } else {
    star = isStarKey(key);
  }
  return star ? starIt(deps) : "dismissed";
}
