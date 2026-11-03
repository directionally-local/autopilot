/**
 * Reopening a saved conversation in the interactive UI: `autopilot resume
 * [id]`, `autopilot -c` and `autopilot -S <id>` without `-p`. (With `-p`
 * those flags keep their print-mode meaning; see print-mode.ts.)
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { listSessions, sessionsDir } from "./sessions.js";
import { launchedByDl } from "./util/env.js";

/** Neither field set: show the resume picker on start (`autopilot resume`). */
export interface InteractiveResumeRequest {
  /** A session id (`autopilot resume <id>`, `-S <id>`). */
  sessionId?: string;
  /** The most recent session in `cwd` (`-c`). */
  latest?: boolean;
}

export type InteractiveResumeTarget =
  | { kind: "session"; sessionId: string }
  | { kind: "picker" }
  | { kind: "error"; message: string };

/** Session ids are file names in the sessions directory (sessions.ts makeSessionId). */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function resolveInteractiveResume(
  req: InteractiveResumeRequest,
  cwd: string = process.cwd(),
): Promise<InteractiveResumeTarget> {
  if (req.sessionId !== undefined) {
    const id = req.sessionId.trim().replace(/\.json$/, "");
    if (!SESSION_ID.test(id) || !existsSync(join(sessionsDir(), `${id}.json`))) {
      return { kind: "error", message: `no saved conversation with id "${req.sessionId}". Run \`autopilot resume\` to pick one.` };
    }
    return { kind: "session", sessionId: id };
  }
  if (req.latest) {
    const [latest] = await listSessions(1, cwd);
    if (!latest) return { kind: "error", message: "no earlier conversation in this directory to continue." };
    return { kind: "session", sessionId: latest.id };
  }
  return { kind: "picker" };
}

/**
 * The line printed when the interactive UI exits, if the session was saved.
 * Started by `dl` (AUTOPILOT_LAUNCHED_BY=dl), `autopilot` isn't on the
 * person's PATH: `dl -c` continues the latest conversation in this folder,
 * which is this one.
 */
export function resumeHint(sessionId: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!sessionId || !SESSION_ID.test(sessionId) || !existsSync(join(sessionsDir(), `${sessionId}.json`))) return null;
  if (launchedByDl(env)) return "Continue this conversation with: dl -c\n";
  return `Resume this conversation with: autopilot resume ${sessionId}\n`;
}
