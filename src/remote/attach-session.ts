/**
 * `autopilot attach-remote`: the interactive UI on a conversation that runs
 * in a sandbox on an Aster server.
 *
 * RemoteAttachSession stands in for App on the other side of the AppBridge:
 * it turns Aster SSE events into snapshots (through attach-adapter) and the
 * view's actions into API calls. Typed messages become turns (one
 * clientTurnId each); messages typed while a turn runs queue, as they do
 * locally. Esc cancels the running turn on the server; quitting only
 * detaches, and the conversation keeps going.
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppActions, AppBridge, AppSnapshot } from "../ui/app-bridge.js";
import type { ChatEvent } from "../ui/view-types.js";
import type { PermissionDecision } from "../tools/executor.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtins.js";
import { getModel, getModelOrInfer, type ModelEntry } from "../models/registry.js";
import { applyAsterEvent, initialAsterState, totalCostUsd, type AsterEffect, type AsterViewState } from "./attach-adapter.js";
import { RemoteApiError, type RemoteClient, type RemoteConversation, type RemoteEvent, type RemoteModelInfo } from "./client.js";

/** The commands a remote session handles; everything else built in is local-only. */
export const REMOTE_COMMANDS: { name: string; description: string; args_hint?: string }[] = [
  { name: "help", description: "Commands available in a remote session" },
  { name: "model", description: "Pick one of the server's models for the next turn (list prints them)", args_hint: "[<id>|list]" },
  { name: "status", description: "Conversation, branch, pull request and model" },
  { name: "pr", description: "Show the conversation's pull request" },
  { name: "exit", description: "Detach (the conversation keeps running on the server)" },
];

const REMOTE_COMMAND_NAMES = new Set([...REMOTE_COMMANDS.map((c) => c.name), "quit", "detach"]);

export const REVOKED_MESSAGE =
  "this laptop's credential was revoked or expired (the server answered 401). Pair this machine with the server again, then reconnect.";

export type AttachOutcome = { kind: "detached" } | { kind: "fatal"; message: string };

export interface StateFileContents {
  conversationId: string;
  branch: string | null;
  repository: string | null;
}

/** Write the reconnect state dl reads next time: JSON, mode 0600, replaced atomically. */
export async function writeStateFile(path: string, conversation: RemoteConversation): Promise<StateFileContents> {
  const contents: StateFileContents = {
    conversationId: conversation.conversationId,
    branch: conversation.branch ?? null,
    repository: conversation.repository ?? null,
  };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return contents;
}

/**
 * The picker's entries for the server's models, in the server's order. The
 * local catalog's entry wins (it has the benchmark scores the picker ranks by),
 * then the server's metadata, then a generic entry, so every ID is pickable.
 */
export function serverModelEntries(ids: string[], catalog: RemoteModelInfo[]): ModelEntry[] {
  const info = new Map(catalog.map((m) => [m.id, m]));
  return ids.map((id) => {
    const local = getModel(id);
    if (local) return local;
    const fallback = getModelOrInfer(id);
    const m = info.get(id);
    if (!m) return fallback;
    return {
      ...fallback,
      ...(m.name ? { name: m.name } : {}),
      ...(m.created !== undefined ? { created: m.created } : {}),
      contextWindow: m.contextWindow ?? fallback.contextWindow,
      pricing: { inputPerMtok: m.inputPerMtok ?? 0, outputPerMtok: m.outputPerMtok ?? 0 },
      supports: { ...fallback.supports, reasoning: m.reasoning ?? false, vision: m.vision ?? false },
    };
  });
}

