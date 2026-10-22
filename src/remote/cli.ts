import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { promisify } from "node:util";
import { openBrowser } from "../util/open-browser.js";
import { RemoteApiError, RemoteClient, TERMINAL_STATUSES, type RemoteConversation, type RemoteEvent } from "./client.js";
import { defaultRemoteName, loadRemotes, normalizeServerUrl, REMOTE_NAME_RE, removeRemote, resolveRemote, saveRemote, type RemoteServer } from "./config.js";
import { detectGitHubRepository, snapshotWorkingTree } from "./git.js";

const execFileAsync = promisify(execFile);
const RUN_EVENT_TYPES = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface RemoteIO {
  out: (text: string) => void;
  err: (text: string) => void;
}

const processIO: RemoteIO = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** `autopilot remote add <url>`: pair through the server's device-code flow. No keys are copied. */
export async function remoteAdd(
  input: { url: string; name?: string; open?: boolean; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> },
  io = processIO,
): Promise<RemoteServer> {
  const url = normalizeServerUrl(input.url);
  const name = input.name ?? defaultRemoteName(url);
  if (!REMOTE_NAME_RE.test(name)) throw new Error("Server names are 1-40 lowercase letters, digits, or dashes");
  const anonymous = new RemoteClient(url, undefined);
  const device = await anonymous.startDeviceAuthorization(clientName());
  io.out(`To pair this machine with ${url}, approve code ${device.userCode} at:\n  ${device.verificationUriComplete}\n`);
  if (input.open !== false && openBrowser(device.verificationUriComplete)) io.out("(opened in your browser)\n");
  io.out("Waiting for approval…\n");
  const credential = await anonymous.waitForCredential(device, {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.sleep ? { sleep: input.sleep } : {}),
  });
  const remote: RemoteServer = {
    name,
    url,
    token: credential.token,
    credentialId: credential.credentialId,
    expiresAt: credential.expiresAt,
    addedAt: new Date().toISOString(),
  };
  await new RemoteClient(url, remote.token).health();
  await saveRemote(remote);
  io.out(`✓ Paired as "${name}" (credential expires ${remote.expiresAt.slice(0, 10)}).\n  Try: autopilot --on ${name} "fix the flaky test"\n`);
  return remote;
}

export async function remoteList(io = processIO): Promise<void> {
  const remotes = await loadRemotes();
  if (remotes.length === 0) {
    io.out("No servers paired. Run: autopilot remote add https://your-server\n");
    return;
  }
  for (const remote of remotes) io.out(`${remote.name}\t${remote.url}\texpires ${remote.expiresAt.slice(0, 10)}\n`);
}

export async function remoteRemove(name: string, io = processIO): Promise<boolean> {
  const removed = await removeRemote(name);
  if (removed) io.out(`Removed "${name}". To revoke its credential on the server: autopilot aster token revoke <id>\n`);
  else io.err(`No server named "${name}".\n`);
  return removed;
}

/**
 * `autopilot --on <server> "task"`: run a task in a sandbox on the server, starting from
 * this checkout (uncommitted changes go along as a patch). Streams until the run ends;
 * Ctrl-C only detaches. Returns the process exit code.
 */
export async function runOnRemote(input: {
  remote?: string;
  task: string;
  cwd: string;
  model?: string;
  /** Used when the server offers it and no model was requested (the local default model). */
  preferredModel?: string;
  repository?: string;
  detach?: boolean;
  signal?: AbortSignal;
}, io = processIO): Promise<number> {
  const remote = await resolveRemote(input.remote);
  const client = new RemoteClient(remote.url, remote.token);
  const repository = input.repository ?? await detectGitHubRepository(input.cwd);
  const snapshot = await snapshotWorkingTree(input.cwd);
  const [workspaces, models] = await Promise.all([client.workspaces(), client.models()]);
  const workspace = workspaces[0];
  if (!workspace) throw new Error(`${remote.name} has no workspace this credential can use`);
  const model = pickModel(models, input.model, input.preferredModel);

  io.err(`Starting on ${remote.name}: ${repository} from ${snapshot.baseCommit.slice(0, 7)} (${snapshot.baseRef})`
    + `${snapshot.files.length ? `, with ${snapshot.files.length} changed file${snapshot.files.length === 1 ? "" : "s"}` : ""} · ${model}\n`);
  const conversation = await client.createCodeConversation({
    workspaceId: workspace.id,
    model,
    repository,
    baseCommit: snapshot.baseCommit,
    ...(snapshot.patch ? { patch: snapshot.patch } : {}),
    idempotencyKey: `cli-${randomUUID()}`,
  });
  await client.submitTurn(conversation.conversationId, input.task, `cli-${randomUUID()}`);
  const shortId = conversation.conversationId.slice(0, 8);
  io.err(`Run ${shortId} · branch ${conversation.branch ?? "?"}\n`);
  if (input.detach) {
    io.err(`Detached. Follow it with: autopilot runs watch ${shortId}\n`);
    return 0;
  }
  io.err(`Ctrl-C detaches; the run keeps going on the server (autopilot runs watch ${shortId}).\n\n`);
  return watchConversation(client, remote, conversation.conversationId, conversation.lastEventId, input.signal, io);
}

