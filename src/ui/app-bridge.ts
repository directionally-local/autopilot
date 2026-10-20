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

import type { ChatEvent } from "./chat.js";
import type { Mode } from "../mode.js";
import type { Usage } from "../agent/messages.js";
import type { DailyUsage } from "../usage-tracker.js";
import type { Task } from "../tools/registry.js";
import type { ModelEntry } from "../models/registry.js";
import type { ProviderId } from "../providers/presets.js";
import type { SessionSummary, Checkpoint } from "../sessions.js";
import type { PlanOption } from "../tools/registry.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import type { PlanCompleteChoice } from "./plan-complete-picker.js";
import type { CustomCommand } from "../commands/types.js";
import type { SaveCustomCommandOptions } from "../commands/save.js";
import type { LspServerConfig } from "../config.js";
import type { HookConfig, HookEvent } from "../hooks/types.js";
import type { RunningWorker } from "../tools/worker-registry.js";
import type { TurnPhase } from "./status.js";
import type { IntentTier } from "./narrator.js";
import type { QueuePlanChoice } from "./queue-plan-picker.js";

/** Which Ink dialog App currently wants open. */
export type AppModal =
  | "model"
  | "provider"
  | "mode"
  | "theme"
  | "ui"
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
  permission: { tool: PermissionRequest["tool"]; args: Record<string, unknown> } | null;
  /** Open dialogs, in App's own terms. */
  modals: AppModal[];
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
  themes: { name: string; label: string }[];
  currentTheme: string;
  currentShell: string;
  memoryEnabled: boolean;
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
  pickTheme: (name: string | null) => void;
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
  exit: () => void;
}

export interface AppBridge {
  sync(snapshot: AppSnapshot): void;
  connect(actions: AppActions): void;
}
