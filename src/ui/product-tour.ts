/**
 * `/tour`: a short, step-by-step tour of what is different about dl (or
 * Autopilot), opened only on request and never at startup. One screen per
 * step; → / l / Enter goes on, ← / h goes back, Esc / q closes. Closing
 * returns to the prompt with nothing printed.
 *
 * The screens are drawn with the chat input out of the way, the same way the
 * GitHub star ask and the browser sign-in waits are (ui/terminal-wait.ts).
 * Where the terminal can't be lent, each step is a small Camouflage list
 * (Next / Back / Close) instead.
 *
 * The only thing remembered is that the tour was opened once (Autopilot's
 * state file, never the repo): the startup hint stops after that.
 */

import { readState, writeState } from "../util/state.js";
import { launchedByDl, type EnvLike } from "../util/env.js";
import { sessionsDir } from "../sessions.js";
import { wrapText } from "../util/wrap.js";

export interface TourStep {
  title: string;
  /** Short plain lines; each wraps on narrow terminals. */
  lines: string[];
}

/** The startup hint, shown under the model until /tour has been opened once. */
export function tourHint(env: EnvLike = process.env): string {
  return `/tour · what's different about ${launchedByDl(env) ? "dl" : "autopilot"}`;
}

/** The tour's steps. Every command named here exists (see product-tour.test.ts). */
export function tourSteps(o: { env?: EnvLike; sessions?: string } = {}): TourStep[] {
  const env = o.env ?? process.env;
  const dl = launchedByDl(env);
  const name = dl ? "dl" : "autopilot";
  const steps: TourStep[] = [
    {
      title: `what ${name} is`,
      lines: [
        `${name} is an open-source coding agent that runs on your computer.`,
        "use it with any provider: the free tier, your own API key, or a model on your own GPUs.",
        "type / for commands and @ to mention a file.",
      ],
    },
    {
      title: "the free tier and models",
      lines: [
        "sign in with GitHub for free weekly usage on hosted models, with DeepSeek for everyday coding.",
        "/model switches models · /usage shows what's left this week.",
        "/provider switches to your own key whenever you like.",
      ],
    },
    {
      title: "invite friends",
      lines: ["/invite shows your invite link and who joined through it."],
    },
    {
      title: "memory",
      lines: [
        `${name} remembers facts about each project across sessions, kept on this computer, secrets redacted.`,
        "/memory shows what's stored · /memory off turns it off.",
      ],
    },
    {
      title: "bring your setup",
      lines: [
        "coming from Claude Code or another agent? your CLAUDE.md, MCP servers and other setup are picked up.",
        "/setup-import shows what's used.",
        `\`${name} --from-claude-code\` continues this folder's latest Claude Code conversation here.`,
      ],
    },
    {
      title: "background work",
      lines: [
        "long commands can keep running in the background, and the agent can hand parts of a task to subagents.",
        "/jobs and /agents show them while they run.",
        ...(dl ? ["on your own server, `dl run \"task\"` runs a task in a sandbox and ends in a pull request."] : []),
      ],
    },
    {
      title: "your sessions stay here",
      lines: [
        dl
          ? `sessions and traces stay on this computer, in ${o.sessions ?? sessionsDir()}; nothing is deleted automatically.`
          : "sessions and traces stay on this computer; nothing is deleted automatically. `autopilot history` shows where.",
        "/resume reopens an earlier conversation.",
        `start ${name} inside a project folder rather than your home folder: it works best there.`,
      ],
    },
  ];
  if (dl) {
    steps.push({
      title: "your own GPUs",
      lines: [
        "got Nvidia GPUs? `dl model up` serves an open model on them,",
        "and `dl model` picks the model your sessions use.",
      ],
    });
  }
  return steps;
}

// ── Navigation ───────────────────────────────────────────────────────────

export type TourAction = "next" | "back" | "close";

