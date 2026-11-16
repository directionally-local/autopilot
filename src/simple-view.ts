/**
 * The simple view: a plain line-by-line prompt for terminals where the full
 * screen (Camouflage) view can't run (#1222). Each line is one turn through
 * print mode's agent loop and output (assistant text on stdout, tool calls
 * and results as dim lines on stderr), on one session that is saved after
 * every turn. Approvals follow print mode's rules: with nobody to ask,
 * anything that would need a person is refused.
 *
 * Started with `--simple` or AUTOPILOT_SIMPLE_VIEW=1, and automatically when
 * the full screen view keeps crashing (see camouflage-launch.ts).
 */

import { productName } from "./util/dl-identity.js";
import { launchedByDl } from "./util/env.js";

/** AUTOPILOT_SIMPLE_VIEW=1 (or true/yes) starts in the simple view. */
export const SIMPLE_VIEW_ENV = "AUTOPILOT_SIMPLE_VIEW";

/** Whether the simple view was asked for, by flag or environment. */
export function simpleViewRequested(flag: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag) return true;
  const v = env[SIMPLE_VIEW_ENV]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** How to start in the simple view next time, in the user's own command. */
export function simpleViewStartHint(env: NodeJS.ProcessEnv = process.env): string {
  return launchedByDl(env) ? `${SIMPLE_VIEW_ENV}=1 dl` : `autopilot --simple (or ${SIMPLE_VIEW_ENV}=1)`;
}

/** The lines printed when the simple view starts. */
export function simpleViewBanner(o: { sessionId?: string | null; resumed?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): string {
  const lines = [
    `${productName(env)} simple view · type a message and press Enter · Ctrl+C stops a turn · /exit quits`,
    "Actions that need your approval are refused here; edits and recoverable commands still run.",
  ];
  if (o.resumed && o.sessionId) lines.push(`Continuing this conversation (session ${o.sessionId}).`);
  return lines.join("\n") + "\n";
}

export interface SimpleViewDeps {
  /** Read one line; null when input ends (Ctrl+D) or the user presses Ctrl+C at the prompt. */
  readLine: (prompt: string) => Promise<string | null>;
  /** Run one turn on the session (undefined: start a new one); reports the session id it used. */
  runTurn: (prompt: string, sessionId: string | undefined, onSession: (id: string) => void) => Promise<void>;
  write: (text: string) => void;
}

export interface SimpleViewOpts {
  /** The conversation to continue (e.g. the one the crashed full screen view was saving). */
  sessionId?: string | null;
  env?: NodeJS.ProcessEnv;
}

/** Run the prompt loop until /exit, /quit or end of input. Returns the session id last used. */
export async function runSimpleView(opts: SimpleViewOpts, deps: SimpleViewDeps): Promise<string | null> {
  const env = opts.env ?? process.env;
  let sessionId = opts.sessionId ?? undefined;
  deps.write(simpleViewBanner({ sessionId, resumed: !!sessionId }, env));
  for (;;) {
    const line = await deps.readLine("> ");
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;
    if (text.startsWith("/")) {
      deps.write(`Slash commands need the full screen view; here only /exit works.\n`);
      continue;
    }
    // A failed turn (exit code set by print mode) doesn't end the loop.
    const exitCode = process.exitCode;
    try {
      await deps.runTurn(text, sessionId, (id) => {
        sessionId = id;
      });
    } catch (err) {
      deps.write(`${productName(env)}: ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      process.exitCode = exitCode;
    }
  }
  if (sessionId) {
    deps.write(
      launchedByDl(env)
        ? "Your conversation is saved. To pick it up again, run `dl -c` in the same folder.\n"
        : `Your conversation is saved: autopilot -S ${sessionId} (add --simple for this view).\n`,
    );
  }
  return sessionId ?? null;
}

/** readLine on the real terminal: one readline per prompt, so Ctrl+C during a turn reaches the turn. */
export async function terminalReadLine(prompt: string): Promise<string | null> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(value);
    };
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish(null);
    });
    rl.on("close", () => finish(null));
    rl.question(prompt, (answer) => finish(answer));
  });
}
