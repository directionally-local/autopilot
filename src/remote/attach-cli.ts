/**
 * `autopilot attach-remote`: open the interactive UI on a conversation that
 * runs in a sandbox on an Aster server (see docs/aster-api.md, "Interactive
 * client").
 *
 * The server and credential come from AUTOPILOT_REMOTE_URL and
 * AUTOPILOT_REMOTE_TOKEN, never argv. Either reconnect with --conversation,
 * or create a conversation with --workspace/--model: a code conversation
 * (the default) also needs --repo (plus --base-commit/--patch-file for
 * uncommitted local work); `--kind chat` opens a sandbox with no repository.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AppBridge } from "../ui/app-bridge.js";
import { RemoteClient, type RemoteConversation } from "./client.js";
import { normalizeServerUrl } from "./config.js";
import { describeRemoteFailure, REMOTE_COMMANDS, RemoteAttachSession, writeStateFile, type AttachOutcome } from "./attach-session.js";

export interface AttachRemoteFlags {
  conversation?: string;
  workspace?: string;
  /** "code" (default) clones --repo; "chat" is a repository-less sandbox. */
  kind?: string;
  repo?: string;
  model?: string;
  baseCommit?: string;
  patchFile?: string;
  stateFile?: string;
  title?: string;
}

/** Mounts the interactive UI and runs a session on it until it ends. */
export type MountRemoteView = (opts: {
  header: { title: string; detail: string[] };
  commands: typeof REMOTE_COMMANDS;
  run: (bridge: AppBridge) => Promise<void>;
}) => Promise<void>;

export interface AttachRemoteDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  mount: MountRemoteView;
  err?: (text: string) => void;
  newId?: () => string;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class AttachUsageError extends Error {}

export type AttachMode = "reconnect" | "create-code" | "create-chat";

/** Validate the flag combination before touching the network. */
export function checkFlags(flags: AttachRemoteFlags): AttachMode {
  const createFlags = [flags.workspace, flags.kind, flags.repo, flags.model, flags.baseCommit, flags.patchFile].some((v) => v !== undefined);
  if (flags.conversation !== undefined) {
    if (createFlags) throw new AttachUsageError("--conversation reconnects to an existing conversation; don't combine it with --workspace/--kind/--repo/--model/--base-commit/--patch-file");
    if (!flags.conversation.trim()) throw new AttachUsageError("--conversation needs an ID");
    return "reconnect";
  }
  const kind = flags.kind?.trim().toLowerCase() ?? "code";
  if (kind !== "code" && kind !== "chat") throw new AttachUsageError('--kind must be "code" (default) or "chat"');
  if (kind === "chat") {
    const missing = (["workspace", "model"] as const).filter((k) => !flags[k]);
    if (missing.length) throw new AttachUsageError(`Pass --conversation <id>, or --workspace and --model to start a chat (missing: ${missing.map((m) => `--${m}`).join(", ")})`);
    const codeOnly = ([["repo", flags.repo], ["base-commit", flags.baseCommit], ["patch-file", flags.patchFile]] as const).filter(([, v]) => v !== undefined).map(([name]) => `--${name}`);
    if (codeOnly.length) throw new AttachUsageError(`--kind chat has no repository; drop ${codeOnly.join(", ")} or use --kind code`);
    return "create-chat";
  }
  const missing = (["workspace", "repo", "model"] as const).filter((k) => !flags[k]);
  if (missing.length) throw new AttachUsageError(`Pass --conversation <id>, or --workspace, --repo and --model to start one (missing: ${missing.map((m) => `--${m}`).join(", ")}; --kind chat needs no --repo)`);
  if (!REPO_RE.test(flags.repo!)) throw new AttachUsageError("--repo must be owner/name");
  if (flags.baseCommit !== undefined && !SHA_RE.test(flags.baseCommit)) throw new AttachUsageError("--base-commit must be a full 40-character commit SHA");
  if (flags.patchFile !== undefined && flags.baseCommit === undefined) throw new AttachUsageError("--patch-file needs --base-commit (the commit the patch applies to)");
  return "create-code";
}