/** The action a key chunk means, or null for any other key. */
export function tourKey(chunk: string): TourAction | null {
  switch (chunk) {
    case "\x1b[C": // →
    case "\x1bOC":
    case "l":
    case "\r":
    case "\n":
      return "next";
    case "\x1b[D": // ←
    case "\x1bOD":
    case "h":
      return "back";
    case "\x1b": // Esc
    case "q":
    case "Q":
    case "\x03": // Ctrl+C
      return "close";
  }
  // Esc and Ctrl+C in the kitty keyboard protocol's CSI-u form; Enter too.
  if (/^\x1b\[27(?:;1)?u$/.test(chunk) || /^\x1b\[99;5u$/.test(chunk)) return "close";
  if (/^\x1b\[13(?:;1)?u$/.test(chunk)) return "next";
  return null;
}

/** The step after `action` from step `at` of `count`; null when the tour closes (Esc, or next on the last step). */
export function tourMove(at: number, action: TourAction, count: number): number | null {
  if (action === "close") return null;
  if (action === "back") return Math.max(0, at - 1);
  return at + 1 >= count ? null : at + 1;
}

/** The footer: "2 of 7 · → next · ← back · esc close" (the last step says done). */
export function tourFooter(at: number, count: number): string {
  return `${at + 1} of ${count} · → ${at + 1 >= count ? "done" : "next"}${at > 0 ? " · ← back" : ""} · esc close`;
}

/** One step as plain text, wrapped to `width` columns: title, body, a blank line, the footer. */
export function tourFrame(steps: TourStep[], at: number, width: number): string[] {
  const step = steps[at]!;
  const body = step.lines.flatMap((line) => wrapText(line, width));
  return [...wrapText(step.title, width), ...body, "", ...wrapText(tourFooter(at, steps.length), width)];
}

/** The frame with the title bold and the footer dim, for a terminal. */
export function styledTourFrame(steps: TourStep[], at: number, width: number): string {
  const lines = tourFrame(steps, at, width);
  const titleRows = wrapText(steps[at]!.title, width).length;
  const footerRows = wrapText(tourFooter(at, steps.length), width).length;
  return lines
    .map((line, i) => (i < titleRows ? `\x1b[1m${line}\x1b[22m` : i >= lines.length - footerRows ? `\x1b[2m${line}\x1b[22m` : line))
    .join("\n");
}

export interface TourDeps {
  /**
   * Draw screens with the chat input out of the way and pass each key to
   * `onKey` until it returns true; resolves false when the terminal can't
   * be lent (then `select` is used).
   */
  screen: (draw: () => string, onKey: (chunk: string) => boolean) => Promise<boolean>;
  /** A Camouflage list: the chosen value, or null on Esc. */
  select: (title: string, options: { value: string; label: string }[], subtitle?: string) => Promise<string | null>;
}

/** Run the tour to its end (or Esc). Resolves with how many steps were seen. */
export async function runProductTour(steps: TourStep[], deps: TourDeps, width: () => number): Promise<number> {
  let at = 0;
  let seen = 1;
  const lent = await deps.screen(
    () => styledTourFrame(steps, at, width()),
    (chunk) => {
      const action = tourKey(chunk);
      if (!action) return false;
      const next = tourMove(at, action, steps.length);
      if (next === null) return true;
      at = next;
      seen = Math.max(seen, at + 1);
      return false;
    },
  );
  if (lent) return seen;
  // No terminal to lend: one list per step.
  for (;;) {
    const step = steps[at]!;
    const last = at + 1 >= steps.length;
    const options = [
      { value: "next", label: last ? "Done" : "Next" },
      ...(at > 0 ? [{ value: "back", label: "Back" }] : []),
      { value: "close", label: "Close the tour" },
    ];
    const r = await deps.select(`${step.title} · ${at + 1} of ${steps.length}`, options, step.lines.join(" "));
    const next = tourMove(at, r === "next" || r === "back" ? r : "close", steps.length);
    if (next === null) return seen;
    at = next;
    seen = Math.max(seen, at + 1);
  }
}

// ── Seen once ────────────────────────────────────────────────────────────

/** True once /tour has been opened on this machine. Never throws. */
export async function productTourSeen(): Promise<boolean> {
  try {
    return (await readState()).productTourSeen === true;
  } catch {
    return false;
  }
}

/** The startup hint until /tour has been opened once, then undefined for good. */
export async function tourHintUntilSeen(env: EnvLike = process.env): Promise<string | undefined> {
  return (await productTourSeen()) ? undefined : tourHint(env);
}

/** Remember that /tour was opened, so the startup hint stops. Never throws. */
export async function markProductTourSeen(): Promise<void> {
  try {
    const state = await readState();
    if (state.productTourSeen === true) return;
    await writeState({ ...state, productTourSeen: true });
  } catch {
    // Best effort: the hint shows again next time.
  }
}
