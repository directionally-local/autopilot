/**
 * The contract between the App (all of autopilot's interactive logic) and an
 * alternative view such as the Camouflage renderer.
 *
 * With a bridge, App runs exactly as it does under Ink (same state, managers,
 * slash commands, turn handling) but renders nothing itself. After every
 * render it reports a snapshot of what's on screen via `sync`, and it hands
 * the view a set of actions (submit text, interrupt, answer a picker) via
 * `connect`. The view decides how to draw the snapshot and when to call the
 * actions. Anything added to App later reaches the view without changes here.
 */

import type { ChatEvent } from "./view-types.js";
import type { Mode } from "../mode.js";
import type { Usage } from "../agent/messages.js";
import type { DailyUsage } from "../usage-tracker.js";
import type { Task } from "../tools/registry.js";
import type { ModelEntry } from "../models/registry.js";
import type { ProviderId } from "../providers/presets.js";
import type { SessionSummary, Checkpoint } from "../sessions.js";
import type { PlanOption } from "../tools/registry.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import type { DestructivePrompt } from "../permissions/guardrails.js";
import type { PlanCompleteChoice } from "./view-types.js";
import type { CustomCommand } from "../commands/types.js";
import type { SaveCustomCommandOptions } from "../commands/save.js";
import type { LspServerConfig } from "../config.js";
import type { HookConfig, HookEvent } from "../hooks/types.js";
import type { RunningWorker } from "../tools/worker-registry.js";
import type { TurnPhase } from "./view-types.js";
import type { IntentTier } from "./narrator.js";
import type { QueuePlanChoice } from "./queue-plan.js";
import type { DlScreen, DlScreenOutcome } from "../providers/dl-growth.js";
import type { FeedbackLine, FeedbackRequest } from "../feedback.js";
import type { AccessRequestLine, AccessRequestOpen } from "../access-request.js";
import type { GithubAccessOutcome, GithubAccessRequest } from "../github-access.js";

/** Which dialog App currently wants open (the Camouflage view draws it). */
export type AppModal =
  | "model"
  | "provider"
  | "mode"
  | "help"
  | "memory"
  | "skills"
  | "shell"
  | "planComplete"
  | "commandList"
  | "commandWizard"
  | "commandPicker"
  | "lspWizard"
  | "inbox"
  | "hooksDashboard"
  | "changelogImage";

export interface AppSnapshot {
  events: ChatEvent[];
  busy: boolean;
  /** A turn is in flight (busy dips between a turn's steps; this doesn't). */
  turnRunning: boolean;
  /** The session being saved, once it has one. */
  sessionId: string | null;
  /** Subagents currently running (see tools/worker-registry). */
  workers: RunningWorker[];
  mode: Mode;
  /** Plan/edit/auto modes are on (off by default: every turn is auto). */
  modesEnabled: boolean;
  model: string;
  usage: Usage | null;
  sessionUsage: DailyUsage | null;
  /** The model's context window, for the context-used percentage. */
  contextLimit: number;
  /** What the running turn is doing (Ink's status bar phase). */
  turnPhase: TurnPhase;
  /** The tool running right now, if any. */
  currentTool: string | null;
  /** AGENTS.md/KIMI.md looks out of date (suggest /init). */
  kimiMdStale: boolean;
  /** The current turn runs tools through generated code (code mode). */
  codeMode: boolean;
  /** How heavy the classifier judged the current turn. */
  intentTier: IntentTier | null;
  tasks: Task[];
  /** A tool waiting for the user's permission. */
  permission: { tool: PermissionRequest["tool"]; args: Record<string, unknown>; sensitiveReason?: string; destructive?: DestructivePrompt } | null;
  /** Open dialogs, in App's own terms. */
  modals: AppModal[];
  /** The models the "model" picker offers, when they aren't the local catalog's
   *  (a remote session offers only the server's). */
  modelChoices?: ModelEntry[];
  /** `/provider`: the provider to start the connect flow at, if one was named. */
  providerSetup: { initial?: ProviderId } | null;
  resumeSessions: SessionSummary[] | null;
  checkpoints: { session: SessionSummary; list: Checkpoint[] } | null;
  planOptions: PlanOption[] | null;
  /** `/queue plan`: the queued follow-ups to group or keep separate. The
   *  queue doesn't drain while this is open. */
  queuePlan: { prompts: string[] } | null;
  /** The user's custom slash commands, for the `/` picker. */
  customCommands: { name: string; description?: string }[];
  currentShell: string;
  memoryEnabled: boolean;
  /** Live memories for the current repo (0 when memory is off). */
  memoryCount: number;
  /** Epoch ms of the most recent memory write, null when there are none. */
  memoryLastWrite: number | null;
  /** Full custom command definitions (for editing). */
  customCommandDefs: CustomCommand[];
  /** The custom-command editor App wants open. */
  commandWizard: { mode: "create" | "edit"; initial?: CustomCommand } | null;
  commandPickerMode: "edit" | "delete" | null;
  /** The repo /changelog-image detected, if any. */
  changelogImageRepo: { owner: string; name: string } | null;
  /** Every configured hook, by event. */
  hooks: { event: HookEvent; hook: HookConfig }[];
  lsp: { servers: Record<string, LspServerConfig>; scope: "project" | "global"; hasProjectDir: boolean };
  /** The free tier's limit, queue or /upgrade screen App wants shown (see providers/dl-growth.ts). */
  dlScreen?: DlScreen | null;
  /** The GitHub star ask's line, to show once no turn is running (see star-ask.ts). */
  starAsk?: string | null;
  /** A push or pull request is waiting on GitHub access (see github-access.ts). */
  githubAccess?: GithubAccessRequest | null;
  /** `/feedback` is open: the message typed after the command, if any, and the active provider (see feedback.ts). */
  feedback?: FeedbackRequest | null;
  /** `/request` is open: the active provider (see access-request.ts). */
  accessRequest?: AccessRequestOpen | null;
  /** `/tour` is open: the view shows it once no turn is running (see ui/product-tour.ts). */
  productTour?: boolean;
}

