/**
 * Camouflage UI (`--ui camouflage`): the same App as the Ink UI, drawn by
 * the Camouflage inline renderer.
 *
 * App keeps all of autopilot's interactive logic (turns, slash commands,
 * MCP/LSP/memory/hooks, queueing, sessions). Through an AppBridge it reports
 * what's on screen after each render; this module turns that into renderer
 * events and turns the user's input back into App actions. Ink renders
 * nothing in this mode.
 *
 * Needs camouflage-tui with the inline SDK. CAMOUFLAGE_BIN overrides the
 * renderer binary.
 */

import { execFileSync, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppActions, AppBridge, AppModal, AppSnapshot } from "./ui/app-bridge.js";
import type { ChatEvent } from "./ui/chat.js";
import type { ToolEventState } from "./ui/tool-view.js";
import type { Cfg } from "./app.js";
import { BUILTIN_COMMANDS, BUILTIN_COMMAND_NAMES } from "./commands/builtins.js";
import type { CustomCommand, CommandSource } from "./commands/types.js";
import { loadConfig, type ReasoningEffort } from "./config.js";
import { getPreset, type ProviderId } from "./providers/presets.js";
import { resolveProviderKey } from "./providers/resolve.js";
import {
  chatgptSignIn,
  commitProvider,
  copilotSignIn,
  credentialLabel,
  describeConnection,
  isVertexProjectId,
  maskKey,
  normalizeEndpoint,
  openRouterSignIn,
  planConnect,
  providerRows,
  saveVertexProject,
  verifyProvider,
  type Connection,
  type KeySource,
} from "./providers/connect.js";
import { OPENROUTER_KEYS_URL } from "./models/openrouter.js";
import { featuredModels, listModels, type ModelEntry } from "./models/registry.js";
import { formatContext, formatModelPrice } from "./ui/model-picker.js";
import { CATEGORIES, SINGLE_COMMANDS } from "./ui/help-menu.js";
import { FEEDBACK_WORKER_URL, openBrowser } from "./ui/app-helpers.js";
import { registerTerminalHandoff } from "./ui/bang-command.js";
import { PRESETS as LSP_PRESETS } from "./ui/lsp-wizard.js";
import { getShellCommand } from "./tools/bash.js";
import type { LspServerConfig } from "./config.js";
import type { HookConfig, HookEvent } from "./hooks/types.js";
import { RECOMMENDED_HOOKS } from "./hooks/recommended.js";
import { setHookEnabled, appendHook, deriveHookId } from "./hooks/settings.js";
import { EVENT_DESCRIPTIONS, EVENT_COMMAND_EXAMPLES, MATCHER_EXAMPLES } from "./ui/hooks-wizard.js";
import { MODES, type Mode } from "./mode.js";
import { logger } from "./util/logger.js";
import { JobManager, type JobRecord } from "./jobs/manager.js";
import { activityFromJob, activityFromSubagent, diffActivityItems, isActiveJob, type ActivityItem } from "./ui/activity.js";
import { workerRegistry, type RunningWorker } from "./tools/worker-registry.js";

interface CamouflageHandle {
  send(eventType: string, payload?: Record<string, unknown>): boolean;
  on(event: string, listener: (...args: any[]) => void): this;
  close(): Promise<number>;
}
interface CamouflageSdk {
  mount(opts: Record<string, unknown>): Promise<CamouflageHandle>;
  permission(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ choice: "allow_once" | "allow_session" | "deny" }>;
  selectList(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; value?: string; cancelled: boolean }>;
  confirm(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; value?: boolean; cancelled: boolean }>;
  form(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; values?: Record<string, string>; cancelled: boolean }>;
  /** camouflage-tui 2.4.0-beta.7+. */
  suspendTerminal?(cam: CamouflageHandle, opts?: { timeoutMs?: number }): Promise<{ supported: boolean }>;
  resumeTerminal?(cam: CamouflageHandle): void;
}

/** The renderer couldn't start (not installed, no binary for this
 *  platform); nothing has been drawn, so the caller can fall back to Ink. */
export class CamouflageUnavailable extends Error {}

async function loadSdk(): Promise<CamouflageSdk> {
  const sdk = (await import("camouflage-tui").catch((err) => {
    throw new CamouflageUnavailable(`camouflage-tui is not installed (${(err as Error).message})`);
  })) as unknown as Partial<CamouflageSdk>;
  if (typeof sdk.permission !== "function" || typeof sdk.mount !== "function" || typeof sdk.selectList !== "function") {
    throw new CamouflageUnavailable("the installed camouflage-tui is too old");
  }
  return sdk as CamouflageSdk;
}

/** The renderer exited unexpectedly mid-session (not the user quitting). */
export class CamouflageCrashed extends Error {
  constructor(
    message: string,
    /** The session to reopen in the Ink UI, if the App had started one. */
    readonly sessionId: string | null,
  ) {
    super(message);
  }
}

export interface RendererInfo {
  packageVersion: string | null;
  /** The binary mount() runs. */
  binary: string;
  source: "CAMOUFLAGE_BIN" | "package" | "PATH";
  /** `<binary> --version`, when the renderer supports it. */
  binaryVersion: string | null;
}

/**
 * Which renderer will run (#862). The SDK uses the binary its postinstall
 * downloaded and falls back to `camouflage-tui` on PATH, which can be a stale
 * build when that download failed — so log both, and say so when it happens.
 */
export function rendererInfo(env: NodeJS.ProcessEnv = process.env): RendererInfo {
  let packageVersion: string | null = null;
  let packageBin: string | null = null;
  try {
    // The package's exports don't include package.json: resolve its entry
    // point and walk up to the package root.
    let dir = dirname(fileURLToPath(import.meta.resolve("camouflage-tui")));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    packageVersion = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? null;
    const local = join(dir, "bin", process.platform === "win32" ? "camouflage-tui.exe" : "camouflage-tui");
    if (existsSync(local)) packageBin = local;
  } catch {
    // not installed: mount() reports that
  }
  let binary: string;
  let source: RendererInfo["source"];
  if (env.CAMOUFLAGE_BIN) {
    binary = env.CAMOUFLAGE_BIN;
    source = "CAMOUFLAGE_BIN";
  } else if (packageBin) {
    binary = packageBin;
    source = "package";
  } else {
    source = "PATH";
    try {
      binary = execFileSync(process.platform === "win32" ? "where" : "which", ["camouflage-tui"], { encoding: "utf8", timeout: 2000 }).trim().split("\n")[0] || "camouflage-tui";
    } catch {
      binary = "camouflage-tui";
    }
  }
  let binaryVersion: string | null = null;
  try {
    binaryVersion = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    // older renderers don't support --version
  }
  return { packageVersion, binary, source, binaryVersion };
}

export interface CamouflageViewOpts {
  cfg: Cfg;
  version: string;
  /** Mount App with this bridge (renderApp with the bridge, Ink drawing nothing). */
  runApp: (bridge: AppBridge) => Promise<void>;
}