/**
 * The UI header: --title, else the repository (code) or the workspace's title (chat); the
 * second line says where the agent runs.
 */
export function remoteHeader(conversation: RemoteConversation, title: string | undefined, workspaceTitle?: string): { title: string; detail: string[] } {
  const chat = conversation.kind === "chat" || (!conversation.repository && conversation.kind !== "code");
  const place = chat ? workspaceTitle?.trim() || conversation.workspaceId : conversation.repository;
  const where = [conversation.model, chat ? place : conversation.repository, chat ? undefined : conversation.branch].filter(Boolean).join(" · ");
  return {
    title: title?.trim() || `autopilot · ${place || "remote"}`,
    detail: [
      `${where ? `${where} · ` : ""}remote session`,
      "/ for commands · Esc cancels the turn · Ctrl-D detaches (it keeps running on the server)",
    ],
  };
}

/** Run `attach-remote`; returns the process exit code (0 detached, 1 error). */
export async function attachRemote(flags: AttachRemoteFlags, deps: AttachRemoteDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const newId = deps.newId ?? (() => randomUUID());
  let mode: AttachMode;
  let client: RemoteClient;
  try {
    mode = checkFlags(flags);
    const url = env.AUTOPILOT_REMOTE_URL?.trim();
    const token = env.AUTOPILOT_REMOTE_TOKEN?.trim();
    if (!url) throw new AttachUsageError("AUTOPILOT_REMOTE_URL is not set (the server's base URL, e.g. http://127.0.0.1:53817)");
    if (!token) throw new AttachUsageError("AUTOPILOT_REMOTE_TOKEN is not set (the bearer token for this laptop)");
    client = new RemoteClient(normalizeServerUrl(url), token, deps.fetch ?? fetch);
  } catch (error) {
    err(`autopilot attach-remote: ${(error as Error).message}\n`);
    return 1;
  }

  let conversation: RemoteConversation;
  try {
    if (mode === "reconnect") {
      conversation = await client.getConversation(flags.conversation!.trim());
    } else if (mode === "create-chat") {
      conversation = await client.createChatConversation({
        workspaceId: flags.workspace!,
        model: flags.model!,
        idempotencyKey: `attach-${newId()}`,
      });
    } else {
      // Read here and handed straight to the request; never logged.
      const patch = flags.patchFile !== undefined ? await readFile(flags.patchFile, "utf8") : undefined;
      conversation = await client.createCodeConversation({
        workspaceId: flags.workspace!,
        model: flags.model!,
        repository: flags.repo!,
        ...(flags.baseCommit ? { baseCommit: flags.baseCommit } : {}),
        ...(patch ? { patch } : {}),
        idempotencyKey: `attach-${newId()}`,
      });
    }
    if (flags.stateFile) await writeStateFile(flags.stateFile, conversation);
  } catch (error) {
    err(`autopilot attach-remote: ${describeRemoteFailure(error)}\n`);
    return 1;
  }

  // Chat conversations are titled by their workspace; the list is cheap and best-effort.
  let workspaceTitle: string | undefined;
  if (conversation.kind === "chat" || (!conversation.repository && conversation.kind !== "code")) {
    workspaceTitle = (await client.workspaces().catch(() => []))
      .find((workspace) => workspace.id === conversation.workspaceId)?.displayName;
  }

  let outcome = { kind: "detached" } as AttachOutcome;
  let first = true;
  await deps.mount({
    header: remoteHeader(conversation, flags.title, workspaceTitle),
    commands: REMOTE_COMMANDS,
    // Called again with a fresh view if the renderer crashes: replay and follow again.
    run: async (bridge) => {
      const session = new RemoteAttachSession({ client, conversation, newId, created: mode !== "reconnect" && first });
      first = false;
      outcome = await session.run(bridge);
    },
  });
  const short = conversation.conversationId.slice(0, 8);
  if (outcome.kind === "fatal") {
    err(`autopilot attach-remote: ${outcome.message}\n`);
    return 1;
  }
  err(`Detached from conversation ${short}. It keeps running on the server.\n`);
  return 0;
}