export interface AppActions {
  /** Submit typed text exactly as the Ink prompt would (slash commands,
   *  `!` commands, queueing while busy, custom commands). */
  submit: (text: string) => void;
  /** Esc: interrupt the running turn. */
  interrupt: () => void;
  /** Shift+Tab. */
  cycleMode: () => void;
  decidePermission: (decision: PermissionDecision) => void;
  /** Deny the pending permission and tell the model what to do instead
   *  (Ink's "Something else"): the text is sent as the next message. */
  denyWithFeedback: (feedback: string) => void;
  pickModel: (model: ModelEntry | null) => void;
  /** The view finished `/provider` (credentials and model saved): reload the config. */
  providerSwitched: (to: ProviderId) => void;
  pickMode: (mode: Mode | null) => void;
  pickResume: (session: SessionSummary | null) => void;
  pickCheckpoint: (checkpointId: string | null) => void;
  pickPlanOption: (option: PlanOption | null) => void;
  pickPlanComplete: (choice: PlanCompleteChoice | null) => void;
  /** Answer `/queue plan` (null cancels and leaves the queue as it was). */
  pickQueuePlan: (choice: QueuePlanChoice) => void;
  pickShell: (shell: string | null) => void;
  generateChangelogImage: (owner: string, repo: string, days: number) => void;
  /** Save LSP servers (closes the LSP wizard). */
  saveLsp: (servers: Record<string, LspServerConfig>, enabled: boolean, scope: "project" | "global") => void;
  /** Reload hooks after the view changed settings.json; returns the fresh list. */
  reloadHooks: () => AppSnapshot["hooks"];
  /** Open the custom-command editor (from the picker, for edit). */
  openCommandWizard: (mode: "create" | "edit", name?: string) => void;
  /** Save from the custom-command editor (closes it). */
  saveCommand: (opts: SaveCustomCommandOptions) => void;
  /** Delete a custom command (after the view confirmed it). */
  deleteCommand: (name: string) => void;
  /** Close a dialog the view can't show. */
  closeModal: (modal: AppModal) => void;
  /** Run a slash command (e.g. from a dialog). */
  runCommand: (command: string) => void;
  /** The free-tier screen ended: retry the blocked request, open the provider picker, or nothing. */
  dlScreenDone?: (outcome: DlScreenOutcome) => void;
  /** The star ask was answered (starred or dismissed). */
  starAskDone?: () => void;
  /** The GitHub access question was answered: the waiting push or pull request goes on. */
  githubAccessDone?: (outcome: GithubAccessOutcome) => void;
  /** `/feedback` ended: the line to add to the transcript (sent, not sent, or why not). */
  feedbackDone?: (line: FeedbackLine) => void;
  /** `/tour` closed (finished or Esc). Nothing is printed. */
  productTourDone?: () => void;
  /** `/request` ended: the line to add to the transcript (sent, already in, cancelled, or why not). */
  accessRequestDone?: (line: AccessRequestLine) => void;
  exit: () => void;
}

export interface AppBridge {
  sync(snapshot: AppSnapshot): void;
  connect(actions: AppActions): void;
}