/** `autopilot runs`: runs on every paired server (or one), newest first. */
export async function listRuns(input: { remote?: string; json?: boolean }, io = processIO): Promise<void> {
  const remotes = input.remote ? [await resolveRemote(input.remote)] : await loadRemotes();
  if (remotes.length === 0) throw new Error("No servers paired yet. Run: autopilot remote add https://your-server");
  const rows: Array<RemoteConversation & { remote: string }> = [];
  for (const remote of remotes) {
    try {
      const runs = await new RemoteClient(remote.url, remote.token).listConversations();
      rows.push(...runs.filter((run) => run.kind === "code").map((run) => ({ ...run, remote: remote.name })));
    } catch (error) {
      io.err(`${remote.name}: ${describeError(error)}\n`);
    }
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (input.json) {
    io.out(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    io.out("No runs yet.\n");
    return;
  }
  for (const run of rows) {
    io.out([
      run.conversationId.slice(0, 8),
      run.remote,
      run.status.padEnd(16),
      run.repository ?? "",
      run.pullRequestURL ?? run.branch ?? "",
      run.createdAt.slice(0, 16).replace("T", " "),
    ].join("  ") + "\n");
  }
}

/** `autopilot runs watch <id>`: replay and follow a run's output. */
export async function watchRun(input: { id: string; remote?: string; signal?: AbortSignal }, io = processIO): Promise<number> {
  const { remote, run } = await findRun(input.id, input.remote);
  const client = new RemoteClient(remote.url, remote.token);
  // A finished run is replayed up to its last event; an active one is followed to its end.
  const finished = TERMINAL_STATUSES.has(run.status) && !run.activeRunId;
  return watchConversation(client, remote, run.conversationId, 0, input.signal, io, finished ? run.lastEventId : undefined);
}

export async function cancelRun(input: { id: string; remote?: string }, io = processIO): Promise<void> {
  const { remote, run } = await findRun(input.id, input.remote);
  const cancelled = await new RemoteClient(remote.url, remote.token).cancel(run.conversationId);
  io.out(`${run.conversationId.slice(0, 8)}: ${cancelled.status}\n`);
}

/** `autopilot pull <run>`: check out a run's branch locally. */
export async function pullRun(input: { id: string; remote?: string; cwd: string }, io = processIO): Promise<void> {
  const { run } = await findRun(input.id, input.remote);
  const branch = run.branch;
  if (!branch) throw new Error("That run has no branch");
  if (run.activeRunId) io.err("The run is still going; you'll get what it has pushed so far.\n");
  const git = (args: string[]) => execFileAsync("git", ["-C", input.cwd, ...args]);
  try {
    await git(["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  } catch {
    throw new Error(`Branch ${branch} isn't on origin yet (the run pushes it when a turn finishes)`);
  }
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).then(() => true, () => false);
  if (exists) {
    await git(["switch", branch]);
    await git(["merge", "--ff-only", `origin/${branch}`]);
  } else {
    await git(["switch", "-c", branch, "--track", `origin/${branch}`]);
  }
  io.out(`On ${branch}${run.pullRequestURL ? ` · ${run.pullRequestURL}` : ""}\n`);
}

async function watchConversation(
  client: RemoteClient,
  remote: RemoteServer,
  conversationId: string,
  cursor: number,
  signal: AbortSignal | undefined,
  io: RemoteIO,
  replayUntil?: number,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  // Ctrl-C during startup (before this listener existed) still detaches.
  if (signal?.aborted) stop();
  const renderer = new EventRenderer(io);
  let outcome: string | undefined;
  try {
    if (replayUntil === undefined || replayUntil > cursor) {
      for await (const event of client.events(conversationId, cursor, controller.signal)) {
        renderer.render(event);
        if (RUN_EVENT_TYPES.has(event.type)) outcome = event.type;
        if (replayUntil === undefined ? RUN_EVENT_TYPES.has(event.type) : event.id >= replayUntil) break;
      }
    }
    if (replayUntil !== undefined && !controller.signal.aborted) outcome ??= "completed";
  } finally {
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
  renderer.finish();
  const shortId = conversationId.slice(0, 8);
  if (!outcome) {
    io.err(`\nDetached from ${shortId}; it keeps running on ${remote.name}. Follow it with: autopilot runs watch ${shortId}\n`);
    return 0;
  }
  const final = await client.getConversation(conversationId);
  if (outcome === "completed") {
    io.err(`\n✓ ${shortId} completed${final.pullRequestURL ? `: ${final.pullRequestURL}` : " (no changes, so no pull request)"}\n`);
    if (final.pullRequestURL) io.err(`  Check it out locally: autopilot pull ${shortId}\n`);
    return 0;
  }
  io.err(`\n✗ ${shortId} ${outcome}\n`);
  return 1;
}

/** Writes assistant text as it streams and one line per tool call. */
class EventRenderer {
  private midLine = false;

  constructor(private readonly io: RemoteIO) {}

  render(event: RemoteEvent): void {
    const data = event.data;
    if (event.type === "assistant.delta") {
      const text = typeof data.text === "string" ? data.text : typeof data.delta === "string" ? data.delta : "";
      if (!text) return;
      this.io.out(text);
      this.midLine = !text.endsWith("\n");
      return;
    }
    if (event.type === "tool.activity" && data.activity === "started") {
      const input = typeof data.input === "string" ? ` ${oneLine(data.input, 120)}` : "";
      this.line(`  › ${String(data.tool ?? "tool")}${input}`);
      return;
    }
    if (event.type === "tool.activity" && data.activity === "failed") {
      this.line(`  ✗ ${String(data.tool ?? "tool")} failed`);
      return;
    }
    if (event.type === "checkpoint.created" && typeof data.message === "string") {
      this.line(`  ● ${oneLine(data.message, 100)}`);
    }
  }

  finish(): void {
    if (this.midLine) this.io.out("\n");
    this.midLine = false;
  }

  private line(text: string): void {
    this.finish();
    this.io.out(`${text}\n`);
  }
}

async function findRun(id: string, remoteName?: string): Promise<{ remote: RemoteServer; run: RemoteConversation }> {
  const needle = id.trim().toLowerCase();
  if (!/^[0-9a-f-]{4,36}$/.test(needle)) throw new Error("Run IDs are the hex IDs `autopilot runs` shows");
  const remotes = remoteName ? [await resolveRemote(remoteName)] : await loadRemotes();
  const matches: Array<{ remote: RemoteServer; run: RemoteConversation }> = [];
  for (const remote of remotes) {
    const runs = await new RemoteClient(remote.url, remote.token).listConversations(200).catch(() => []);
    for (const run of runs) if (run.conversationId.startsWith(needle)) matches.push({ remote, run });
  }
  if (matches.length === 0) throw new Error(`No run ${id} on ${remoteName ?? "any paired server"}`);
  if (matches.length > 1) throw new Error(`${id} matches several runs; use more characters`);
  return matches[0]!;
}

function pickModel(models: string[], requested: string | undefined, preferred: string | undefined): string {
  if (requested) {
    if (!models.includes(requested)) throw new Error(`The server doesn't offer ${requested}`);
    return requested;
  }
  if (preferred && models.includes(preferred)) return preferred;
  const first = models[0];
  if (!first) throw new Error("The server offers no models");
  return first;
}

function clientName(): string {
  const host = hostname().replace(/\.local$/, "").replace(/[^\p{L}\p{N} ._'()@-]/gu, "-").slice(0, 40) || "laptop";
  return `${host} (autopilot)`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function describeError(error: unknown): string {
  if (error instanceof RemoteApiError) return `${error.message} (${error.code})`;
  return error instanceof Error ? error.message : String(error);
}
