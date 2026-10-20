/**
 * Auto-fresh preparation, shared by the two triggers in the TUI (a long
 * auto/edit session, and a history still too large after aggressive
 * compaction): save a silent "pre-fresh auto-save" checkpoint so the user
 * can roll back, then build the continuation summary the fresh session
 * starts from. Starting the fresh session itself stays with the host.
 */

import type { Checkpoint } from "../sessions.js";
import { serializeArtifactStore, type ArtifactStore, type SessionState } from "./session-state.js";
import type { ChatMessage } from "./messages.js";

export interface AutoFreshDeps {
  messages: ChatMessage[];
  compiledContext: boolean;
  sessionState: SessionState;
  artifactStore: ArtifactStore;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  /** The continuation summary (null when there's nothing to carry over). */
  summarize(): Promise<string | null>;
  now?: () => number;
}

/** The pre-fresh checkpoint for a history, or null when it's empty. */
export function preFreshCheckpoint(deps: Pick<AutoFreshDeps, "messages" | "compiledContext" | "sessionState" | "artifactStore" | "now">): Checkpoint | null {
  const turnIndex = deps.messages.length;
  if (turnIndex === 0) return null;
  const now = deps.now?.() ?? Date.now();
  return {
    id: `cp_prefresh_${now}`,
    label: "pre-fresh auto-save",
    turnIndex,
    timestamp: new Date(now).toISOString(),
    sessionState: deps.compiledContext ? deps.sessionState : undefined,
    artifactStore: serializeArtifactStore(deps.artifactStore),
  };
}

/** Checkpoint, then summarize. Errors propagate (the host reports "Auto-fresh failed"). */
export async function prepareAutoFresh(deps: AutoFreshDeps): Promise<string | null> {
  const checkpoint = preFreshCheckpoint(deps);
  if (checkpoint) await deps.saveCheckpoint(checkpoint);
  return deps.summarize();
}
