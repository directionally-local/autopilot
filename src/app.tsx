import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { Box, Text, useApp, useInput, useWindowSize, render } from "ink";
import Spinner from "./ui/spinner.js";

import { runAgentTurn, AgentLoopError, type GuardrailEvent } from "./agent/loop.js";
import type { ResponseMeta } from "./agent/client.js";
import { llmAuthFromConfig } from "./agent/llm-auth.js";
import { buildSystemPrompt, buildSessionPrefix } from "./agent/system-prompt.js";
import { summarizeMessagesViaLlm } from "./agent/llm-summarize.js";
import {
  compactMessagesViaArtifacts,
  shouldCompact,
  recallArtifacts,
  estimatePromptTokens,
} from "./agent/artifact-compaction.js";
import { proactiveCompactionThreshold } from "./agent/context-budget.js";
import {
  emptySessionState,
  ArtifactStore,
  formatRecalledArtifacts,
  serializeArtifactStore,
  type SessionState,
} from "./agent/session-state.js";
import { ToolExecutor, ALL_TOOLS } from "./tools/executor.js";
import type { ToolSpec } from "./tools/registry.js";
import { getShellCommand } from "./tools/bash.js";
import { McpManager } from "./mcp/manager.js";
import { LspManager } from "./lsp/manager.js";
import { HooksManager } from "./hooks/manager.js";
import { sanitizeString, appendStoppedToolResults } from "./agent/messages.js";
import type { ChatMessage, ContentPart, Usage } from "./agent/messages.js";
import { KimiApiError, humanizeApiError } from "./util/errors.js";
import { AbortScope } from "./util/abort-scope.js";
import { logger } from "./util/logger.js";
import { ChatView, type ChatEvent } from "./ui/chat.js";
import { StatusBar } from "./ui/status.js";
import { PermissionModal } from "./ui/permission.js";
import { usePermissionController } from "./ui/use-permission-controller.js";
import { ResumePicker } from "./ui/resume-picker.js";
import { CheckpointPicker } from "./ui/checkpoint-picker.js";
import { PlanOptionsPicker } from "./ui/plan-options-picker.js";
import { QueuePlanPicker } from "./ui/queue-plan-picker.js";
import { createQueueBatch, canDrainQueue, type QueuedPrompt } from "./agent/queue-batch.js";
import { isImmediateSubagentCommand, isRunNowCommand, SubagentPanel, useSubagentList } from "./ui/subagent-panel.js";
import { planTriageAction, steerMessage, triageIncoming, type TriageResult } from "./agent/inbox-triage.js";
import { answerAside } from "./agent/aside.js";
import { workerRegistry } from "./tools/worker-registry.js";
import { recordSubagentEvent } from "./tools/subagent-stats.js";
import { completionCheckFromConfig } from "./agent/completion-check.js";
import { TaskList } from "./ui/task-list.js";
import type { Task, PlanOption } from "./tools/registry.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import QRCode from "qrcode";
import type { ToolRender } from "./tools/registry.js";
import { CustomTextInput } from "./ui/text-input.js";
import { setTerminalTitle } from "./ui/terminal-title.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { Onboarding } from "./ui/onboarding.js";
import { Welcome } from "./ui/welcome.js";
import { configPath, DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, loadConfig, saveConfig, type KimiConfig, type ReasoningEffort, DEFAULT_PLUMBING_MODEL } from "./config.js";
import { startRemoteSession, streamRemoteProgress } from "./remote/worker-client.js";
import { saveRemoteSession, type RemoteSession } from "./remote/session-store.js";
import { deployForTui } from "./remote/deploy.js";
import { authGitHubForTui } from "./remote/tui-auth.js";
import { nextMode, type Mode } from "./mode.js";
import { classifyIntent } from "./intent/classify.js";
import { allowsSubagentDispatch, resolveSubagentGuidance } from "./intent/subagent-policy.js";
import type { SemanticSkillRoutingResult } from "./skills/index.js";
import { getMemoryDb } from "./memory/db.js";
import { listAllSkills, createSkill, deleteSkill, setSkillEnabled, findSkillFile } from "./skills/manager.js";
import {
  loadSession,
  addCheckpoint,
  generateSessionTitle,
  type Checkpoint,
} from "./sessions.js";
import { unlink } from "node:fs/promises";
import { encodeImageFile, type EncodedImage } from "./util/image.js";
import { recordUsage, getCostReport, usageEvents } from "./usage-tracker.js";
import type { DailyUsage } from "./usage-tracker.js";
import { MemoryManager } from "./memory/manager.js";
import { injectRecalledMemoryOnce } from "./memory/recall-inject.js";
import { loadCustomCommands } from "./commands/loader.js";
import { renderCommand } from "./commands/renderer.js";
import type { CustomCommand, SlashItem } from "./commands/types.js";
import { BUILTIN_COMMANDS, BUILTIN_COMMAND_NAMES } from "./commands/builtins.js";
import type { SaveCustomCommandOptions } from "./commands/save.js";
import { buildInitPrompt } from "./init/context-generator.js";
import { ThemeProvider } from "./ui/theme-context.js";
import { resolveTheme, themeList, themeNames, DEFAULT_THEME_NAME } from "./ui/theme.js";
import { loadAndMergeThemes } from "./ui/theme-loader.js";
import type { Theme } from "./ui/theme.js";
import { getModelOrInfer, type ModelEntry } from "./models/registry.js";
import type { ResolvedLspConfig } from "./util/lsp-config.js";
import { maybeLspNudge } from "./util/lsp-nudge.js";
import { glob } from "./util/glob.js";
import { FilePicker, type FilePickerItem } from "./ui/file-picker.js";
import { SlashPicker } from "./ui/slash-picker.js";
import { usePickerController } from "./ui/use-picker-controller.js";
import { useModalHost } from "./ui/use-modal-host.js";
import type { AppBridge, AppModal } from "./ui/app-bridge.js";
import type { HookConfig, HookEvent } from "./hooks/types.js";
import { ModalHost } from "./ui/modal-host.js";
import { PlanCompletePicker } from "./ui/plan-complete-picker.js";
import type { PlanCompleteChoice } from "./ui/plan-complete-picker.js";
import { useSessionManager } from "./ui/use-session-manager.js";
import { ResumeProgress } from "./ui/resume-progress.js";
import { useTurnController } from "./ui/use-turn-controller.js";
import {
  interruptTurn as runInterruptTurn,
  interruptOrExit as runInterruptOrExit,
  type InterruptDeps,
} from "./ui/input-handlers.js";
import { dispatchSlashCommand, type SlashContext, executeFreshStart } from "./ui/slash-commands.js";
import { generateContinuationSummary } from "./agent/continuation-summary.js";
import { runInit as runInitImpl } from "./init/run-init.js";
import { runStartupTasks } from "./ui/run-startup-tasks.js";
import { initLsp as initLspImpl, initMcp as initMcpImpl } from "./ui/manager-init.js";
import { runCompact as runCompactImpl } from "./agent/run-compact.js";
import { classifyNextMessage, makeTurnId, traceCompiledCompaction, traceLlmCompaction } from "./trace/index.js";
import { toOpenAIToolDefs } from "./tools/registry.js";
import { distillSessionPlan } from "./agent/distill.js";
import { resolvePlanForFresh } from "./agent/plan-resolver.js";
import { writeToClipboard } from "./util/clipboard.js";
import { enableUserShellCommands } from "./agent/user-shell.js";
import {
  formatBangContext,
  isTerminalHandedOff,
  parseBangCommand,
  registerInkInstance,
  runBangCommand,
} from "./ui/bang-command.js";
import {
  handleCommandDelete as handleCommandDeleteImpl,
  handleCommandSave as handleCommandSaveImpl,
  handleLspSave as handleLspSaveImpl,
  handleRemoteCancel as handleRemoteCancelImpl,
} from "./ui/command-handlers.js";
import {
  AUTO_COMPACT_THRESHOLD,
  buildFilePickerIgnoreList,
  capEvents,
  compactEventsVisual,
  CONTEXT_LIMIT,
  DEFAULT_AUTO_FRESH_SUGGESTION_TURNS,
  detectGitBranch,
  detectGitHubRepo,
  findImagePaths,
  costLookupFromConfig,
  makePrefixMessages,
  MAX_IMAGES_PER_MESSAGE,
  mkAssistantId,
  mkKey,
  openBrowser,
  rebuildSystemPromptForMode,
  trackRecentFile,
  replaceQueuedPrompt,
  replaceUserPromptEvent,
} from "./ui/app-helpers.js";

/** The TUI's config is exactly the loaded config. */
export type Cfg = KimiConfig;

interface PromptEditTarget {
  key: string;
  historyText: string;
  messagesBefore: ChatMessage[] | null;
}

interface PendingPromptEdit {
  key: string;
  full: string;
  display: string;
  messagesBefore: ChatMessage[];
}

