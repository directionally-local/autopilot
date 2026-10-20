/**
 * Tool-loop state that outlives a single turn but belongs to one session:
 * the web-fetch history behind the research-spiral guardrail, the turns where
 * high-signal memories landed (AGENTS.md drift detection), and the count of
 * failed memory auto-extractions. One object per session id instead of three
 * module-level maps keyed by it.
 */

export interface SessionToolState {
  /** URLs fetched this session (a spiral split across turns still trips the cap). */
  webFetchHistory: string[];
  /** Turn indices where a high-signal memory landed (sliding window). */
  driftEvents: number[];
  /** Fire-and-forget memory-extraction failures. */
  memoryExtractionErrors: number;
}

const states = new Map<string, SessionToolState>();

export function sessionToolState(sessionId: string | undefined): SessionToolState {
  const key = sessionId ?? "default";
  let state = states.get(key);
  if (!state) {
    state = { webFetchHistory: [], driftEvents: [], memoryExtractionErrors: 0 };
    states.set(key, state);
  }
  return state;
}

/** Tests / embedders: forget one part of the state, or all of it, for every session. */
export function resetSessionToolState(part?: keyof SessionToolState): void {
  if (!part) return void states.clear();
  for (const s of states.values()) {
    if (part === "memoryExtractionErrors") s.memoryExtractionErrors = 0;
    else s[part] = [];
  }
}
