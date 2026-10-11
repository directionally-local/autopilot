import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "./agent/messages.js";
import { repairDanglingToolCalls } from "./agent/messages.js";
import type { SessionState, SerializedArtifact } from "./agent/session-state.js";
import { listFilesByMtime, pruneFiles, RETENTION } from "./storage-limits.js";

export interface SessionSummary {
  id: string;
  filePath: string;
  cwd: string;
  firstPrompt: string;
  /** Human-readable title generated from first prompt and intent. */
  title?: string;
  messageCount: number;
  updatedAt: string;
  checkpointCount: number;
}

export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Human-readable label */
  label: string;
  /** Index into messages array where checkpoint was taken */
  turnIndex: number;
  timestamp: string;
  /** Snapshot of session state at checkpoint time */
  sessionState?: SessionState;
  /** Snapshot of artifact store at checkpoint time */
  artifactStore?: SerializedArtifact[];
}

export interface SessionFile {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  /** Human-readable title generated from first prompt and intent. */
  title?: string;
  /** Compiled session state for token-optimized context (optional). */
  sessionState?: SessionState;
  /** Persisted artifact store for recalled raw tool outputs (optional). */
  artifactStore?: SerializedArtifact[];
  /** User-created checkpoints within this session (optional). */
  checkpoints?: Checkpoint[];
}

export function sessionsDir(): string {
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(xdg, "kimiflare", "sessions");
}

function sanitize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const INTENT_PREFIX_MAP: Record<string, string> = {
  diagnose: "Bug:",
  feature_bounded: "Feature:",
  feature_exploratory: "Feature:",
  polish: "Refactor:",
  meta: "Plan:",
  explore: "Explore:",
  qa: "Q&A:",
  verify: "Verify:",
  small_edit: "Edit:",
  default: "Task:",
};

/** Generate a short human-readable title from the first user prompt. */
export function generateSessionTitle(firstPrompt: string, intent: string): string {
  const prefix = INTENT_PREFIX_MAP[intent] ?? INTENT_PREFIX_MAP.default;
  const cleaned = firstPrompt
    .replace(/\s+/g, " ")
    .replace(/[\n\r]/g, " ")
    .trim();
  const words = cleaned.split(" ").slice(0, 6).join(" ");
  const title = `${prefix} ${words}`;
  return title.length > 40 ? title.slice(0, 37) + "..." : title;
}

export function makeSessionId(firstPrompt: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const slug = sanitize(firstPrompt) || "session";
  return `${ts}_${slug}`;
}

export async function saveSession(file: SessionFile): Promise<string> {
  const dir = sessionsDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${file.id}.json`);
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
  return path;
}

/** Prune old session files to enforce retention policy. */
export async function pruneSessions(): Promise<number> {
  const dir = sessionsDir();
  const files = await listFilesByMtime(dir, /\.json$/);
  return pruneFiles(files, RETENTION.sessionMaxAgeDays, RETENTION.sessionMaxCount);
}

export async function listSessions(limit = 30, cwd?: string): Promise<SessionSummary[]> {
  const dir = sessionsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const [s, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
      const parsed = JSON.parse(raw) as SessionFile;
      if (cwd && parsed.cwd !== cwd) continue;
      const firstUser = parsed.messages.find((m) => m.role === "user");
      const firstPrompt =
        typeof firstUser?.content === "string"
          ? firstUser.content
          : firstUser?.content
            ? firstUser.content.find((p) => p.type === "text")?.text ?? "(no prompt)"
            : "(no prompt)";
      summaries.push({
        id: parsed.id,
        filePath: path,
        cwd: parsed.cwd,
        firstPrompt: firstPrompt.slice(0, 80),
        title: parsed.title,
        messageCount: parsed.messages.filter((m) => m.role !== "system").length,
        updatedAt: parsed.updatedAt ?? s.mtime.toISOString(),
        checkpointCount: parsed.checkpoints?.length ?? 0,
      });
    } catch {
      /* skip unreadable */
    }
  }
  summaries.sort((a, b) => (b.updatedAt < a.updatedAt ? -1 : 1));
  return summaries.slice(0, limit);
}

export async function loadSession(filePath: string): Promise<SessionFile> {
  const raw = await readFile(filePath, "utf8");
  const file = JSON.parse(raw) as SessionFile;
  // A turn interrupted mid-tool-call may have been saved with assistant
  // tool_calls that never got results; the API rejects such a history
  // ("No tool output found for function call …"). Heal it on load.
  if (Array.isArray(file.messages)) repairDanglingToolCalls(file.messages);
  return file;
}

/** Add a checkpoint to an existing session file. */
export async function addCheckpoint(
  filePath: string,
  checkpoint: Checkpoint,
): Promise<void> {
  const file = await loadSession(filePath);
  if (!file.checkpoints) file.checkpoints = [];
  file.checkpoints.push(checkpoint);
  await saveSession(file);
}

/** Load a session and truncate to a specific checkpoint. */
export async function loadSessionFromCheckpoint(
  filePath: string,
  checkpointId: string,
): Promise<{ file: SessionFile; checkpoint: Checkpoint }> {
  const file = await loadSession(filePath);
  const checkpoint = file.checkpoints?.find((c) => c.id === checkpointId);
  if (!checkpoint) {
    throw new Error(`checkpoint ${checkpointId} not found`);
  }
  // Truncate messages to checkpoint turn index
  const truncated = file.messages.slice(0, checkpoint.turnIndex);
  return {
    file: {
      ...file,
      messages: truncated,
      sessionState: checkpoint.sessionState ?? file.sessionState,
      artifactStore: checkpoint.artifactStore ?? file.artifactStore,
    },
    checkpoint,
  };
}