/** A one-line description of an API failure; 401 always means the credential is gone. */
export function describeRemoteFailure(error: unknown): string {
  if (error instanceof RemoteApiError) {
    if (error.status === 401) return REVOKED_MESSAGE;
    if (error.code === "conversation_not_found") return "the server has no such conversation for this credential (it may have been deleted).";
    return `${error.message} (${error.code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

export interface RemoteAttachSessionOpts {
  client: RemoteClient;
  conversation: RemoteConversation;
  /** IDs for clientTurnId (tests make them predictable). */
  newId?: () => string;
  /** True for a freshly created conversation (no history to replay). */
  created?: boolean;
}

interface QueuedMessage {
  key: string;
  text: string;
}

export class RemoteAttachSession {
  readonly state: AsterViewState = initialAsterState();
  private readonly client: RemoteClient;
  private conversation: RemoteConversation;
  private readonly newId: () => string;
  private bridge: AppBridge | null = null;
  private readonly abort = new AbortController();
  private finish: ((outcome: AttachOutcome) => void) | null = null;
  private outcome: AttachOutcome | null = null;
  /** Local notices and the user's messages, merged into the transcript by event order. */
  private readonly queue: QueuedMessage[] = [];
  /** A submit is in flight or a turn is running (events set state.running; this covers the gap before them). */
  private submitting = false;
  /** History before this event ID is replayed, not live: input waits until it's caught up. */
  private replayUntil: number;
  private model: string;
  private nextModel: string | null = null;
  private serverModels: ModelEntry[] | null = null;
  /** `/model` opened the picker (the view draws it from snapshot.modelChoices). */
  private pickingModel = false;
  private shownPullRequest: string | undefined;
  private permission: AppSnapshot["permission"] = null;
  private keySeq = 0;
  private scheduled = false;
  private reconnecting = false;
  /** Turn-ending events seen; a turn that ends before its submit returns mustn't be marked running again. */
  private turnsEnded = 0;

  constructor(opts: RemoteAttachSessionOpts) {
    this.client = opts.client;
    this.conversation = opts.conversation;
    this.newId = opts.newId ?? (() => randomUUID());
    this.model = opts.conversation.model;
    this.replayUntil = opts.conversation.lastEventId;
    this.note(connectionNote(opts.conversation, opts.created === true));
    if (opts.conversation.activeRunId) this.state.running = true;
  }

  /** Mount on the view: resolves when the user detaches or the session can't continue. */
  run(bridge: AppBridge): Promise<AttachOutcome> {
    this.bridge = bridge;
    bridge.connect(this.actions());
    const done = new Promise<AttachOutcome>((resolve) => {
      this.finish = resolve;
    });
    this.maybeShowPullRequest(this.conversation.pullRequestURL);
    this.flush();
    void this.follow();
    return done;
  }

  /** Stop following and resolve run(). The conversation on the server is untouched. */
  end(outcome: AttachOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.abort.abort();
    this.finish?.(outcome);
  }

  get replaying(): boolean {
    return this.state.lastEventId < this.replayUntil;
  }

  get busy(): boolean {
    return this.submitting || this.state.running || this.replaying;
  }

  snapshot(): AppSnapshot {
    const usage = this.state.usage;
    return {
      events: this.state.events,
      busy: this.state.running || this.submitting,
      turnRunning: this.state.running || this.submitting,
      sessionId: null,
      workers: [],
      mode: "auto",
      modesEnabled: false,
      model: this.nextModel ?? this.model,
      usage,
      sessionUsage: totalCostUsd(this.state) > 0 || usage
        ? {
            date: new Date().toISOString().slice(0, 10),
            promptTokens: usage?.prompt_tokens ?? 0,
            completionTokens: usage?.completion_tokens ?? 0,
            cachedTokens: 0,
            cost: totalCostUsd(this.state),
          }
        : null,
      // The server owns the context window; don't show a percentage of an unknown limit.
      contextLimit: 0,
      turnPhase: this.state.phase,
      currentTool: this.state.currentTool,
      kimiMdStale: false,
      codeMode: false,
      intentTier: null,
      tasks: this.state.tasks,
      permission: this.permission,
      modals: this.pickingModel ? ["model"] : [],
      ...(this.pickingModel && this.serverModels ? { modelChoices: this.serverModels } : {}),
      providerSetup: null,
      resumeSessions: null,
      checkpoints: null,
      planOptions: null,
      queuePlan: null,
      customCommands: [],
      currentShell: "auto",
      memoryEnabled: false,
      customCommandDefs: [],
      commandWizard: null,
      commandPickerMode: null,
      changelogImageRepo: null,
      hooks: [],
      lsp: { servers: {}, scope: "global", hasProjectDir: false },
    };
  }

  // ----- the view's actions --------------------------------------------------

  private actions(): AppActions {
    const unavailable = (what: string) => () => this.warn(`${what} isn't available in a remote session.`);
    return {
      submit: (text) => this.submit(text),
      interrupt: () => void this.cancel(),
      cycleMode: () => this.info("Remote sessions always run in auto mode on the server."),
      decidePermission: (decision) => void this.decide(decision),
      denyWithFeedback: (feedback) => {
        void this.decide("deny");
        this.submit(feedback);
      },
      pickModel: (model) => {
        // Esc (null) leaves the next turn's model as it was.
        this.pickingModel = false;
        this.flush();
        if (model) void this.switchModel(model.id);
      },
      providerSwitched: unavailable("Switching providers"),
      pickMode: () => {},
      pickResume: () => {},
      pickCheckpoint: () => {},
      pickPlanOption: () => {},
      pickPlanComplete: () => {},
      pickQueuePlan: () => {},
      pickShell: () => {},
      generateChangelogImage: unavailable("/changelog-image"),
      saveLsp: unavailable("Language servers"),
      reloadHooks: () => [],
      openCommandWizard: unavailable("Custom commands"),
      saveCommand: unavailable("Custom commands"),
      deleteCommand: unavailable("Custom commands"),
      closeModal: (modal) => {
        if (modal !== "model") return;
        this.pickingModel = false;
        this.flush();
      },
      runCommand: (command) => this.submit(command),
      exit: () => this.end({ kind: "detached" }),
    };
  }

  /** Typed text: a remote command, a refusal for a local-only one, or a message for the agent. */
  submit(raw: string): void {
    const text = raw.trim();
    if (!text) return;
    if (text.startsWith("!")) {
      return this.warn("Shell commands (!) run on this laptop, so they're off in a remote session. Ask the agent to run it in the sandbox instead.");
    }
    const command = /^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text);
    if (command) {
      const name = command[1]!;
      const args = command[2]?.trim() ?? "";
      if (REMOTE_COMMAND_NAMES.has(name)) return this.command(name, args);
      if (BUILTIN_COMMAND_NAMES.has(name)) {
        return this.warn(`/${name} works on this laptop's session, so it's off in a remote session. Type /help for what works here.`);
      }
      return this.warn(`Unknown command /${name}. Type /help for what works in a remote session.`);
    }
    const laptopImages = laptopImagePaths(text);
    if (laptopImages.length > 0) {
      return this.warn(`Not sent: ${laptopImages.join(", ")} is a file on this laptop, and a remote session can't attach it. Remove the path (files in the repository can be named relative to it) and send again.`);
    }
    const key = this.key("user");
    if (this.busy || this.queue.length > 0) {
      this.state.events.push({ kind: "user", key, text, queued: true });
      this.queue.push({ key, text });
      this.flush();
      return;
    }
    this.state.events.push({ kind: "user", key, text });
    void this.dispatch({ key, text });
  }

  private command(name: string, args: string): void {
    switch (name) {
      case "help":
        return this.info(
          [
            "Remote session: the agent runs in a sandbox on the server.",
            ...REMOTE_COMMANDS.map((c) => `  /${c.name}${c.args_hint ? ` ${c.args_hint}` : ""} — ${c.description}`),
            "  Esc — cancel the running turn on the server",
            "  Ctrl-D or /exit — detach; the conversation keeps running on the server",
            "Messages typed while a turn runs are queued and sent when it ends.",
          ].join("\n"),
        );
      case "model":
        if (!args) return void this.openModelPicker();
        if (args === "list") return void this.listModels();
        return void this.switchModel(args);
      case "status": {
        const c = this.conversation;
        return this.info(
          [
            `Conversation  ${c.conversationId}`,
            ...(c.repository ? [`Repository    ${c.repository}`] : []),
            ...(c.branch ? [`Branch        ${c.branch}`] : []),
            `Pull request  ${this.shownPullRequest ?? "none yet"}`,
            `Model         ${this.model}${this.nextModel ? ` (next turn: ${this.nextModel})` : ""}`,
            `Turn          ${this.state.running ? "running" : "idle"}${this.queue.length ? ` · ${this.queue.length} queued` : ""}`,
          ].join("\n"),
        );
      }
      case "pr":
        return this.info(this.shownPullRequest ? `Pull request: ${this.shownPullRequest}` : "No pull request yet: the server opens one after a turn that changes the repository.");
      default:
        // exit, quit, detach
        return this.end({ kind: "detached" });
    }
  }

  /** `/model` with no ID: the same picker as a local session, offering only the server's models. */
  private async openModelPicker(): Promise<void> {
    const models = await this.models();
    if (this.outcome) return;
    if (!models?.length) return this.listModels();
    this.pickingModel = true;
    this.flush();
  }

  private async listModels(): Promise<void> {
    const models = (await this.models())?.map((m) => m.id);
    const lines = [`Current model: ${this.model}${this.nextModel ? ` (next turn: ${this.nextModel})` : ""}`];
    if (models?.length) lines.push("Offered by the server:", ...models.slice(0, 40).map((m) => `  ${m}`), ...(models.length > 40 ? [`  … and ${models.length - 40} more`] : []), "Switch with /model <id>.");
    else lines.push("Switch with /model <id> (the server checks it against its catalog).");
    this.info(lines.join("\n"));
  }

  private async switchModel(id: string): Promise<void> {
    const models = await this.models();
    if (models && !models.some((m) => m.id === id)) {
      return this.warn(`The server doesn't offer ${id}. /model lists the ones it does.`);
    }
    if (id === this.model) {
      this.nextModel = null;
      return this.info(`Already using ${id}.`);
    }
    this.nextModel = id;
    this.info(`The next turn uses ${id}.`);
  }

  private async models(): Promise<ModelEntry[] | null> {
    if (this.serverModels) return this.serverModels;
    try {
      const { models, catalog } = await this.client.modelCatalog();
      this.serverModels = serverModelEntries(models, catalog);
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return null;
      return null;
    }
    return this.serverModels;
  }

  /** Send one message as a turn. Keyed by clientTurnId, so the client's retries can't start it twice. */
  private async dispatch(msg: QueuedMessage): Promise<void> {
    this.submitting = true;
    this.state.phase = "generating";
    this.flush();
    const model = this.nextModel ?? undefined;
    const endedBefore = this.turnsEnded;
    try {
      await this.client.submitTurn(this.conversation.conversationId, msg.text, `attach-${this.newId()}`, model);
      if (model) {
        this.model = model;
        this.nextModel = null;
      }
      if (this.turnsEnded === endedBefore) this.state.running = true;
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return;
      const busy = error instanceof RemoteApiError && error.code === "conversation_busy";
      this.error(
        busy
          ? "Not sent: the server is still running another turn on this conversation (from another client?). Send it again when that one ends."
          : `Not sent: ${describeRemoteFailure(error)}`,
      );
      if (error instanceof RemoteApiError && error.code === "model_not_allowed") this.nextModel = null;
    } finally {
      this.submitting = false;
      this.flush();
      if (!this.state.running) this.drain();
    }
  }

  /** The next queued message, once nothing is running. */
  private drain(): void {
    if (this.outcome || this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.state.events = this.state.events.map((e) => (e.kind === "user" && e.key === next.key ? { ...e, queued: false } : e));
    void this.dispatch(next);
  }

  private async cancel(): Promise<void> {
    if (!this.state.running && !this.submitting) return;
    try {
      await this.client.cancel(this.conversation.conversationId);
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return;
      this.error(`Couldn't cancel the turn: ${describeRemoteFailure(error)}`);
    }
  }

  private async decide(decision: PermissionDecision): Promise<void> {
    const approval = this.state.approval;
    this.permission = null;
    this.flush();
    if (!approval) return;
    try {
      // The server has no "for this session" grant: allow_session allows this one action.
      await this.client.decideApproval(approval.approvalId, decision === "deny" ? "deny" : "allow");
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return;
      this.error(`Couldn't answer the approval: ${describeRemoteFailure(error)}`);
    }
  }

  // ----- events ----------------------------------------------------------------

  /** Follow the event stream from the start (replaying history), reconnecting with Last-Event-ID. */
  private async follow(): Promise<void> {
    try {
      const events = this.client.events(this.conversation.conversationId, this.state.lastEventId, this.abort.signal, {
        onRetry: () => {
          if (this.reconnecting) return;
          this.reconnecting = true;
          this.warn("Lost the connection to the server; reconnecting…");
        },
      });
      for await (const event of events) {
        if (this.reconnecting) {
          this.reconnecting = false;
        }
        this.apply(event);
      }
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.end({ kind: "fatal", message: describeRemoteFailure(error) });
    }
  }

  /** Apply one event from the stream. */
  apply(event: RemoteEvent): void {
    const wasReplaying = this.replaying;
    const effects = applyAsterEvent(this.state, event);
    for (const effect of effects) this.effect(effect);
    if (wasReplaying && !this.replaying) void this.caughtUp();
    this.flush();
  }

  private effect(effect: AsterEffect): void {
    switch (effect.kind) {
      case "turnEnded":
        this.turnsEnded++;
        if (this.replaying) return;
        void this.afterTurn();
        return;
      case "approvalRequired":
        void this.showApproval(effect.approvalId);
        return;
      case "approvalResolved":
        this.permission = null;
        return;
    }
  }

  /** History is replayed: the conversation's current state decides whether a turn is still running. */
  private async caughtUp(): Promise<void> {
    try {
      const conversation = await this.client.getConversation(this.conversation.conversationId);
      this.conversation = conversation;
      if (conversation.activeRunId && !["completed", "failed", "cancelled", "interrupted"].includes(conversation.status)) this.state.running = true;
      this.maybeShowPullRequest(conversation.pullRequestURL);
    } catch (error) {
      this.fatalIfUnauthorized(error);
    }
    this.flush();
    this.drain();
  }

  /** A live turn ended: show a new pull request, then send the next queued message. */
  private async afterTurn(): Promise<void> {
    try {
      const conversation = await this.client.getConversation(this.conversation.conversationId);
      this.conversation = conversation;
      this.model = this.nextModel ? this.model : conversation.model || this.model;
      this.maybeShowPullRequest(conversation.pullRequestURL);
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return;
    }
    this.flush();
    this.drain();
  }

  private maybeShowPullRequest(url: string | undefined): void {
    if (!url || url === this.shownPullRequest) return;
    const changed = this.shownPullRequest !== undefined;
    this.shownPullRequest = url;
    this.info(`${changed ? "Pull request changed" : "Pull request"}: ${url}`);
  }

  private async showApproval(approvalId: string): Promise<void> {
    let args: Record<string, unknown> = {};
    try {
      const approval = await this.client.getApproval(approvalId);
      if (approval.status !== "pending") return;
      args = approval.arguments ?? {};
    } catch (error) {
      if (this.fatalIfUnauthorized(error)) return;
      // Expired or unreadable: the prompt still works from the event's summary.
    }
    const pending = this.state.approval;
    if (!pending || pending.approvalId !== approvalId) return;
    const title = pending.explanation || pending.tool;
    this.permission = {
      tool: { name: pending.tool, description: title, parameters: {}, needsPermission: true, run: async () => "", render: () => ({ title }) } as never,
      args: { ...args },
    };
    this.flush();
  }

  private fatalIfUnauthorized(error: unknown): boolean {
    if (error instanceof RemoteApiError && error.status === 401) {
      this.end({ kind: "fatal", message: REVOKED_MESSAGE });
      return true;
    }
    return false;
  }

  // ----- transcript helpers ----------------------------------------------------

  private key(prefix: string): string {
    return `local-${prefix}-${++this.keySeq}`;
  }

  private note(text: string): void {
    this.state.events.push({ kind: "info", key: this.key("info"), text });
  }

  private info(text: string): void {
    this.pushLocal({ kind: "info", key: this.key("info"), text });
  }

  private warn(text: string): void {
    this.pushLocal({ kind: "info", key: this.key("warn"), text, tone: "warn" });
  }

  private error(text: string): void {
    this.pushLocal({ kind: "error", key: this.key("error"), text });
  }

  private pushLocal(event: ChatEvent): void {
    this.state.events.push(event);
    this.flush();
  }

  /** Send a snapshot, coalescing a burst of events into one. */
  private flush(): void {
    if (!this.bridge || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.bridge) this.bridge.sync(this.snapshot());
    });
  }
}

/**
 * The first line of the transcript. A conversation this attach created, or one with no
 * output yet (its log holds only `conversation.created`), is "Connected": there is no
 * earlier output to announce. Only a conversation with history is "Reconnected".
 */
export function connectionNote(conversation: RemoteConversation, created: boolean): string {
  const short = conversation.conversationId.slice(0, 8);
  const branch = conversation.branch ? ` · branch ${conversation.branch}` : "";
  if (created) return `Connected to conversation ${short}${branch}, created on the server just now. The agent runs in a sandbox there.`;
  if (conversation.lastEventId <= 1 && !conversation.activeRunId) return `Connected to conversation ${short}${branch}. Nothing has happened in it yet; the agent runs in a sandbox on the server.`;
  return `Reconnected to conversation ${short}${branch}. Earlier output follows (the server's log keeps the agent's side, not your past messages).`;
}

/** Absolute (or ~) image paths: files only this laptop has. */
export function laptopImagePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)["']?((?:~|\/)[^\s"']*\.(?:png|jpe?g|gif|webp|bmp|heic))["']?/gi)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}