export async function runCamouflageView(opts: CamouflageViewOpts): Promise<void> {
  const sdk = await loadSdk();
  const renderer = rendererInfo();
  logger.info("camouflage.renderer", { ...renderer });
  const restoreConsole = captureConsole();
  let cam: CamouflageHandle;
  try {
    cam = await sdk.mount({
      ui: "inline",
      appTitle: "autopilot",
      inheritStderr: false,
      ...(process.env.CAMOUFLAGE_BIN ? { bin: process.env.CAMOUFLAGE_BIN } : {}),
    });
  } catch (err) {
    restoreConsole();
    throw new CamouflageUnavailable((err as Error).message);
  }
  cam.on("stderr", (chunk: string) => logger.warn("camouflage.stderr", { chunk }));
  if (renderer.source === "PATH") {
    // The package's own binary is missing (its install step failed): whatever
    // is on PATH may be an old build with bugs fixed long ago.
    logger.warn("camouflage.renderer_from_path", { ...renderer });
    cam.send("RuntimeError", {
      message: `camouflage-tui ${renderer.packageVersion ?? ""} has no renderer binary of its own (its install step failed), so ${renderer.binary} from PATH is used and may be outdated. Reinstall autopilot-ai to fix it.`,
      severity: "warning",
    });
  }

  const cwd = process.cwd();
  cam.send("SessionStarted", {
    title: `autopilot ${opts.version}`,
    detail: [
      [shortModel(opts.cfg.model), shortPath(cwd), gitBranch(cwd)].filter(Boolean).join(" · "),
      `/ for commands · @ to mention files${opts.cfg.modesEnabled ? " · shift+tab to switch modes" : ""}`,
    ],
    accent: "orange",
    assistant_label: "autopilot",
  });
  const files = listFiles(cwd);
  if (files.length > 0) {
    cam.send("MentionCandidatesRegistered", { candidates: files.map((token) => ({ token, kind: "file" })) });
  }

  const view = new View(cam, sdk);
  // `!` commands borrow the terminal from the renderer while they run.
  registerTerminalHandoff({
    suspend: async () => (sdk.suspendTerminal ? (await sdk.suspendTerminal(cam)).supported : false),
    resume: () => sdk.resumeTerminal?.(cam),
  });
  cam.on("userInput", (text: string) => {
    if (view.routeActivityCommand(text)) return;
    view.echoed.push(text.trim());
    view.actions?.submit(text);
  });
  // Esc during a provider sign-in cancels the sign-in, not the turn.
  cam.on("cancelRequested", () => (view.signIn ? view.signIn.abort() : view.actions?.interrupt()));
  // `@../`, `@~/`, `@/`: list the folder being typed (same rules as the Ink
  // picker). Read off the raw stream so any SDK version works.
  cam.on("event", (ev: { event_type?: string; payload?: { query?: string } }) => {
    if (ev.event_type !== "MentionQuery") return;
    const query = ev.payload?.query ?? "";
    void listMentionDir(cwd, query).then(({ dir, entries }) => {
      cam.send("MentionCandidatesRegistered", {
        for_query: dir,
        candidates: entries.map((e) => ({ token: e, kind: e.endsWith("/") ? "dir" : "file" })),
      });
    });
  });
  cam.on("modeChangeRequested", () => view.actions?.cycleMode());
  cam.on("activityStopRequested", ({ id }: { id: string }) => view.stopActivity(id));
  cam.on("activityViewChanged", (change: { view: "list" | "detail" | "closed"; id?: string }) => {
    view.activityViewChanged(change);
  });

  let closing = false;
  const finish = async () => {
    if (closing) return;
    closing = true;
    view.dispose();
    registerTerminalHandoff(null);
    // close() can wait forever on a renderer that already died.
    await Promise.race([cam.close().catch(() => undefined), new Promise((r) => setTimeout(r, 1000).unref())]);
    restoreConsole();
  };
  let crashed: { code: number | null; signal: string | null } | null = null;
  cam.on("exit", (info?: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (closing) return;
    const code = info?.code ?? 0;
    const signal = info?.signal ?? null;
    if (code === 0 && !signal) {
      // The user quit the renderer (Ctrl+C twice): end the App too.
      void finish().then(() => {
        if (view.actions) view.actions.exit();
        else process.exit(0);
      });
      return;
    }
    // The renderer crashed (#862). The session must survive it: say where the
    // crash report is, let the turn in flight finish (it is saved after every
    // turn), then end the App so the caller reopens it in the Ink UI.
    crashed = { code, signal };
    logger.error("camouflage.crashed", { code, signal, ...renderer });
    void finish().then(async () => {
      // The renderer left the terminal in raw mode; give it back.
      if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
      process.stderr.write(
        `\nThe Camouflage renderer stopped unexpectedly (${signal ?? `exit code ${code}`}). ` +
          `Its crash report is in ${join(homedir(), ".camouflage")} (crash-*.txt).\n` +
          (view.busy ? "Finishing the current turn, then reopening this conversation in the classic UI…\n" : "Reopening this conversation in the classic UI…\n"),
      );
      await view.settle();
      // Before the App connected there's nothing to end: stop waiting for it.
      if (view.actions) view.actions.exit();
      else crashedBeforeApp();
    });
  });

  let crashedBeforeApp: () => void = () => {};
  const beforeApp = new Promise<void>((resolve) => (crashedBeforeApp = resolve));
  try {
    await Promise.race([opts.runApp(view), beforeApp]);
  } finally {
    await finish();
  }
  if (crashed) {
    const c = crashed as { code: number | null; signal: string | null };
    throw new CamouflageCrashed(`renderer exited (${c.signal ?? `code ${c.code}`})`, view.sessionId);
  }
  if (view.hadConversation) process.stdout.write("Resume this conversation with: autopilot -c\n");
}