function App({
  initialCfg,
  initialUpdateResult,
  initialLspScope,
  initialLspProjectPath,
  bridge,
}: {
  initialCfg: Cfg | null;
  initialUpdateResult?: UpdateCheckResult;
  initialLspScope: "project" | "global";
  initialLspProjectPath: string | null;
  /** Render through another view (e.g. Camouflage) instead of Ink. */
  bridge?: AppBridge;
}) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [cfg, setCfg] = useState<Cfg | null>(initialCfg);
  const modelContextLimit = useMemo(
    () => (cfg ? getModelOrInfer(cfg.model).contextWindow : CONTEXT_LIMIT),
    [cfg?.model],
  );
  const [lspScope, setLspScope] = useState<"project" | "global">(initialLspScope);
  const [lspProjectPath, setLspProjectPath] = useState<string | null>(initialLspProjectPath);
  const [events, setRawEvents] = useState<ChatEvent[]>([]);
  const setEvents = useCallback(
    (updater: React.SetStateAction<ChatEvent[]>) => {
      setRawEvents((prev) => {
        const next = typeof updater === "function" ? (updater as (prev: ChatEvent[]) => ChatEvent[])(prev) : updater;
        return capEvents(next);
      });
    },
    [],
  );
  const [input, setInput] = useState("");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sessionUsage, setSessionUsage] = useState<DailyUsage | null>(null);

  // Refresh sessionUsage when usage-tracker emits an out-of-band update
  // (e.g. after OpenRouter confirms a turn's cost and patches a turn's real cost).
  useEffect(() => {
    const handler = (sid: string) => {
      if (sessionIdRef.current && sid === sessionIdRef.current) {
        void getCostReport(sid).then((report) => setSessionUsage(report.session));
      }
    };
    usageEvents.on("update", handler);
    return () => {
      usageEvents.off("update", handler);
    };
  }, []);
  const [responseMeta, setResponseMeta] = useState<ResponseMeta | null>(null);
  const turn = useTurnController();
  const {
    busy, busyRef,
    isAbortingRef, lastEscapeAtRef,
    supervisorRef,
    turnPhase, setTurnPhase,
    turnStartedAt,
    currentToolName, setCurrentToolName,
    lastActivityAt, setLastActivityAt,
    turnCounterRef,
    showReasoning,
    tasks, setTasks, tasksRef,
    tasksStartedAt, setTasksStartedAt,
    tasksStartTokens, setTasksStartTokens,
    beginTurn, endTurn, clearTaskTracking,
  } = turn;
  const [planOptions, setPlanOptions] = useState<PlanOption[] | null>(null);
  const planOptionsRef = useRef<PlanOption[] | null>(null);
  const {
    pending: perm,
    askPermission: askForPermission,
    hasPending: hasPendingPermission,
    decide: decidePermission,
    denyPending: denyPendingPermission,
    clearResolveRef: clearPermissionResolveRef,
  } = usePermissionController(
    () => modeRef.current,
    (toolName) => {
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: `plan mode blocked ${toolName}; exit plan mode to execute`,
        },
      ]);
    },
  );
  const modals = useModalHost();
  const {
    commandWizard, setCommandWizard,
    commandPicker, setCommandPicker,
    commandToDelete, setCommandToDelete,
    showCommandList, setShowCommandList,
    showLspWizard, setShowLspWizard,
    showThemePicker, setShowThemePicker,
    showUiPicker, setShowUiPicker,
    setShowModelPicker,
    showModePicker, setShowModePicker,
    showRemoteDashboard, setShowRemoteDashboard,
    showInboxModal, setShowInboxModal,
    showHelpMenu, setShowHelpMenu,
    showMemoryPicker, setShowMemoryPicker,
    showSkillsPicker, setShowSkillsPicker,
    showShellPicker, setShowShellPicker,
    showPlanCompletePicker, setShowPlanCompletePicker,
    showChangelogImagePicker, setShowChangelogImagePicker,
    hasFullscreenModal,
    hasAnyModal,
  } = modals;
  const [queue, setQueue] = useState<QueuedPrompt[]>([]);
  // Completion must wake the drain effect even when busy was cleared earlier
  // during an intermediate assistant/tool callback.
  const [queueDrainRevision, setQueueDrainRevision] = useState(0);
  /** Running subagents, for the Camouflage activity panel (bridge snapshot). */
  const runningSubagents = useSubagentList();
  const announcedSubagentsRef = useRef<Set<string>>(new Set());
  /** Latest queue for async triage callbacks (state closures go stale). */
  const queueRef = useRef<QueuedPrompt[]>([]);
  queueRef.current = queue;
  const triageQueuedRef = useRef<((item: QueuedPrompt) => Promise<void>) | null>(null);
  const promoteQueuedRef = useRef<(() => boolean) | null>(null);
  const [queuePlanDraft, setQueuePlanDraft] = useState<QueuedPrompt[] | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [draftInput, setDraftInput] = useState("");
  const latestPromptRef = useRef<PromptEditTarget | null>(null);
  const pendingPromptEditRef = useRef<PendingPromptEdit | null>(null);

  // Plan/edit/auto modes are behind a feature flag (cfg.modesEnabled, off by
  // default): with it off every session runs in auto and the mode UI is hidden.
  const modesEnabled = cfg?.modesEnabled === true;
  const [mode, setMode] = useState<Mode>(initialCfg?.modesEnabled ? "edit" : "auto");
  useEffect(() => {
    // Toggling the flag from /settings: off → back to auto; on → start in edit.
    setMode((m) => (modesEnabled ? (m === "auto" ? "edit" : m) : "auto"));
  }, [modesEnabled]);
  const [codeMode, setCodeMode] = useState<boolean>(false);
  const filePickerEnabled = initialCfg?.filePicker ?? true;
  const [effort, setEffort] = useState<ReasoningEffort>(
    initialCfg?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
  );
  const [selectedRemoteSession, setSelectedRemoteSession] = useState<RemoteSession | null>(null);
  const [verbose, setVerbose] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(initialUpdateResult?.hasUpdate ?? false);
  const [latestVersion, setLatestVersion] = useState<string | null>(initialUpdateResult?.latestVersion ?? null);
  const [theme, setTheme] = useState<Theme>(resolveTheme(initialCfg?.theme));
  const [originalTheme, setOriginalTheme] = useState<Theme | null>(null);
  const [skillsActive, setSkillsActive] = useState(0);
  const [memoryRecalled, setMemoryRecalled] = useState(false);
  const [intentTier, setIntentTier] = useState<"light" | "medium" | "heavy" | null>(null);
  const [kimiMdStale, setKimiMdStale] = useState(false);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [lastSessionTopic, setLastSessionTopic] = useState<string | null>(null);
  const [changelogImageRepo, setChangelogImageRepo] = useState<{ owner: string; name: string } | null>(null);

  useEffect(() => {
    setGitBranch(detectGitBranch());
  }, []);

  // Fetch last session topic for smart welcome greetings
  useEffect(() => {
    void import("./sessions.js").then(({ listSessions }) =>
      listSessions(1).then((sessions) => {
        const last = sessions[0];
        if (last) {
          setLastSessionTopic(last.firstPrompt);
        }
      }),
    );
  }, []);

  // Register a SIGINT handler so Ctrl+C still works when the terminal is not
  // in raw mode (e.g. after a child process modified terminal state). The
  // handler delegates to the same logic as the useInput Ctrl+C handler.
  // This is different from the previous attempt (c6e9c1f) which unconditionally
  // called exit() and caused screen flashing by conflicting with useInput.
  useEffect(() => {
    const onSigint = () => {
      logger.info("sigint:fired", {
        hasHandler: sigintHandlerRef.current !== null,
      });
      // A `!` command owns the terminal: Ctrl+C is for it, not for us.
      if (isTerminalHandedOff()) return;
      sigintHandlerRef.current?.();
    };
    process.on("SIGINT", onSigint);
    return () => {
      process.off("SIGINT", onSigint);
    };
  }, []);

  // Load user and project themes at startup
  useEffect(() => {
    let cancelled = false;
    loadAndMergeThemes().then(({ errors, wcagWarnings }) => {
      if (cancelled) return;
      if (errors.length > 0) {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: `theme load errors:\n${errors.join("\n")}` },
        ]);
      }
      if (wcagWarnings.length > 0) {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `theme WCAG warnings:\n${wcagWarnings.join("\n")}` },
        ]);
      }
      // Re-resolve current theme in case a user/project theme overrides the built-in
      setTheme(resolveTheme(initialCfg?.theme));
    });
    return () => { cancelled = true; };
  }, []);

  // Cursor offset for the input box. The picker controller owns its own
  // open/close/selection state — see `usePickerController` below.
  const [cursorOffset, setCursorOffset] = useState(0);
  const [customCommandsVersion, setCustomCommandsVersion] = useState(0);

  const cacheStableRef = useRef(initialCfg?.cacheStablePrompts !== false);
  const messagesRef = useRef<ChatMessage[]>(
    makePrefixMessages(cacheStableRef.current, cfg?.model ?? DEFAULT_MODEL, "edit", ALL_TOOLS, cfg?.preferPullRequests),
  );
  const executorRef = useRef<ToolExecutor>(new ToolExecutor(ALL_TOOLS));
  const activeAsstIdRef = useRef<number | null>(null);
  const sessionScopeRef = useRef<AbortScope>(new AbortScope());
  const activeScopeRef = useRef<AbortScope | null>(null);
  /** Holds the latest Ctrl+C interrupt logic so the SIGINT handler can delegate to it. */
  const sigintHandlerRef = useRef<(() => void) | null>(null);
  const pendingToolCallsRef = useRef<Map<string, string>>(new Map());
  /** Mid-turn messages triaged as steers, delivered at the next tool
   *  boundary or before the final answer (drainPendingInput). */
  const pendingSteersRef = useRef<Array<{ key: string; full: string; display: string; content: string }>>([]);
  const modeRef = useRef<Mode>(mode);
  const effortRef = useRef<ReasoningEffort>(effort);
  const usageRef = useRef<Usage | null>(null);
  const responseMetaRef = useRef<ResponseMeta | null>(null);
  const lastApiErrorRef = useRef<{ httpStatus?: number; code?: number; message: string } | null>(null);
  const updateCheckedRef = useRef(false);
  const sessionStateRef = useRef<SessionState>(emptySessionState());
  const artifactStoreRef = useRef<ArtifactStore>(new ArtifactStore());
  const compiledContextRef = useRef(initialCfg?.compiledContext === true);
  const updateNudgedRef = useRef(false);
  const compactSuggestedRef = useRef(false);
  const freshSuggestedRef = useRef(false);
  const mcpManagerRef = useRef(new McpManager());
  const mcpToolsRef = useRef<ToolSpec[]>([]);
  const mcpInitRef = useRef(false);
  const submitRef = useRef<(full: string, display?: string) => void>(() => {});
  const lspManagerRef = useRef(new LspManager());
  const lspToolsRef = useRef<ToolSpec[]>([]);
  const lspInitRef = useRef(false);
  const memoryManagerRef = useRef<MemoryManager | null>(null);
  const hooksManagerRef = useRef<HooksManager>(new HooksManager(process.cwd()));
  // Wire hooks into the executor so every tool call — including those
  // generated from inside the code-mode sandbox (heavy-tier turns) —
  // fires PreToolUse / PostToolUse. The ref-based assignment after
  // construction is needed because the executor was created in line
  // with `useRef(new ToolExecutor(...))` above, before HooksManager
  // existed.
  useEffect(() => {
    executorRef.current.setHooks(hooksManagerRef.current);
    return () => executorRef.current.setHooks(null);
  }, []);
  const sessionStartRecallRef = useRef<Promise<import("./memory/schema.js").HybridResult[]> | null>(null);
  const kimiMdStaleNudgedRef = useRef(false);
  /** Trace turn id of the turn in flight (set by processMessage). */
  const currentTurnIdRef = useRef<string | null>(null);
  /** Set when the next submitted message is the feedback typed into a permission deny box. */
  const denyFeedbackRef = useRef(false);
  /** Stores the plan distilled from a plan-mode session so it survives follow-up discussion. */
  const sessionPlanRef = useRef<string | null>(null);
  /**
   * Plan text bound to the plan-complete picker when it is armed, so a
   * session reset between arming and picking can't invalidate the pick.
   */
  const planCompletePlanRef = useRef<string | null>(null);

  const sessionMgr = useSessionManager({
    cfg,
    mode,
    messagesRef,
    sessionStateRef,
    artifactStoreRef,
    compiledContextRef,
    responseMetaRef,
    memoryManagerRef,
    setEvents,
    setHistory,
    setUsage,
    setSessionUsage,
    setResponseMeta,
    mkKey,
  });
  const {
    sessionIdRef,
    sessionCreatedAtRef,
    sessionTitleRef,
    resumeSessions, setResumeSessions,
    checkpointSession, setCheckpointSession,
    checkpointList,
    resuming, resumingMessage, resumeProgress, resumeStage,
    ensureSessionId,
    saveSessionSafe,
    openResumePicker,
    doResumeSession,
    handleResumePick,
    handleCheckpointPick,
    resetSession,
    traceRef,
    ensureTraceStarted,
    turnHistoryRef,
    noteTurnEnded,
  } = sessionMgr;

  // Batched streaming delta refs to reduce React re-render frequency
  const pendingTextRef = useRef<Map<number, { text: string; reasoning: string }>>(new Map());
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const customCommandsRef = useRef<CustomCommand[]>([]);
  const recentFilesRef = useRef<Map<string, number>>(new Map());
  const MAX_RECENT_FILES = 10;

  // Custom commands that shadow built-ins are warned about and won't run, so
  // don't surface them in the picker either. customCommandsVersion is bumped
  // by every customCommandsRef mutation — keep that invariant intact.
  const allSlashCommands = React.useMemo<SlashItem[]>(() => {
    const customs: SlashItem[] = customCommandsRef.current
      .filter((c) => !BUILTIN_COMMAND_NAMES.has(c.name.toLowerCase()))
      .map((c) => ({
        name: c.name,
        description: c.description ?? "",
        source: c.source,
      }));
    // Mode commands only appear in the picker when the modes flag is on.
    const MODE_COMMANDS = new Set(["mode", "plan", "auto", "edit"]);
    const builtins = modesEnabled ? BUILTIN_COMMANDS : BUILTIN_COMMANDS.filter((c) => !MODE_COMMANDS.has(c.name));
    return [...builtins, ...customs];
  }, [customCommandsVersion, modesEnabled]);

  // Preserves the pre-refactor asymmetry: the picker close-on-modal check
  // includes showInboxModal but EXCLUDES showRemoteDashboard and
  // showThemePicker. Likely an oversight from when those modals were
  // added later — kept as-is for this pure refactor; revisit when we
  // audit modal/keybinding semantics.
  const modalActive =
    commandWizard !== null ||
    commandPicker !== null ||
    commandToDelete !== null ||
    showCommandList ||
    showLspWizard ||
    resumeSessions !== null ||
    checkpointSession !== null ||
    resuming ||
    perm !== null ||
    showInboxModal ||
    showHelpMenu ||
    showModePicker ||
    showMemoryPicker ||
    showSkillsPicker ||
    showShellPicker;

  const loadFilePickerItems = useCallback(async (query = ""): Promise<FilePickerItem[]> => {
    const cwd = process.cwd();
    const pathQuery = query.startsWith("/") || query.startsWith("~") || query.startsWith(".");
    if (pathQuery) {
      const slash = query.lastIndexOf("/");
      const exactDirectory = query === "~" || query === "." || query === ".." || query.endsWith("/..");
      const prefix = exactDirectory ? `${query.replace(/\/$/, "")}/` : slash >= 0 ? query.slice(0, slash + 1) : "";
      const directory = exactDirectory ? query : slash >= 0 ? query.slice(0, slash + 1) : query;
      const expanded = directory.startsWith("~") ? join(homedir(), directory.slice(1)) : directory;
      const target = resolve(cwd, expanded || ".");
      const entries = await glob("*", {
        cwd: target,
        dot: false,
        absolute: false,
        onlyFiles: false,
        markDirectories: true,
        suppressErrors: true,
      });
      return entries.slice(0, 300).map((entry) => {
        const isDirectory = entry.endsWith("/");
        return { name: prefix + (isDirectory ? entry.slice(0, -1) : entry), isDirectory };
      }).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    const entries = await glob("**/*", {
      cwd,
      ignore: buildFilePickerIgnoreList(cwd),
      dot: false,
      absolute: false,
      onlyFiles: false,
      markDirectories: true,
    });
    return entries.slice(0, 300).map((entry) => ({
      name: entry.endsWith("/") ? entry.slice(0, -1) : entry,
      isDirectory: entry.endsWith("/"),
    }));
  }, []);

  const picker = usePickerController({
    input,
    cursorOffset,
    setInput,
    setCursorOffset,
    filePickerEnabled,
    allSlashCommands,
    modalActive,
    loadFilePickerItems,
    onFileSelected: (name) => trackRecentFile(recentFilesRef, name, MAX_RECENT_FILES),
    onSlashSelected: (value) => submitRef.current(value),
    getRecentFiles: () => recentFilesRef.current,
  });

  useEffect(() => {
    if (!cfg) return;
    runStartupTasks({
      cfg,
      setEvents,
      mkKey,
      memoryManagerRef,
      sessionStartRecallRef,
      setKimiMdStale,
      customCommandsRef,
      setCustomCommandsVersion,
    });
  }, [cfg, setEvents]);

  // Periodically clear performance marks to prevent perf_hooks buffer overflow
  // in long-running sessions (react-devtools-core causes marks on every render).
  useEffect(() => {
    const id = setInterval(() => {
      try {
        performance.clearMarks();
        performance.clearMeasures();
      } catch {
        // ignore — not all Node versions expose these globally
      }
    }, 300_000); // every 5 minutes
    return () => clearInterval(id);
  }, []);

  const reloadCustomCommands = useCallback(async () => {
    const { commands, warnings } = await loadCustomCommands(process.cwd());
    customCommandsRef.current = commands;
    setCustomCommandsVersion((v) => v + 1);
    for (const w of warnings) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `commands: ${w}` }]);
    }
    const shadowed = commands.filter((c) => BUILTIN_COMMAND_NAMES.has(c.name.toLowerCase()));
    for (const c of shadowed) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `commands: /${c.name} (${c.filepath}) shadowed by built-in — will not run` },
      ]);
    }
  }, [setEvents]);

  useEffect(() => {
    if (!cfg || updateCheckedRef.current) return;
    updateCheckedRef.current = true;

    if (initialUpdateResult) {
      if (initialUpdateResult.hasUpdate && !updateNudgedRef.current) {
        updateNudgedRef.current = true;
        setHasUpdate(true);
        setLatestVersion(initialUpdateResult.latestVersion);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `update available: ${initialUpdateResult.localVersion} → ${initialUpdateResult.latestVersion}`,
          },
        ]);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "run:  npm i -g autopilot-ai@latest  then restart",
          },
        ]);
      }
      return;
    }

    void checkForUpdate().then((result) => {
      if (result.hasUpdate && !updateNudgedRef.current) {
        updateNudgedRef.current = true;
        setHasUpdate(true);
        setLatestVersion(result.latestVersion);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `update available: ${result.localVersion} → ${result.latestVersion}`,
          },
        ]);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "run:  npm i -g autopilot-ai@latest  then restart",
          },
        ]);
      }
    });
    // Camouflage UI access is temporarily disabled; skip camouflage-tui update checks.
    // void checkOptionalDependency("camouflage-tui", "beta").then((dep) => { ... });
  }, [cfg, initialUpdateResult]);

  useEffect(() => {
    modeRef.current = mode;
    if (cacheStableRef.current) {
      messagesRef.current[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg?.model ?? DEFAULT_MODEL,
          mode,
          preferPullRequests: cfg?.preferPullRequests,
        }),
      };
    } else {
      messagesRef.current[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg?.model ?? DEFAULT_MODEL,
          mode,
          preferPullRequests: cfg?.preferPullRequests,
        }),
      };
    }
    if (mode === "plan") {
      executorRef.current.clearSessionPermissions();
    }
  }, [mode, cfg?.model]);

  useEffect(() => {
    effortRef.current = effort;
  }, [effort]);

  useEffect(() => {
    if (!cfg) return;
    const id = setInterval(() => {
      void checkForUpdate().then((result) => {
        if (result.hasUpdate) {
          setHasUpdate(true);
          setLatestVersion(result.latestVersion);
          if (!updateNudgedRef.current) {
            updateNudgedRef.current = true;
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `update available: ${result.localVersion} → ${result.latestVersion}`,
              },
            ]);
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: "run:  npm i -g autopilot-ai@latest  then restart",
              },
            ]);
          }
        }
      });
      // Camouflage UI access is temporarily disabled; skip camouflage-tui update checks.
      // void checkOptionalDependency("camouflage-tui", "beta").then((dep) => { ... });
    }, 30 * 60 * 1000); // 30 minutes
    return () => clearInterval(id);
  }, [cfg]);

  const initMcp = useCallback(async () => {
    if (!cfg) return;
    await initMcpImpl({
      cfg,
      setEvents,
      mkKey,
      executorRef,
      messagesRef,
      cacheStableRef,
      modeRef,
      mcpToolsRef,
      lspToolsRef,
      mcpManagerRef,
      mcpInitRef,
    });
  }, [cfg]);

  const initLsp = useCallback(async () => {
    if (!cfg) return;
    await initLspImpl({
      cfg,
      setEvents,
      mkKey,
      executorRef,
      messagesRef,
      cacheStableRef,
      modeRef,
      mcpToolsRef,
      lspToolsRef,
      lspManagerRef,
      lspInitRef,
    });
  }, [cfg]);

  useEffect(() => {
    if (cfg && !mcpInitRef.current) {
      void initMcp();
    }
    if (cfg && !lspInitRef.current) {
      void initLsp();
    }
  }, [cfg, initMcp, initLsp]);

  /** Mid-turn compaction hook: called between tool-iteration cycles in runAgentTurn.
   *  Prevents context overflow during long exploration sessions. */
  const onIterationEnd = useCallback(
    async (messages: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> => {
      if (signal.aborted) return messages;
      // Budget-aware: small-context models compact before the hard preflight
      // limit; large ones still compact at the cost-driven 80k cap.
      if (!shouldCompact({ messages, tokenThreshold: cfg ? proactiveCompactionThreshold(cfg.model) : undefined })) return messages;

      // M6.1: fire PreCompact before either compaction path runs.
      // Best-effort + fire-and-forget — never block compaction on a
      // user hook. Same shape as the user-triggered /compact path.
      if (hooksManagerRef.current.hasEnabledHooks("PreCompact")) {
        void hooksManagerRef.current
          .fire(
            "PreCompact",
            {
              event: "PreCompact",
              session_id: sessionIdRef.current,
              cwd: process.cwd(),
            },
            null,
            signal,
          )
          .catch(() => {});
      }

      if (compiledContextRef.current) {
        const store = artifactStoreRef.current;
        const result = compactMessagesViaArtifacts({
          messages,
          state: sessionStateRef.current,
          store,
        });
        if (result.metrics.rawTurnsRemoved > 0) {
          traceCompiledCompaction(traceRef.current, result, currentTurnIdRef.current);
          sessionStateRef.current = result.newState;
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `auto-compacted: ${result.metrics.estimatedTokensBefore} → ${result.metrics.estimatedTokensAfter} tokens (${result.metrics.archivedArtifacts} artifacts)`,
            },
          ]);
          await saveSessionSafe();
        }
        // After compaction, recall memories so the model retains durable anchors
        const manager = memoryManagerRef.current;
        if (manager && !signal.aborted) {
          try {
            const cwd = process.cwd();
            const queryText = sessionStateRef.current.task || cwd;
            const results = await manager.recall({ text: queryText, repoPath: cwd, limit: 5 });
            if (results.length > 0 && !signal.aborted) {
              const text = await manager.synthesizeRecalled(results);
              if (injectRecalledMemoryOnce(result.newMessages, text)) {
                setEvents((e) => [
                  ...e,
                  {
                    kind: "memory",
                    key: mkKey(),
                    text: `recalled ${results.length} memory${results.length === 1 ? "" : "ies"} after compaction`,
                  },
                ]);
                await saveSessionSafe();
              }
            }
          } catch {
            // Non-fatal
          }
        }
        return result.newMessages;
      }

      // Non-compiled context: fall back to LLM summarizer
      if (cfg && !signal.aborted) {
        try {
          const result = await summarizeMessagesViaLlm({
            ...llmAuthFromConfig(cfg),
            model: cfg.model,
            messages,
            signal,
          });
          if (result.replacedCount > 0) {
            traceLlmCompaction(traceRef.current, messages, result, currentTurnIdRef.current);
            setEvents((e) => [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `auto-compacted: ${result.replacedCount} messages summarized`,
              },
            ]);
            await saveSessionSafe();
          }
          return result.newMessages;
        } catch {
          // Non-fatal: if compaction fails, continue with original messages
        }
      }
      return messages;
    },
    [cfg],
  );

  // The deps for interruptTurn / interruptOrExit. Assigned via a ref
  // below — after updateTool is declared — because useInput, the SIGINT
  // handler, and Esc all need to share the same object.
  const interruptDepsRef = useRef<InterruptDeps | null>(null);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      logger.info("input:ctrl+c", {
        busy: busyRef.current,
        hasActiveScope: activeScopeRef.current !== null,
        isAborting: isAbortingRef.current,
        hasPerm: hasPendingPermission(),
      });
      // Multi-agent cancel path: abort the dedicated controller so the
      // polling loop breaks and /cancel fires on each active worker.
      const outcome = runInterruptOrExit(interruptDepsRef.current!);
      if (!outcome.didInterruptTurn && !outcome.hadPermission) {
        logger.info("input:ctrl+c:exiting");
      }
      return;
    }
    if (key.escape) {
      const now = Date.now();
      // Preserves the pre-refactor asymmetry: this Esc-handler check
      // EXCLUDES commandPicker, showInboxModal, and showRemoteDashboard
      // (so Esc still fires the abort-turn path when those are open).
      // Kept as-is for this pure refactor.
      const modalOpen =
        perm !== null ||
        showLspWizard ||
        showCommandList ||
        commandWizard !== null ||
        commandToDelete !== null ||
        resumeSessions !== null ||
        checkpointSession !== null ||
        planOptions !== null ||
        queuePlanDraft !== null ||
        showThemePicker;
      if (!modalOpen && !isAbortingRef.current && now - lastEscapeAtRef.current > 500) {
        if ((busyRef.current || supervisorRef.current.isRunning) && activeScopeRef.current) {
          lastEscapeAtRef.current = now;
          runInterruptTurn(interruptDepsRef.current!);
          return;
        }
      }
    }
    if (key.ctrl && inputChar === "r") {
      turn.toggleReasoning();
      return;
    }
    if (key.ctrl && inputChar === "g") {
      promoteQueuedRef.current?.();
      return;
    }
    if (key.shift && key.tab) {
      if (modesEnabled) setMode((m) => nextMode(m));
      return;
    }
    if (key.ctrl && inputChar === "o") {
      setVerbose((v) => !v);
      return;
    }
  });

  // Keep the SIGINT handler in sync with the latest state/refs so that when
  // the terminal sends a real SIGINT (bypassing Ink raw mode) we can still
  // interrupt the turn or exit gracefully.
  sigintHandlerRef.current = () => {
    logger.info("sigint:handler", {
      busy: busyRef.current,
      hasActiveScope: activeScopeRef.current !== null,
      isAborting: isAbortingRef.current,
      hasPerm: hasPendingPermission(),
    });
    // SIGINT preserves the pre-refactor asymmetry: it does NOT iterate
    // pendingToolCalls to mark them cancelled (the Ctrl+C path does).
    // Pass `skipPendingToolCleanup: true` so interruptTurn matches.
    const outcome = runInterruptOrExit({
      ...interruptDepsRef.current!,
      skipPendingToolCleanup: true,
    });
    if (!outcome.didInterruptTurn && !outcome.hadPermission) {
      logger.info("sigint:handler:exiting");
    }
  };

  const flushAssistantUpdates = useCallback(() => {
    flushTimeoutRef.current = null;
    const pending = pendingTextRef.current;
    if (pending.size === 0) return;
    pendingTextRef.current = new Map();
    setEvents((evts) =>
      evts.map((e) => {
        if (e.kind !== "assistant") return e;
        const delta = pending.get(e.id);
        if (!delta) return e;
        return {
          ...e,
          text: e.text + delta.text,
          reasoning: e.reasoning + delta.reasoning,
        } as ChatEvent;
      }),
    );
  }, []);

  const updateAssistant = useCallback(
    (id: number, patch: (e: Extract<ChatEvent, { kind: "assistant" }>) => Partial<ChatEvent>) => {
      const result = patch({ text: "", reasoning: "" } as Extract<ChatEvent, { kind: "assistant" }>);
      const assistantResult = result as Partial<Extract<ChatEvent, { kind: "assistant" }>>;
      const hasTextDelta = assistantResult.text !== undefined && assistantResult.text.length > 0;
      const hasReasoningDelta = assistantResult.reasoning !== undefined && assistantResult.reasoning.length > 0;

      if (hasTextDelta || hasReasoningDelta) {
        const existing = pendingTextRef.current.get(id) ?? { text: "", reasoning: "" };
        pendingTextRef.current.set(id, {
          text: existing.text + (assistantResult.text ?? ""),
          reasoning: existing.reasoning + (assistantResult.reasoning ?? ""),
        });
        if (!flushTimeoutRef.current) {
          flushTimeoutRef.current = setTimeout(flushAssistantUpdates, 16); // ~60fps
        }
        return;
      }

      // Non-text patches (streaming flag, etc.) apply immediately after flushing
      if (flushTimeoutRef.current) {
        clearTimeout(flushTimeoutRef.current);
        flushAssistantUpdates();
      }
      setEvents((evts) =>
        evts.map((e) =>
          e.kind === "assistant" && e.id === id ? ({ ...e, ...result } as ChatEvent) : e,
        ),
      );
    },
    [flushAssistantUpdates],
  );

  const updateTool = useCallback(
    (id: string, patch: Partial<Extract<ChatEvent, { kind: "tool" }>>) => {
      setEvents((evts) =>
        evts.map((e) =>
          e.kind === "tool" && e.id === id ? ({ ...e, ...patch } as ChatEvent) : e,
        ),
      );
    },
    [],
  );

  const updateResponseMeta = useCallback((meta: ResponseMeta) => {
    responseMetaRef.current = meta;
    setResponseMeta(meta);
  }, []);

  // Keep the interruptDepsRef in sync with the latest refs / state. Read
  // by the useInput handler (Ctrl+C, Esc) and the SIGINT handler above.
  interruptDepsRef.current = {
    busyRef, activeScopeRef, isAbortingRef, supervisorRef,
    hasPendingPermission, denyPendingPermission,
    pendingToolCallsRef, updateTool, messagesRef,
    setEvents, mkKey,
    saveSessionSafe, clearTaskTracking,
    lspManagerRef, exit,
  };

  const runCompact = useCallback(async () => {
    if (!cfg) return;
    await runCompactImpl({
      cfg,
      busy,
      mkKey,
      setEvents,
      beginTurn,
      endTurn,
      saveSessionSafe,
      clearPermissionResolveRef,
      sessionScopeRef,
      activeScopeRef,
      compiledContextRef,
      artifactStoreRef,
      messagesRef,
      sessionStateRef,
      pendingToolCallsRef,
      hooks: hooksManagerRef.current,
      sessionId: sessionIdRef.current,
      supervisorRef,
      trace: traceRef.current,
    });
  }, [cfg, busy, saveSessionSafe]);

  const runInit = useCallback(async () => {
    if (!cfg) return;
    await runInitImpl({
      cfg,
      busy,
      mkKey,
      setEvents,
      setCodeMode,
      setTurnPhase,
      setCurrentToolName,
      setLastActivityAt,
      setUsage,
      setSessionUsage,
      setKimiMdStale,
      beginTurn,
      endTurn,
      ensureSessionId,
      onIterationEnd,
      updateAssistant,
      updateTool,
      updateResponseMeta,
      askForPermission,
      clearPermissionResolveRef,
      messagesRef,
      sessionScopeRef,
      activeScopeRef,
      mcpToolsRef,
      lspToolsRef,
      executorRef,
      effortRef,
      memoryManagerRef,
      pendingToolCallsRef,
      recentFilesRef,
      usageRef,
      activeAsstIdRef,
      responseMetaRef,
      kimiMdStaleNudgedRef,
      lspManagerRef,
      modeRef,
      cacheStableRef,
      lastApiErrorRef,
      supervisorRef,
    });
  }, [cfg, busy, updateAssistant, updateTool, updateResponseMeta]);

  const handleThemePick = useCallback(
    (picked: Theme | null) => {
      setShowThemePicker(false);
      if (!picked) return;
      setCfg((c) => {
        if (!c) return c;
        const updated = { ...c, theme: picked.name };
        void saveConfig(updated).catch(() => {});
        return updated;
      });
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `theme: ${picked.label} — restart to apply` },
      ]);
    },
    [],
  );

  const handleUiPick = useCallback(
    (picked: "ink" | null) => {
      setShowUiPicker(false);
      if (!picked) return;
      setCfg((c) => {
        if (!c) return c;
        const updated = { ...c, uiEngine: picked };
        void saveConfig(updated).catch(() => {});
        return updated;
      });
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: `UI engine set to "${picked}". React Ink is the only available engine.`,
        },
      ]);
    },
    [mkKey, setShowUiPicker],
  );

  const handleModelPick = useCallback(
    (picked: ModelEntry | null) => {
      setShowModelPicker(false);
      if (!picked) return;
      const previousModel = cfg?.model ?? "the current model";
      setCfg((c) => {
        if (!c) return c;
        const updated = { ...c, model: picked.id };
        void saveConfig(updated).catch(() => {});
        return updated;
      });
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: busy
            ? `model selected: ${picked.id} · ${picked.contextWindow.toLocaleString()} ctx. The current turn continues with ${previousModel}; your next message will use ${picked.id}. Conversation history is kept.`
            : `model switched: ${previousModel} → ${picked.id} · ${picked.contextWindow.toLocaleString()} ctx. Your next message will use this model; conversation history is kept.`,
        },
      ]);
    },
    [busy, cfg?.model, mkKey, setShowModelPicker],
  );

  const buildSlashContext = useCallback((): SlashContext => ({
    exit,
    busy,
    mkKey,
    setEvents,
    cfg,
    setCfg,
    mode,
    setMode,
    setShowReasoning: turn.setShowReasoning,
    setUsage,
    setSessionUsage,
    setResponseMeta,
    setHasUpdate,
    setLatestVersion,
    setShowThemePicker,
    setShowModelPicker,
    setShowModePicker,
    setShowInboxModal,
    setShowHooksDashboard: modals.setShowHooksDashboard,
    setShowHelpMenu,
    setShowLspWizard,
    setShowRemoteDashboard,
    setShowCommandList,
    setCommandWizard,
    setCommandPicker,
    setShowMemoryPicker,
    setShowSkillsPicker,
    setShowShellPicker,
    setShowChangelogImagePicker,
    setChangelogImageRepo,
    setTasks: turn.setTasks,
    setTasksStartedAt: turn.setTasksStartedAt,
    lspScope,
    lspProjectPath,
    resetSession,
    clearTaskTracking,
    openResumePicker,
    runCompact,
    runInit,
    initMcp,
    initLsp,
    ensureSessionId,
    lspManagerRef,
    mcpManagerRef,
    hooksManagerRef,
    cacheStableRef,
    messagesRef,
    flushTimeoutRef,
    pendingTextRef,
    activeAsstIdRef,
    pendingToolCallsRef,
    usageRef,
    turnCounterRef,
    responseMetaRef,
    executorRef,
    mcpToolsRef,
    mcpInitRef,
    lspToolsRef,
    lspInitRef,
    sessionIdRef,
    compactSuggestedRef,
    updateNudgedRef,
    freshSuggestedRef,
    memoryManagerRef,
    artifactStoreRef,
    sessionStateRef,
    compiledContextRef,
    lastApiErrorRef,
    activeScopeRef,
    sessionPlanRef,
    traceRef,
    turnHistoryRef,
  }), [
    exit, busy, cfg, mode, lspScope, lspProjectPath,
    setCfg, setMode, setEvents, setUsage, setSessionUsage, setResponseMeta,
    setHasUpdate, setLatestVersion, setShowThemePicker, setShowModelPicker, setShowModePicker,
    setShowInboxModal, setShowHelpMenu,
    setShowMemoryPicker, setShowSkillsPicker, setShowShellPicker,
    setShowChangelogImagePicker, setChangelogImageRepo,
    setShowLspWizard, setShowRemoteDashboard, setShowCommandList,
    setCommandWizard, setCommandPicker,
    turn.setShowReasoning, turn.setTasks, turn.setTasksStartedAt,
    resetSession, clearTaskTracking, openResumePicker, runCompact, runInit,
    initMcp, initLsp, ensureSessionId,
  ]);

  const handlePlanCompletePick = useCallback(
    (picked: PlanCompleteChoice | null) => {
      setShowPlanCompletePicker(false);
      const boundPlan = planCompletePlanRef.current;
      planCompletePlanRef.current = null;
      if (!picked || picked === "continue") return;

      // Prefer the plan bound to the picker when it was armed (immune to
      // session resets in between); fall back to resolving from session state.
      const plan = boundPlan ?? resolvePlanForFresh({
        mode: "plan",
        messages: messagesRef.current,
        sessionPlan: sessionPlanRef.current,
        memoryManager: memoryManagerRef.current,
        memoryEnabled: cfg?.memoryEnabled,
        repoPath: process.cwd(),
      });
      if (!plan) {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: "No plan found to start fresh with." },
        ]);
        setMode(picked);
        return;
      }

      const clipResult = executeFreshStart(buildSlashContext(), plan, picked, { seedMessages: false });

      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: clipResult.success
            ? `Plan copied to clipboard. Starting fresh session in ${picked} mode with plan only…`
            : `Clipboard unavailable. Starting fresh session in ${picked} mode with plan only…`,
        },
      ]);

      if (!clipResult.success) {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "--- Plan ---\n" + plan }]);
      }

      setMode(picked);
      modeRef.current = picked;
      submitRef.current(plan);
    },
    [mkKey, setShowPlanCompletePicker, setMode, setEvents, submitRef, buildSlashContext],
  );

  const handleSlash = useCallback(
    async (cmd: string): Promise<boolean> => dispatchSlashCommand(buildSlashContext(), cmd),
    [buildSlashContext],
  );

  const handleCommandSave = useCallback(
    (opts: SaveCustomCommandOptions) =>
      handleCommandSaveImpl(
        { setEvents, mkKey, commandWizard, setCommandWizard, reloadCustomCommands },
        opts,
      ),
    [commandWizard, reloadCustomCommands, setEvents],
  );

  const handleCommandDelete = useCallback(
    (cmd: CustomCommand) =>
      handleCommandDeleteImpl(
        { setEvents, mkKey, setCommandToDelete, reloadCustomCommands },
        cmd,
      ),
    [reloadCustomCommands, setEvents, setCommandToDelete],
  );

  const handleLspSave = useCallback(
    (
      servers: NonNullable<Cfg["lspServers"]>,
      enabled: boolean,
      scope: "project" | "global",
    ) =>
      handleLspSaveImpl(
        {
          cfg,
          setCfg,
          setEvents,
          mkKey,
          setLspScope,
          setLspProjectPath,
          setShowLspWizard,
        },
        servers,
        enabled,
        scope,
      ),
    [cfg, setCfg, setEvents, setShowLspWizard],
  );

  const handleRemoteCancel = useCallback(
    (session: RemoteSession) =>
      handleRemoteCancelImpl(
        { setEvents, mkKey, setSelectedRemoteSession, setShowRemoteDashboard },
        session,
      ),
    [setEvents, setShowRemoteDashboard],
  );

  // `! <command>`: run it in the user's terminal, show the output, and share
  // it with the model as context for the next turn.
  const runUserShellCommand = useCallback(
    async (command: string, display: string, queuedKey?: string) => {
      if (queuedKey) {
        setEvents((evts) =>
          evts.map((e) => (e.kind === "user" && e.key === queuedKey ? { ...e, text: display, queued: false } : e)),
        );
      } else {
        setEvents((e) => [...e, { kind: "user", key: mkKey(), text: display }]);
      }
      if (!command) {
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: "usage: ! <command> — runs in your terminal (logins and prompts work); the output is shared with the agent",
          },
        ]);
        return;
      }
      const result = await runBangCommand(command, process.cwd());
      const id = `bang_${mkKey()}`;
      const status = result.signal ? `signal=${result.signal}` : `exit=${result.exitCode ?? "?"}`;
      setEvents((e) => [
        ...e,
        {
          kind: "tool",
          key: id,
          id,
          name: "bash",
          args: JSON.stringify({ command }),
          status: result.exitCode === 0 ? "done" : "error",
          result: `${status}\n${result.output ?? "(output not captured)"}`,
          render: { title: `! ${command}`.slice(0, 120) },
        },
      ]);
      messagesRef.current.push({ role: "user", content: sanitizeString(formatBangContext(result)) });
      await saveSessionSafe();
    },
    [mkKey, saveSessionSafe],
  );

  const processMessage = useCallback(
    async (text: string, displayText?: string, opts?: { queuedKeys?: string[]; userPromptForHooks?: string; eventKey?: string; historyText?: string }) => {
      if (!cfg) return;
      let trimmed = text.trim();
      if (!trimmed) return;

      let display = displayText?.trim() || trimmed;
      const promptKey = opts?.eventKey ?? opts?.queuedKeys?.[0];
      if (promptKey && !trimmed.startsWith("/") && parseBangCommand(trimmed) === null) {
        const previousTarget = latestPromptRef.current;
        if (opts?.eventKey || previousTarget?.key === promptKey) {
          latestPromptRef.current = {
            key: promptKey,
            historyText: opts?.historyText ?? previousTarget?.historyText ?? display,
            messagesBefore: [...messagesRef.current],
          };
        }
      }

      // Mark busy immediately so no other path can race into processMessage
      // while async setup (image encoding, hooks, etc.) is in flight.
      beginTurn();

      let overrideModel: string | undefined;
      let overrideEffort: ReasoningEffort | undefined;

      const bangCommand = parseBangCommand(trimmed);
      if (bangCommand !== null) {
        await runUserShellCommand(bangCommand, display, opts?.queuedKeys?.[0]);
        endTurn();
        return;
      }

      if (trimmed.startsWith("/")) {
        const head = trimmed.split(/\s+/)[0]!.toLowerCase();
        const selfManaged = ["/compact", "/init"].includes(head);
        if (await handleSlash(trimmed)) {
          if (!selfManaged) {
            endTurn();
          }
          return;
        }
        const cmdName = head.slice(1);
        const custom = customCommandsRef.current.find((c) => c.name === cmdName);
        if (custom) {
          const info = (text: string) =>
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
          const { prompt: rendered, warnings } = await renderCommand(custom, trimmed, {
            cwd: process.cwd(),
          });
          for (const w of warnings) info(`/${custom.name}: ${w}`);
          if (custom.shell) {
            info(`/${custom.name}: executing shell code from template`);
          }
          if (!rendered.trim()) {
            endTurn();
            return;
          }
          const parts: string[] = [];
          if (custom.model) {
            overrideModel = custom.model;
            parts.push(`model=${custom.model}`);
          }
          if (custom.effort) {
            overrideEffort = custom.effort;
            parts.push(`effort=${custom.effort}`);
          }
          if (parts.length > 0) info(`command '${custom.name}' → ${parts.join(", ")} (this turn)`);
          if (custom.mode) info(`note: mode override (${custom.mode}) is not yet wired; current mode applies`);
          display = trimmed;
          trimmed = rendered;
        }
      }

      // Track @-mentioned files for recent-files picker boost
      const mentionMatches = trimmed.matchAll(/@(\S+)/g);
      for (const m of mentionMatches) {
        const path = m[1];
        if (path) trackRecentFile(recentFilesRef, path, MAX_RECENT_FILES);
      }

      const imagePaths = findImagePaths(trimmed).slice(0, MAX_IMAGES_PER_MESSAGE);
      let images: string[] = [];
      let content: string | ContentPart[] = sanitizeString(trimmed);

      if (imagePaths.length > 0) {
        const encoded = await Promise.all(
          imagePaths.map(async (path) => {
            try {
              const img = await encodeImageFile(path);
              return { path, img };
            } catch (e) {
              setEvents((es) => [
                ...es,
                { kind: "error", key: mkKey(), text: `failed to encode image ${path}: ${(e as Error).message}` },
              ]);
              return null;
            }
          }),
        );
        const valid = encoded.filter((x): x is { path: string; img: EncodedImage } => x !== null);
        if (valid.length > 0) {
          images = valid.map((v) => v.img.filename);
          const parts: ContentPart[] = [
            { type: "text", text: sanitizeString(trimmed) },
            ...valid.map((v) => ({ type: "image_url" as const, image_url: { url: v.img.dataUrl } })),
          ];
          content = parts;
        }
      }

      if (opts?.queuedKeys && opts.queuedKeys.length > 0) {
        const queuedKeys = new Set(opts.queuedKeys);
        setEvents((evts) =>
          evts.map((e) =>
            e.kind === "user" && queuedKeys.has(e.key)
              ? { ...e, images: images.length > 0 ? images : e.images, queued: false }
              : e,
          ),
        );
      } else {
        setEvents((e) => [...e, { kind: "user", key: opts?.eventKey ?? mkKey(), text: display, images: images.length > 0 ? images : undefined }]);
      }

      // LSP nudge: if user references code files and LSP is not configured
      const nudge = maybeLspNudge(display, cfg?.lspEnabled ?? false, cfg?.lspServers ?? {});
      if (nudge) {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: nudge }]);
      }

      // M6.1: classify intent EARLY so the tier is available to the
      // UserPromptSubmit hook payload. Classification is local + cheap
      // (no network). The result is reused below where the turn is
      // actually configured, so this isn't a duplicate cost.
      const classification = classifyIntent(trimmed);

      // UserPromptSubmit hook (veto-able). Fired after we know the
      // prompt resolves to actual user-message content (post slash /
      // custom command expansion). A vetoing hook cancels the turn
      // before any LLM call.
      if (hooksManagerRef.current.hasEnabledHooks("UserPromptSubmit")) {
        const promptOutcome = await hooksManagerRef.current.fire(
          "UserPromptSubmit",
          {
            event: "UserPromptSubmit",
            session_id: sessionIdRef.current,
            cwd: process.cwd(),
            prompt: opts?.userPromptForHooks ?? display,
            tier: classification.tier,
          },
          null,
        );
        if (promptOutcome.vetoed) {
          const reason = promptOutcome.vetoReason || "UserPromptSubmit hook blocked the prompt";
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: `hook blocked the prompt: ${reason}` },
          ]);
          endTurn();
          return;
        }
      }

      messagesRef.current.push({ role: "user", content });
      const traceUserSource: "typed" | "deny_feedback" = denyFeedbackRef.current ? "deny_feedback" : "typed";
      denyFeedbackRef.current = false;

      // Pre-turn save: ensure session exists even if user exits mid-turn
      await saveSessionSafe();

      // Recall artifacts before sending if compiled context is enabled
      if (compiledContextRef.current) {
        const { ids, recalled } = recallArtifacts(messagesRef.current, artifactStoreRef.current, sessionStateRef.current);
        if (recalled.length > 0) {
          const recalledText = formatRecalledArtifacts(recalled);
          messagesRef.current.push({ role: "system", content: recalledText });
          sessionStateRef.current = {
            ...sessionStateRef.current,
            artifact_index: { ...sessionStateRef.current.artifact_index },
          };
        }
      }

      // Occasional gentle nudge about /init (educational, not a warning)
      turnCounterRef.current += 1;
      if (
        turnCounterRef.current % 15 === 0 &&
        ["AGENTS.md", "KIMI.md", "KIMIFLARE.md", "AGENT.md"].some((name) => existsSync(join(process.cwd(), name))) &&
        !kimiMdStale
      ) {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "Tip: Rerunning /init occasionally helps autopilot (formerly kimiflare) stay accurate as your project evolves." },
        ]);
      }

      // Auto-fresh suggestion for long auto/edit sessions
      const autoFreshThreshold = cfg?.autoFreshSuggestionTurns ?? DEFAULT_AUTO_FRESH_SUGGESTION_TURNS;
      if (
        autoFreshThreshold > 0 &&
        turnCounterRef.current >= autoFreshThreshold &&
        (modeRef.current === "auto" || modeRef.current === "edit") &&
        !freshSuggestedRef.current
      ) {
        freshSuggestedRef.current = true;
        if (cfg?.autoFreshEnabled) {
          // Auto-execute /fresh after a silent checkpoint
          void (async () => {
            try {
              const turnIndex = messagesRef.current.length;
              if (turnIndex > 0) {
                const cp: Checkpoint = {
                  id: `cp_prefresh_${Date.now()}`,
                  label: "pre-fresh auto-save",
                  turnIndex,
                  timestamp: new Date().toISOString(),
                  sessionState: compiledContextRef.current ? sessionStateRef.current : undefined,
                  artifactStore: serializeArtifactStore(artifactStoreRef.current),
                };
                ensureSessionId();
                const { sessionsDir } = await import("./sessions.js");
                const filePath = join(sessionsDir(), `${sessionIdRef.current}.json`);
                await addCheckpoint(filePath, cp);
              }
              const summary = await generateContinuationSummary({
                messages: messagesRef.current,
                mode: modeRef.current,
                ...llmAuthFromConfig(cfg),
                model: cfg.plumbingModel ?? DEFAULT_PLUMBING_MODEL,
                memoryManager: memoryManagerRef.current,
                memoryEnabled: cfg.memoryEnabled,
              });
              if (summary) {
                executeFreshStart(buildSlashContext(), summary);
                setEvents((e) => [
                  ...e,
                  { kind: "info", key: mkKey(), text: "Auto-fresh triggered: starting new session with continuation context…" },
                ]);
              }
            } catch (e) {
              setEvents((es) => [
                ...es,
                { kind: "error", key: mkKey(), text: `Auto-fresh failed: ${(e as Error).message}` },
              ]);
            }
          })();
        } else {
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `Session has run for ${turnCounterRef.current} turns. The model may slow down with accumulated context. Run /fresh to continue with a summarized state, or /compact to compress history.`,
            },
          ]);
        }
      }

      responseMetaRef.current = null;
      setResponseMeta(null);

      // Classification already computed above for the UserPromptSubmit
      // hook payload (M6.1). Reuse it here to avoid re-running.
      setIntentTier(classification.tier);

      // Generate a human-readable title on first turn
      if (!sessionTitleRef.current) {
        sessionTitleRef.current = generateSessionTitle(trimmed, classification.intent);
        setTerminalTitle(sessionTitleRef.current);
      }

      const effortForTier: Record<string, ReasoningEffort> = {
        light: "low",
        medium: "medium",
        heavy: "high",
      };
      const turnReasoningEffort = overrideEffort ?? effortForTier[classification.tier] ?? effortRef.current;
      const effectiveCodeMode = classification.tier === "heavy";
      setCodeMode(effectiveCodeMode);

      const turnScope = sessionScopeRef.current.createChild();
      activeScopeRef.current = turnScope;

      // Pre-turn async work (session-start memory recall + skill routing) is
      // performed inside runAgentTurn so it is covered by the supervisor
      // lifecycle and the turn's abort signal.

      const sharedCallbacks = {
        onCompacted: (info: { tokensBefore: number; tokensAfter: number; turnsRemoved: number; artifactsArchived: number }) => {
          setEvents((e) => [
            ...e,
            {
              kind: "info",
              key: mkKey(),
              text: `context budget: compacted ${info.turnsRemoved} older turn${info.turnsRemoved === 1 ? "" : "s"} (${info.tokensBefore} → ${info.tokensAfter} tokens, ${info.artifactsArchived} artifacts archived)`,
            },
          ]);
        },
        onAssistantStart: () => {
          const id = mkAssistantId();
          activeAsstIdRef.current = id;
          beginTurn();
          setTurnPhase("generating");
          setLastActivityAt(Date.now());
          setEvents((e) => [
            ...e,
            { kind: "assistant", key: `asst_${id}`, id, text: "", reasoning: "", streaming: true },
          ]);
        },
        onReasoningDelta: (d: string) => {
          const id = activeAsstIdRef.current;
          if (id !== null) updateAssistant(id, (e) => ({ reasoning: e.reasoning + d }));
          setLastActivityAt(Date.now());
        },
        onTextDelta: (d: string) => {
          const id = activeAsstIdRef.current;
          if (id !== null) updateAssistant(id, (e) => ({ text: e.text + d }));
          setLastActivityAt(Date.now());
        },
        onInfo: (text: string) => {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
        },
        onAssistantFinal: () => {
          const id = activeAsstIdRef.current;
          if (id !== null) updateAssistant(id, () => ({ streaming: false }));
          setTurnPhase("waiting");

          // If no tool calls were finalized, the turn is effectively done.
          // Reset busy immediately so the UI returns to idle without waiting
          // for the supervisor's onDone hook.
          if (pendingToolCallsRef.current.size === 0) {
            endTurn();
          }
        },
        onToolCallFinalized: (call: import("./agent/messages.js").ToolCall) => {
          pendingToolCallsRef.current.set(call.id, call.function.name);
          setTurnPhase("executing");
          setCurrentToolName(call.function.name);
          setLastActivityAt(Date.now());
          const spec = executorRef.current.list().find((t) => t.name === call.function.name);
          let renderMeta: ToolRender | undefined;
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            renderMeta = spec?.render?.(args);
          } catch {
            /* ignore render failure */
          }
          setEvents((e) => [
            ...e,
            {
              kind: "tool",
              key: `tool_${call.id}`,
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
              status: "queued",
              render: renderMeta,
              expanded: false,
            },
          ]);
        },
        onToolWillExecute: (id: string, name: string) => {
          setTurnPhase("executing");
          setCurrentToolName(name);
          setLastActivityAt(Date.now());
          updateTool(id, { status: "running", startedAt: Date.now() });
        },
        onToolResult: (r: import("./tools/executor.js").ToolResult) => {
          pendingToolCallsRef.current.delete(r.tool_call_id);
          setLastActivityAt(Date.now());
          if (pendingToolCallsRef.current.size === 0) {
            setTurnPhase("waiting");
            setCurrentToolName(null);
            // Unblock the UI before onIterationEnd (compaction / memory recall)
            // so the user isn't stuck watching a spinner while housekeeping runs
            // between iterations.
            endTurn();
          }
          updateTool(r.tool_call_id, {
            status: r.guardrail ? "blocked" : !r.ok && typeof r.content === "string" && r.content.startsWith("Permission denied") ? "rejected" : r.ok ? "done" : "error",
            result: r.guardrail ? undefined : r.content,
          });
        },
        onUsage: (u: Usage) => {
          usageRef.current = u;
          setUsage(u);
        },
        onUsageFinal: (u: Usage, meta?: ResponseMeta) => {
          const sid = ensureSessionId();
          void recordUsage(sid, u, costLookupFromConfig(cfg, meta ?? responseMetaRef.current), cfg?.model);
          void getCostReport(sid).then((report) => setSessionUsage(report.session));
        },
        onResponseMeta: updateResponseMeta,
        onTasks: (nextTasks: Task[]) => {
          const prevEmpty = tasksRef.current.length === 0;
          const prevAllDone =
            tasksRef.current.length > 0 &&
            tasksRef.current.every((t) => t.status === "completed");
          tasksRef.current = nextTasks;
          setTasks(nextTasks);
          if ((prevEmpty || prevAllDone) && nextTasks.length > 0) {
            setTasksStartedAt(Date.now());
            setTasksStartTokens(usageRef.current?.prompt_tokens ?? 0);
          }
          if (nextTasks.length === 0) {
            setTasksStartedAt(null);
            setTasksStartTokens(0);
          }
        },
        onPlanOptions: (options: PlanOption[]) => {
          planOptionsRef.current = options;
        },
        askPermission: askForPermission,
        // Sandbox/memory warnings (e.g. Code Mode falling back to the plain
        // node:vm sandbox) were previously dropped on the floor in the TUI.
        onWarning: (msg: string) => {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: msg }]);
        },
        onGuardrail: (ev: GuardrailEvent) => {
          if (ev.kind === "loop_recovery" || ev.kind === "loop_stopped") return;
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: ev.message }]);
        },
        onKimiMdStale: () => {
          if (!kimiMdStaleNudgedRef.current) {
            kimiMdStaleNudgedRef.current = true;
            setKimiMdStale(true);
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "Project context may be stale. Run /init to refresh AGENTS.md based on recent changes." },
            ]);
          }
        },
        onMemoryRecalled: (count: number) => {
          setEvents((e) => [
            ...e,
            { kind: "memory", key: mkKey(), text: `recalled ${count} memory${count === 1 ? "" : "ies"} about this repo` },
          ]);
        },
        onSkillsSelected: (result: SemanticSkillRoutingResult) => {
          setSkillsActive(result.sectionCount);
        },
        onMetaBanner: (info: { intentTier: string; skillsActive: number; memoryRecalled: boolean }) => {
          setEvents((e) => [
            ...e,
            {
              kind: "meta",
              key: mkKey(),
              intentTier: info.intentTier as "light" | "medium" | "heavy",
              skillsActive: info.skillsActive,
              memoryRecalled: info.memoryRecalled,
            },
          ]);
        },
      };

      const cleanupTurn = () => {
        logger.info("cleanupTurn");
        setCodeMode(false);
        const asstId = activeAsstIdRef.current;
        if (asstId !== null) updateAssistant(asstId, () => ({ streaming: false }));
        endTurn();
        setQueueDrainRevision((revision) => revision + 1);
        activeAsstIdRef.current = null;
        activeScopeRef.current = null;
        clearPermissionResolveRef();
        pendingToolCallsRef.current.clear();

        // Clear task list so it doesn't linger into the next turn
        clearTaskTracking();

        // Settle everything the turn left in motion. Unsettled events keep
        // themselves and everything after them in Ink's live tree, and their
        // spinners animate forever, so a turn must never end with any.
        setEvents((evts) =>
          evts.some((e) => (e.kind === "assistant" && e.streaming) || (e.kind === "tool" && (e.status === "running" || e.status === "queued")))
            ? evts.map((e) =>
                e.kind === "tool" && e.status === "running"
                  ? { ...e, status: "error" as const, result: "(stopped)" }
                  : e.kind === "tool" && e.status === "queued"
                    ? { ...e, status: "cancelled" as const }
                    : e.kind === "assistant" && e.streaming
                      ? { ...e, streaming: false }
                      : e,
              )
            : evts,
        );
      };

      // Clear the one-shot session-start recall so it is not reused.
      sessionStartRecallRef.current = null;

      // Last-resort guard against race conditions (e.g. queued messages draining
      // while a slash-command-initiated turn like /compact is still winding down).
      // If the supervisor is already running, undo beginTurn() and bail out.
      if (supervisorRef.current.isRunning) {
        endTurn();
        return;
      }

      const delegationGuidance = await resolveSubagentGuidance({
        prompt: display,
        tier: classification.tier,
        policy: cfg.subagentPolicy ?? "auto",
        apiKey: cfg.openrouterApiKey,
        customEndpoint: Boolean(cfg.baseUrl),
        signal: turnScope.signal,
      });
      if (delegationGuidance.kind !== "none") {
        const probability = delegationGuidance.probability === undefined
          ? ""
          : ` (Jev estimate: ${Math.round(delegationGuidance.probability * 100)}%)`;
        const text = delegationGuidance.kind === "explicit-delegate"
          ? "Subagent policy: respecting your explicit request to delegate. Worker calls still require permission."
          : delegationGuidance.kind === "explicit-sequential"
            ? "Subagent policy: respecting your instruction to work without delegation."
            : delegationGuidance.kind === "auto-delegate"
              ? "Subagent policy: auto will assess this substantial task for independent work; worker calls remain permission-gated."
              : `Subagent suggestion: independent work may help${probability}. No worker will launch without your confirmation.`;
        setEvents((events) => [...events, { kind: "info", key: mkKey(), text }]);
      }

      const turnTools = [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current].filter(
        (tool) => tool.name !== "subagent" || allowsSubagentDispatch(delegationGuidance.kind),
      );
      void recordSubagentEvent({
        kind: "turn",
        ts: Date.now(),
        sessionId: ensureSessionId(),
        offered: turnTools.some((tool) => tool.name === "subagent"),
        guidance: delegationGuidance.kind,
      });

      // Session trace: `session_start` once per session (with the exact tools
      // and system prompt), then this turn's `user_message`.
      const turnId = makeTurnId();
      currentTurnIdRef.current = turnId;
      const trace = await ensureTraceStarted({
        tools: toOpenAIToolDefs(turnTools),
        systemPrompt: messagesRef.current
          .filter((m) => m.role === "system" && typeof m.content === "string")
          .map((m) => m.content as string)
          .join("\n\n"),
        model: overrideModel ?? cfg.model,
        mode: "tui",
        config: cfg,
      });
      if (trace.enabled) {
        // How the user followed up is a signal about the previous turn.
        const previousTurn = turnHistoryRef.current.at(-1);
        if (previousTurn) {
          trace.emit(
            "outcome",
            { kind: "next_message", turn_id: previousTurn.turnId, classification: classifyNextMessage(trimmed), classifier: "regex" },
            previousTurn.turnId,
          );
        }
        trace.emit(
          "user_message",
          {
            content_blob: trace.blob(typeof content === "string" ? content : trimmed) ?? "",
            source: traceUserSource,
            attachments: Array.isArray(content) ? content.filter((p) => p.type !== "text").length : 0,
          },
          turnId,
        );
      }

      supervisorRef.current.startTurn(
        {
          ...llmAuthFromConfig(cfg),
          model: overrideModel ?? cfg.model,
          messages: messagesRef.current,
          tools: turnTools,
          executor: executorRef.current,
          cwd: process.cwd(),
          signal: turnScope.signal,
          reasoningEffort: turnReasoningEffort,
          coauthor:
            cfg.coauthor !== false
              ? { name: cfg.coauthorName || "autopilot", email: cfg.coauthorEmail || "kimiflare@proton.me" }
              : undefined,
          sessionId: ensureSessionId(),
          memoryManager: memoryManagerRef.current,
          hooks: hooksManagerRef.current,
          githubToken: cfg.githubOAuthToken,
          keepLastImageTurns: cfg.imageHistoryTurns ?? 2,
          // Unattended-friendly: reset the per-cycle counter automatically,
          // bounded by the hard ceiling (never pause for a modal).
          toolLimitBehavior: "continue",
          maxTotalToolIterations: cfg.maxTotalToolIterations,
          codeMode: effectiveCodeMode,
          allowDirectPush: cfg.allowDirectPush,
          preferPullRequests: cfg.preferPullRequests,
          onIterationEnd,
          drainPendingInput: () =>
            pendingSteersRef.current.splice(0).map((steer) => ({ role: "user" as const, content: steer.content })),
          // Request preflight archives older turns here when the next request
          // would not fit the model's input budget.
          compaction: {
            getState: () => sessionStateRef.current,
            setState: (state) => {
              sessionStateRef.current = state;
            },
            getStore: () => artifactStoreRef.current,
          },
          intentClassification: classification,
          delegationDirective: delegationGuidance.refinedDirective ?? delegationGuidance.directive,
          completionCheck: completionCheckFromConfig(cfg),
          sessionStartRecall: sessionStartRecallRef.current ?? undefined,
          skillsDb: getMemoryDb() ?? undefined,
          skillRoutingConfig: {
            embeddingModel: cfg.memoryEmbeddingModel,
            maxSkillTokens: modelContextLimit - 10_000,
          },
          mode: modeRef.current,
          cacheStable: cacheStableRef.current,
          trace,
          turnId,
          onFileChange: (path, content) => {
            if (content) {
              lspManagerRef.current.notifyChange(path, content);
            } else {
              void import("node:fs/promises").then(({ readFile }) =>
                readFile(path, "utf8")
                  .then((c) => lspManagerRef.current.notifyChange(path, c))
                  .catch(() => {}),
              );
            }
          },
          callbacks: sharedCallbacks,
        },
        {
          onDone: () => {
            noteTurnEnded(turnId);
            // Fire-and-forget all post-turn housekeeping so the UI returns to
            // idle immediately and the user can type the next message without
            // waiting for compaction, memory recall, or session persistence.
            void (async () => {
              await saveSessionSafe();

              // If the turn was killed (preempted or aborted), skip expensive
              // post-turn work so the next turn can start immediately.
              if (turnScope.signal.aborted) {
                return;
              }

              // Auto-compact after turn when thresholds are met. With compiled
              // context on, use the heuristic compactor; otherwise fall back to the
              // LLM summarizer so users have a safety net regardless of the flag.
              let didCompact = false;
              if (shouldCompact({ messages: messagesRef.current, tokenThreshold: proactiveCompactionThreshold(overrideModel ?? cfg.model) })) {
                // M6.1: same PreCompact fire as the mid-turn site above.
                if (hooksManagerRef.current.hasEnabledHooks("PreCompact")) {
                  void hooksManagerRef.current
                    .fire(
                      "PreCompact",
                      {
                        event: "PreCompact",
                        session_id: sessionIdRef.current,
                        cwd: process.cwd(),
                      },
                      null,
                    )
                    .catch(() => {});
                }
                if (compiledContextRef.current) {
                  const store = artifactStoreRef.current;
                  const result = compactMessagesViaArtifacts({
                    messages: messagesRef.current,
                    state: sessionStateRef.current,
                    store,
                  });
                  if (result.metrics.rawTurnsRemoved > 0) {
                    traceCompiledCompaction(traceRef.current, result, turnId);
                    messagesRef.current = result.newMessages;
                    sessionStateRef.current = result.newState;
                    setEvents((e) => [
                      ...e,
                      {
                        kind: "info",
                        key: mkKey(),
                        text: `auto-compacted: ${result.metrics.estimatedTokensBefore} → ${result.metrics.estimatedTokensAfter} tokens (${result.metrics.archivedArtifacts} artifacts)`,
                      },
                    ]);
                    await saveSessionSafe();
                    didCompact = true;
                  }
                } else {
                  try {
                    const before = messagesRef.current;
                    const result = await summarizeMessagesViaLlm({
                      ...llmAuthFromConfig(cfg),
                      model: cfg.model,
                      messages: messagesRef.current,
                      signal: turnScope.signal,
                    });
                    if (result.replacedCount > 0) {
                      traceLlmCompaction(traceRef.current, before, result, turnId);
                      messagesRef.current = result.newMessages;
                      setEvents((e) => [
                        ...e,
                        {
                          kind: "info",
                          key: mkKey(),
                          text: `auto-compacted: ${result.replacedCount} messages summarized`,
                        },
                      ]);
                      await saveSessionSafe();
                      didCompact = true;
                    }
                  } catch (compactErr) {
                    if ((compactErr as Error).name !== "AbortError") {
                      setEvents((es) => [
                        ...es,
                        {
                          kind: "info",
                          key: mkKey(),
                          text: `auto-compact failed: ${(compactErr as Error).message ?? String(compactErr)}`,
                        },
                      ]);
                    }
                  }
                }

                // After compaction, recall memories so the model retains durable anchors.
                // Only surface the recall event when compaction actually happened —
                // otherwise the message is noise on turns that merely crossed the
                // threshold without removing anything.
                if (didCompact) {
                  const manager = memoryManagerRef.current;
                  if (manager) {
                    try {
                      const cwd = process.cwd();
                      const queryText = sessionStateRef.current.task || cwd;
                      const results = await manager.recall({ text: queryText, repoPath: cwd, limit: 5 });
                      if (results.length > 0) {
                        const text = await manager.synthesizeRecalled(results);
                        if (injectRecalledMemoryOnce(messagesRef.current, text)) {
                          setEvents((e) => [
                            ...e,
                            {
                              kind: "memory",
                              key: mkKey(),
                              text: `recalled ${results.length} memory${results.length === 1 ? "" : "ies"} after compaction`,
                            },
                          ]);
                          await saveSessionSafe();
                        }
                      }
                    } catch {
                      // Non-fatal
                    }
                  }
                }
              }

              // Token-based hybrid compaction + fresh start (Option C).
              // When the in-memory message array grows very large (e.g. massive
              // file reads or long sessions), the standard 80k/12-turn
              // compaction may not be enough. We run an aggressive compaction
              // at a higher token threshold, and if that still leaves us above
              // the fresh-start threshold we nuke the session with /fresh.
              const autoCompactTokenThreshold = cfg?.autoCompactTokenThreshold ?? 500_000;
              const autoFreshTokenThreshold = cfg?.autoFreshTokenThreshold ?? 2_000_000;
              const estimatedTokens = estimatePromptTokens(messagesRef.current);
              if (estimatedTokens > autoCompactTokenThreshold) {
                let didAggressiveCompact = false;
                if (compiledContextRef.current) {
                  const store = artifactStoreRef.current;
                  const result = compactMessagesViaArtifacts({
                    messages: messagesRef.current,
                    state: sessionStateRef.current,
                    store,
                    keepLastTurns: 1,
                  });
                  if (result.metrics.rawTurnsRemoved > 0) {
                    traceCompiledCompaction(traceRef.current, result, turnId);
                    messagesRef.current = result.newMessages;
                    sessionStateRef.current = result.newState;
                    setEvents((e) => [
                      ...e,
                      {
                        kind: "info",
                        key: mkKey(),
                        text: `auto-compacted (aggressive): ${result.metrics.estimatedTokensBefore.toLocaleString()} → ${result.metrics.estimatedTokensAfter.toLocaleString()} tokens (${result.metrics.archivedArtifacts} artifacts)`,
                      },
                    ]);
                    await saveSessionSafe();
                    didAggressiveCompact = true;
                  }
                } else {
                  try {
                    const before = messagesRef.current;
                    const result = await summarizeMessagesViaLlm({
                      ...llmAuthFromConfig(cfg),
                      model: cfg.model,
                      messages: messagesRef.current,
                      keepLastTurns: 1,
                      signal: turnScope.signal,
                    });
                    if (result.replacedCount > 0) {
                      traceLlmCompaction(traceRef.current, before, result, turnId);
                      messagesRef.current = result.newMessages;
                      setEvents((e) => [
                        ...e,
                        {
                          kind: "info",
                          key: mkKey(),
                          text: `auto-compacted (aggressive): ${result.replacedCount} messages summarized`,
                        },
                      ]);
                      await saveSessionSafe();
                      didAggressiveCompact = true;
                    }
                  } catch (compactErr) {
                    if ((compactErr as Error).name !== "AbortError") {
                      setEvents((es) => [
                        ...es,
                        {
                          kind: "info",
                          key: mkKey(),
                          text: `aggressive auto-compact failed: ${(compactErr as Error).message ?? String(compactErr)}`,
                        },
                      ]);
                    }
                  }
                }

                const tokensAfterCompact = estimatePromptTokens(messagesRef.current);
                if (tokensAfterCompact > autoFreshTokenThreshold) {
                  try {
                    const turnIndex = messagesRef.current.length;
                    if (turnIndex > 0) {
                      const cp: Checkpoint = {
                        id: `cp_prefresh_${Date.now()}`,
                        label: "pre-fresh auto-save",
                        turnIndex,
                        timestamp: new Date().toISOString(),
                        sessionState: compiledContextRef.current ? sessionStateRef.current : undefined,
                        artifactStore: serializeArtifactStore(artifactStoreRef.current),
                      };
                      ensureSessionId();
                      const { sessionsDir } = await import("./sessions.js");
                      const filePath = join(sessionsDir(), `${sessionIdRef.current}.json`);
                      await addCheckpoint(filePath, cp);
                    }
                    const summary = await generateContinuationSummary({
                      messages: messagesRef.current,
                      mode: modeRef.current,
                      ...llmAuthFromConfig(cfg),
                      model: cfg.plumbingModel ?? DEFAULT_PLUMBING_MODEL,
                      memoryManager: memoryManagerRef.current,
                      memoryEnabled: cfg.memoryEnabled,
                    });
                    if (summary) {
                      executeFreshStart(buildSlashContext(), summary);
                      setEvents((e) => [
                        ...e,
                        {
                          kind: "info",
                          key: mkKey(),
                          text: `Auto-fresh triggered at ~${tokensAfterCompact.toLocaleString()} tokens: starting new session with continuation context…`,
                        },
                      ]);
                    }
                  } catch (e) {
                    setEvents((es) => [
                      ...es,
                      { kind: "error", key: mkKey(), text: `Auto-fresh failed: ${(e as Error).message}` },
                    ]);
                  }
                }
              }
            })();

            cleanupTurn();

            // If the turn completed in plan mode and produced a substantive plan,
            // prompt the user to choose the next step (auto, edit, or continue).
            if (modeRef.current === "plan") {
              const plan = distillSessionPlan(messagesRef.current);
              if (plan) {
                sessionPlanRef.current = plan;
                // Durable backup: store the plan under a deterministic topic key
                // so it survives /clear, executeFreshStart, or ref resets.
                if (cfg?.memoryEnabled && memoryManagerRef.current && sessionIdRef.current) {
                  void memoryManagerRef.current.rememberPlan(plan, process.cwd(), sessionIdRef.current).catch(() => {
                    // Non-fatal: the in-session ref is the primary fast path.
                  });
                }
                // When the model presented explicit plan options, the option
                // pick chains into this picker with the chosen plan instead.
                if (!planOptionsRef.current) {
                  planCompletePlanRef.current = plan;
                  setShowPlanCompletePicker(true);
                }
              }
            }

            if (planOptionsRef.current) {
              setPlanOptions(planOptionsRef.current);
            }
          },
          onError: async (e) => {
            noteTurnEnded(turnId);
            if (e.name === "AbortError") {
              // Inject synthetic tool results for any pending tool calls so message
              // history remains valid (assistant msg with tool_calls needs 1:1 results).
              // Idempotent: the interrupt handler may already have done this.
              appendStoppedToolResults(messagesRef.current, pendingToolCallsRef.current);
              setEvents((evts) =>
                evts.map((e) => (e.kind === "tool" && e.status === "running" ? { ...e, status: "error" as const, result: "(stopped)" } : e)),
              );
            } else if (
              e instanceof KimiApiError &&
              (e.httpStatus === 429 || (e.httpStatus !== undefined && e.httpStatus >= 500))
            ) {
              const err = { httpStatus: e.httpStatus, code: e.code, message: humanizeApiError(e) };
              lastApiErrorRef.current = err;
              setEvents((es) => [
                ...es,
                { kind: "api_error", key: mkKey(), ...err },
              ]);
            } else {
              const displayText =
                e instanceof KimiApiError
                  ? humanizeApiError(e)
                  : e.message ?? String(e);
              setEvents((es) => [
                ...es,
                { kind: "error", key: mkKey(), text: displayText },
              ]);
            }
            cleanupTurn();
          },
        },
      );
    },
    [cfg, handleSlash, updateAssistant, updateTool, saveSessionSafe, updateResponseMeta, setShowPlanCompletePicker, runUserShellCommand, ensureTraceStarted],
  );

  useEffect(() => {
    if (canDrainQueue({
      busy,
      queuePlanOpen: queuePlanDraft !== null,
      supervisorIdle: supervisorRef.current.phase === "idle",
      hasPendingWork: pendingPromptEditRef.current !== null || pendingSteersRef.current.length > 0 || queue.length > 0,
    })) {
      const pendingEdit = pendingPromptEditRef.current;
      if (pendingEdit) {
        pendingPromptEditRef.current = null;
        messagesRef.current = [...pendingEdit.messagesBefore];
        setEvents((events) => replaceUserPromptEvent(events, pendingEdit.key, pendingEdit.display, true));
        processMessage(pendingEdit.full, pendingEdit.display, {
          queuedKeys: [pendingEdit.key],
          historyText: pendingEdit.display,
        });
        return;
      }

      // Steers the turn never picked up (it was interrupted or failed) run
      // next as normal prompts instead of being lost.
      if (pendingSteersRef.current.length > 0) {
        const leftovers = pendingSteersRef.current.splice(0).map(({ key, full, display }) => ({ key, full, display }));
        setQueue((q) => [...leftovers, ...q]);
        return;
      }

      if (queue.length > 0) {
        const next = queue[0]!;
        setQueue((q) => q.slice(1));
        processMessage(next.full, next.display, {
          queuedKeys: next.sourceKeys ?? [next.key],
          ...(next.batchPrompts ? { userPromptForHooks: next.batchPrompts.join("\n\n") } : {}),
        });
      }
    }
  }, [busy, queue, queuePlanDraft, processMessage, queueDrainRevision]);

  const handleQueuePlanPick = useCallback(
    (choice: "group" | "separate" | null) => {
      if (choice === "group" && queuePlanDraft) {
        const batch = createQueueBatch(queuePlanDraft);
        if (batch) {
          setQueue([batch]);
          setEvents((events) => [
            ...events,
            { kind: "info", key: mkKey(), text: `${batch.sourceKeys?.length ?? queuePlanDraft.length} queued follow-ups grouped into one coordinated turn.` },
          ]);
        }
      }
      setQueuePlanDraft(null);
    },
    [queuePlanDraft],
  );

  const submit = useCallback(
    (full: string, display?: string) => {
      const trimmedFull = full.trim();
      if (!trimmedFull) return;
      const trimmedDisplay = (display ?? full).trim() || trimmedFull;

      if (/^\/queue\s+plan$/i.test(trimmedFull)) {
        const historyEntry = trimmedDisplay;
        setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
        setInput("");
        setHistoryIndex(-1);
        if (queue.length < 2) {
          setEvents((events) => [...events, { kind: "info", key: mkKey(), text: "Queue planning needs at least two queued chat prompts." }]);
        } else if (!createQueueBatch(queue)) {
          setEvents((events) => [...events, { kind: "info", key: mkKey(), text: "Queue planning only groups chat prompts; slash commands and ! shell commands stay in the FIFO queue." }]);
        } else {
          setQueuePlanDraft([...queue]);
        }
        return;
      }

      const historyEntry = trimmedDisplay;
      const editTarget = latestPromptRef.current;
      const selectedHistoryEntry = history[historyIndex];
      const isEditedLatestPrompt =
        historyIndex === history.length - 1 &&
        editTarget !== null &&
        events.some((event) => event.kind === "user" && event.key === editTarget.key) &&
        selectedHistoryEntry === editTarget.historyText;

      if (isEditedLatestPrompt && editTarget) {
        if (trimmedDisplay === selectedHistoryEntry) {
          setInput("");
          setHistoryIndex(-1);
          return;
        }
        const updatedQueue = replaceQueuedPrompt(queue, editTarget.key, trimmedFull, trimmedDisplay);
        if (updatedQueue || editTarget.messagesBefore) {
          setHistory((items) =>
            items.length > 0 && items[items.length - 1] === editTarget.historyText
              ? [...items.slice(0, -1), trimmedDisplay]
              : items,
          );
          setInput("");
          setHistoryIndex(-1);
          latestPromptRef.current = { ...editTarget, historyText: trimmedDisplay };
          setEvents((events) => replaceUserPromptEvent(events, editTarget.key, trimmedDisplay));

          if (updatedQueue) {
            setQueue(updatedQueue);
            return;
          }

          const edit: PendingPromptEdit = {
            key: editTarget.key,
            full: trimmedFull,
            display: trimmedDisplay,
            messagesBefore: editTarget.messagesBefore!,
          };
          if (busyRef.current || supervisorRef.current.isRunning) {
            pendingPromptEditRef.current = edit;
            runInterruptTurn(interruptDepsRef.current!);
          } else {
            messagesRef.current = [...edit.messagesBefore];
            setEvents((events) => replaceUserPromptEvent(events, edit.key, edit.display, true));
            processMessage(edit.full, edit.display, {
              queuedKeys: [edit.key],
              historyText: edit.display,
            });
          }
          return;
        }
      }

      if (isRunNowCommand(trimmedFull)) {
        setInput("");
        setHistoryIndex(-1);
        const promoted = promoteQueuedRef.current?.() ?? false;
        if (!promoted) {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: busyRef.current || supervisorRef.current.isRunning ? "nothing queued to run now" : "nothing is running — queued messages run next anyway" }]);
        }
        return;
      }

      // Subagent management must work mid-turn: workers only run while a turn
      // is busy, so queueing these commands would make them useless.
      if ((busyRef.current || supervisorRef.current.isRunning) && isImmediateSubagentCommand(trimmedFull)) {
        setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
        setInput("");
        setHistoryIndex(-1);
        void handleSlash(trimmedFull);
        return;
      }

      if (busyRef.current || supervisorRef.current.isRunning) {
        const key = mkKey();
        const isChatPrompt = !trimmedFull.startsWith("/") && parseBangCommand(trimmedFull) === null;
        setEvents((e) => [...e, { kind: "user", key, text: trimmedDisplay, queued: true }]);
        // Queue first so order is preserved and "unsure" already means queued;
        // triage then decides whether to pull it out to steer, interrupt, or
        // answer as an aside (#725).
        const queued: QueuedPrompt = {
          full: trimmedFull,
          display: trimmedDisplay,
          key,
          ...(isChatPrompt ? { triage: { source: "pending" as const, reason: "deciding…" } } : {}),
        };
        queueRef.current = [...queueRef.current, queued];
        setQueue((q) => [...q, queued]);
        if (isChatPrompt) {
          latestPromptRef.current = { key, historyText: historyEntry, messagesBefore: null };
          void triageQueuedRef.current?.(queued);
        }
        setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
        setInput("");
        setHistoryIndex(-1);
        return;
      }

      setHistory((h) => (h.length > 0 && h[h.length - 1] === historyEntry ? h : [...h, historyEntry]));
      setInput("");
      setHistoryIndex(-1);
      const key = mkKey();
      processMessage(trimmedFull, trimmedDisplay !== trimmedFull ? trimmedDisplay : undefined, {
        eventKey: key,
        historyText: historyEntry,
      });
    },
    [processMessage, handleSlash, queue, history, historyIndex, events],
  );
  submitRef.current = submit;

  // Subagents are shown in the compact live region trail; no need for inline notices.
  // useEffect(() => {
  //   if (!bridge) return;
  //   const seen = announcedSubagentsRef.current;
  //   const fresh = runningSubagents.filter((w) => !seen.has(w.id));
  //   if (fresh.length === 0) return;
  //   for (const w of fresh) seen.add(w.id);
  //   setEvents((evts) => [
  //     ...evts,
  //     ...fresh.map((w) => ({
  //       kind: "info" as const,
  //       key: mkKey(),
  //       text: `subagent #${w.index} started: ${w.task.replace(/\s+/g, " ").slice(0, 100)} · /agents to view or stop`,
  //     })),
  //   ]);
  // }, [bridge, runningSubagents]);

  // --- Mid-turn triage (#725) -------------------------------------------
  // Messages sent while the agent works are queued first; triage may then
  // pull them out to steer the current turn, interrupt it, or answer as an
  // aside. Unsure → stays queued, and Ctrl+G promotes it.
  const textOf = (m: ChatMessage | undefined): string =>
    !m ? "" : typeof m.content === "string" ? m.content : Array.isArray(m.content)
      ? m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join(" ")
      : "";
  const describeActivity = (): { currentTask: string; activity?: string; progress?: string; recentAssistantText?: string } => {
    const msgs = messagesRef.current;
    const currentTask = textOf([...msgs].reverse().find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith("[Message from the user") && !m.content.startsWith("[The user asked to handle")));
    const recentAssistantText = textOf([...msgs].reverse().find((m) => m.role === "assistant" && textOf(m).length > 0));
    const inProgress = tasksRef.current.find((t) => t.status === "in_progress");
    const done = tasksRef.current.filter((t) => t.status === "completed").length;
    const progress = tasksRef.current.length > 0
      ? `${done}/${tasksRef.current.length} tasks done${inProgress ? `; working on: ${inProgress.title}` : ""}`
      : undefined;
    const tools = [...pendingToolCallsRef.current.values()];
    const workers = workerRegistry.list();
    const activity = [
      tools.length ? `tools: ${tools.join(", ")}` : "",
      workers.length ? `${workers.length} subagent(s): ${workers.map((w) => w.task.slice(0, 60)).join("; ")}` : "",
    ].filter(Boolean).join(" · ") || undefined;
    return { currentTask, activity, progress, recentAssistantText };
  };
  const removeQueued = (key: string): QueuedPrompt | null => {
    const item = queueRef.current.find((q) => q.key === key) ?? null;
    if (!item) return null;
    queueRef.current = queueRef.current.filter((q) => q.key !== key);
    setQueue((q) => q.filter((i) => i.key !== key));
    return item;
  };
  const markDelivered = (key: string, note: string) => {
    setEvents((evts) => [
      ...evts.map((e) => (e.kind === "user" && e.key === key ? { ...e, queued: false } : e)),
      { kind: "info", key: mkKey(), text: note },
    ]);
  };
  const applyTriage = (item: QueuedPrompt, result: TriageResult, promoted = false): void => {
    const action = planTriageAction(result, {
      busy: busyRef.current || supervisorRef.current.isRunning,
      subagentsRunning: workerRegistry.list().length > 0,
      promoted,
    });
    switch (action.do) {
      case "keep-queued":
        if (action.note) {
          setQueue((q) => q.map((i) => (i.key === item.key ? { ...i, triage: { source: result.source, reason: result.reason } } : i)));
          // Camouflage has no inline queue line; say it in the transcript.
          if (bridge) {
            setEvents((evts) => [...evts, { kind: "info", key: mkKey(), text: `${action.note} — runs after the current turn · /now to run it first` }]);
          }
        }
        return;
      case "aside": {
        if (!cfg) return;
        void answerAside(item.full, describeActivity(), { ...llmAuthFromConfig(cfg), model: cfg.plumbingModel ?? cfg.model })
          .then((answer) => {
            if (!removeQueued(item.key)) return; // already ran as a normal turn
            markDelivered(item.key, `aside (the agent keeps working): ${answer}`);
          })
          .catch(() => {
            setQueue((q) => q.map((i) => (i.key === item.key ? { ...i, triage: { source: "default", reason: "couldn't answer as an aside" } } : i)));
          });
        return;
      }
      case "interrupt": {
        if (!removeQueued(item.key)) return;
        // Run it next, ahead of anything else queued; completed tool results are kept.
        const front: QueuedPrompt = { ...item, triage: undefined };
        queueRef.current = [front, ...queueRef.current];
        setQueue((q) => [front, ...q]);
        setEvents((evts) => [...evts, { kind: "info", key: mkKey(), text: action.note }]);
        runInterruptTurn(interruptDepsRef.current!);
        return;
      }
      case "steer":
        if (!removeQueued(item.key)) return;
        pendingSteersRef.current.push({ key: item.key, full: item.full, display: item.display, content: steerMessage(item.full, action.urgent) });
        markDelivered(item.key, action.note);
        return;
    }
  };
  triageQueuedRef.current = async (item: QueuedPrompt) => {
    const result = await triageIncoming(item.full, describeActivity(), {
      apiKey: cfg?.openrouterApiKey,
      customEndpoint: Boolean(cfg?.baseUrl),
    });
    if (!queueRef.current.some((q) => q.key === item.key)) return; // promoted or already ran
    applyTriage(item, result);
  };
  promoteQueuedRef.current = () => {
    if (!(busyRef.current || supervisorRef.current.isRunning)) return false;
    const latest = [...queueRef.current].reverse().find((q) => q.triage !== undefined);
    if (!latest) return false;
    applyTriage(latest, { kind: "steer", source: "rule", reason: "you asked to run it now" }, true);
    return true;
  };

  useEffect(() => {
    if (usage && usage.prompt_tokens / modelContextLimit < AUTO_COMPACT_THRESHOLD * 0.7) {
      compactSuggestedRef.current = false;
    }
    if (compactSuggestedRef.current) return;
    if (busy) return;
    if (!usage || usage.prompt_tokens / modelContextLimit < AUTO_COMPACT_THRESHOLD) return;
    compactSuggestedRef.current = true;
    const pct = Math.round((usage.prompt_tokens / modelContextLimit) * 100);
    setEvents((e) => [
      ...e,
      {
        kind: "info",
        key: mkKey(),
        text: `context ${pct}% full — auto-compacting older turns`,
      },
    ]);
    void runCompact().catch((err) => {
      setEvents((e) => [
        ...e,
        {
          kind: "error",
          key: mkKey(),
          text: `auto-compact failed: ${(err as Error).message} — run /compact manually`,
        },
      ]);
    });
  }, [usage, modelContextLimit, busy, runCompact]);

  function handleChangelogImageGenerate(owner: string, repo: string, days: number) {
          setShowChangelogImagePicker(false);
          const asstId = mkAssistantId();
          setEvents((e) => [
            ...e,
            {
              kind: "assistant",
              key: `asst_${asstId}`,
              id: asstId,
              text: `Generating changelog image for ${owner}/${repo} (last ${days} day${days === 1 ? "" : "s"})…`,
              reasoning: "",
              streaming: true,
            },
          ]);

          const taskList: import("./tools/registry.js").Task[] = [
            { id: "fetch-prs", title: "Fetch merged PRs", status: "pending" },
            { id: "fetch-release", title: "Fetch latest release", status: "pending" },
            { id: "summarize", title: "Summarize with LLM", status: "pending" },
            { id: "render", title: "Render changelog image", status: "pending" },
            { id: "save", title: "Save PNG file", status: "pending" },
          ];
          turn.setTasks(taskList);
          turn.setTasksStartedAt(Date.now());

          const updateTask = (id: string, status: import("./tools/registry.js").Task["status"]) => {
            turn.setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
          };

          setTimeout(() => {
            void (async () => {
              try {
                updateTask("fetch-prs", "in_progress");
                updateTask("fetch-release", "in_progress");
                const { changelogImageTool } = await import("./tools/changelog-image.js");
                const result = await changelogImageTool.run({ owner, repo, days }, {
                  cwd: process.cwd(),
                  githubToken: cfg?.githubOAuthToken,
                  llmAuth: llmAuthFromConfig(cfg),
                  model: cfg?.model,
                });
                updateTask("fetch-prs", "completed");
                updateTask("fetch-release", "completed");
                updateTask("summarize", "completed");
                updateTask("render", "completed");
                updateTask("save", "completed");

                const text = typeof result === "string" ? result : result.content;
                setEvents((e) =>
                  e.map((ev) =>
                    ev.kind === "assistant" && ev.id === asstId
                      ? { ...ev, text, streaming: false }
                      : ev,
                  ),
                );
              } catch (err) {
                const msg = `changelog-image failed: ${err instanceof Error ? err.message : String(err)}`;
                setEvents((e) =>
                  e.map((ev) =>
                    ev.kind === "assistant" && ev.id === asstId
                      ? { ...ev, text: msg, streaming: false }
                      : ev,
                  ),
                );
              } finally {
                turn.setTasksStartedAt(null);
              }
            })();
          }, 0);
  }

  function configuredHooks(): { event: HookEvent; hook: HookConfig }[] {
    const out: { event: HookEvent; hook: HookConfig }[] = [];
    for (const ev of ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "PreCompact"] as const) {
      for (const h of hooksManagerRef.current.hooksFor(ev)) out.push({ event: ev, hook: h });
    }
    return out;
  }

  function handlePlanOptionPick(option: PlanOption | null) {
              setPlanOptions(null);
              planOptionsRef.current = null;
              if (option) {
                // Defer the fresh start to the plan-complete picker so the
                // user picks an execution mode first and the session is only
                // reset once, right before the plan is submitted.
                sessionPlanRef.current = option.plan;
                if (cfg?.memoryEnabled && memoryManagerRef.current && sessionIdRef.current) {
                  void memoryManagerRef.current.rememberPlan(option.plan, process.cwd(), sessionIdRef.current).catch(() => {
                    // Non-fatal: the in-session ref is the primary fast path.
                  });
                }
                planCompletePlanRef.current = option.plan;
                setShowPlanCompletePicker(true);
                setEvents((e) => [
                  ...e,
                  {
                    kind: "info",
                    key: mkKey(),
                    text: `Selected plan "${option.label}" — choose how to execute.`,
                  },
                ]);
              }
  }

  // ── Alternative view (Camouflage) ─────────────────────────────────────
  // Report what's on screen after every render, and keep the view's
  // actions pointing at this render's handlers.
  useEffect(() => {
    if (!bridge) return;
    const open: AppModal[] = [];
    if (modals.showModelPicker) open.push("model");
    if (modals.showModePicker) open.push("mode");
    if (modals.showThemePicker) open.push("theme");
    if (modals.showUiPicker) open.push("ui");
    if (modals.showHelpMenu) open.push("help");
    if (modals.showMemoryPicker) open.push("memory");
    if (modals.showSkillsPicker) open.push("skills");
    if (modals.showShellPicker) open.push("shell");
    if (modals.showPlanCompletePicker) open.push("planComplete");
    if (modals.showCommandList) open.push("commandList");
    if (modals.commandWizard) open.push("commandWizard");
    if (modals.commandPicker) open.push("commandPicker");
    if (modals.showLspWizard) open.push("lspWizard");
    if (modals.showRemoteDashboard) open.push("remoteDashboard");
    if (modals.showInboxModal) open.push("inbox");
    if (modals.showHooksDashboard) open.push("hooksDashboard");
    if (modals.showChangelogImagePicker) open.push("changelogImage");
    bridge.connect({
      submit: (text) => submitRef.current(text),
      interrupt: () => {
        if (busyRef.current || supervisorRef.current.isRunning) runInterruptTurn(interruptDepsRef.current!);
      },
      cycleMode: () => {
        if (modesEnabled) setMode((m) => nextMode(m));
      },
      decidePermission,
      pickModel: handleModelPick,
      pickMode: (m) => {
        setShowModePicker(false);
        if (m) {
          setMode(m);
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `mode: ${m}` }]);
        }
      },
      pickResume: handleResumePick,
      pickCheckpoint: handleCheckpointPick,
      pickPlanOption: handlePlanOptionPick,
      pickPlanComplete: handlePlanCompletePick,
      closeModal: (m) => {
        const close: Record<AppModal, () => void> = {
          model: () => setShowModelPicker(false),
          mode: () => setShowModePicker(false),
          theme: () => modals.setShowThemePicker(false),
          ui: () => modals.setShowUiPicker(false),
          help: () => modals.setShowHelpMenu(false),
          memory: () => modals.setShowMemoryPicker(false),
          skills: () => modals.setShowSkillsPicker(false),
          shell: () => modals.setShowShellPicker(false),
          planComplete: () => handlePlanCompletePick(null),
          commandList: () => modals.setShowCommandList(false),
          commandWizard: () => modals.setCommandWizard(null),
          commandPicker: () => modals.setCommandPicker(null),
          lspWizard: () => modals.setShowLspWizard(false),
          remoteDashboard: () => modals.setShowRemoteDashboard(false),
          inbox: () => modals.setShowInboxModal(false),
          hooksDashboard: () => modals.setShowHooksDashboard(false),
          changelogImage: () => modals.setShowChangelogImagePicker(false),
        };
        close[m]();
      },
      runCommand: (cmd) => {
        void handleSlash(cmd);
      },
      pickTheme: (name) => handleThemePick(themeList().find((t) => t.name === name) ?? null),
      pickShell: (shell) => {
        if (shell && cfg) {
          const next = { ...cfg, shell: shell === "auto" ? undefined : shell };
          setCfg(next);
          void saveConfig(next).catch(() => {});
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `shell set to ${shell}` }]);
        }
        modals.setShowShellPicker(false);
      },
      generateChangelogImage: handleChangelogImageGenerate,
      reloadHooks: () => {
        hooksManagerRef.current.reload();
        return configuredHooks();
      },
      saveLsp: (servers, enabled, scope) => void handleLspSave(servers, enabled, scope),
      openCommandWizard: (wizardMode, name) => {
        const initial = name ? customCommandsRef.current.find((c) => c.name === name) : undefined;
        modals.setCommandPicker(null);
        modals.setCommandWizard({ mode: wizardMode, initial });
      },
      saveCommand: (opts) => {
        void handleCommandSave(opts);
      },
      deleteCommand: (name) => {
        const cmd = customCommandsRef.current.find((c) => c.name === name);
        modals.setCommandPicker(null);
        if (cmd) void handleCommandDelete(cmd);
      },
      exit,
    });
    bridge.sync({
      events,
      busy,
      workers: runningSubagents,
      mode,
      model: cfg?.model ?? "",
      usage,
      sessionUsage,
      tasks,
      permission: perm ? { tool: perm.tool, args: perm.args } : null,
      modals: open,
      resumeSessions,
      checkpoints: checkpointSession ? { session: checkpointSession, list: checkpointList } : null,
      planOptions,
      customCommands: customCommandsRef.current.map((c) => ({ name: c.name, description: c.description })),
      themes: themeList().map((t) => ({ name: t.name, label: t.label })),
      currentTheme: cfg?.theme ?? DEFAULT_THEME_NAME,
      currentShell: cfg?.shell ?? "auto",
      memoryEnabled: !!cfg?.memoryEnabled,
      customCommandDefs: customCommandsRef.current,
      commandWizard: modals.commandWizard,
      commandPickerMode: modals.commandPicker?.mode ?? null,
      changelogImageRepo,
      modesEnabled,
      hooks: configuredHooks(),
      lsp: {
        servers: cfg?.lspServers ?? {},
        scope: lspScope,
        hasProjectDir: existsSync(join(process.cwd(), ".kimiflare")),
      },
    });
  });

  if (bridge) return null;

  if (!cfg) {
    return (
      <ThemeProvider theme={theme}>
        <Onboarding
          onCancel={() => exit()}
          onDone={async (newCfg) => {
            setCfg(newCfg);
            setEvents((e) => [
              ...e,
              { kind: "info", key: mkKey(), text: "configuration saved — welcome to autopilot (formerly kimiflare)!" },
            ]);
          }}
        />
      </ThemeProvider>
    );
  }

  if (planOptions !== null) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <PlanOptionsPicker
            options={planOptions}
            onPick={handlePlanOptionPick}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (checkpointSession !== null) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <CheckpointPicker
            session={checkpointSession}
            checkpoints={checkpointList}
            onPick={handleCheckpointPick}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (resumeSessions !== null) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ResumePicker sessions={resumeSessions} onPick={handleResumePick} />
        </Box>
      </ThemeProvider>
    );
  }

  if (resuming) {
    return (
      <ThemeProvider theme={theme}>
        <ResumeProgress progress={resumeProgress} stage={resumeStage} theme={theme} />
      </ThemeProvider>
    );
  }

  if (hasFullscreenModal) {
    return (
      <ModalHost
        modals={modals}
        theme={theme}
        customCommands={customCommandsRef.current}
        builtinNames={BUILTIN_COMMAND_NAMES}
        onCommandSave={handleCommandSave}
        onCommandDelete={handleCommandDelete}
        lspServers={cfg?.lspServers ?? {}}
        lspScope={lspScope}
        hasProjectDir={existsSync(join(process.cwd(), ".kimiflare"))}
        onLspSave={handleLspSave}
        themes={themeList()}
        onPickTheme={handleThemePick}
        currentUiEngine={cfg?.uiEngine === "ink" ? "ink" : "ink"}
        onPickUi={handleUiPick}
        currentModel={cfg?.model ?? ""}
        modelSwitchBusy={busy}
        onPickModel={handleModelPick}
        currentMode={mode}
        onPickMode={(m) => {
          if (m) {
            setMode(m);
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `mode: ${m}` }]);
          }
          setShowModePicker(false);
        }}
        selectedRemoteSession={selectedRemoteSession}
        onSelectRemoteSession={setSelectedRemoteSession}
        onCancelRemoteSession={handleRemoteCancel}
        onInboxOpen={openBrowser}
        getConfiguredHooks={configuredHooks}
        cwd={process.cwd()}
        onHooksMutate={() => hooksManagerRef.current.reload()}
        costAttributionEnabled={cfg?.costAttribution ?? false}
        onRunCommand={(cmd) => {
          // Defer so the modal closes before the command runs
          setTimeout(() => handleSlash(cmd), 0);
        }}
        currentShell={cfg?.shell}
        onPickShell={(shell) => {
          if (shell) {
            const next = { ...cfg!, shell: shell === "auto" ? undefined : shell };
            setCfg(next);
            void saveConfig(next).catch(() => {});
            setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `shell set to ${shell}` }]);
          }
          setShowShellPicker(false);
        }}
        memoryEnabled={memoryManagerRef.current !== null}
        memoryManager={memoryManagerRef.current}
        onMemoryAction={(action) => {
          setShowMemoryPicker(false);
          setTimeout(() => handleSlash(`/memory ${action}`), 0);
        }}
        onMemoryDone={() => setShowMemoryPicker(false)}
        onSkillsAction={(action) => {
          setShowSkillsPicker(false);
          if (action === "list") {
            setTimeout(() => handleSlash("/skills list"), 0);
            return;
          }
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `Type /skills ${action} <name> to ${action} a skill.` }]);
        }}
        onSkillsDone={() => setShowSkillsPicker(false)}
        changelogImageRepo={changelogImageRepo}
        onChangelogImageGenerate={handleChangelogImageGenerate}
        onChangelogImageCancel={() => setShowChangelogImagePicker(false)}
      />
    );
  }

  const hasConversation = events.some((e) => e.kind === "user" || e.kind === "assistant");

  return (
    <ThemeProvider theme={theme}>
      <Box flexDirection="column">
        {!hasConversation && events.length === 0 ? (
          <Welcome />
        ) : (
          <ChatView events={events} showReasoning={showReasoning} verbose={verbose} intentTier={intentTier ?? undefined} />
        )}
        {perm ? (
          <PermissionModal
            tool={perm.tool}
            args={perm.args}
            onDecide={decidePermission}
            onFeedback={(text) => {
              denyFeedbackRef.current = true;
              submitRef.current(text);
            }}
          />
        ) : showPlanCompletePicker ? (
          <PlanCompletePicker onPick={handlePlanCompletePick} />
        ) : queuePlanDraft !== null ? (
          <QueuePlanPicker prompts={queuePlanDraft} onPick={handleQueuePlanPick} />
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {tasks.length > 0 && (
              <TaskList
                tasks={tasks}
                startedAt={tasksStartedAt}
                tokensDelta={Math.max(0, (usage?.prompt_tokens ?? 0) - tasksStartTokens)}
              />
            )}
            <SubagentPanel />
            {queue.length > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                {queue.map((q, i) => (
                  <Text key={`queue_${i}`} color={theme.info.color} dimColor={theme.info.dim}>
                    ⏳ {q.display}
                    {busy && q.triage ? (
                      <Text>
                        {"  · "}
                        {q.triage.source === "pending" ? "deciding…" : q.triage.source === "default" ? "queued (unsure)" : "queued"}
                        {" · "}
                        <Text bold>Ctrl+G</Text> or <Text bold>/now</Text> run this now
                      </Text>
                    ) : null}
                  </Text>
                ))}
                {queue.length > 1 && (
                  <Text color={theme.info.color}>
                    Type <Text bold>/queue plan</Text> to review and coordinate these follow-ups together.
                  </Text>
                )}
              </Box>
            )}
            <StatusBar
              usage={usage}
              sessionUsage={sessionUsage}
              thinking={busy}
              turnStartedAt={turnStartedAt}
              mode={mode}
              modesEnabled={modesEnabled}
              contextLimit={modelContextLimit}
              model={cfg.model}
              responseMeta={responseMeta}
              codeMode={codeMode}
              skillsActive={skillsActive}
              memoryRecalled={memoryRecalled}
              phase={turnPhase}
              currentTool={currentToolName}
              lastActivityAt={lastActivityAt}
              kimiMdStale={kimiMdStale}
              gitBranch={gitBranch}
              intentTier={intentTier ?? undefined}
            />
            {picker.active?.kind === "file" && (
              <FilePicker
                items={picker.fileItems}
                selectedIndex={picker.active.selected}
                query={picker.query}
                recentFiles={new Set(recentFilesRef.current.keys())}
              />
            )}
            {picker.active?.kind === "slash" && (
              <SlashPicker
                items={picker.slashItems}
                selectedIndex={picker.active.selected}
                query={picker.query}
              />
            )}
          {parseBangCommand(input) !== null && (
            <Box marginTop={1}>
              <Text dimColor>! shell command — runs in your terminal (logins and prompts work); output is shared with the agent</Text>
            </Box>
          )}
          {historyIndex === history.length - 1 &&
            latestPromptRef.current?.historyText === history[history.length - 1] && (
              <Box marginTop={1}>
                <Text dimColor>editing last message — Enter replaces it</Text>
              </Box>
            )}
          <Box marginTop={parseBangCommand(input) !== null ? 0 : 1}>
            <Text color={theme.prompt ?? theme.accent}>› </Text>
            <CustomTextInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              enablePaste
              width={columns && columns > 2 ? columns - 2 : undefined}
              cursorOffset={cursorOffset}
              onCursorChange={setCursorOffset}
              pickerActive={picker.isActive}
              onPickerUp={picker.onUp}
              onPickerDown={picker.onDown}
              onPickerSelect={picker.onSelect}
              onPickerCancel={picker.onCancel}
              onHistoryUp={() => {
                if (history.length === 0) return;
                if (historyIndex === -1) {
                  setDraftInput(input);
                  const nextIndex = history.length - 1;
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                } else {
                  const nextIndex = Math.max(0, historyIndex - 1);
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                }
              }}
              onHistoryDown={() => {
                if (historyIndex === -1) return;
                const nextIndex = historyIndex + 1;
                if (nextIndex >= history.length) {
                  setHistoryIndex(-1);
                  setInput(draftInput);
                } else {
                  setHistoryIndex(nextIndex);
                  setInput(history[nextIndex]!);
                }
              }}
              onClearQueueItem={(text) => {
                setQueue((q) => {
                  const idx = q.findIndex((item) => item.display === text);
                  if (idx >= 0) {
                    const next = [...q];
                    next.splice(idx, 1);
                    return next;
                  }
                  return q;
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
    </ThemeProvider>
  );
}

/**
 * Run App headless behind a bridge (e.g. the Camouflage view): App's logic
 * runs as usual but Ink draws nothing and reads no keys; the bridge owns the
 * terminal.
 */
export async function renderAppWithBridge(
  cfg: Cfg,
  bridge: AppBridge,
  updateResult?: UpdateCheckResult,
  lspScope: "project" | "global" = "global",
  lspProjectPath: string | null = null,
) {
  enableUserShellCommands();
  const { PassThrough, Writable } = await import("node:stream");
  // Ink's useInput needs a raw-mode-capable stdin; give it one that never
  // produces keys, so the renderer alone reads the terminal.
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  const stdout = Object.assign(new Writable({ write: (_c, _e, cb) => cb() }), { columns: 100, rows: 40, isTTY: false });
  const instance = render(
    <App
      initialCfg={cfg}
      initialUpdateResult={updateResult}
      initialLspScope={lspScope}
      initialLspProjectPath={lspProjectPath}
      bridge={bridge}
    />,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
      interactive: false,
    },
  );
  await instance.waitUntilExit();
}

export async function renderApp(
  cfg: Cfg | null,
  updateResult?: UpdateCheckResult,
  lspScope: "project" | "global" = "global",
  lspProjectPath: string | null = null,
) {
  // The TUI is the only host that supports `!` commands (see agent/user-shell.ts).
  enableUserShellCommands();
  const instance = render(
    <App
      initialCfg={cfg}
      initialUpdateResult={updateResult}
      initialLspScope={lspScope}
      initialLspProjectPath={lspProjectPath}
    />,
    {
      incrementalRendering: true,
      // Disable Ink's built-in Ctrl+C → app.exit() handler. We need
      // Ctrl+C to reach our useInput handler so it can interrupt the
      // current turn (abort the scope, kill the supervisor, deny
      // pending modals) without unmounting the React tree. Without
      // this, Ink consumes Ctrl+C, exits the app mid-cleanup, the
      // agent loop and LSP servers keep the process alive in the
      // background, and the terminal is left in cooked mode showing
      // a frozen last frame with a phantom prompt below — see RF-20.
      exitOnCtrlC: false,
    },
  );
  registerInkInstance(instance);
  await instance.waitUntilExit();
  registerInkInstance(null);
}
