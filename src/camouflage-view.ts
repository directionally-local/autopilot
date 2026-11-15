/**
 * Camouflage UI, autopilot's interactive interface: App drawn by the
 * Camouflage inline renderer.
 *
 * App keeps all of autopilot's interactive logic (turns, slash commands,
 * MCP/LSP/memory/hooks, queueing, sessions). Through an AppBridge it reports
 * what's on screen after each render; this module turns that into renderer
 * events and turns the user's input back into App actions. App runs headless
 * inside Ink, which renders nothing.
 *
 * Needs camouflage-tui with the inline SDK. CAMOUFLAGE_BIN overrides the
 * renderer binary.
 */

import { execFileSync, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppActions, AppBridge, AppModal, AppSnapshot } from "./ui/app-bridge.js";
import type { ChatEvent } from "./ui/view-types.js";
import type { ToolEventState } from "./ui/view-types.js";
import type { Cfg } from "./app.js";
import { BUILTIN_COMMANDS, BUILTIN_COMMAND_NAMES } from "./commands/builtins.js";
import type { CustomCommand, CommandSource } from "./commands/types.js";
import { configPath, hasLegacyCloudflareConfig, loadConfig, readPersistedConfig, type ReasoningEffort } from "./config.js";
import { onboardingCancelledMessage, ownKeyIntro, runFirstRun, type FirstRunOutcome } from "./camouflage-onboarding.js";
import { onShutdown } from "./util/exit.js";
import { warnIfNoTerminalSize } from "./util/terminal-size.js";
import { getPreset, type ProviderId } from "./providers/presets.js";
import { DL_STATUS_OPEN, dlFreeStatus, dlPausedLine, type DlFreeStatus } from "./providers/dl-status.js";
import { DL_FREE_MODEL, DL_PROVIDER_ID, DlError, dlAccessToken, dlAuthPrompt, dlCheckout, dlModelAllowanceLine, dlStartLine, dlSignedInInviteLine, dlSignedInLine, fetchDlMe, isDlAuthError, lastKnownDlMe, type DlMe } from "./providers/directionally-local.js";
import { runDlScreen, type DlScreen, type DlScreenDeps } from "./providers/dl-growth.js";
import { getAppVersion } from "./util/version.js";
import { FEEDBACK_FALLBACK_LINE, FEEDBACK_MESSAGE_PROMPT, runFeedback, type FeedbackLine, type FeedbackRequest } from "./feedback.js";
import {
  ACCESS_BUILDING_MAX,
  ACCESS_BUILDING_PROMPT,
  ACCESS_FAILED_LINE,
  ACCESS_LINK_PROMPT,
  ACCESS_TITLE,
  runAccessRequest,
  type AccessRequestLine,
  type AccessRequestOpen,
} from "./access-request.js";
import { copyWithOsc52 } from "./util/osc52.js";
import { resolveActiveProvider, resolveProviderKey } from "./providers/resolve.js";
import {
  chatgptSignIn,
  commitProvider,
  copilotSignIn,
  credentialLabel,
  describeConnection,
  directionallyLocalSignIn,
  dlSignInLines,
  DL_SIGN_IN_NEEDED,
  dlWaitingText,
  envKeyProvider,
  FIRST_RUN_QUESTION,
  firstRunChoices,
  firstRunSubtitle,
  freeChoosable,
  rowsWithFreeStatus,
  statusMessage,
  leavingFreeTierLine,
  OWN_KEY_BILLING_LINE,
  OWN_KEY_EXCLUDE,
  type FirstRunChoice,
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
import { activeProviderCatalog, featuredModels, listModels, type ModelEntry } from "./models/registry.js";
import { formatContext, formatModelPrice } from "./ui/model-format.js";
import { CATEGORIES, SINGLE_COMMANDS } from "./ui/help-catalog.js";
import { launchedByDl } from "./util/env.js";
import { headerTitle, productName } from "./util/dl-identity.js";
import { FEEDBACK_WORKER_URL, openBrowser } from "./ui/app-helpers.js";
import { BUG_REPORT_LINE } from "./ui/bug-report.js";
import { registerTerminalHandoff } from "./ui/bang-command.js";
import { readKeyWithoutInput, screenWithoutInput, waitWithoutInput, type WaitIo } from "./ui/terminal-wait.js";
import { markProductTourSeen, runProductTour, tourHintUntilSeen, tourSteps } from "./ui/product-tour.js";
import { runStarAsk } from "./star-ask.js";
import { runGithubAccess, type GithubAccessOutcome } from "./github-access.js";
import { ghAuthLogin, runGh, type GhLogin, type GhRun } from "./util/gh-cli.js";
import { terminalWrapWidth, wrapText } from "./util/wrap.js";
import { CONFIRMED_IRREVERSIBLE, type DestructivePrompt } from "./permissions/guardrails.js";
import { PRESETS as LSP_PRESETS } from "./ui/lsp-presets.js";
import { formatBashTitle, getShellCommand } from "./tools/bash.js";
import { formatJobStartTitle } from "./tools/jobs.js";
import { isCommandCollapsed } from "./util/command-preview.js";
import type { LspServerConfig } from "./config.js";
import { TOOL_HOOK_EVENTS, type HookConfig, type HookEvent } from "./hooks/types.js";
import { RECOMMENDED_HOOKS } from "./hooks/recommended.js";
import { setHookEnabled, appendHook, deriveHookId } from "./hooks/settings.js";
import { EVENT_DESCRIPTIONS, EVENT_COMMAND_EXAMPLES, MATCHER_EXAMPLES } from "./ui/hooks-catalog.js";
import { MODES, type Mode } from "./mode.js";
import { logger } from "./util/logger.js";
import { JobManager, type JobRecord } from "./jobs/manager.js";
import { activityFromJob, activityFromSubagent, diffActivityItems, isActiveJob, type ActivityItem } from "./ui/activity.js";
import { workerRegistry, type RunningWorker } from "./tools/worker-registry.js";
import { CamouflageCrashed, CamouflageUnavailable, diagnoseRenderer, mountFailureReason, rendererBlocker } from "./camouflage-launch.js";
import { humanizePhase } from "./ui/narrator.js";
import { resumeHint } from "./interactive-resume.js";
import { gpuDetection, qualifiesForPrivateModel, type DetectedGpu, type GpuDetection, type UnansweredTool } from "./gpu/detect.js";
import { handoffPath, modelUpResult, requestModelUp, type ModelUpFailure } from "./gpu/handoff.js";
import { checkModelsEndpoint, normalizeBaseUrl, serverBaseUrl } from "./gpu/endpoint.js";
import { detectedTelemetry, flushGpuTelemetry, gpuTelemetrySends, sendGpuTelemetry, type GpuErrorType, type GpuTelemetry } from "./gpu/telemetry.js";
import {
  EARLY_ACCESS_CHOICES,
  EARLY_ACCESS_EMAIL_ERROR,
  EARLY_ACCESS_EMAIL_TITLE,
  EARLY_ACCESS_SUBTITLE,
  EARLY_ACCESS_TELEMETRY_OFF,
  EARLY_ACCESS_THANKS,
  EARLY_ACCESS_THANKS_EMAIL,
  earlyAccessEmailSubtitle,
  earlyAccessQuestion,
  looksLikeEmail,
  ENDPOINT_TITLE,
  ENDPOINT_URL_ERROR,
  modelUpFailedLine,
  MODEL_UP_FAILED_TITLE,
  modelUpFailedSubtitle,
  modelUpFailureChoices,
  modelUpFailureDetails,
  offersModelUpRetry,
  readRunLogTail,
  NO_GPU_HINT,
  CHECKING_GPUS,
  CHECKING_GPUS_AFTER_MS,
  UNANSWERED_CHOICES,
  unansweredLine,
  unansweredNext,
  unansweredTitle,
  noDlHint,
  PRIVATE_MODEL_CHOICES,
  PRIVATE_MODEL_SUBTITLE,
  privateModelQuestion,
  readGpuState,
  reportModelUpResult,
  REMOTE_SERVER_STEPS,
  REMOTE_SERVER_TITLE,
  rememberGpu,
  remoteTunnelHint,
  servedLine,
  smallNvidiaHint,
  THIS_MACHINE_WITHOUT_DL,
  WHERE_QUESTION,
  whereChoices,
  type GpuWhere,
} from "./gpu/first-run.js";
// The SDK's lifecycle types — imported, never re-declared, so this glue can't
// drift from camouflage-tui (2.12.0+).
import type { StreamHandle, ToolHandle, Turn } from "camouflage-tui";

interface CamouflageHandle {
  send(eventType: string, payload?: Record<string, unknown>): boolean;
  /** camouflage-tui 2.12.0+: open a turn whose handles auto-settle. */
  turn(opts?: { id?: string }): Turn;
  on(event: string, listener: (...args: any[]) => void): this;
  close(): Promise<number>;
}

interface CamouflageSdk {
  mount(opts: Record<string, unknown>): Promise<CamouflageHandle>;
  selectList(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; value?: string; cancelled: boolean }>;
  confirm(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; value?: boolean; cancelled: boolean }>;
  form(cam: CamouflageHandle, spec: Record<string, unknown>): Promise<{ id: string; values?: Record<string, string>; cancelled: boolean }>;
  /** camouflage-tui 2.4.0-beta.7+. */
  suspendTerminal?(cam: CamouflageHandle, opts?: { timeoutMs?: number }): Promise<{ supported: boolean }>;
  resumeTerminal?(cam: CamouflageHandle): void;
}

/** Renderer severity for an info/memory notice: a warning-toned info
 *  event (e.g. a failed hook, #889) shows as a warning. */
export function noticeSeverity(e: Extract<ChatEvent, { kind: "info" | "memory" }>): "info" | "warn" {
  return e.kind === "info" && e.tone === "warn" ? "warn" : "info";
}

export { CamouflageUnavailable, CamouflageCrashed };

/** CamouflageUnavailable with the on-disk diagnosis attached. */
function unavailable(reason: string): CamouflageUnavailable {
  return new CamouflageUnavailable(reason, diagnoseRenderer());
}

async function loadSdk(): Promise<CamouflageSdk> {
  const sdk = (await import("camouflage-tui").catch((err) => {
    throw unavailable(`camouflage-tui could not be loaded (${(err as Error).message})`);
  })) as unknown as Partial<CamouflageSdk>;
  if (typeof sdk.mount !== "function" || typeof sdk.selectList !== "function") {
    throw unavailable("the installed camouflage-tui is too old");
  }
  return sdk as CamouflageSdk;
}

export interface RendererInfo {
  packageVersion: string | null;
  /** The binary mount() runs. */
  binary: string;
  source: "CAMOUFLAGE_BIN" | "package";
  /** `<binary> --version`, when the renderer supports it. */
  binaryVersion: string | null;
}

/**
 * Which renderer runs (#862): CAMOUFLAGE_BIN, else the binary camouflage-tui's
 * postinstall downloaded. (Since camouflage-tui 2.8 the SDK never falls back
 * to a `camouflage-tui` on PATH; a missing binary is re-downloaded or fails.)
 */
export function rendererInfo(env: NodeJS.ProcessEnv = process.env): RendererInfo {
  let packageVersion: string | null = null;
  let packageBin = "camouflage-tui";
  try {
    // The package's exports don't include package.json: resolve its entry
    // point and walk up to the package root.
    let dir = dirname(fileURLToPath(import.meta.resolve("camouflage-tui")));
    while (!existsSync(join(dir, "package.json")) && dirname(dir) !== dir) dir = dirname(dir);
    packageVersion = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version ?? null;
    const local = join(dir, "bin", process.platform === "win32" ? "camouflage-tui.exe" : "camouflage-tui");
    packageBin = local;
  } catch {
    // not installed: mount() reports that
  }
  let binary: string;
  let source: RendererInfo["source"];
  if (env.CAMOUFLAGE_BIN) {
    binary = env.CAMOUFLAGE_BIN;
    source = "CAMOUFLAGE_BIN";
  } else {
    binary = packageBin;
    source = "package";
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
  /** Null on first run (no credentials yet): provider setup runs in the renderer before the App mounts. */
  cfg: Cfg | null;
  version: string;
  /**
   * Mount App with this bridge (renderApp with the bridge, Ink drawing
   * nothing). `cfg` is opts.cfg, or the config first-run setup just saved.
   */
  runApp: (bridge: AppBridge, cfg: Cfg) => Promise<void>;
}

/**
 * A session that isn't the local App (`autopilot attach-remote`): it brings
 * its own header and slash commands, and needs no provider setup or local
 * resume hint. `run` drives the view through the same AppBridge App uses.
 */
export interface CamouflageSessionViewOpts {
  version: string;
  header: { title: string; detail: string[] };
  commands: RegisteredSlashCommand[];
  /** Gets the View (an AppBridge, plus the setup screens `autopilot connect` runs without an App). */
  run: (bridge: View) => Promise<void>;
}

/** How the session ended: normally, or before it began because first-run setup was cancelled or failed. */
/** "setup-model-up": first run handed over to dl model up (gpu/handoff.ts); exit so dl can run it. */
export type CamouflageViewResult = "done" | "setup-cancelled" | "setup-failed" | "setup-model-up";

/**
 * The header's detail lines, kept nearly silent: the model (with the folder
 * and branch), the `/tour` hint until the tour has been opened once, and on
 * the free tier one line with what's left this week and the invite link
 * (see dlStartLine). First run has no model yet.
 */
export function sessionHeaderDetail(
  cfg: Pick<Cfg, "model"> | null,
  cwd: string,
  branch: string | null,
  o: { free?: string; tourHint?: string } = {},
): string[] {
  if (!cfg) return [[shortPath(cwd), branch].filter(Boolean).join(" · "), "First run"];
  return [
    [shortModel(cfg.model), shortPath(cwd), branch].filter(Boolean).join(" · "),
    ...(o.tourHint ? [o.tourHint] : []),
    ...(o.free ? [o.free] : []),
  ];
}

/**
 * The header's free-tier line: only when the active provider is the free tier
 * (signed in; not an own key, a local GPU server or any other provider), and
 * only with an account read; nothing rather than a placeholder otherwise.
 */
export function freeHeaderLine(cfg: Cfg | null, me: DlMe | null, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!cfg || resolveActiveProvider(cfg, env).id !== DL_PROVIDER_ID) return undefined;
  return dlStartLine(me, cfg.model);
}

/** How long the header waits for /v1/me after the renderer mounts, for the free tier's line. */
const FREE_HEADER_WAIT_MS = 300;

export async function runCamouflageView(input: CamouflageViewOpts | CamouflageSessionViewOpts): Promise<CamouflageViewResult> {
  const custom = "run" in input ? input : null;
  const opts: CamouflageViewOpts = custom ? { cfg: null, version: custom.version, runApp: (bridge) => custom.run(bridge as View) } : (input as CamouflageViewOpts);
  const sdk = await loadSdk();
  // Fail before mounting when the renderer certainly can't run (a postinstall
  // that silently left bin/ empty on an unsupported platform, a bad
  // CAMOUFLAGE_BIN), instead of a spawn error or a doomed download.
  const diagnosis = diagnoseRenderer();
  const blocker = rendererBlocker(diagnosis);
  if (blocker) throw new CamouflageUnavailable(blocker, diagnosis);
  if (!diagnosis.envBin && !diagnosis.packageBinExists) {
    // The SDK downloads the missing binary once before giving up.
    process.stderr.write(`autopilot: the Camouflage renderer is missing (${diagnosis.packageBin}); downloading it…\n`);
  }
  // A pty that reports 0×0 draws nothing useful; the renderer assumes 80×24, and this says why.
  warnIfNoTerminalSize();
  // On the free tier, read the account while the renderer mounts: the header shows what's left.
  const onFreeTier = (cfg: Cfg | null) => !custom && !!cfg && resolveActiveProvider(cfg).id === DL_PROVIDER_ID;
  const meSoon: Promise<DlMe | null> = onFreeTier(opts.cfg) ? fetchDlMe().catch(() => null) : Promise.resolve(null);
  // First run asks "How should it think?": read the free tier's status while the renderer mounts.
  if (!custom && !opts.cfg && !envKeyProvider()) {
    void dlFreeStatus();
    // And look for GPUs in the background (cached; instant without GPU tools, up to 10 s per try with them).
    void gpuDetection().catch(() => null);
  }
  // Back from dl model up (gpu/handoff.ts): count how it went, once.
  reportModelUpResult();
  const restoreConsole = captureConsole();
  let cam: CamouflageHandle;
  try {
    cam = await sdk.mount({
      ui: "inline",
      appTitle: productName(),
      inheritStderr: false,
      ...(process.env.CAMOUFLAGE_BIN ? { bin: process.env.CAMOUFLAGE_BIN } : {}),
    });
  } catch (err) {
    restoreConsole();
    throw unavailable(mountFailureReason((err as Error).message));
  }
  if (typeof cam.turn !== "function") {
    // The lifecycle API is what keeps a forgotten finish event from wedging
    // the renderer's spinner; without it this integration would be guessing.
    restoreConsole();
    throw unavailable("the installed camouflage-tui is too old (the lifecycle API needs 2.12.0 or newer)");
  }
  const renderer = rendererInfo();
  logger.info("camouflage.renderer", { ...renderer });
  cam.on("stderr", (chunk: string) => logger.warn("camouflage.stderr", { chunk }));

  const cwd = process.cwd();
  const branch = gitBranch(cwd);
  // The /tour hint shows until the tour has been opened once.
  const tourLine = custom ? undefined : await tourHintUntilSeen();
  const startSession = (cfg: Cfg | null, me: DlMe | null) =>
    cam.send("SessionStarted", {
      title: custom ? custom.header.title : headerTitle(opts.version),
      detail: custom
        ? custom.header.detail
        : sessionHeaderDetail(cfg, cwd, branch, { tourHint: tourLine, free: freeHeaderLine(cfg, me) }),
      accent: "orange",
      assistant_label: productName(),
    });
  // A slow account read doesn't hold the session up: the header goes without the line
  // (an account already read in this process is used as is).
  startSession(
    opts.cfg,
    onFreeTier(opts.cfg)
      ? lastKnownDlMe() ?? (await Promise.race([meSoon, new Promise<null>((r) => setTimeout(r, FREE_HEADER_WAIT_MS, null).unref())]))
      : null,
  );
  const files = listFiles(cwd);
  if (files.length > 0) {
    cam.send("MentionCandidatesRegistered", { candidates: files.map((token) => ({ token, kind: "file" })) });
  }

  const view = new View(cam, sdk, custom ? { commands: custom.commands } : {});
  // `!` commands borrow the terminal from the renderer while they run.
  registerTerminalHandoff({
    suspend: async () => (sdk.suspendTerminal ? (await sdk.suspendTerminal(cam)).supported : false),
    resume: () => sdk.resumeTerminal?.(cam),
  });
  cam.on("userInput", (text: string) => {
    if (view.signIn && view.signInWaiting) {
      // A sign-in is waiting on the browser: nothing typed now goes anywhere.
      cam.send("RuntimeError", { message: view.signInWaiting, severity: "info" });
      return;
    }
    if (!view.actions) {
      // First-run setup is still running: there is no session to send it to.
      cam.send("RuntimeError", { message: "Finish connecting a provider first — the session starts right after.", severity: "info" });
      return;
    }
    // /jobs and /agents browse this machine's background work: not a remote session's.
    if (!custom && view.routeActivityCommand(text)) return;
    view.echoed.push(text.trim());
    view.actions?.submit(text);
  });
  // Esc during a provider sign-in cancels the sign-in, not the turn.
  cam.on("cancelRequested", () => {
    view.cancels++;
    if (view.signIn) view.signIn.abort();
    else view.actions?.interrupt();
  });
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
  // A signal or crash mid-session: give the terminal back before exiting (#877).
  const unregisterShutdown = onShutdown("camouflage-renderer", finish);
  let crashed: { code: number | null; signal: string | null } | null = null;
  cam.on("exit", (info?: { code: number | null; signal: NodeJS.Signals | null }) => {
    if (closing) return;
    const code = info?.code ?? 0;
    const signal = info?.signal ?? null;
    if (rendererExitIsUserQuit(code, signal)) {
      // The user quit the renderer (Ctrl+C twice, or Ctrl+C delivered as
      // SIGINT): end the App too.
      void finish().then(() => {
        if (view.actions) return view.actions.exit();
        // Quit during first-run setup: nothing was saved, say so on the way out.
        quitBeforeApp = true;
        endBeforeApp();
      });
      return;
    }
    // The renderer crashed (#862). The session must survive it: say where the
    // crash report is, let the turn in flight finish (it is saved after every
    // turn), then end the App so the caller reopens it in a fresh renderer.
    crashed = { code, signal };
    logger.error("camouflage.crashed", { code, signal, ...renderer });
    void finish().then(async () => {
      // The renderer left the terminal in raw mode; give it back.
      if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
      process.stderr.write(
        `\nThe Camouflage renderer stopped unexpectedly (${signal ?? `exit code ${code}`}). ` +
          `Its crash report is in ${join(homedir(), ".camouflage")} (crash-*.txt).\n` +
          (view.busy ? "Finishing the current turn first…\n" : ""),
      );
      await view.settle();
      // Before the App connected there's nothing to end: stop waiting for it.
      if (view.actions) view.actions.exit();
      else endBeforeApp();
    });
  });

  // The renderer went away (quit or crash) before the App connected.
  let endBeforeApp: () => void = () => {};
  let quitBeforeApp = false;
  const beforeApp = new Promise<void>((resolve) => (endBeforeApp = resolve));
  let setup: FirstRunOutcome | null = null;
  try {
    let cfg = opts.cfg;
    if (custom) {
      if (!crashed) await Promise.race([custom.run(view), beforeApp]);
    } else if (!cfg) {
      const onboarding = runFirstRun({
        upgrading: hasLegacyCloudflareConfig,
        configPath,
        show: (lines) => view.showLines(lines),
        envKey: () => envKeyProvider(),
        setup: (o) => view.firstRunSetup(o),
        loadConfig,
      });
      const outcome = await Promise.race([onboarding, beforeApp.then(() => null)]);
      if (outcome?.kind === "ready") {
        cfg = outcome.cfg;
        // A free-tier sign-in just read the account.
        startSession(cfg, lastKnownDlMe());
      } else {
        setup = outcome ?? (quitBeforeApp ? { kind: "cancelled" } : null);
      }
    }
    if (!custom && cfg && !crashed) await Promise.race([opts.runApp(view, cfg), beforeApp]);
  } finally {
    unregisterShutdown();
    await finish();
  }
  if (crashed) {
    const c = crashed as { code: number | null; signal: string | null };
    throw new CamouflageCrashed(`renderer exited (${c.signal ?? `code ${c.code}`})`, view.sessionId);
  }
  const outcome = setup as FirstRunOutcome | null;
  if (outcome?.kind === "model-up") return "setup-model-up";
  if (outcome?.kind === "cancelled") {
    process.stdout.write(`${onboardingCancelledMessage()}\n`);
    return "setup-cancelled";
  }
  if (outcome?.kind === "failed") {
    process.stderr.write(`autopilot: ${outcome.message}\n`);
    return "setup-failed";
  }
  const hint = custom ? null : resumeHint(view.sessionId);
  if (hint) process.stdout.write(hint);
  return "done";
}

/** Translates App snapshots into renderer events, sending only what changed. Exported for tests. */
/**
 * Run a provider call, turning an expired sign-in into a prompt instead of a
 * rejection. The crash log names the error and the exit, not the caller, so
 * every detached `fetchDlMe`/`dlAccessToken` call goes through here.
 */
export async function catchDlAuth<T>(
  work: () => Promise<T>,
  say: (message: string, severity?: "info" | "error") => void,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (e) {
    if (isDlAuthError(e)) {
      say(dlAuthPrompt(e), "error");
      return undefined;
    }
    throw e;
  }
}

export class View implements AppBridge {
  actions: AppActions | null = null;
  /** Prompts the renderer already printed when the user submitted them. */
  echoed: string[] = [];
  /** Per-event state already sent, keyed by ChatEvent.key. */
  private sent = new Map<string, { text: number; done: boolean }>();
  /** Reasoning characters already sent, per open assistant stream. */
  private reasoningSent = new Map<string, number>();
  /** Events before this index are fully sent and won't change. */
  private settled = 0;
  private firstKey: string | undefined;
  /** True once a prompt, answer or tool reached the renderer (not just notices). */
  private conversationShown = false;
  private segments: Record<string, string> = {};
  private todos = "";
  private permission: unknown = null;
  private openPrompt: string | null = null;
  /** A provider sign-in waiting on the browser; Esc aborts it. */
  signIn: AbortController | null = null;
  /** What typed input is answered with while the free tier's sign-in waits on the browser. */
  signInWaiting: string | null = null;
  /** The terminal lent out while waiting on a browser (tests swap in a fake). */
  terminalIo: WaitIo | undefined = undefined;
  /** The provider calls the setup screens make; replaced in tests. */
  providerCalls = { dlSignIn: directionallyLocalSignIn, verify: verifyProvider, dlMe: () => fetchDlMe() };
  /** The free tier's public status (open on any failure, within 1.5 s). */
  freeStatus: () => Promise<DlFreeStatus> = () => dlFreeStatus();
  /** What the GPU first run calls (detection, the environment dl set, fetch for endpoints); replaced in tests. */
  gpuCalls: { detect: () => Promise<GpuDetection>; env: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {
    detect: () => gpuDetection(),
    env: process.env,
  };
  /** What /feedback calls (the free tier token, and fetch); replaced in tests. */
  feedbackCalls: { token: () => Promise<string | undefined>; fetchImpl?: typeof fetch } = { token: () => dlAccessToken() };
  /** What /request calls (the free tier token, refreshed on `force`, and fetch); replaced in tests. */
  accessRequestCalls: { token: (force?: boolean) => Promise<string | undefined>; fetchImpl?: typeof fetch } = {
    token: (force) => dlAccessToken(force ? { force } : {}),
  };
  /** What the free tier's limit, queue and /upgrade screens call; replaced in tests. */
  dlScreenCalls: Pick<DlScreenDeps, "checkout" | "fetchMe" | "openBrowser" | "copy" | "sleep" | "now"> = {
    checkout: (product, quantity) => dlCheckout(product, quantity !== undefined ? { quantity } : {}),
    fetchMe: () => fetchDlMe(),
    openBrowser: (url) => openBrowser(url),
    copy: (text) => copyWithOsc52(text),
    sleep: (ms, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    now: () => Date.now(),
  };
  /** What the star ask and the GitHub sign-in call (gh, the browser); replaced in tests. */
  githubCalls: { gh: GhRun; login: GhLogin; openBrowser: (url: string) => boolean } = {
    gh: runGh,
    login: ghAuthLogin,
    openBrowser: (url) => openBrowser(url),
  };
  /** Esc presses (cancelRequested) so far: a permission prompt denied with
   *  Esc interrupts the turn instead of asking for feedback. */
  cancels = 0;
  private commandsKey: string | undefined;
  private readonly sentSubagentPolicyNotices = new Set<string>();
  /** The jobs database: undefined until first use, null when it couldn't open. */
  private jobsManager: JobManager | null | undefined;
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
  /** The turn the current run's handles belong to; null while the app is idle. */
  private turn: Turn | null = null;
  /** Assistant streams still open, keyed by ChatEvent.key. */
  private readonly streams = new Map<string, StreamHandle>();
  /** Tools still running, keyed by ChatEvent.key. */
  private readonly tools = new Map<string, ToolHandle>();

  constructor(
    private cam: CamouflageHandle,
    private sdk: CamouflageSdk,
    /** `commands`: a fixed slash-command list (a remote session) instead of the built-ins plus custom ones. */
    /** `openJobs`: how to open the jobs database (tests inject a failing one). */
    private readonly opts: { commands?: RegisteredSlashCommand[]; openJobs?: () => JobManager } = {},
  ) {}

  /**
   * The jobs database, opened on first use. When it can't open (a broken
   * SQLite install, an unwritable state dir), background-job activity is off
   * for this session with one dim notice, instead of crashing the UI.
   */
  private get jobs(): JobManager | null {
    if (this.jobsManager !== undefined) return this.jobsManager;
    try {
      this.jobsManager = (this.opts.openJobs ?? (() => new JobManager()))();
    } catch (error) {
      this.jobsManager = null;
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn("camouflage.jobs_db_unavailable", { error: reason });
      this.cam.send("RuntimeError", {
        message: `Background job activity is off: couldn't open the jobs database (${reason.split("\n")[0]}).`,
        severity: "info",
      });
    }
    return this.jobsManager;
  }

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

  /** The current run's turn, opened on first use: everything under it settles together. */
  private ensureTurn(): Turn {
    return (this.turn ??= this.cam.turn());
  }

  /**
   * Settle whatever the run left open — streams that never completed and
   * tools that never finished. The renderer keeps its spinner while any
   * entry is open (`is_busy()`), which is how a forgotten finish event used
   * to wedge the UI. `phase: null`: the footer's phase belongs to
   * statusSegments(), which already sends "idle" when the App goes quiet.
   *
   * Handles stay in their maps, settled, so an idle snapshot that keeps
   * reporting the same open event doesn't re-announce a stream the renderer
   * has already finished; the maps are dropped with the transcript itself.
   */
  private endTurn(): void {
    this.turn?.end({ phase: null });
    this.turn = null;
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
    // Nothing is running: settle anything the run left open. Skipped while a
    // permission prompt is up — the user may still answer it.
    if (!s.turnRunning && !s.permission) this.endTurn();
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
    const jobs = this.jobs;
    if (!jobs) return;
    try {
      const job = jobs.get(id);
      if (!job || !isActiveJob(job)) return;
      jobs.cancel(id);
      this.refreshActivities();
    } catch (error) {
      logger.warn("camouflage.activity_stop_failed", { id, error: String(error) });
      this.cam.send("RuntimeError", { message: `Unable to stop background job: ${(error as Error).message}`, severity: "error" });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endTurn();
    if (this.activityPoll) clearInterval(this.activityPoll);
    this.activityPoll = null;
    this.jobsManager?.close();
  }

  private syncActivity(workers: RunningWorker[]): void {
    this.latestWorkers = workers;
    try {
      // Jobs live in one database per user; show only this session's, not every session's.
      const records = this.sessionId ? this.jobs?.list({ session: { id: this.sessionId, cwd: process.cwd() }, limit: 100 }) ?? [] : [];
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
    const jobs = this.jobs;
    if (!jobs) return;
    for (const stream of ["stdout", "stderr"] as const) {
      const key = `${id}:${stream}`;
      try {
        const result = initial
          ? jobs.logs(id, stream, { tail: 1000 })
          : jobs.logs(id, stream, { offset: this.jobLogOffsets.get(key) ?? 0 });
        this.jobLogOffsets.set(key, result.offset);
        if (result.content) this.cam.send("ActivityLog", { id, chunk: result.content, stream });
      } catch {
        // The selected item may have been removed while the detail view opened.
      }
    }
  }

  private syncCommands(custom: { name: string; description?: string }[]): void {
    if (this.opts.commands) {
      const key = JSON.stringify(this.opts.commands);
      if (key !== this.commandsKey) this.cam.send("SlashCommandsRegistered", { commands: this.opts.commands });
      this.commandsKey = key;
      return;
    }
    this.commandsKey = syncSlashCommands(custom, this.commandsKey, (commands) => {
      this.cam.send("SlashCommandsRegistered", { commands });
    });
  }

  private syncEvents(events: ChatEvent[]): void {
    // /clear, /resume and compaction replace the list: start over.
    if (events.length < this.settled || (this.firstKey !== undefined && events[0]?.key !== this.firstKey)) {
      if (this.conversationShown) {
        this.cam.send("TranscriptCleared", {});
        this.sent.clear();
        // New transcript, new handles: the old ones are settled and their
        // renderer-side entries are gone with the clear.
        this.streams.clear();
        this.tools.clear();
        this.conversationShown = false;
      }
      // Otherwise only the startup notices are on screen (`dl -c`,
      // `autopilot -c` replaying history at launch): clearing the screen
      // would push them and the input box into the scrollback, leaving an
      // empty box above the history. The history prints below them instead,
      // above the input box, and notices already shown aren't repeated.
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
    if ((e.kind === "user" && !e.queued) || e.kind === "assistant" || e.kind === "tool") this.conversationShown = true;
    switch (e.kind) {
      case "user": {
        if (e.queued) return false;
        // The renderer printed what the user typed when they submitted it;
        // don't print App's copy again. (Messages App adds on its own,
        // e.g. from a resumed session, still go through.)
        const i = this.echoed.indexOf(e.text.trim());
        if (i >= 0) this.echoed.splice(0, i + 1);
        else this.cam.send("UserMessageCreated", { text: e.text });
        return this.mark(e.key, 0, true);
      }
      case "assistant": {
        const stream = this.streamFor(e.key);
        // Reasoning streams first; the renderer shows it on Ctrl+R.
        const thought = this.reasoningSent.get(e.key) ?? 0;
        if (e.reasoning.length > thought) {
          stream.reasoning(e.reasoning.slice(thought));
          this.reasoningSent.set(e.key, e.reasoning.length);
        }
        const already = prev?.text ?? 0;
        if (e.text.length > already && e.text.startsWith(e.text.slice(0, already))) {
          stream.write(e.text.slice(already));
        }
        if (!e.streaming) {
          this.reasoningSent.delete(e.key);
          stream.end({ text: e.text });
          this.streams.delete(e.key);
          return this.mark(e.key, e.text.length, true);
        }
        return this.mark(e.key, e.text.length, false);
      }
      case "tool":
        return this.syncTool(e);
      case "info":
      case "memory":
        if (e.kind === "info" && !shouldSendSubagentPolicyNotice(e.text, this.sentSubagentPolicyNotices)) {
          return this.mark(e.key, 0, true);
        }
        if (e.kind === "info" && e.tone === "dim") return this.dim(e.key, e.text);
        return this.notice(e.key, e.text, noticeSeverity(e));
      case "error":
        if (e.detail) {
          this.notice(e.key, e.text, "error");
          return this.dim(e.key, e.detail);
        }
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

  /** The stream handle for an assistant event, opened on first sight. */
  private streamFor(key: string): StreamHandle {
    let stream = this.streams.get(key);
    if (!stream) {
      stream = this.ensureTurn().stream({ id: key });
      this.streams.set(key, stream);
    }
    return stream;
  }

  private syncTool(e: { key: string } & ToolEventState): boolean {
    let tool = this.tools.get(e.key);
    if (!tool) {
      const { label, args } = toolRow(e.name, e.render?.title, e.args, process.stdout.columns);
      tool = this.ensureTurn().tool({ id: e.key, name: label, args, started_at_ms: e.startedAt });
      this.tools.set(e.key, tool);
    }
    if (e.status === "queued" || e.status === "running") return this.mark(e.key, 0, false);
    const ok = e.status === "done";
    const content = e.result ?? "";
    const bang = splitBangResult(e.render?.title, content);
    const output = e.status === "rejected" ? "" : bang.output;
    tool.finish({
      exit_code: bang.exitCode ?? (ok ? 0 : 1),
      status: e.status === "rejected" ? "rejected" : e.status === "cancelled" ? "cancelled" : ok ? "done" : "error",
      summary: bang.status ?? toolSummary(e.name, ok, e.status === "rejected", output),
      output: e.status === "rejected" ? "" : toolOutputWithCommand(output, shellCommandArg(e.name, e.args)),
      ...(ok && e.render?.diff ? { diff: e.render.diff } : {}),
    });
    this.tools.delete(e.key);
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

  /** Plain dim lines, no bullet. */
  private dim(key: string, text: string): boolean {
    this.cam.send("Splash", { text: text.split("\n").map((l) => `\x1b[2m${l}\x1b[0m`).join("\n") });
    return this.mark(key, 0, true);
  }

  private mark(key: string, text: number, done: boolean): boolean {
    this.sent.set(key, { text, done });
    return done;
  }

  private syncStatus(s: AppSnapshot): void {
    const next = statusSegments(s);
    const changed: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) {
      if ((this.segments[k] ?? "") !== v) changed[k] = v;
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
    if (s.permission.destructive) return void this.askDestructive(s.permission.destructive);
    const { tool, args, sensitiveReason } = s.permission;
    const detail = permissionDetail(tool.name, args, sensitiveReason, process.stdout.columns);
    let render: { title: string; diff?: { path: string; before: string; after: string } } | undefined;
    try {
      render = tool.render?.(args);
    } catch {
      render = undefined;
    }
    const cancelsBefore = this.cancels;
    void this.ensureTurn()
      .permission({
        request_id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tool: tool.name,
        action: render?.title ?? tool.name,
        ...(detail ? { detail } : {}),
        ...(render?.diff ? { diff: render.diff } : {}),
      })
      .then(async (answer) => {
        if (answer.choice !== "deny") {
          this.actions?.decidePermission(answer.choice === "allow_once" ? "allow" : "allow_session");
          return;
        }
        const feedback = await this.denyFeedback(answer.feedback, () => this.cancels !== cancelsBefore);
        if (feedback) this.actions?.denyWithFeedback(feedback);
        else this.actions?.decidePermission("deny");
      });
  }

  /**
   * An irreversible action (permissions/guardrails.ts): says what will be
   * lost and whether recovery exists. A production-looking target needs its
   * name typed; anything else typed, or Esc, is Don't.
   */
  private async askDestructive(d: DestructivePrompt): Promise<void> {
    if (d.confirmName) {
      this.cam.send("RuntimeError", { message: d.subtitle, severity: "warn" });
      const r = await this.sdk.form(this.cam, {
        id: `destructive-${Date.now()}`,
        title: d.title,
        fields: [{ name: "confirm", label: `Type ${d.confirmName} to run it`, placeholder: "Anything else doesn't run it" }],
      });
      const ok = !r.cancelled && r.values?.confirm?.trim() === d.confirmName;
      return void this.actions?.decidePermission(ok ? CONFIRMED_IRREVERSIBLE : "deny");
    }
    const r = await this.select(d.title, [{ value: "run", label: "Run it" }, { value: "deny", label: "Don't run it" }], "deny", d.subtitle);
    this.actions?.decidePermission(r === "run" ? CONFIRMED_IRREVERSIBLE : "deny");
  }

  /**
   * "No, and tell autopilot what to do differently" (Ink's "Something
   * else"): ask what the model should do instead. The renderer's own prompt
   * has no text field, so a form follows the denial. Esc on the prompt also
   * denies but interrupts the turn: no form then. Returns "" for a plain deny.
   */
  private async denyFeedback(given: string | undefined, escaped: () => boolean): Promise<string> {
    if (given?.trim()) return given.trim();
    // Esc sends the denial, then cancelRequested; let the latter arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (escaped() || this.disposed) return "";
    const r = await this.sdk.form(this.cam, {
      id: `deny-${Date.now()}`,
      title: "Tell autopilot what to do differently",
      fields: [{ name: "feedback", label: "Instead…", placeholder: "Enter with nothing typed just denies" }],
    });
    return r.cancelled ? "" : r.values?.feedback?.trim() ?? "";
  }

  /** Map App's pickers to renderer prompts. */
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
    if (s.githubAccess) {
      return want("githubAccess", async () => {
        const outcome = await this.githubAccess().catch(() => "not-now" as const);
        a.githubAccessDone?.(outcome);
      });
    }
    if (s.starAsk && !s.turnRunning) {
      const line = s.starAsk;
      return want("starAsk", async () => {
        await this.starAsk(line).catch(() => undefined);
        a.starAskDone?.();
      });
    }
    if (s.productTour && !s.turnRunning) {
      return want("productTour", async () => {
        await this.productTour().catch(() => undefined);
        a.productTourDone?.();
      });
    }
    if (s.dlScreen) {
      const screen = s.dlScreen;
      return want("dlScreen", async () => {
        const outcome = await this.dlScreen(screen).catch(() => "dismissed" as const);
        a.dlScreenDone?.(outcome);
      });
    }
    if (s.feedback) {
      const req = s.feedback;
      return want("feedback", async () => {
        const line = await this.feedback(req).catch((): FeedbackLine => ({ text: FEEDBACK_FALLBACK_LINE, severity: "error" }));
        a.feedbackDone?.(line);
      });
    }
    if (s.accessRequest) {
      const req = s.accessRequest;
      return want("accessRequest", async () => {
        const line = await this.accessRequest(req).catch((): AccessRequestLine => ({ text: ACCESS_FAILED_LINE, severity: "error" }));
        a.accessRequestDone?.(line);
      });
    }
    if (s.queuePlan) {
      const prompts = s.queuePlan.prompts;
      return want("queuePlan", async () => {
        this.cam.send("Splash", { text: queuePlanSplash(prompts) });
        const r = await this.select("Coordinate queued follow-ups?", queuePlanOptions(prompts.length), undefined, "Worker calls still require permission; grouping doesn't authorize parallel edits");
        a.pickQueuePlan(r === "group" || r === "separate" ? r : null);
      });
    }
    const modal = s.modals[0];
    if (!modal) return;
    switch (modal) {
      case "model":
        return want("model", async () => {
          const models = s.modelChoices ?? pickableModels();
          // On the free tier the list is its one model: say how to get others, so search isn't a dead end.
          const freeOnly = models.length === 1 && models[0]!.id === DL_FREE_MODEL;
          const subtitle = freeOnly
            ? "The free tier has this one model. For any other, use your own key: /provider"
            : "Context · price per Mtok (input / output / cached) · type to search all models";
          const r = await this.select("Select a model", modelOptions(models, s.model), s.model, subtitle);
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
          const r = await this.select("Help", helpOptions(s.customCommands), undefined, helpFooter());
          if (r) await this.runWithArgs(r);
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
            { value: "/memory doctor", label: "Check memory health, hit rate, noise, orphaned rows" },
            { value: "/memory export", label: "Export memories to JSON…" },
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
        { value: "project", label: "Project", description: ".autopilot/commands in this repo" },
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
        let path: string;
        try {
          path = appendHook("project", cwd, rec.event, { ...rec.hook, enabled: true });
        } catch (e) {
          this.cam.send("RuntimeError", { message: `could not enable ${rec.id}: ${(e as Error).message}`, severity: "error" });
          continue;
        }
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
    const toolEvent = TOOL_HOOK_EVENTS.has(event);
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
      { value: "project", label: "project", description: ".autopilot/settings.json" },
      { value: "global", label: "global", description: "~/.config/autopilot/settings.json" },
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
    // Read the free tier's status while the config loads; the picker waits for it at most 1.5 s.
    if (!initial) void this.freeStatus();
    const cfg = await loadConfig().catch(() => null);
    const saved = await this.connectAndPickModel({ cfg, initial, firstRun: false });
    if (saved) this.actions?.providerSwitched(saved.id);
  }

  /**
   * First-run setup, before the App mounts: one question, then the `/provider` steps,
   * seeded from the raw config file (a Cloudflare-era config keeps the
   * account id/token Workers AI can reuse). True once a provider and model
   * are saved; false when the user backs out of the first-run question.
   */
  async firstRunSetup(o: { upgrading: boolean; envKey?: { id: ProviderId; envVar: string } }): Promise<boolean | "model-up"> {
    const persisted = await readPersistedConfig().catch(() => null);
    const outcome = await this.howToThink({ cfg: persisted, firstRun: true, upgrading: o.upgrading, ...(o.envKey ? { envKey: o.envKey } : {}) });
    return outcome === "model-up" ? outcome : outcome !== null;
  }

  /**
   * First run's one question: the free tier, or your own key. Free goes
   * straight into the GitHub sign-in; own key opens the provider picker
   * without the free tier. A denied sign-in says why and asks again. No
   * answer is marked current unless a provider is already configured. With a
   * known provider's key in the environment the
   * question is skipped and that key is used (backing out of it asks).
   */
  private async howToThink(o: {
    cfg: Partial<Cfg> | null;
    firstRun: boolean;
    upgrading?: boolean;
    standalone?: boolean;
    envKey?: { id: ProviderId; envVar: string };
  }): Promise<ConnectOutcome | null | "model-up"> {
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    // GPU detection runs while the free tier's status loads (it's cached for the session, and
    // instant without GPU tools). A GPU tool that is there gets its whole budget (nvidia-smi can
    // take seconds after idle): the question waits for it, with "Checking for GPUs…" meanwhile.
    let detected = false;
    const detecting = this.gpuCalls
      .detect()
      .catch((): GpuDetection => ({ gpu: null }))
      .finally(() => {
        detected = true;
      });
    const common = { cfg: o.cfg, firstRun: o.firstRun, ...(o.upgrading ? { upgrading: true } : {}), ...(o.standalone ? { standalone: true } : {}) };
    if (o.envKey) {
      const saved = await this.connectAndPickModel({ ...common, initial: o.envKey.id, envKeyDirect: true, backReturns: true });
      if (saved) return saved;
    }
    // The renderer marks the default "✓ current", so there is one only when a provider is configured.
    const configured = o.firstRun ? undefined : o.cfg?.provider;
    const status = await this.freeTierStatus(o.cfg);
    // Without GPU tools the detection is done in a few ms (no process started): no line then.
    if (!detected) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([detecting, new Promise<void>((resolve) => (timer = setTimeout(resolve, CHECKING_GPUS_AFTER_MS)))]);
      clearTimeout(timer);
    }
    if (!detected) say(CHECKING_GPUS);
    const detection = await detecting;
    const gpu = detection.gpu;
    // Only dl started from a terminal can run dl model up; `autopilot connect` never hands over.
    const canModelUp = o.firstRun && !!handoffPath(this.gpuCalls.env);
    if (o.firstRun && (await this.gpuPreScreen(detection, canModelUp, say)) === "model-up") return "model-up";
    const starter = lastKnownDlMe()?.level === "starter";
    const chosen: FirstRunChoice | undefined = configured ? (configured === "directionally-local" ? "free" : configured === "vllm" ? "gpus" : "own-key") : undefined;
    // Paused, Free can't be chosen: it is never the default (own key comes first instead).
    const current = chosen === "free" && !freeChoosable(status) ? undefined : chosen;
    let ownKeyIntroShown = false;
    for (;;) {
      const choice = await this.select(
        FIRST_RUN_QUESTION,
        firstRunChoices(status, undefined, starter),
        current,
        firstRunSubtitle(status, o.firstRun ? "Esc to quit" : "Esc to cancel", starter),
      );
      if (choice === null) return null;
      sendGpuTelemetry({ event: "option", option: choice === "own-key" ? "own_key" : choice === "gpus" ? "gpus" : "free", gpuVendor: gpu?.vendor ?? "none" }, this.gpuCalls.env);
      if (choice === "gpus") {
        const own = await this.ownGpus({ cfg: o.cfg, firstRun: o.firstRun, standalone: !!o.standalone }, gpu, canModelUp, say, detection.unanswered);
        if (own === "back") continue;
        return own;
      }
      if (choice === "free" && !freeChoosable(status)) {
        // The select can't disable a row: say why and ask again.
        say(dlPausedLine(status));
        continue;
      }
      if (choice === "own-key") {
        if (o.firstRun && !ownKeyIntroShown) this.showLines(ownKeyIntro(configPath()));
        ownKeyIntroShown = true;
        const saved = await this.connectAndPickModel({
          ...common,
          exclude: OWN_KEY_EXCLUDE,
          title: "Choose your provider",
          subtitle: `${OWN_KEY_BILLING_LINE} · type to search · Enter to connect · Esc to go back`,
        });
        if (saved) return saved;
        continue;
      }
      const free = await this.freeTierSignIn(o.cfg, say);
      // A denial's message names the way on; the question comes back.
      if (free.kind !== "connected") continue;
      const saved = await this.commitChoice(free.connection, DL_FREE_MODEL, { firstRun: o.firstRun, standalone: !!o.standalone }, say);
      if (saved) return saved;
    }
  }

  /**
   * Before first run's question: what this machine's GPU means (gpu/first-run.ts). A 24 GB
   * Nvidia card, with dl to run the setup, is offered a private model ("model-up" when the
   * answer is yes); a smaller one, AMD, Ascend or none gets its one line or question. A GPU
   * tool that is there but didn't answer says so and keeps the GPU paths open. Answers are
   * remembered, and the detection is counted once per machine.
   */
  private async gpuPreScreen(
    detection: GpuDetection,
    canModelUp: boolean,
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<"model-up" | undefined> {
    const env = this.gpuCalls.env;
    const gpu = detection.gpu;
    const remembered = await readGpuState();
    if (!remembered.counted) {
      sendGpuTelemetry(detectedTelemetry(detection), env);
      await rememberGpu({ counted: true });
    }
    const result = modelUpResult(env);
    if (result && !result.ok) {
      // Back from a dl model up that didn't finish. With dl able to run it again: the failure
      // menu (Retry, See what failed, Pick another model, Continue). Otherwise say so, and go on.
      if (canModelUp && offersModelUpRetry(result)) return this.modelUpFailureMenu(gpu, result, say);
      say(modelUpFailedLine(result.error), result.error === "cancelled" ? "info" : "error");
      return undefined;
    }
    if (gpu && qualifiesForPrivateModel(gpu)) {
      if (!canModelUp) {
        say(noDlHint(gpu));
        return undefined;
      }
      if (remembered.privateModel === "no") return undefined;
      const answer = await this.select(privateModelQuestion(gpu), PRIVATE_MODEL_CHOICES.map((c) => ({ ...c })), "yes", PRIVATE_MODEL_SUBTITLE);
      if (answer === null) return undefined;
      sendGpuTelemetry({ event: "prompt", gpuVendor: "nvidia", answer: answer === "yes" ? "yes" : "no", gpuVramGb: gpu.vramGb }, env);
      if (answer === "yes") return this.handOverModelUp(gpu, say);
      await rememberGpu({ privateModel: "no" });
      return undefined;
    }
    if (gpu?.vendor === "nvidia") {
      say(smallNvidiaHint(gpu));
      return undefined;
    }
    if (gpu && (gpu.vendor === "amd" || gpu.vendor === "ascend")) {
      if (remembered.earlyAccess?.[gpu.vendor]) return undefined;
      const answer = await this.select(earlyAccessQuestion(gpu), EARLY_ACCESS_CHOICES.map((c) => ({ ...c })), "no", EARLY_ACCESS_SUBTITLE);
      if (answer === null) return undefined;
      const yes = answer === "yes";
      // A yes may leave an email, sent with the count; with telemetry off nothing is sent, so none is asked for.
      const sending = gpuTelemetrySends(env);
      const email = yes && sending ? await this.earlyAccessEmail(gpu, say) : undefined;
      sendGpuTelemetry({ event: "early_access", gpuVendor: gpu.vendor, answer: yes ? "yes" : "no", gpuModel: gpu.model, gpuVramGb: gpu.vramGb, ...(email ? { email } : {}) }, env);
      await rememberGpu({ earlyAccess: { [gpu.vendor]: yes ? "yes" : "no" } });
      if (yes) say(!sending ? EARLY_ACCESS_TELEMETRY_OFF : email ? EARLY_ACCESS_THANKS_EMAIL : EARLY_ACCESS_THANKS);
      return undefined;
    }
    if (!gpu && detection.unanswered) return this.unansweredGpu(detection.unanswered, canModelUp, say);
    if (!gpu) say(NO_GPU_HINT);
    return undefined;
  }

  /**
   * A GPU tool that is on PATH but didn't answer, twice: the GPU is likely there. Say so plainly;
   * for Nvidia with dl able to run the setup, offer dl model up (it checks the GPU itself) or
   * the usual choices, where "Use your own GPUs" also offers this machine. Not remembered: the
   * tool may answer next time.
   */
  private async unansweredGpu(
    tool: UnansweredTool,
    canModelUp: boolean,
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<"model-up" | undefined> {
    const line = unansweredLine(tool);
    if (tool.vendor !== "nvidia" || !canModelUp) {
      say(line);
      return undefined;
    }
    const answer = await this.select(unansweredTitle(tool), UNANSWERED_CHOICES.map((c) => ({ ...c })), "model-up", unansweredNext(tool));
    if (answer === null) return undefined;
    sendGpuTelemetry({ event: "prompt", gpuVendor: "nvidia", answer: answer === "model-up" ? "yes" : "no" }, this.gpuCalls.env);
    return answer === "model-up" ? this.handOverModelUp(null, say) : undefined;
  }

  /** The optional email after a yes to early access; asked again until it looks like one. Esc or empty skips. */
  private async earlyAccessEmail(gpu: DetectedGpu, say: (message: string, severity?: "info" | "error") => void): Promise<string | undefined> {
    for (;;) {
      const f = await this.sdk.form(this.cam, {
        id: `early-access-email-${Date.now()}`,
        title: EARLY_ACCESS_EMAIL_TITLE,
        fields: [{ name: "email", label: earlyAccessEmailSubtitle(gpu), placeholder: "you@example.com" }],
      });
      const email = f.cancelled ? "" : (f.values?.email?.trim() ?? "");
      if (!email) return undefined;
      if (looksLikeEmail(email)) return email;
      say(EARLY_ACCESS_EMAIL_ERROR, "error");
    }
  }

  /**
   * After a private model setup that failed: what failed (dl's reason) and four ways on. Retry
   * and Pick another model hand over to dl again; See what failed shows the reason, the log's
   * path and its last lines that matter (never the server's whole log); Continue goes on to the
   * usual choices.
   */
  private async modelUpFailureMenu(
    gpu: DetectedGpu | null,
    failure: ModelUpFailure,
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<"model-up" | undefined> {
    for (;;) {
      const choice = await this.select(MODEL_UP_FAILED_TITLE, modelUpFailureChoices(failure), "retry", modelUpFailedSubtitle(failure));
      if (choice === null || choice === "continue") return undefined;
      if (choice === "details") {
        this.showLines(modelUpFailureDetails(failure, failure.log ? await readRunLogTail(failure.log) : undefined));
        continue;
      }
      const handed = await this.handOverModelUp(gpu, say, choice === "retry" ? (failure.model ? { model: failure.model } : {}) : { pick: true });
      if (handed) return handed;
    }
  }

  /** Ask dl for `dl model up` (Autopilot exits next; dl starts it again on the new model). */
  private async handOverModelUp(
    gpu: DetectedGpu | null,
    say: (message: string, severity?: "info" | "error") => void,
    then: { model?: string; pick?: boolean } = {},
  ): Promise<"model-up" | undefined> {
    const path = handoffPath(this.gpuCalls.env);
    if (!path) return undefined;
    try {
      await requestModelUp(path, gpu, then);
    } catch (e) {
      say(`Couldn't hand over to dl model up: ${(e as Error).message}. Run dl model up in a terminal.`, "error");
      return undefined;
    }
    await flushGpuTelemetry();
    return "model-up";
  }

  /**
   * "Use your own GPUs": where they are. This machine hands over to `dl model up`; another
   * server of yours shows the two commands to run there, then takes its address; a vLLM (or
   * other OpenAI-compatible) server you run takes its URL and an optional key. Either is
   * checked with /v1/models, a model picked, and saved as the vLLM provider. "back" returns
   * to the question.
   */
  private async ownGpus(
    o: { cfg: Partial<Cfg> | null; firstRun: boolean; standalone: boolean },
    gpu: DetectedGpu | null,
    canModelUp: boolean,
    say: (message: string, severity?: "info" | "error") => void,
    unanswered?: UnansweredTool,
  ): Promise<ConnectOutcome | "model-up" | "back"> {
    const env = this.gpuCalls.env;
    for (;;) {
      const where = await this.select(WHERE_QUESTION, whereChoices(gpu, canModelUp, unanswered), undefined, "Esc to go back");
      if (where === null) return "back";
      sendGpuTelemetry({ event: "option", option: where as GpuWhere, gpuVendor: gpu?.vendor ?? "none" }, env);
      if (where === "this_machine") {
        if (!canModelUp) {
          say(THIS_MACHINE_WITHOUT_DL);
          continue;
        }
        if ((await this.handOverModelUp(gpu, say)) === "model-up") return "model-up";
        continue;
      }
      const saved = where === "remote_server" ? await this.remoteGpuServer(o, say) : await this.ownEndpoint(o, say);
      if (saved) return saved;
    }
  }

  /** Another server of yours: the two commands for it, then its address and port. Null = back. */
  private async remoteGpuServer(
    o: { cfg: Partial<Cfg> | null; firstRun: boolean; standalone: boolean },
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<ConnectOutcome | null> {
    this.showLines(REMOTE_SERVER_STEPS);
    let address = "";
    let port = "8000";
    for (;;) {
      const f = await this.sdk.form(this.cam, {
        id: `gpu-server-${Date.now()}`,
        title: REMOTE_SERVER_TITLE,
        fields: [
          { name: "address", label: "Address (host name or IP)", placeholder: "gpu.example.com", required: true, ...(address ? { default: address } : {}) },
          { name: "port", label: "Port", default: port },
        ],
      });
      if (f.cancelled) return null;
      address = f.values?.address?.trim() ?? "";
      port = f.values?.port?.trim() || "8000";
      const baseUrl = serverBaseUrl(address, port);
      if (!baseUrl) {
        say("Enter a host name or IP, and a port from 1 to 65535.", "error");
        continue;
      }
      const saved = await this.connectGpuEndpoint(o, baseUrl, undefined, "remote_server", say);
      if (saved === "failed") {
        say(remoteTunnelHint(port));
        continue;
      }
      return saved;
    }
  }

  /** A vLLM or other OpenAI-compatible server you run: its URL and an optional key. Null = back. */
  private async ownEndpoint(
    o: { cfg: Partial<Cfg> | null; firstRun: boolean; standalone: boolean },
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<ConnectOutcome | null> {
    let url = "";
    for (;;) {
      const f = await this.sdk.form(this.cam, {
        id: `gpu-endpoint-${Date.now()}`,
        title: ENDPOINT_TITLE,
        fields: [
          { name: "url", label: "Base URL", placeholder: "http://10.0.0.5:8000/v1", required: true, ...(url ? { default: url } : {}) },
          { name: "key", label: "API key (optional)", kind: "password" },
        ],
      });
      if (f.cancelled) return null;
      url = f.values?.url?.trim() ?? "";
      const baseUrl = normalizeBaseUrl(url);
      if (!baseUrl) {
        say(ENDPOINT_URL_ERROR, "error");
        continue;
      }
      const key = f.values?.key?.trim() || undefined;
      const saved = await this.connectGpuEndpoint(o, baseUrl, key, "endpoint", say);
      if (saved === "failed") continue;
      return saved;
    }
  }

  /**
   * Check <base>/models, pick one of its models (the only one is picked for you), and save it
   * as the vLLM provider. "failed" when the check or save failed (said, and counted), null when
   * the person backed out of the model list.
   */
  private async connectGpuEndpoint(
    o: { cfg: Partial<Cfg> | null; firstRun: boolean; standalone: boolean },
    baseUrl: string,
    key: string | undefined,
    path: "remote_server" | "endpoint",
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<ConnectOutcome | null | "failed"> {
    const env = this.gpuCalls.env;
    const fail = (errorType: GpuErrorType) => {
      sendGpuTelemetry({ event: "result", outcome: "failed", path, errorType }, env);
      return "failed" as const;
    };
    say(`Checking ${baseUrl}/models…`);
    const check = await checkModelsEndpoint(baseUrl, key, this.gpuCalls.fetchImpl);
    if (!check.ok) {
      say(check.message, "error");
      return fail(check.error);
    }
    say(servedLine(baseUrl, check.models.length));
    const model =
      check.models.length === 1
        ? check.models[0]!
        : await this.select("Pick a model", check.models.map((id) => ({ value: id, label: id })), undefined, `Served by ${baseUrl} · switch any time with /model`);
    if (model === null) return null;
    // Loads the catalog for the model list and /model (and checks the address once more).
    const verified = await this.providerCalls.verify("vllm", key, key ? "key" : "none", baseUrl);
    if (!verified.ok) {
      say(verified.message, "error");
      return fail("unreachable");
    }
    const connection: Connection = { ...verified.connection, baseUrl, ...(key ? { key } : {}) };
    const saved = await this.commitChoice(connection, model, { firstRun: o.firstRun, standalone: o.standalone }, say);
    if (!saved) return fail("save_failed");
    sendGpuTelemetry({ event: "result", outcome: "ok", path }, env);
    return saved;
  }

  /**
   * The free tier's status for a picker that offers it: open once signed in
   * (their errors already say what's going on), else the service's answer.
   */
  private async freeTierStatus(cfg: Partial<Cfg> | null): Promise<DlFreeStatus> {
    if (resolveProviderKey("directionally-local", cfg as Cfg | null)) return DL_STATUS_OPEN;
    return this.freeStatus().catch(() => DL_STATUS_OPEN);
  }

  /** Save the provider and model, and confirm it. Null when the save failed (said). */
  private async commitChoice(
    connection: Connection,
    modelId: string,
    o: { firstRun: boolean; standalone: boolean },
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<ConnectOutcome | null> {
    let saved: Cfg;
    try {
      saved = await commitProvider(connection, modelId);
    } catch (e) {
      say(`Couldn't save the config: ${(e as Error).message}`, "error");
      return null;
    }
    if (o.firstRun) say(`✓ Saved to ${configPath()}. Switch provider any time with /provider, model with /model.`);
    else if (o.standalone) say(`✓ Saved to ${configPath()}.`);
    return { id: connection.id, connection, model: modelId, cfg: saved };
  }

  /**
   * The free tier's GitHub device sign-in (or the saved one), verified, with
   * the "Signed in as" line. `denied` when the service said no (its message is
   * shown), `cancelled` on Esc, `failed` for anything else.
   */
  private async freeTierSignIn(
    cfg: Partial<Cfg> | null,
    say: (message: string, severity?: "info" | "error") => void,
  ): Promise<{ kind: "connected"; connection: Connection } | { kind: "denied" | "cancelled" | "failed" }> {
    const id: ProviderId = "directionally-local";
    const verified = async (key: string, source: KeySource): Promise<{ kind: "connected"; connection: Connection } | { kind: "failed" }> => {
      const res = await this.providerCalls.verify(id, key, source);
      if (!res.ok) {
        say(res.message, "error");
        return { kind: "failed" };
      }
      const me = (await catchDlAuth(() => this.providerCalls.dlMe(), say)) ?? null;
      say(dlSignedInLine(me));
      const invite = dlSignedInInviteLine(me);
      if (invite) say(invite);
      return { kind: "connected", connection: res.connection };
    };
    const signedIn = resolveProviderKey(id, cfg);
    if (signedIn) {
      const r = await this.select(`Connect ${getPreset(id).name}`, [
        { value: "use", label: "Use your existing GitHub sign-in" },
        { value: "again", label: "Sign in again" },
      ]);
      if (r === null) return { kind: "cancelled" };
      if (r === "use") return verified(signedIn, "config");
    }
    say(dlSignInLines());
    const ctrl = new AbortController();
    this.signIn = ctrl;
    // Once the code is shown, the chat input gives way to the waiting text (code included) until the sign-in ends.
    let waiting: Promise<(() => void) | null> | null = null;
    // The sign-in paragraph, said once the wait ends when it was drawn in the lent terminal (so it stays in the scrollback).
    let sayAfter: string | null = null;
    const stopWaiting = async () => {
      const end = await waiting;
      if (end) {
        end();
        if (sayAfter) say(sayAfter);
      }
      this.signInWaiting = null;
    };
    let key: string;
    try {
      key = (
        await this.providerCalls.dlSignIn((code) => {
          const opened = openBrowser(code.verificationUriComplete);
          // Not said first: a line said just before the renderer lends the terminal is
          // drawn late or not at all (it has no event to wait for), which on a retry
          // left only the waiting line. The waiting text carries the whole paragraph.
          const text = dlWaitingText(code, opened);
          this.signInWaiting = text;
          if (ctrl.signal.aborted) {
            say(dlSignInLines(code, opened));
            return;
          }
          sayAfter = dlSignInLines(code, opened);
          waiting = this.waitWithoutInput(text, () => ctrl.abort());
        }, ctrl.signal)
      ).key;
    } catch (e) {
      await stopWaiting();
      if (ctrl.signal.aborted) {
        say(DL_SIGN_IN_NEEDED);
        return { kind: "cancelled" };
      }
      if (e instanceof DlError) {
        say(e.message, "error");
        return { kind: e.denial || e.code === "access_denied" ? "denied" : "failed" };
      }
      say(`Sign-in failed: ${(e as Error).message}`, "error");
      return { kind: "failed" };
    } finally {
      this.signIn = null;
    }
    await stopWaiting();
    return verified(key, "signin");
  }

  /**
   * The free tier's limit, queue or /upgrade screen: the choice, then the
   * invite link, the checkout (Esc stops waiting for it) or the provider
   * picker (App opens that on "own-key").
   */
  dlScreen(screen: DlScreen): ReturnType<typeof runDlScreen> {
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    return runDlScreen(screen, {
      ...this.dlScreenCalls,
      say,
      select: (title, options, subtitle) => this.select(title, options, undefined, subtitle),
      input: async (title, placeholder) => {
        const f = await this.sdk.form(this.cam, {
          id: `dl-topup-amount-${Date.now()}`,
          title,
          fields: [{ name: "amount", label: "Amount in dollars", ...(placeholder ? { placeholder } : {}) }],
        });
        return f.cancelled ? null : (f.values?.amount?.trim() ?? null);
      },
      wait: async (text, cancel) => {
        // Esc (cancelRequested) and typed input go to the wait, as during a sign-in.
        const ctrl = new AbortController();
        ctrl.signal.addEventListener("abort", cancel, { once: true });
        this.signIn = ctrl;
        this.signInWaiting = text;
        const end = await this.waitWithoutInput(text, () => ctrl.abort());
        return () => {
          end?.();
          this.signIn = null;
          this.signInWaiting = null;
        };
      },
    });
  }

  /**
   * `/feedback`: a multi-line message (unless typed after the command), then
   * the reply address on one line (prefilled with the public GitHub email
   * when signed in to the free tier), then the send. Only the typed message
   * leaves this machine (see feedback.ts).
   */
  feedback(req: FeedbackRequest): Promise<FeedbackLine> {
    const say = (message: string) => void this.cam.send("RuntimeError", { message, severity: "info" });
    return runFeedback(req.inline ? { inline: req.inline } : {}, {
      providerId: req.providerId,
      autopilotVersion: getAppVersion(),
      token: () => catchDlAuth(() => this.feedbackCalls.token(), say),
      ...(this.feedbackCalls.fetchImpl ? { fetchImpl: this.feedbackCalls.fetchImpl } : {}),
      status: say,
      askMessage: async ({ problem, draft }) => {
        const f = await this.sdk.form(this.cam, {
          id: `feedback-message-${Date.now()}`,
          title: `Feedback for the team${problem ? ` · ${problem}` : ""}`,
          fields: [{ name: "message", label: FEEDBACK_MESSAGE_PROMPT, kind: "multiline", required: true, ...(draft ? { default: draft } : {}) }],
        });
        return f.cancelled ? null : f.values?.message ?? "";
      },
      askEmail: async ({ suggested, problem }) => {
        const f = await this.sdk.form(this.cam, {
          id: `feedback-email-${Date.now()}`,
          title: `Feedback for the team${problem ? ` · ${problem}` : ""}`,
          fields: [
            {
              name: "email",
              label: suggested ? `Replies go to ${suggested} · Enter to keep, or type another` : "Email for a reply (optional) · Enter to skip",
              ...(suggested ? { default: suggested } : { placeholder: "you@example.com" }),
            },
          ],
        });
        return f.cancelled ? null : f.values?.email ?? "";
      },
    });
  }

  /**
   * `/request`: the request's status, then (with none pending) what the
   * person is building and an optional link, each on one line, then the
   * send. The answers go only to the free tier service (see access-request.ts).
   */
  accessRequest(req: AccessRequestOpen): Promise<AccessRequestLine> {
    const say = (message: string) => void this.cam.send("RuntimeError", { message, severity: "info" });
    return runAccessRequest({
      providerId: req.providerId,
      ...(req.providerName ? { providerName: req.providerName } : {}),
      token: this.accessRequestCalls.token,
      ...(this.accessRequestCalls.fetchImpl ? { fetchImpl: this.accessRequestCalls.fetchImpl } : {}),
      status: say,
      ask: async (field, { problem, draft }) => {
        const f = await this.sdk.form(this.cam, {
          id: `access-request-${field}-${Date.now()}`,
          title: `${ACCESS_TITLE}${problem ? ` · ${problem}` : ""}`,
          fields: [
            field === "building"
              ? { name: field, label: ACCESS_BUILDING_PROMPT, required: true, placeholder: `10 to ${ACCESS_BUILDING_MAX} characters`, ...(draft ? { default: draft } : {}) }
              : { name: field, label: ACCESS_LINK_PROMPT, placeholder: "https://github.com/you", ...(draft ? { default: draft } : {}) },
          ],
        });
        return f.cancelled ? null : f.values?.[field] ?? "";
      },
    });
  }

  /**
   * The GitHub star ask: the line with the chat input out of the way, then
   * one key (s stars it). Where the terminal can't be lent, a two-choice list.
   */
  starAsk(line: string): ReturnType<typeof runStarAsk> {
    const say = (message: string) => void this.cam.send("RuntimeError", { message, severity: "info" });
    return runStarAsk(line, {
      readKey: (l) =>
        readKeyWithoutInput(
          l,
          {
            suspend: async () => (this.sdk.suspendTerminal ? (await this.sdk.suspendTerminal(this.cam)).supported : false),
            resume: () => this.sdk.resumeTerminal?.(this.cam),
          },
          this.terminalIo,
        ),
      select: (title, options, subtitle) => this.select(title, options, undefined, subtitle),
      say,
      openBrowser: this.githubCalls.openBrowser,
      gh: this.githubCalls.gh,
    });
  }

  /**
   * `/tour` (ui/product-tour.ts): one screen per step with the chat input
   * out of the way; where the terminal can't be lent, one list per step.
   * Opening it once stops the startup hint.
   */
  async productTour(): Promise<void> {
    void markProductTourSeen();
    const io = this.terminalIo ?? { stdout: process.stdout };
    await runProductTour(
      tourSteps(),
      {
        screen: (draw, onKey) =>
          screenWithoutInput(
            draw,
            onKey,
            {
              suspend: async () => (this.sdk.suspendTerminal ? (await this.sdk.suspendTerminal(this.cam)).supported : false),
              resume: () => this.sdk.resumeTerminal?.(this.cam),
            },
            this.terminalIo,
          ),
        select: (title, options, subtitle) => this.select(title, options, undefined, subtitle),
      },
      () => terminalWrapWidth(io.stdout),
    );
  }

  /**
   * A push or pull request without GitHub access: sign in with gh in the
   * browser (Esc stops waiting), set GITHUB_TOKEN later, or not now.
   */
  githubAccess(): Promise<GithubAccessOutcome> {
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    return runGithubAccess({
      select: (title, options, subtitle) => this.select(title, options, undefined, subtitle),
      say,
      openBrowser: this.githubCalls.openBrowser,
      gh: this.githubCalls.gh,
      login: this.githubCalls.login,
      wait: async (text, cancel) => {
        const ctrl = new AbortController();
        ctrl.signal.addEventListener("abort", cancel, { once: true });
        this.signIn = ctrl;
        this.signInWaiting = text;
        const end = await this.waitWithoutInput(text, () => ctrl.abort());
        return () => {
          end?.();
          this.signIn = null;
          this.signInWaiting = null;
        };
      },
    });
  }

  /**
   * Hide the chat input behind `line` while something outside the terminal
   * runs (see ui/terminal-wait.ts); resolves with the function that brings
   * it back. Where the terminal can't be lent, the line is said instead and
   * typed input is answered with it (`signInWaiting`).
   */
  private async waitWithoutInput(line: string, cancel: () => void): Promise<(() => void) | null> {
    const end = await waitWithoutInput(
      line,
      cancel,
      {
        suspend: async () => (this.sdk.suspendTerminal ? (await this.sdk.suspendTerminal(this.cam)).supported : false),
        resume: () => this.sdk.resumeTerminal?.(this.cam),
      },
      this.terminalIo,
    );
    if (!end) void this.cam.send("RuntimeError", { message: line, severity: "info" });
    return end;
  }

  /** Lines printed above the prompts (welcome copy, notices). */
  showLines(lines: string[]): void {
    // The renderer cuts a Splash line off at the edge: wrap so every word is read.
    this.cam.send("Splash", { text: wrapText(lines.join("\n"), terminalWrapWidth()).join("\n") });
  }

  /**
   * `autopilot connect`: the first-run steps with no App to start afterwards.
   * `exclude` leaves providers out of the list (those a key gateway can't
   * proxy, for `--state-file`). Null when the user backs out.
   */
  async connectSetup(o: { exclude?: ReadonlySet<ProviderId>; initial?: ProviderId } = {}): Promise<ConnectOutcome | null> {
    const cfg = (await loadConfig().catch(() => null)) ?? (await readPersistedConfig().catch(() => null));
    // With the free tier on offer, the same one question as first run; without it (--state-file), the provider list.
    if (!o.initial && !o.exclude?.has("directionally-local")) {
      const outcome = await this.howToThink({ cfg, firstRun: false, standalone: true });
      return outcome === "model-up" ? null : outcome;
    }
    return this.connectAndPickModel({ cfg, firstRun: false, standalone: true, title: "Connect a model provider", ...o });
  }

  /**
   * `autopilot connect --model-only`: keep the active provider, verify its
   * saved credentials (which loads its catalog), pick a model and save it.
   */
  async pickModelOnly(): Promise<ConnectOutcome | null> {
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    const cfg = await loadConfig().catch(() => null);
    const active = resolveActiveProvider(cfg);
    const { id, preset } = active;
    const key = active.apiKey;
    if (!key && (preset.keyRequired || id === "openrouter")) {
      say(`${preset.name} isn't connected yet — run \`autopilot connect\` without --model-only first.`, "error");
      return null;
    }
    const source: KeySource = key ? (preset.apiKeyEnv.some((n) => process.env[n]?.trim()) ? "env" : "config") : "none";
    const baseUrl = id === "custom" ? active.baseUrl : cfg?.providers?.[id]?.baseUrl;
    say(key ? `Checking the key with ${preset.name}…` : `Connecting to ${preset.name}…`);
    const res = await verifyProvider(id, key, source, baseUrl);
    if (!res.ok) {
      say(res.message, "error");
      return null;
    }
    say(`✓ ${describeConnection(res.connection)}`);
    const current = cfg?.model ?? "";
    const modelId = await this.select(
      `Pick a ${preset.name} model`,
      modelOptions(pickableModels(), current),
      current || undefined,
      "Context · price per Mtok (input / output / cached) · type to search · Esc to keep the current model",
    );
    if (modelId === null) return null;
    try {
      const saved = await commitProvider(res.connection, modelId);
      say(`✓ Saved to ${configPath()}.`);
      return { id, connection: res.connection, model: modelId, cfg: saved };
    } catch (e) {
      say(`Couldn't save the config: ${(e as Error).message}`, "error");
      return null;
    }
  }

  /** Provider list → connect → model → save. What was saved, or null if cancelled. */
  private async connectAndPickModel(o: {
    cfg: Partial<Cfg> | null;
    initial?: ProviderId;
    firstRun: boolean;
    upgrading?: boolean;
    /** No App follows (`autopilot connect`): confirm the save the way first run does. */
    standalone?: boolean;
    /** Providers to leave out of the list. */
    exclude?: ReadonlySet<ProviderId>;
    /** The list's title, instead of the first-run / switch one. */
    title?: string;
    /** The list's subtitle, instead of the first-run / switch one. */
    subtitle?: string;
    /** First run with a key in the environment: use it without asking "use it or enter another". */
    envKeyDirect?: boolean;
    /** Backing out of `initial` returns null instead of opening the list. */
    backReturns?: boolean;
  }): Promise<ConnectOutcome | null> {
    const say = (message: string, severity: "info" | "error" = "info") => void this.cam.send("RuntimeError", { message, severity });
    const { cfg, firstRun } = o;
    let id: ProviderId | undefined = o.initial;
    for (;;) {
      if (!id) {
        const offered = providerRows(cfg, { markActive: !firstRun, upgrading: o.upgrading }).filter((row) => !o.exclude?.has(row.id));
        const status = offered.some((r) => r.id === "directionally-local") ? await this.freeTierStatus(cfg) : DL_STATUS_OPEN;
        const rows = rowsWithFreeStatus(offered, status);
        const notice = statusMessage(status);
        // Paused (and not signed in), the free row can't be chosen: never the default, and choosing it says why.
        const freePaused = !freeChoosable(status) && !offered.find((r) => r.id === "directionally-local")?.credentials;
        const current = rows.find((r) => r.active && !(freePaused && r.id === "directionally-local"))?.id;
        const r = await this.select(
          o.title ?? (firstRun ? "Choose where your models run" : "Switch provider"),
          rows.map((row) => ({
            value: row.id,
            label: row.name,
            columns: [credentialLabel(row)],
            description: row.hint,
            keywords: `${row.id} ${row.hint}`,
          })),
          current,
          o.subtitle ??
            `${notice ? `${notice} · ` : ""}${
              firstRun
                ? `${OWN_KEY_BILLING_LINE} · type to search · Enter to connect · Esc to quit`
                : "Conversation history is kept · type to search · Enter to connect"
            }`,
        );
        if (r === null) return null;
        if (freePaused && r === "directionally-local") {
          say(dlPausedLine(status));
          continue;
        }
        id = r as ProviderId;
      }
      // Leaving the free tier for a provider that bills your own key: say so first.
      const leaving = !firstRun && cfg ? leavingFreeTierLine(resolveActiveProvider(cfg as Cfg).id, id) : undefined;
      if (leaving) say(leaving);
      const connection = await this.connectProvider(id, cfg, say, { envKeyDirect: !!o.envKeyDirect && id === o.initial });
      if (connection === "back") {
        if (o.backReturns) return null;
        id = undefined;
        continue;
      }
      if (!connection) return null;
      const preset = getPreset(id);
      // The free tier's sign-in says "Signed in as" itself.
      if (id !== "directionally-local") say(`✓ ${describeConnection(connection)}`);
      if (connection.openRouter?.isFreeTier) {
        say("This key has no credits yet: only free models work (search \"free\"). Add credits at https://openrouter.ai/settings/credits.");
      }
      const models = pickableModels();
      // The free tier has exactly one model: nothing to pick.
      const modelId =
        id === "directionally-local"
          ? DL_FREE_MODEL
          : await this.select(
              `Pick a ${preset.name} model`,
              modelOptions(models, ""),
              undefined,
              "Context · price per Mtok (input / output / cached) · type to search · switch any time with /model",
            );
      if (modelId === null) {
        id = undefined;
        continue;
      }
      let saved: Cfg;
      try {
        saved = await commitProvider(connection, modelId);
      } catch (e) {
        say(`Couldn't save the config: ${(e as Error).message}`, "error");
        // On first run there is no session to fall back to: try again.
        if (firstRun && !o.backReturns) continue;
        return null;
      }
      if (firstRun) say(`✓ Saved to ${configPath()}. Switch provider any time with /provider, model with /model.`);
      else if (o.standalone) say(`✓ Saved to ${configPath()}.`);
      return { id, connection, model: modelId, cfg: saved };
    }
  }

  /** One provider's connect step. Null = cancelled, "back" = return to the list. */
  private async connectProvider(
    id: ProviderId,
    cfg: Partial<Cfg> | null,
    say: (message: string, severity?: "info" | "error") => void,
    opts: { envKeyDirect?: boolean } = {},
  ): Promise<Connection | null | "back"> {
    const preset = getPreset(id);
    const plan = planConnect(id, cfg);
    let baseUrl: string | undefined;

    const verify = async (key: string | undefined, source: KeySource, url?: string): Promise<Connection | null> => {
      say(preset.keyRequired || id === "openrouter" ? `Checking the key with ${preset.name}…` : `Connecting to ${preset.name}…`);
      const res = await this.providerCalls.verify(id, key, source, url);
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
      case "directionally-local": {
        // Straight into the device sign-in: there is no key to paste.
        const r = await this.freeTierSignIn(cfg, say);
        return r.kind === "connected" ? r.connection : "back";
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
        if (plan.source === "env" && opts.envKeyDirect) return (await verify(plan.key, "env", cfg?.providers?.[id]?.baseUrl)) ?? "back";
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

/** What the provider setup screens saved: for `/provider`, first run and `autopilot connect`. */
export interface ConnectOutcome {
  id: ProviderId;
  /** The credentials the provider was verified with. */
  connection: Connection;
  model: string;
  /** The config as saved. */
  cfg: Cfg;
}

type PickOption = { value: string; label: string; description?: string; section?: string; columns?: string[]; state?: "on" | "off"; keywords?: string };

export type RegisteredSlashCommand = { name: string; description?: string; args_hint?: string };

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

/** The help menu's dim line: where to report a bug (the renderer's own hint line says how to pick). */
export function helpFooter(): string {
  return BUG_REPORT_LINE;
}

/** The Ink help menu's pages as sections, plus custom commands. */
export function helpOptions(custom: { name: string; description?: string }[], env: NodeJS.ProcessEnv = process.env): PickOption[] {
  const out: PickOption[] = [];
  // Started by dl, the product the person knows is dl.
  const dl = launchedByDl(env);
  const describe = (c: { command: string; description: string }) =>
    dl && c.command === "/exit" ? "exit dl; typing exit on its own also works" : dl && c.command === "/update" ? "check for a newer dl" : c.description;
  for (const cat of CATEGORIES) {
    for (const c of cat.commands) {
      if (!c.command.startsWith("/")) continue;
      out.push({ value: c.command, label: c.command, description: describe(c), section: cat.label });
    }
  }
  for (const c of SINGLE_COMMANDS) out.push({ value: c.command, label: c.command, description: describe(c), section: "General" });
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
  const me = activeProviderCatalog() === DL_PROVIDER_ID ? lastKnownDlMe() : null;
  const starter = me?.level === "starter";
  const row = (m: ModelEntry, section: string): PickOption => {
    // On the free tier, each model's own weekly allowance is the useful third column.
    const allowance = activeProviderCatalog() === DL_PROVIDER_ID ? dlModelAllowanceLine(m.id, me) : undefined;
    // A Starter account gets DeepSeek only: say so on the GPT-6 rows, and leave DeepSeek active.
    const locked = starter && m.id !== "deepseek/deepseek-v4.1-flash-1017";
    return {
      value: m.id,
      label: m.id,
      section,
      ...(locked ? { description: "locked on Starter — DeepSeek only", state: "off" as const } : {}),
      columns: [formatContext(m.contextWindow), formatModelPrice(m.pricing), ...(allowance ? [allowance] : [])],
      keywords: m.name ?? "",
    };
  };
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

/**
 * The detail row of a permission prompt. A shell command (bash, job_start)
 * is shown in full whenever its row would cut it at this terminal's width,
 * using the same width toolRow clips to (T2-06), and a call flagged by
 * ToolSpec.permissionReason says why it needs approval (a read or write of a
 * credentials location), so that prompt does not look like any other.
 */
export function permissionDetail(
  toolName: string,
  args: Record<string, unknown>,
  sensitiveReason: string | undefined,
  columns?: number,
): string | undefined {
  const lines: string[] = [];
  if (sensitiveReason) lines.push(`⚠ This call ${sensitiveReason}.`);
  if (typeof args.command === "string" && (toolName === "bash" || toolName === "job_start")) {
    const label = toolName.charAt(0).toUpperCase() + toolName.slice(1);
    const width = columns ? Math.max(20, Math.min(120, columns - label.length - 12)) : 120;
    if (isCommandCollapsed(args.command, width)) lines.push(args.command.trim());
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * "read src/a.ts" → { label: "Read", args: "src/a.ts" }. With the terminal's
 * `columns`, a shell command (bash, job_start) is re-previewed to fit the row.
 */
export function toolRow(name: string, title: string | undefined, rawArgs: string | undefined, columns?: number): { label: string; args: string } {
  const label = name.startsWith("mcp_") || name.startsWith("lsp_") ? name : name.charAt(0).toUpperCase() + name.slice(1);
  const command = shellCommandArg(name, rawArgs);
  if (command !== undefined && columns) {
    // Room for the status glyph, label and elapsed time around the command.
    const width = Math.max(20, Math.min(120, columns - label.length - 12));
    title = name === "bash" ? formatBashTitle(command, width) : formatJobStartTitle(command, width + "job_start: ".length);
  }
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

/** The command of a bash or job_start call, from its raw JSON arguments. */
export function shellCommandArg(name: string, rawArgs: string | undefined): string | undefined {
  if (name !== "bash" && name !== "job_start") return undefined;
  try {
    const parsed = rawArgs ? (JSON.parse(rawArgs) as { command?: unknown }) : {};
    return typeof parsed.command === "string" ? parsed.command : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The output behind "ctrl+o to expand". A collapsed shell command is appended
 * in full after the result, so the error lines shown by default stay first.
 */
export function toolOutputWithCommand(output: string, command: string | undefined): string {
  if (command === undefined || !isCommandCollapsed(command)) return output;
  const full = `Full command:\n${command.trim()}`;
  return output ? `${output.replace(/\n+$/, "")}\n\n${full}` : full;
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

/** The `/queue plan` choices (Ink's QueuePlanPicker). */
export function queuePlanOptions(count: number): PickOption[] {
  return [
    { value: "group", label: `Group ${count} follow-ups into one coordinated turn`, description: "the coordinator finds dependencies and handles them together" },
    { value: "separate", label: "Keep separate and continue the FIFO queue" },
    { value: "cancel", label: "Cancel and leave the queue unchanged" },
  ];
}

/** The follow-ups a `/queue plan` covers, printed above its picker. */
export function queuePlanSplash(prompts: string[]): string {
  return [
    "\x1b[1mQueued follow-ups\x1b[0m",
    ...prompts.map((p, i) => `\x1b[2m${i + 1}.\x1b[0m ${queuePreview(p)}`),
  ].join("\n");
}

export type StatusInput = Pick<
  AppSnapshot,
  "modesEnabled" | "mode" | "busy" | "model" | "usage" | "sessionUsage" | "contextLimit" | "turnPhase" | "currentTool" | "kimiMdStale" | "codeMode" | "intentTier" | "memoryEnabled" | "memoryCount" | "memoryLastWrite"
>;

/**
 * Renderer status segments (Ink's StatusBar). Well-known keys drive the
 * renderer: `phase` the spinner, `activity` its verb, `warn` the left footer;
 * `context`, `code` and `intent` are plain footer badges. Empty removes one.
 */
export function statusSegments(s: StatusInput): Record<string, string> {
  const tier = s.intentTier ?? undefined;
  const executing = s.busy && s.turnPhase === "executing" && !!s.currentTool;
  const pct = s.usage && s.contextLimit > 0 ? Math.round((s.usage.prompt_tokens / s.contextLimit) * 100) : null;
  const warn = [
    pct !== null && pct >= 80 ? `ctx ${pct}% · /compact recommended` : "",
    s.kimiMdStale ? "⚠ project context stale · run /init" : "",
  ].filter(Boolean);
  return {
    // With modes off (the default) every turn is auto; show no mode badge.
    mode: !s.modesEnabled ? "" : s.mode === "auto" ? "auto" : s.mode === "plan" ? "plan" : "edit",
    phase: !s.busy ? "idle" : executing ? "tool" : "thinking",
    // Empty lets the renderer name the running tool row itself.
    activity: executing ? `${capitalize(humanizePhase("executing", tier))} ${s.currentTool}` : s.busy && tier === "heavy" ? "Reasoning" : "",
    model: shortModel(s.model),
    tokens: s.usage ? `${formatK(s.usage.prompt_tokens)} tokens` : "",
    context: pct !== null ? `ctx ${pct}%` : "",
    cost: s.sessionUsage ? `${s.sessionUsage.reconcilePending ? "≈" : ""}$${s.sessionUsage.cost.toFixed(2)}` : "",
    code: s.codeMode ? "code mode" : "",
    intent: s.busy && tier ? `${tier} task` : "",
    // Memory state at a glance (#1077): on/off, how many, when last written.
    memory: !s.memoryEnabled
      ? "memory off"
      : s.memoryCount === 0
        ? "memory on · no memories yet"
        : `memory on · ${s.memoryCount} · last ${relTime(new Date(s.memoryLastWrite ?? Date.now()).toISOString())}`,
    warn: warn.join(" · "),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function queuePreview(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 110 ? `${line.slice(0, 107)}…` : line;
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

/** Folders never walked for `@` mentions: dependency trees, caches and system folders. */
const MENTION_SKIP_DIRS = new Set([
  "node_modules", "Library", "Caches", "Applications", "System", "Volumes", "private",
  "dist", "build", "out", "target", "vendor", "__pycache__", "venv", ".venv", "Pods",
  "DerivedData", "site-packages", "bower_components", "coverage", "tmp", "temp",
]);
/** The most files one walk returns, and how long it may take. */
export const MENTION_MAX_FILES = 5000;
export const MENTION_MAX_MS = 1000;

/**
 * A bounded walk of `cwd` for `@` mentions when git can't answer (not a repo, or no git):
 * files only, skipping dot-folders and the big dependency and cache trees, at most
 * `maxFiles` files and about `maxMs` milliseconds. Sorted, so the list is stable.
 */
export function walkFiles(cwd: string, options: { maxFiles?: number; maxMs?: number; now?: () => number } = {}): string[] {
  const maxFiles = options.maxFiles ?? MENTION_MAX_FILES;
  const maxMs = options.maxMs ?? MENTION_MAX_MS;
  const now = options.now ?? Date.now;
  const started = now();
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < maxFiles) {
    if (now() - started > maxMs) break;
    const rel = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles || now() - started > maxMs) break;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || MENTION_SKIP_DIRS.has(entry.name)) continue;
        stack.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out;
}

/** Tracked and untracked-but-not-ignored files, for `@` mentions; a bounded walk outside a repo. */
function listFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\n").filter(Boolean).slice(0, MENTION_MAX_FILES);
  } catch {
    // Not a git repo (or no git): walk the folder instead, bounded, so `@` still lists files.
    return walkFiles(cwd);
  }
}

/**
 * Whether a renderer exit means the user asked to quit rather than a crash.
 *
 * A clean exit (code 0, no signal) is the renderer's own Ctrl+C-twice quit.
 * SIGINT is how the terminal delivers Ctrl+C when the renderer is not in raw
 * mode (e.g. after a `!` command or a terminal handoff): the renderer has no
 * SIGINT handler, so it dies. Treating that as a crash made autopilot restart
 * the renderer on every Ctrl+C, so quitting took several presses until the
 * crash-restart budget ran out.
 */
export function rendererExitIsUserQuit(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal === "SIGINT") return true;
  return (code ?? 0) === 0 && !signal;
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