/** Translates App snapshots into renderer events, sending only what changed. */
class View implements AppBridge {
  actions: AppActions | null = null;
  hadConversation = false;
  /** Prompts the renderer already printed when the user submitted them. */
  echoed: string[] = [];
  /** Per-event state already sent, keyed by ChatEvent.key. */
  private sent = new Map<string, { text: number; done: boolean }>();
  /** Reasoning characters already sent, per open assistant stream. */
  private reasoningSent = new Map<string, number>();
  /** Events before this index are fully sent and won't change. */
  private settled = 0;
  private firstKey: string | undefined;
  private segments: Record<string, string> = {};
  private todos = "";
  private permission: unknown = null;
  private openPrompt: string | null = null;
  /** A provider sign-in waiting on the browser; Esc aborts it. */
  signIn: AbortController | null = null;
  private commandsKey: string | undefined;
  private readonly sentSubagentPolicyNotices = new Set<string>();
  private readonly jobs = new JobManager();
  private readonly sentActivities = new Map<string, string>();
  private readonly workerActivities = new Map<string, {
    item: ActivityItem;
    logs: string[];
    active: boolean;
    expiresAt: number;
  }>();
  private readonly jobLogOffsets = new Map<string, number>();
  private readonly workerLogOffsets = new Map<string, number>();
  private latestJobs: JobRecord[] = [];
  private latestWorkers: RunningWorker[] = [];
  private activitySnapshotSent = false;
  private activityDetailId: string | null = null;
  private activityPoll: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private cam: CamouflageHandle,
    private sdk: CamouflageSdk,
  ) {}

  connect(actions: AppActions): void {
    this.actions = actions;
  }

  /** A turn is in flight (from the latest snapshot). */
  busy = false;
  /** The session the App is saving. */
  sessionId: string | null = null;
  private idleWaiters: Array<() => void> = [];

  /** Resolves once the App is idle (no turn running). */
  settle(maxWaitMs = 120_000): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
      // Never strand the user: give up waiting after a while (the session is saved per turn).
      setTimeout(resolve, maxWaitMs).unref();
    });
  }

  sync(s: AppSnapshot): void {
    this.busy = s.turnRunning;
    this.sessionId = s.sessionId;
    if (!s.turnRunning) for (const resolve of this.idleWaiters.splice(0)) resolve();
    if (this.disposed) {
      // The renderer is gone (it crashed): nobody can answer a permission
      // prompt, so deny it and let the turn finish.
      if (s.permission) this.actions?.decidePermission("deny");
      return;
    }
    this.syncCommands(s.customCommands);
    this.syncEvents(s.events);
    this.syncStatus(s);
    const todos = JSON.stringify(s.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })));
    if (todos !== this.todos) {
      this.todos = todos;
      this.cam.send("TodoListUpdate", { todos: JSON.parse(todos) });
    }
    this.syncPermission(s);
    this.syncPrompts(s);
    this.syncActivity(s.workers);
  }

  /** Built-in plus the user's custom commands, re-sent when they change. */
  routeActivityCommand(text: string): boolean {
    if (!/^\/(?:jobs|agents)$/i.test(text.trim())) return false;
    this.cam.send("ActivityBrowserOpen", {});
    return true;
  }

  activityViewChanged(change: { view: "list" | "detail" | "closed"; id?: string }): void {
    this.activityDetailId = change.view === "detail" ? change.id ?? null : null;
    this.jobLogOffsets.clear();
    this.workerLogOffsets.clear();
    if (this.activityDetailId) {
      if (this.activityDetailId.startsWith("agent:")) this.streamWorkerLogs(this.activityDetailId, true);
      else this.streamJobLogs(this.activityDetailId, true);
    }
    this.ensureActivityPolling();
  }

  stopActivity(id: string): void {
    if (id.startsWith("agent:")) {
      // Stops this subagent only; the turn and other subagents keep going.
      workerRegistry.cancel(id.slice("agent:".length));
      return;
    }
    try {
      const job = this.jobs.get(id);
      if (!job || !isActiveJob(job)) return;
      this.jobs.cancel(id);
      this.refreshActivities();
    } catch (error) {
      logger.warn("camouflage.activity_stop_failed", { id, error: String(error) });
      this.cam.send("RuntimeError", { message: `Unable to stop background job: ${(error as Error).message}`, severity: "error" });
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.activityPoll) clearInterval(this.activityPoll);
    this.activityPoll = null;
    this.jobs.close();
  }

  private syncActivity(workers: RunningWorker[]): void {
    this.latestWorkers = workers;
    try {
      const records = this.jobs.list({ limit: 100 });
      this.latestJobs = [
        ...records.filter(isActiveJob),
        ...records.filter((job) => !isActiveJob(job)).slice(0, 5),
      ];
    } catch (error) {
      logger.warn("camouflage.activity_jobs_read_failed", { error: String(error) });
    }

    const now = Date.now();
    const currentWorkers = new Set<string>();
    for (const worker of workers) {
      const id = `agent:${worker.id}`;
      currentWorkers.add(id);
      this.workerActivities.set(id, {
        item: activityFromSubagent(worker),
        logs: [`mission: ${worker.task}`, `model: ${worker.model}`],
        active: true,
        expiresAt: Number.POSITIVE_INFINITY,
      });
    }
    for (const [id, activity] of this.workerActivities) {
      if (currentWorkers.has(id) || !activity.active) continue;
      activity.active = false;
      activity.expiresAt = now + 10 * 60_000;
      if (activity.item.status === "running" || activity.item.status === "waiting") {
        // A subagent that was stopping when it left the registry was cancelled.
        const cancelled = activity.item.summary === "Stopping…";
        activity.item = {
          ...activity.item,
          status: cancelled ? "stopped" : "done",
          stoppable: false,
          summary: cancelled ? "Stopped" : "Finished — results returned to the agent",
          updated_at_ms: now,
        };
      }
    }
    for (const [id, activity] of this.workerActivities) {
      if (!activity.active && activity.expiresAt <= now) this.workerActivities.delete(id);
    }
    const finishedWorkers = [...this.workerActivities.entries()]
      .filter(([, activity]) => !activity.active)
      .sort((a, b) => (b[1].item.updated_at_ms ?? b[1].item.started_at_ms ?? 0) - (a[1].item.updated_at_ms ?? a[1].item.started_at_ms ?? 0));
    for (const [id] of finishedWorkers.slice(20)) this.workerActivities.delete(id);

    const next = new Map<string, ActivityItem>();
    for (const job of this.latestJobs) next.set(job.id, activityFromJob(job));
    for (const [id, activity] of this.workerActivities) next.set(id, activity.item);

    for (const event of diffActivityItems(this.sentActivities, [...next.values()], this.activitySnapshotSent)) {
      this.cam.send(event.type, event.payload as unknown as Record<string, unknown>);
    }
    this.activitySnapshotSent = true;
    this.sentActivities.clear();
    for (const [id, item] of next) this.sentActivities.set(id, JSON.stringify(item));

    if (this.activityDetailId?.startsWith("agent:")) this.streamWorkerLogs(this.activityDetailId, false);
    this.ensureActivityPolling();
  }

  private ensureActivityPolling(): void {
    const needsPolling = this.latestJobs.some(isActiveJob);
    if (needsPolling && !this.activityPoll && !this.disposed) {
      this.activityPoll = setInterval(() => this.refreshActivities(), 1000);
      this.activityPoll.unref?.();
    } else if (!needsPolling && this.activityPoll) {
      clearInterval(this.activityPoll);
      this.activityPoll = null;
    }
  }

  private refreshActivities(): void {
    if (this.disposed) return;
    this.syncActivity(this.latestWorkers);
    const id = this.activityDetailId;
    if (id && !id.startsWith("agent:")) this.streamJobLogs(id, false);
  }

  private streamWorkerLogs(id: string, reset: boolean): void {
    const activity = this.workerActivities.get(id);
    if (!activity) return;
    const offset = reset ? 0 : this.workerLogOffsets.get(id) ?? 0;
    const chunk = activity.logs.slice(offset).join("\n");
    if (chunk) this.cam.send("ActivityLog", { id, chunk: `${chunk}\n`, stream: "stdout" });
    this.workerLogOffsets.set(id, activity.logs.length);
  }

  private streamJobLogs(id: string, initial: boolean): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${id}:${stream}`;
      try {
        const result = initial
          ? this.jobs.logs(id, stream, { tail: 1000 })
          : this.jobs.logs(id, stream, { offset: this.jobLogOffsets.get(key) ?? 0 });
        this.jobLogOffsets.set(key, result.offset);
        if (result.content) this.cam.send("ActivityLog", { id, chunk: result.content, stream });
      } catch {
        // The selected item may have been removed while the detail view opened.
      }
    }
  }

  private syncCommands(custom: { name: string; description?: string }[]): void {
    this.commandsKey = syncSlashCommands(custom, this.commandsKey, (commands) => {
      this.cam.send("SlashCommandsRegistered", { commands });
    });
  }

  private syncEvents(events: ChatEvent[]): void {
    // /clear, /resume and compaction replace the list: start over.
    if (events.length < this.settled || (this.firstKey !== undefined && events[0]?.key !== this.firstKey)) {
      this.cam.send("TranscriptCleared", {});
      this.sent.clear();
      this.settled = 0;
    }
    this.firstKey = events[0]?.key;
    let allSettledSoFar = true;
    for (let i = this.settled; i < events.length; i++) {
      const done = this.syncEvent(events[i]!);
      if (done && allSettledSoFar) this.settled = i + 1;
      else allSettledSoFar = false;
    }
  }

  /** Send whatever is new about one event. Returns true once it's final. */
  private syncEvent(e: ChatEvent): boolean {
    const prev = this.sent.get(e.key);
    if (prev?.done) return true;
    switch (e.kind) {
      case "user": {
        if (e.queued) return false;
        this.hadConversation = true;
        // The renderer printed what the user typed when they submitted it;
        // don't print App's copy again. (Messages App adds on its own,
        // e.g. from a resumed session, still go through.)
        const i = this.echoed.indexOf(e.text.trim());
        if (i >= 0) this.echoed.splice(0, i + 1);
        else this.cam.send("UserMessageCreated", { text: e.text });
        return this.mark(e.key, 0, true);
      }
      case "assistant": {
        if (!prev) this.cam.send("AssistantStreamStarted", { stream_id: e.key });
        // Reasoning streams first; the renderer shows it on Ctrl+R.
        const thought = this.reasoningSent.get(e.key) ?? 0;
        if (e.reasoning.length > thought) {
          this.cam.send("AssistantReasoningDelta", { stream_id: e.key, token: e.reasoning.slice(thought) });
          this.reasoningSent.set(e.key, e.reasoning.length);
        }
        const already = prev?.text ?? 0;
        if (e.text.length > already && e.text.startsWith(e.text.slice(0, already))) {
          this.cam.send("AssistantTokenDelta", { stream_id: e.key, token: e.text.slice(already) });
        }
        if (!e.streaming) {
          this.reasoningSent.delete(e.key);
          this.cam.send("AssistantMessageCompleted", { stream_id: e.key, text: e.text });
          return this.mark(e.key, e.text.length, true);
        }
        return this.mark(e.key, e.text.length, false);
      }
      case "tool":
        return this.syncTool(e, prev);
      case "info":
      case "memory":
        if (e.kind === "info" && !shouldSendSubagentPolicyNotice(e.text, this.sentSubagentPolicyNotices)) {
          return this.mark(e.key, 0, true);
        }
        return this.notice(e.key, e.text, "info");
      case "error":
        return this.notice(e.key, e.text, "error");
      case "api_error":
        return this.notice(e.key, e.message, "error");
      case "jev":
        return this.notice(e.key, `Jev: ${e.result}${e.probability ? ` ${e.probability}` : ""} · ${e.receipt}`, "info");
      case "qrcode":
        this.cam.send("Splash", { text: [e.caption, "", ...e.lines].join("\n") });
        return this.mark(e.key, 0, true);
      default:
        return this.mark((e as { key: string }).key, 0, true);
    }
  }

  private syncTool(e: { key: string } & ToolEventState, prev: { text: number; done: boolean } | undefined): boolean {
    if (!prev) {
      const { label, args } = toolRow(e.name, e.render?.title, e.args);
      this.cam.send("ToolExecutionStarted", { tool_id: e.key, tool: label, command: args, started_at_ms: e.startedAt });
    }
    if (e.status === "queued" || e.status === "running") return this.mark(e.key, 0, false);
    const ok = e.status === "done";
    const content = e.result ?? "";
    const bang = splitBangResult(e.render?.title, content);
    const output = e.status === "rejected" ? "" : bang.output;
    this.cam.send("ToolExecutionFinished", {
      tool_id: e.key,
      exit_code: bang.exitCode ?? (ok ? 0 : 1),
      status: e.status === "rejected" ? "rejected" : e.status === "cancelled" ? "cancelled" : ok ? "done" : "error",
      summary: bang.status ?? toolSummary(e.name, ok, e.status === "rejected", output),
      output,
      ...(ok && e.render?.diff ? { diff: e.render.diff } : {}),
    });
    return this.mark(e.key, 0, true);
  }

  private notice(key: string, message: string, severity: "info" | "warn" | "error"): boolean {
    if (message.includes("\n")) {
      // Multi-line output (reports, lists) is preformatted: print it as-is.
      const color = severity === "error" ? "\x1b[31m" : severity === "warn" ? "\x1b[33m" : "\x1b[2m";
      this.cam.send("Splash", { text: message.split("\n").map((l) => `${color}${l}\x1b[0m`).join("\n") });
    } else {
      this.cam.send("RuntimeError", { message, severity });
    }
    return this.mark(key, 0, true);
  }

  private mark(key: string, text: number, done: boolean): boolean {
    this.sent.set(key, { text, done });
    return done;
  }

  private syncStatus(s: AppSnapshot): void {
    const next: Record<string, string> = {
      // With modes off (the default) every turn is auto; show no mode badge.
      mode: !s.modesEnabled ? "" : s.mode === "auto" ? "auto" : s.mode === "plan" ? "plan" : "edit",
      phase: s.busy ? "thinking" : "idle",
      model: shortModel(s.model),
      tokens: s.usage ? `${formatK(s.usage.prompt_tokens)} tokens` : "",
      cost: s.sessionUsage ? `${s.sessionUsage.reconcilePending ? "≈" : ""}$${s.sessionUsage.cost.toFixed(2)}` : "",
    };
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if (this.segments[k] !== v) changed[k] = v;
    }
    if (Object.keys(changed).length > 0) {
      this.segments = next;
      this.cam.send("StatusUpdate", { segments: changed });
    }
  }

  private syncPermission(s: AppSnapshot): void {
    if (!s.permission) {
      this.permission = null;
      return;
    }
    if (this.permission === s.permission.args) return;
    this.permission = s.permission.args;
    const { tool, args } = s.permission;
    let render: { title: string; diff?: { path: string; before: string; after: string } } | undefined;
    try {
      render = tool.render?.(args);
    } catch {
      render = undefined;
    }
    void this.sdk
      .permission(this.cam, {
        request_id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tool: tool.name,
        action: render?.title ?? tool.name,
        ...(render?.diff ? { diff: render.diff } : {}),
      })
      .then((answer) => {
        const decision = answer.choice === "allow_once" ? "allow" : answer.choice === "allow_session" ? "allow_session" : "deny";
        this.actions?.decidePermission(decision);
      });
  }

  /** Map App's pickers to renderer prompts; dialogs without one yet are
   *  closed with a pointer to the Ink UI. */
  private syncPrompts(s: AppSnapshot): void {
    const a = this.actions;
    if (!a) return;
    const want = (key: string, open: () => Promise<void>) => {
      if (this.openPrompt === key) return;
      this.openPrompt = key;
      void open().finally(() => {
        if (this.openPrompt === key) this.openPrompt = null;
      });
    };
    if (s.resumeSessions) {
      const sessions = s.resumeSessions;
      return want("resume", async () => {
        if (sessions.length === 0) {
          a.pickResume(null);
          return void this.cam.send("RuntimeError", { message: "No earlier conversations in this directory.", severity: "info" });
        }
        const r = await this.select(
          "Resume a conversation",
          sessions.map((x) => ({
            value: x.id,
            label: truncateText(x.title ?? x.firstPrompt, 60),
            columns: [relTime(x.updatedAt), `${x.messageCount} msgs`],
            keywords: `${x.firstPrompt} ${x.id}`,
          })),
        );
        a.pickResume(sessions.find((x) => x.id === r) ?? null);
      });
    }
    if (s.checkpoints) {
      const { list } = s.checkpoints;
      return want("checkpoint", async () => {
        const r = await this.select("Restore a checkpoint", list.map((c) => ({ value: c.id, label: c.label, description: relTime(c.timestamp) })));
        a.pickCheckpoint(r);
      });
    }
    if (s.planOptions) {
      const options = s.planOptions;
      return want("planOptions", async () => {
        const r = await this.select("Choose a plan", options.map((o, i) => ({ value: String(i), label: o.label })));
        a.pickPlanOption(r === null ? null : options[Number(r)] ?? null);
      });
    }
    const modal = s.modals[0];
    if (!modal) return;
    switch (modal) {
      case "model":
        return want("model", async () => {
          const models = pickableModels();
          const r = await this.select("Select a model", modelOptions(models, s.model), s.model, "Context · price per Mtok (input / output / cached) · type to search all models");
          a.pickModel(models.find((m) => m.id === r) ?? null);
        });
      case "provider": {
        const initial = s.providerSetup?.initial;
        a.closeModal("provider");
        return want("provider", () => this.providerSetup(initial));
      }
      case "mode":
        return want("mode", async () => {
          const r = await this.select("Switch mode", MODES.map((m) => ({ value: m, label: m })), s.mode);
          a.pickMode((r as Mode | null) ?? null);
        });
      case "planComplete":
        return want("planComplete", async () => {
          const r = await this.select("The plan is ready. What next?", [
            { value: "auto", label: "Execute this plan and accept changes (auto mode)" },
            { value: "edit", label: "Start building and ask for permission (edit mode)" },
            { value: "continue", label: "Continue planning or ask a question" },
          ]);
          a.pickPlanComplete((r as "auto" | "edit" | "continue" | null) ?? null);
        });
      case "help":
        a.closeModal("help");
        return want("help", async () => {
          const r = await this.select("Help", helpOptions(s.customCommands), undefined, "Pick a command to run · type to search");
          if (r) await this.runWithArgs(r);
        });
      case "theme":
        return want("theme", async () => {
          const r = await this.select(
            "Theme",
            s.themes.map((t) => ({ value: t.name, label: t.label })),
            s.currentTheme,
            "Applies to the Ink UI; Camouflage uses your terminal's colors",
          );
          a.pickTheme(r);
        });
      case "shell":
        return want("shell", async () => {
          const r = await this.select(
            "Shell for the bash tool",
            [
              { value: "auto", label: "auto", description: "detect from environment" },
              { value: "bash", label: "bash" },
              { value: "cmd", label: "cmd.exe", description: "Windows" },
              { value: "powershell", label: "PowerShell" },
            ],
            s.currentShell,
          );
          a.pickShell(r);
        });
      case "memory":
        a.closeModal("memory");
        return want("memory", async () => {
          const r = await this.select("Memory", [
            { value: s.memoryEnabled ? "/memory off" : "/memory on", label: s.memoryEnabled ? "Disable memory" : "Enable memory", state: s.memoryEnabled ? "on" : "off" },
            { value: "/memory", label: "Show memory stats" },
            { value: "/memory search <query>", label: "Search memories…" },
            { value: "clear", label: "Clear all memories for this repo" },
          ]);
          if (r === "clear") {
            const ok = await this.sdk.confirm(this.cam, { id: `confirm-${Date.now()}`, prompt: "Clear every memory for this repo?", yes_label: "Yes, clear everything", no_label: "No, keep my memories", default: "no" });
            if (ok.value) a.runCommand("/memory clear");
          } else if (r) {
            await this.runWithArgs(r);
          }
        });
      case "skills":
        a.closeModal("skills");
        return want("skills", async () => {
          const r = await this.select("Skills", [
            { value: "/skills list", label: "List skills" },
            { value: "/skills add <name>", label: "Add a skill…" },
            { value: "/skills edit <name>", label: "Edit a skill…" },
            { value: "/skills enable <name>", label: "Enable a skill…" },
            { value: "/skills disable <name>", label: "Disable a skill…" },
            { value: "/skills delete <name>", label: "Delete a skill…" },
          ]);
          if (r) await this.runWithArgs(r);
        });
      case "commandList":
        a.closeModal("commandList");
        this.cam.send("ShowKeyValueView", {
          id: "custom-commands",
          title: s.customCommands.length > 0 ? "Custom commands" : "No custom commands yet. Create one with /command create.",
          items: s.customCommands.map((c) => ({ label: `/${c.name}`, value: c.description ?? "" })),
        });
        return;
      case "commandPicker":
        return want("commandPicker", async () => {
          const editing = s.commandPickerMode === "edit";
          if (s.customCommands.length === 0) {
            a.closeModal("commandPicker");
            return void this.cam.send("RuntimeError", { message: "No custom commands yet. Create one with /command create.", severity: "info" });
          }
          const r = await this.select(editing ? "Edit a custom command" : "Delete a custom command", s.customCommands.map((c) => ({ value: c.name, label: `/${c.name}`, description: c.description })));
          if (!r) return a.closeModal("commandPicker");
          if (editing) return a.openCommandWizard("edit", r);
          const ok = await this.sdk.confirm(this.cam, { id: `confirm-${Date.now()}`, prompt: `Delete /${r}?`, default: "no" });
          if (ok.value) a.deleteCommand(r);
          else a.closeModal("commandPicker");
        });
      case "changelogImage":
        a.closeModal("changelogImage");
        return want("changelogImage", async () => {
          const detected = s.changelogImageRepo;
          const f = await this.sdk.form(this.cam, {
            id: `changelog-${Date.now()}`,
            title: "Changelog image",
            fields: [{ name: "repo", label: "Repository (owner/name)", default: detected ? `${detected.owner}/${detected.name}` : "", required: true }],
          });
          const repo = f.values?.repo?.trim();
          if (f.cancelled || !repo || !repo.includes("/")) return;
          const [owner, name] = repo.split("/", 2) as [string, string];
          const days = await this.select("Merged PRs from", [
            { value: "1", label: "Past 24 hours" },
            { value: "7", label: "Past 7 days" },
            { value: "30", label: "Past 30 days" },
          ], "7");
          if (days) a.generateChangelogImage(owner, name, Number(days));
        });
      case "lspWizard":
        a.closeModal("lspWizard");
        return want("lspWizard", () => this.lspWizard(s.lsp));
      case "hooksDashboard":
        a.closeModal("hooksDashboard");
        return want("hooksDashboard", () => this.hooksDashboard(s.hooks));
      case "inbox":
        a.closeModal("inbox");
        return want("inbox", () => this.inbox());
      case "commandWizard":
        if (!s.commandWizard) return;
        return want(`commandWizard-${s.commandWizard.mode}-${s.commandWizard.initial?.name ?? ""}`, () => this.commandEditor(s));
      default:
        this.cam.send("RuntimeError", {
          message: `${modalName(modal)} isn't available here yet.`,
          severity: "warn",
        });
        a.closeModal(modal);
    }
  }

  /**
   * The custom-command editor (Ink's CommandWizard): name, description and
   * template; optional mode, effort and model; project or global; preview;
   * save through App's handleCommandSave.
   */
  private async commandEditor(s: AppSnapshot): Promise<void> {
    const a = this.actions!;
    const { mode: wizardMode, initial } = s.commandWizard!;
    const others = s.customCommandDefs.map((c) => c.name).filter((n) => n !== initial?.name);
    let draft = { name: initial?.name ?? "", description: initial?.description ?? "", template: initial?.template ?? "" };
    let problem = "";
    for (;;) {
      const r = await this.sdk.form(this.cam, {
        id: `cmd-${Date.now()}`,
        title: `${wizardMode === "edit" ? `Edit /${initial?.name ?? ""}` : "New custom command"}${problem ? ` · ${problem}` : ""}`,
        fields: [
          { name: "name", label: "Name (you'll type /name)", default: draft.name, required: true, placeholder: "e.g. review" },
          { name: "description", label: "Description (shown in the / picker)", default: draft.description },
          {
            name: "template",
            label: "Prompt template",
            kind: "multiline",
            default: draft.template,
            required: true,
            placeholder: "$ARGUMENTS = everything after the command · $1, $2 = arguments · !`git diff` = shell output · @README.md = file contents",
          },
        ],
      });
      if (r.cancelled || !r.values) return a.closeModal("commandWizard");
      draft = { name: r.values.name?.trim() ?? "", description: r.values.description?.trim() ?? "", template: r.values.template ?? "" };
      problem = validateCommandName(draft.name, others) ?? (draft.template.trim() ? "" : "the template can't be empty");
      if (!problem) break;
    }

    let cmdMode = initial?.mode;
    let effort = initial?.effort;
    let model = initial?.model;
    const advanced = await this.select("Advanced options", [
      { value: "skip", label: "Skip", description: "use the session's mode, effort and model" },
      { value: "set", label: "Set mode, effort or model…" },
    ]);
    if (advanced === null) return a.closeModal("commandWizard");
    if (advanced === "set") {
      const m = await this.select("Mode for this command", ["none", "edit", "plan", "auto"].map((v) => ({ value: v, label: v })), cmdMode ?? "none");
      if (m !== null) cmdMode = m === "none" ? undefined : (m as Mode);
      const e = await this.select("Reasoning effort", ["none", "low", "medium", "high"].map((v) => ({ value: v, label: v })), effort ?? "none");
      if (e !== null) effort = e === "none" ? undefined : (e as ReasoningEffort);
      const models = pickableModels();
      const pick = await this.select(
        "Model for this command",
        [{ value: "", label: "none", description: "use the session's model", section: "Default" }, ...modelOptions(models, model ?? "")],
        model ?? "",
      );
      if (pick !== null) model = pick || undefined;
    }

    const where = await this.select(
      "Save to",
      [
        { value: "project", label: "Project", description: ".kimiflare/commands in this repo" },
        { value: "global", label: "Global", description: "available in every project" },
      ],
      initial?.source ?? "project",
    );
    if (where === null) return a.closeModal("commandWizard");

    const front = Object.entries({ description: draft.description || undefined, mode: cmdMode, model, effort })
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`);
    const preview = (front.length > 0 ? ["---", ...front, "---"] : []).concat(draft.template.split("\n"));
    this.cam.send("Splash", { text: [`\x1b[1m/${draft.name}\x1b[0m`, ...preview.map((l) => `\x1b[2m│\x1b[0m ${l}`)].join("\n") });
    const ok = await this.sdk.confirm(this.cam, { id: `save-${Date.now()}`, prompt: `Save /${draft.name}?`, yes_label: "Save", no_label: "Cancel" });
    if (!ok.value) return a.closeModal("commandWizard");
    a.saveCommand({
      name: draft.name,
      description: draft.description || undefined,
      template: draft.template,
      source: where as CommandSource,
      mode: cmdMode,
      model,
      effort,
      cwd: process.cwd(),
    });
  }

  /**
  /** /hooks (Ink's HooksDashboard + HooksWizard): Enter toggles a
   *  configured hook or installs a recommended one; loops until Esc. */
  private async hooksDashboard(initial: AppSnapshot["hooks"]): Promise<void> {
    const cwd = process.cwd();
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    let configured = initial;
    const refresh = () => {
      configured = this.actions?.reloadHooks() ?? configured;
    };
    let cursor: string | undefined;
    for (;;) {
      const ids = new Set(configured.map((c) => c.hook.id ?? deriveHookId(c.event, c.hook.command)));
      const options: PickOption[] = [
        ...configured.map((c) => {
          const id = c.hook.id ?? deriveHookId(c.event, c.hook.command);
          return {
            value: `cfg:${id}`,
            label: id,
            section: "Configured",
            columns: [c.event],
            description: c.hook.description ?? c.hook.command,
            state: c.hook.enabled === false ? ("off" as const) : ("on" as const),
          };
        }),
        ...RECOMMENDED_HOOKS.filter((r) => !ids.has(r.id)).map((r) => ({
          value: `rec:${r.id}`,
          label: r.id,
          section: "Recommended",
          columns: [r.event],
          description: r.hook.description ?? r.hook.command,
        })),
        { value: "create", label: "+ Create a custom hook…", section: "Custom" },
      ];
      const r = await this.select("Hooks", options, cursor, "Enter toggles · recommended hooks install into this project");
      if (r === null) return;
      cursor = r;
      if (r === "create") {
        const saved = await this.hookWizard(cwd);
        if (saved) {
          refresh();
          say(`saved ${saved.id} (${saved.event}) → ${saved.path}`);
        }
        continue;
      }
      const id = r.slice(4);
      if (r.startsWith("cfg:")) {
        const entry = configured.find((c) => (c.hook.id ?? deriveHookId(c.event, c.hook.command)) === id);
        if (!entry) continue;
        const enable = entry.hook.enabled === false;
        const path = setHookEnabled(cwd, id, enable);
        if (path) {
          refresh();
          say(`${enable ? "enabled" : "disabled"} ${id} in ${path}`);
        }
      } else {
        const rec = RECOMMENDED_HOOKS.find((x) => x.id === id);
        if (!rec) continue;
        const path = appendHook("project", cwd, rec.event, { ...rec.hook, enabled: true });
        refresh();
        cursor = `cfg:${id}`;
        say(`enabled ${rec.id} (${rec.event}) → ${path}`);
      }
    }
  }

  /** Ink's HooksWizard: event → (matcher) → command → details → scope → save. */
  private async hookWizard(cwd: string): Promise<{ event: HookEvent; id: string; path: string } | null> {
    const events = Object.keys(EVENT_DESCRIPTIONS) as HookEvent[];
    const ev = await this.select("Create hook · event", events.map((e) => ({ value: e, label: e, description: EVENT_DESCRIPTIONS[e] })));
    if (ev === null) return null;
    const event = ev as HookEvent;
    const toolEvent = event === "PreToolUse" || event === "PostToolUse";
    this.cam.send("Splash", {
      text: [
        `\x1b[1mExamples for ${event}\x1b[0m`,
        ...EVENT_COMMAND_EXAMPLES[event].map((l) => (l.startsWith("#") ? `\x1b[2m${l}\x1b[0m` : l)),
        ...(toolEvent ? ["", "\x1b[2m# Matchers (regex on the tool name):\x1b[0m", ...MATCHER_EXAMPLES.map((l) => `\x1b[2m${l}\x1b[0m`)] : []),
      ].join("\n"),
    });
    const f = await this.sdk.form(this.cam, {
      id: `hook-${Date.now()}`,
      title: `Create ${event} hook`,
      fields: [
        ...(toolEvent ? [{ name: "matcher", label: "Tool matcher (regex, blank = all)", placeholder: "^(edit|write)$" }] : []),
        { name: "command", label: "Shell command", required: true, kind: "multiline" as const },
        { name: "id", label: "Id (optional)", placeholder: "my-hook" },
        { name: "description", label: "Description (optional)" },
      ],
    });
    if (f.cancelled || !f.values?.command?.trim()) return null;
    const v = f.values;
    const scope = await this.select("Save to", [
      { value: "project", label: "project", description: ".kimiflare/settings.json" },
      { value: "global", label: "global", description: "~/.config/kimiflare/settings.json" },
    ]);
    if (scope === null) return null;
    const draft: HookConfig = {
      command: v.command!.trim(),
      ...(v.matcher?.trim() ? { matcher: v.matcher.trim() } : {}),
      ...(v.id?.trim() ? { id: v.id.trim() } : {}),
      ...(v.description?.trim() ? { description: v.description.trim() } : {}),
      enabled: true,
    };
    try {
      const path = appendHook(scope as "project" | "global", cwd, event, draft);
      return { event, id: draft.id ?? draft.command.slice(0, 8), path };
    } catch (e) {
      this.cam.send("RuntimeError", { message: `save failed: ${(e as Error).message}`, severity: "error" });
      return null;
    }
  }

  /**
   * `/provider` (Ink's ProviderSetup): pick a provider from a searchable list,
   * connect it — sign in, a masked key, an endpoint, or nothing for local
   * runtimes — then pick one of its models. Keys never reach the transcript.
   */
  private async providerSetup(initial?: ProviderId): Promise<void> {
    const a = this.actions!;
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    const cfg = await loadConfig().catch(() => null);
    let id: ProviderId | undefined = initial;
    for (;;) {
      if (!id) {
        const rows = providerRows(cfg, { markActive: true });
        const current = rows.find((r) => r.active)?.id;
        const r = await this.select(
          "Switch provider",
          rows.map((row) => ({
            value: row.id,
            label: row.name,
            columns: [credentialLabel(row)],
            description: row.hint,
            keywords: `${row.id} ${row.hint}`,
          })),
          current,
          "Conversation history is kept · type to search · Enter to connect",
        );
        if (r === null) return;
        id = r as ProviderId;
      }
      const connection = await this.connectProvider(id, cfg, say);
      if (connection === "back") {
        id = undefined;
        continue;
      }
      if (!connection) return;
      const preset = getPreset(id);
      say(`✓ ${describeConnection(connection)}`);
      if (connection.openRouter?.isFreeTier) {
        say("This key has no credits yet: only free models work (search \"free\"). Add credits at https://openrouter.ai/settings/credits.");
      }
      const models = pickableModels();
      const modelId = await this.select(
        `Pick a ${preset.name} model`,
        modelOptions(models, ""),
        undefined,
        "Context · price per Mtok (input / output / cached) · type to search · switch any time with /model",
      );
      if (modelId === null) {
        id = undefined;
        continue;
      }
      try {
        await commitProvider(connection, modelId);
      } catch (e) {
        return say(`Couldn't save the config: ${(e as Error).message}`, "error");
      }
      a.providerSwitched(id);
      return;
    }
  }

  /** One provider's connect step. Null = cancelled, "back" = return to the list. */
  private async connectProvider(
    id: ProviderId,
    cfg: Cfg | null,
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<Connection | null | "back"> {
    const preset = getPreset(id);
    const plan = planConnect(id, cfg);
    let baseUrl: string | undefined;

    const verify = async (key: string | undefined, source: KeySource, url?: string): Promise<Connection | null> => {
      say(preset.keyRequired || id === "openrouter" ? `Checking the key with ${preset.name}…` : `Connecting to ${preset.name}…`);
      const res = await verifyProvider(id, key, source, url);
      if (res.ok) return res.connection;
      say(res.message, "error");
      return null;
    };

    /** A masked key form; retries until the key checks out or the user cancels. */
    const askKey = async (): Promise<Connection | null | "back"> => {
      for (;;) {
        const f = await this.sdk.form(this.cam, {
          id: `provider-key-${Date.now()}`,
          title: `${preset.name} API key`,
          fields: [
            {
              name: "key",
              label: preset.keysUrl ? `Paste your key — create one at ${id === "openrouter" ? OPENROUTER_KEYS_URL : preset.keysUrl}` : "Paste your key",
              kind: "password",
              required: id !== "custom",
            },
          ],
        });
        if (f.cancelled) return "back";
        const key = f.values?.key?.trim();
        if (!key && id !== "custom") continue;
        const c = await verify(key || undefined, "key", baseUrl);
        if (c) return c;
      }
    };

    /** Run a browser/device sign-in that Esc can cancel. */
    const withSignIn = async <T,>(run: (signal: AbortSignal) => Promise<T>): Promise<T | null> => {
      const ctrl = new AbortController();
      this.signIn = ctrl;
      try {
        return await run(ctrl.signal);
      } catch (e) {
        say(ctrl.signal.aborted ? "Sign-in cancelled." : `Sign-in failed: ${(e as Error).message}`, ctrl.signal.aborted ? "info" : "error");
        return null;
      } finally {
        this.signIn = null;
      }
    };

    switch (plan.kind) {
      case "openrouter": {
        const existing = resolveProviderKey("openrouter", cfg);
        const r = await this.select(
          "Connect your OpenRouter account",
          [
            ...(existing ? [{ value: "saved", label: `Use the ${process.env.OPENROUTER_API_KEY ? "key from your environment" : "saved key"} (${maskKey(existing)})` }] : []),
            { value: "signin", label: "Sign in with OpenRouter", description: "recommended — approve in your browser, no key to copy" },
            { value: "key", label: "Paste an API key", description: `create one at ${OPENROUTER_KEYS_URL}` },
          ],
        );
        if (r === null) return "back";
        if (r === "saved") return (await verify(existing, process.env.OPENROUTER_API_KEY ? "env" : "config")) ?? "back";
        if (r === "key") return askKey();
        const key = await withSignIn((signal) =>
          openRouterSignIn({
            signal,
            open: openBrowser,
            show: (url, opened) =>
              say(opened ? `Approve Autopilot in your browser — a key is created for you. Esc to cancel. (${url})` : `Open this link and approve Autopilot: ${url}`),
            askCode: async () => {
              const f = await this.sdk.form(this.cam, {
                id: `or-code-${Date.now()}`,
                title: "Paste the code OpenRouter shows",
                fields: [{ name: "code", label: "Code", kind: "password", required: true }],
              });
              return f.cancelled ? null : f.values?.code ?? null;
            },
          }),
        );
        if (!key) return "back";
        return (await verify(key, "signin")) ?? "back";
      }
      case "copilot":
      case "chatgpt": {
        const signedIn = resolveProviderKey(id, cfg);
        if (signedIn) {
          const r = await this.select(`Connect ${preset.name}`, [
            { value: "use", label: `Use your existing ${id === "copilot" ? "GitHub" : "ChatGPT"} sign-in` },
            { value: "again", label: "Sign in again" },
          ]);
          if (r === null) return "back";
          if (r === "use") return (await verify(signedIn, "config", cfg?.providers?.[id]?.baseUrl)) ?? "back";
        }
        if (id === "copilot") {
          const res = await withSignIn((signal) =>
            copilotSignIn(({ uri, code }) => {
              openBrowser(uri);
              say(`Open ${uri} and enter the code ${code} — waiting for you to approve in the browser. Esc to cancel. Copilot usage counts against your plan.`);
            }, signal),
          );
          if (!res) return "back";
          return (await verify(res.key, "signin", res.baseUrl)) ?? "back";
        }
        const res = await withSignIn((signal) =>
          chatgptSignIn((url) => {
            const opened = openBrowser(url);
            say(`${opened ? "Approve Autopilot in your browser" : `Open ${url}`} and allow token sharing. Esc to cancel. Usage counts against your ChatGPT plan.`);
          }, signal),
        );
        if (!res) return "back";
        return (await verify(res.key, "signin")) ?? "back";
      }
      case "baseUrl": {
        for (;;) {
          const f = await this.sdk.form(this.cam, {
            id: `provider-url-${Date.now()}`,
            title: plan.purpose === "azure" ? "Your Azure OpenAI resource" : "Your OpenAI-compatible endpoint",
            fields: [
              {
                name: "url",
                label: plan.purpose === "azure" ? "Resource name (the <name> in https://<name>.openai.azure.com) or endpoint URL" : "Base URL",
                placeholder: plan.purpose === "azure" ? "my-resource" : "http://localhost:4000/v1",
                required: true,
              },
            ],
          });
          if (f.cancelled) return "back";
          const res = normalizeEndpoint(plan.purpose, f.values?.url ?? "");
          if ("error" in res) {
            say(res.error, "error");
            continue;
          }
          baseUrl = res.url;
          return askKey();
        }
      }
      case "project": {
        for (;;) {
          const f = await this.sdk.form(this.cam, {
            id: `vertex-project-${Date.now()}`,
            title: "Google Cloud project",
            fields: [{ name: "project", label: "Project id — credentials come from gcloud (gcloud auth application-default login)", required: true }],
          });
          if (f.cancelled) return "back";
          const project = f.values?.project ?? "";
          if (!isVertexProjectId(project)) {
            say("Enter a Google Cloud project id", "error");
            continue;
          }
          await saveVertexProject(project);
          return (await verify(undefined, "none")) ?? "back";
        }
      }
      case "key":
        return askKey();
      case "ready": {
        if (plan.source === "none") return (await verify(undefined, "none", cfg?.providers?.[id]?.baseUrl)) ?? "back";
        const r = await this.select(`Connect ${preset.name}`, [
          {
            value: "use",
            label: `Use the ${plan.source === "env" ? "key from your environment" : "saved key"}${plan.key ? ` (${maskKey(plan.key)})` : ""}`,
          },
          { value: "new", label: "Enter a different key" },
        ]);
        if (r === null) return "back";
        if (r === "use") return (await verify(plan.key, plan.source, cfg?.providers?.[id]?.baseUrl)) ?? "back";
        return askKey();
      }
    }
  }

  /** /lsp setup (Ink's LspWizard). */
  private async lspWizard(lsp: AppSnapshot["lsp"]): Promise<void> {
    const a = this.actions!;
    const { servers, scope } = lsp;
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    const names = Object.keys(servers);
    const action = await this.select("LSP servers", [
      { value: "add", label: "Add server" },
      ...(names.length ? [
        { value: "toggle", label: "Enable / disable a server" },
        { value: "delete", label: "Delete a server" },
      ] : []),
    ], undefined, names.length ? names.map((k) => `${k} ${servers[k]!.enabled === false ? "off" : "on"}`).join(" · ") : "No servers configured");
    if (action === null) return;

    if (action === "toggle" || action === "delete") {
      const key = await this.select(action === "toggle" ? "Toggle server" : "Delete server", names.map((k) => ({
        value: k,
        label: k,
        description: servers[k]!.command.join(" "),
        ...(action === "toggle" ? { state: servers[k]!.enabled === false ? "off" as const : "on" as const } : {}),
      })));
      if (key === null) return;
      if (action === "toggle") {
        return a.saveLsp({ ...servers, [key]: { ...servers[key]!, enabled: servers[key]!.enabled === false } }, true, scope);
      }
      const ok = await this.sdk.confirm(this.cam, { id: `lspdel-${Date.now()}`, prompt: `Delete ${key}?`, default: "no" });
      if (!ok.value) return;
      const next = { ...servers };
      delete next[key];
      return a.saveLsp(next, Object.keys(next).length > 0, scope);
    }

    const id = await this.select("Add LSP server", LSP_PRESETS.map((p) => ({
      value: p.id,
      label: p.name,
      description: p.description + (p.id in servers ? " · configured" : ""),
    })));
    if (id === null) return;
    const preset = LSP_PRESETS.find((p) => p.id === id)!;
    let name = preset.id;
    let command = preset.command;
    if (preset.id === "custom") {
      const f = await this.sdk.form(this.cam, {
        id: `lspcustom-${Date.now()}`,
        title: "Custom LSP server",
        fields: [
          { name: "name", label: "Name", required: true, placeholder: "my-server" },
          { name: "command", label: "Command", required: true, placeholder: "my-language-server --stdio" },
        ],
      });
      if (f.cancelled || !f.values?.name?.trim() || !f.values.command?.trim()) return;
      name = f.values.name.trim();
      command = f.values.command.trim().split(/\s+/);
    } else if (preset.installCommand) {
      const r = await this.select(`Install ${preset.name}`, [
        { value: "run", label: "Run install command", description: preset.installCommand },
        { value: "skip", label: "Skip install", description: "already installed" },
      ], undefined, preset.installHint);
      if (r === null) return;
      if (r === "run") {
        say(`$ ${preset.installCommand}`);
        const res = await runShell(preset.installCommand);
        say(res.output.trim().split("\n").slice(-12).join("\n") || (res.ok ? "Installed." : "Install failed."), res.ok ? "info" : "error");
        if (!res.ok) {
          const go = await this.sdk.confirm(this.cam, { id: `lspanyway-${Date.now()}`, prompt: "Install failed. Save the server anyway?", default: "no" });
          if (!go.value) return;
        }
      }
    }
    const defaultToProject = lsp.hasProjectDir || scope === "project";
    const where = await this.select("Save to", [
      { value: "project", label: "This project only" },
      { value: "global", label: "Global config" },
    ], defaultToProject ? "project" : "global");
    if (where === null) return;
    const next: Record<string, LspServerConfig> = { ...servers, [name]: { command, enabled: true } };
    a.saveLsp(next, true, where as "project" | "global");
  }

  /** The voice-note inbox (Ink's InboxModal): handle + secret, then the
   *  messages; picking one opens it in the browser. */
  private async inbox(): Promise<void> {
    const f = await this.sdk.form(this.cam, {
      id: `inbox-${Date.now()}`,
      title: "Check your inbox",
      fields: [
        { name: "handle", label: "Your X / Twitter handle", required: true, placeholder: "without the @" },
        { name: "secret", label: "Secret", kind: "password", required: true },
      ],
    });
    const handle = f.values?.handle?.trim().replace(/^@/, "");
    const secret = f.values?.secret?.trim();
    if (f.cancelled || !handle || !secret) return;
    const q = `u=${encodeURIComponent(handle)}&s=${encodeURIComponent(secret)}`;
    let messages: { id: string; createdAt: number; seen: boolean }[] = [];
    try {
      const res = await fetch(`${FEEDBACK_WORKER_URL}/inbox/check?${q}`);
      if (!res.ok) throw new Error(`the inbox server returned ${res.status}`);
      const data = (await res.json()) as { messages?: typeof messages };
      messages = (data.messages ?? []).sort((x, y) => y.createdAt - x.createdAt);
    } catch (err) {
      return void this.cam.send("RuntimeError", { message: `Couldn't check the inbox: ${err instanceof Error ? err.message : String(err)}`, severity: "error" });
    }
    if (messages.length === 0) {
      return void this.cam.send("RuntimeError", { message: `No messages yet for @${handle}.`, severity: "info" });
    }
    const r = await this.select(
      `Inbox for @${handle}`,
      messages.map((m) => ({ value: m.id, label: new Date(m.createdAt).toLocaleString(), state: m.seen ? "off" : "on", description: m.seen ? "" : "new" })),
    );
    if (r) openBrowser(`${FEEDBACK_WORKER_URL}/inbox?${q}&m=${encodeURIComponent(r)}`);
  }

  /** Run a command; for templates like "/skills add <name>", ask for each
   *  `<arg>` in a form first (Ink only lists those as text). */
  private async runWithArgs(template: string): Promise<void> {
    const args = [...template.matchAll(/<([^>]+)>/g)].map((m) => m[1]!);
    if (args.length === 0) return this.actions?.runCommand(template);
    const r = await this.sdk.form(this.cam, {
      id: `args-${Date.now()}`,
      title: template.replace(/\s*<[^>]+>/g, "").trim(),
      fields: args.map((name) => ({ name, label: name.charAt(0).toUpperCase() + name.slice(1), required: true })),
    });
    if (r.cancelled || !r.values) return;
    const values = r.values;
    this.actions?.runCommand(template.replace(/<([^>]+)>/g, (_m, name: string) => values[name] ?? ""));
  }

  private async select(prompt: string, options: PickOption[], current?: string, subtitle?: string): Promise<string | null> {
    const r = await this.sdk.selectList(this.cam, {
      id: `pick-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      prompt,
      options,
      ...(current ? { default: current } : {}),
      ...(subtitle ? { subtitle } : {}),
    });
    return r.cancelled || r.value === undefined ? null : r.value;
  }
}

// ----- helpers ---------------------------------------------------------------

/** Run a shell command to completion, capturing its output. */
function runShell(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const { shell, args } = getShellCommand();
    const child = spawn(shell, [...args, command], { env: process.env });
    let out = "";
    child.stdout?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.on("close", (code) => resolve({ ok: code === 0, output: out || (code === 0 ? "" : `Exit code: ${code}`) }));
    child.on("error", (err) => resolve({ ok: false, output: err.message }));
  });
}

type PickOption = { value: string; label: string; description?: string; section?: string; columns?: string[]; state?: "on" | "off"; keywords?: string };

type RegisteredSlashCommand = { name: string; description?: string; args_hint?: string };

/** Send the complete command list only when the serialized renderer payload changes. */
export function syncSlashCommands(
  custom: { name: string; description?: string }[],
  lastKey: string | undefined,
  send: (commands: RegisteredSlashCommand[]) => void,
): string {
  const builtin: RegisteredSlashCommand[] = [
    ...BUILTIN_COMMANDS.map((c) => ({ name: c.name, description: c.description, args_hint: c.argHint })),
    { name: "jobs", description: "Browse background jobs and agents" },
    { name: "agents", description: "Browse background agents and jobs" },
  ];
  const names = new Set(builtin.map((c) => c.name));
  const commands = [
    ...builtin,
    ...custom
      .filter((c) => !names.has(c.name))
      .map((c) => ({ name: c.name, description: c.description ? `${c.description} (custom)` : "Custom command" })),
  ];
  const key = JSON.stringify(commands);
  if (key !== lastKey) send(commands);
  return key;
}

/** Deduplicate repeated policy notices in Camouflage without hiding user-directed decisions. */
export function shouldSendSubagentPolicyNotice(message: string, sent: Set<string>): boolean {
  if (!message.startsWith("Subagent policy:") || message.startsWith("Subagent policy: respecting your ")) return true;
  if (sent.has(message)) return false;
  sent.add(message);
  return true;
}

/** Split the status prefix stored for `!` tool events from the actual command output. */
export function splitBangResult(
  title: string | undefined,
  content: string,
): { output: string; status?: string; exitCode?: number } {
  if (!title?.startsWith("! ")) return { output: content };
  const match = /^(exit=\d+|signal=[^\r\n]+|exit=\?)(?:\r?\n)/.exec(content);
  if (!match) return { output: content };
  const exit = /^exit=(\d+)$/.exec(match[1]!);
  return {
    output: content.slice(match[0].length),
    status: match[1],
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
  };
}

/** The Ink command wizard's name rules. */
export function validateCommandName(name: string, existing: string[]): string | null {
  if (!name) return "a name is required";
  if (!/^[a-zA-Z][a-zA-Z0-9_\-/]*$/.test(name)) return "use letters, numbers, _ - / and start with a letter";
  if (BUILTIN_COMMAND_NAMES.has(name.toLowerCase())) return `/${name} is a built-in command`;
  if (existing.includes(name)) return `/${name} already exists`;
  return null;
}

/** The Ink help menu's pages as sections, plus custom commands. */
export function helpOptions(custom: { name: string; description?: string }[]): PickOption[] {
  const out: PickOption[] = [];
  for (const cat of CATEGORIES) {
    for (const c of cat.commands) {
      if (!c.command.startsWith("/")) continue;
      out.push({ value: c.command, label: c.command, description: c.description, section: cat.label });
    }
  }
  for (const c of SINGLE_COMMANDS) out.push({ value: c.command, label: c.command, description: c.description, section: "General" });
  for (const c of custom) out.push({ value: `/${c.name}`, label: `/${c.name}`, description: c.description, section: "Custom commands" });
  return out;
}

/** The Ink model picker's set: tool-capable models, no `:batch` variants. */
function pickableModels(): ModelEntry[] {
  return listModels().filter((m) => m.supports.tools && !m.id.endsWith(":batch"));
}

/**
 * The Ink model picker's layout: the current model (if it isn't featured),
 * then "Best & latest" (featuredModels), then every other model, which Ink
 * reaches by searching. Context and price as columns.
 */
export function modelOptions(models: ModelEntry[], current: string): PickOption[] {
  const featured = featuredModels(models);
  const featuredIds = new Set(featured.map((m) => m.id));
  const row = (m: ModelEntry, section: string): PickOption => ({
    value: m.id,
    label: m.id,
    section,
    columns: [formatContext(m.contextWindow), formatModelPrice(m.pricing)],
    keywords: m.name ?? "",
  });
  const out: PickOption[] = [];
  const cur = models.find((m) => m.id === current);
  if (cur && !featuredIds.has(cur.id)) out.push(row(cur, "Current"));
  for (const m of featured) out.push(row(m, "Best & latest — ranked by agentic + coding benchmarks"));
  for (const m of models) {
    if (!featuredIds.has(m.id) && m.id !== cur?.id) out.push(row(m, "All models"));
  }
  return out;
}

function truncateText(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * Entries of the folder a path mention points into, as tokens prefixed with
 * the folder exactly as typed ("../src/a.ts", folders end in "/"). Mirrors
 * the Ink file picker: hidden files skipped, folders first, 300 at most.
 */
export async function listMentionDir(cwd: string, query: string): Promise<{ dir: string; entries: string[] }> {
  const exact = query === "~" || query === "." || query === ".." || query.endsWith("/..");
  const dir = exact ? `${query}/` : query.slice(0, query.lastIndexOf("/") + 1);
  const expanded = dir.startsWith("~") ? join(homedir(), dir.slice(1)) : dir;
  const target = resolve(cwd, expanded || ".");
  try {
    const items = await readdir(target, { withFileTypes: true });
    const entries = items
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
      .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)))
      .slice(0, 300)
      .map((d) => `${dir}${d.name}${d.isDir ? "/" : ""}`);
    return { dir, entries };
  } catch {
    return { dir, entries: [] };
  }
}

function modalName(m: AppModal): string {
  const names: Record<AppModal, string> = {
    model: "The model picker",
    mode: "The mode picker",
    provider: "/provider",
    theme: "/theme",
    ui: "/ui",
    help: "/help",
    memory: "The memory picker",
    skills: "The skills picker",
    shell: "The shell picker",
    planComplete: "The plan picker",
    commandList: "/command list",
    commandWizard: "The command editor",
    commandPicker: "The command picker",
    lspWizard: "The LSP setup wizard",
    inbox: "The inbox",
    hooksDashboard: "The hooks dashboard",
    changelogImage: "/changelog-image",
  };
  return names[m];
}

/** "read src/a.ts" → { label: "Read", args: "src/a.ts" }. */
export function toolRow(name: string, title: string | undefined, rawArgs: string | undefined): { label: string; args: string } {
  const label = name.startsWith("mcp_") || name.startsWith("lsp_") ? name : name.charAt(0).toUpperCase() + name.slice(1);
  if (title) {
    const rest = title.toLowerCase().startsWith(`${name.toLowerCase()} `) ? title.slice(name.length + 1) : title;
    return { label, args: rest.trim() };
  }
  if (name === "execute_code") {
    // execute_code is synthesized by the agent loop and has no ToolSpec.render,
    // so without this the row shows the raw {"code":"…"} JSON payload.
    return { label: "Code", args: clip(executeCodeSummary(rawArgs)) };
  }
  const args = (rawArgs ?? "").replace(/\s+/g, " ").trim();
  return { label, args: clip(args) };
}

function clip(s: string): string {
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** The model's stated reasoning for a code batch, else its first meaningful line. */
export function executeCodeSummary(rawArgs: string | undefined): string {
  let parsed: { code?: unknown; reasoning?: unknown } = {};
  try {
    parsed = rawArgs ? (JSON.parse(rawArgs) as typeof parsed) : {};
  } catch {
    return "running a code batch";
  }
  if (typeof parsed.reasoning === "string" && parsed.reasoning.trim()) return parsed.reasoning.replace(/\s+/g, " ").trim();
  const code = typeof parsed.code === "string" ? parsed.code : "";
  const first = code
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("//"));
  return first ? first.replace(/\s+/g, " ") : "running a code batch";
}

/** One line under the tool row: what the result amounts to. */
export function toolSummary(name: string, ok: boolean, declined: boolean, content: string): string {
  if (declined) return "You declined this · tell autopilot what to do instead";
  const lines = content.length === 0 ? 0 : content.replace(/\n$/, "").split("\n").length;
  if (!ok) {
    const first = content.split("\n").find((l) => l.trim()) ?? "Failed";
    return first.length > 100 ? `${first.slice(0, 99)}…` : first;
  }
  switch (name) {
    case "read":
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    case "grep":
    case "glob":
      return lines === 0 ? "No matches" : `${lines} ${lines === 1 ? "match" : "matches"}`;
    case "write":
    case "edit":
      return content.split("\n")[0]?.slice(0, 100) || "Done";
    default:
      return lines === 0 ? "Done" : `${lines} ${lines === 1 ? "line" : "lines"} of output`;
  }
}

function relTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function shortModel(id: string): string {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}

function shortPath(p: string): string {
  const home = homedir();
  return p === home ? "~" : p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Tracked and untracked-but-not-ignored files, for `@` mentions. */
function listFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).slice(0, 5000);
  } catch {
    return [];
  }
}

/** The renderer owns the terminal; send stray console output to the log. */
function captureConsole(): () => void {
  const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const to = (level: "info" | "warn" | "error") => (...args: unknown[]) =>
    logger[level]("console", { message: args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" ") });
  console.log = to("info");
  console.info = to("info");
  console.debug = to("info");
  console.warn = to("warn");
  console.error = to("error");
  return () => Object.assign(console, saved);
}

function safeString(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
