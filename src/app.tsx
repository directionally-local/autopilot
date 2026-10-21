import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useApp, useInput, useWindowSize, render } from "ink";

import type { ResponseMeta } from "./agent/client.js";
import { activeOpenRouterKey, embeddingAuthFromConfig, llmAuthFromConfig, providerPresetOf } from "./agent/llm-auth.js";
import { buildSystemPrompt, buildSessionPrefix } from "./agent/system-prompt.js";
import { summarizeMessagesViaLlm } from "./agent/llm-summarize.js";
import {
  shouldCompact,
  recallArtifacts,
  estimatePromptTokens,
} from "./agent/artifact-compaction.js";
import { proactiveCompactionThreshold } from "./agent/context-budget.js";
import {
  emptySessionState,
  ArtifactStore,
  formatRecalledArtifacts,
  type SessionState,
} from "./agent/session-state.js";
import { ToolExecutor, ALL_TOOLS } from "./tools/executor.js";
import type { ToolSpec } from "./tools/registry.js";
import { McpManager } from "./mcp/manager.js";
import { LspManager } from "./lsp/manager.js";
import { takeHookStartupNotices } from "./hooks/notices.js";
import { HooksManager, formatHookFailureNotice } from "./hooks/manager.js";
import { sanitizeString, appendStoppedToolResults } from "./agent/messages.js";
import type { ChatMessage, Usage } from "./agent/messages.js";
import { AbortScope } from "./util/abort-scope.js";
import { logger } from "./util/logger.js";
import type { ChatEvent } from "./ui/view-types.js";
import { usePermissionController } from "./ui/use-permission-controller.js";
import { queuePlanPreview } from "./ui/queue-plan.js";
import { createQueueBatch, canDrainQueue, type QueuedPrompt } from "./agent/queue-batch.js";
import { useSubagentList } from "./ui/subagent-list.js";
import { triageIncoming } from "./agent/inbox-triage.js";
import { createTriageCoordinator, decideSubmit, describeActivity, pushHistory, type PromptEditTarget } from "./ui/input-coordinator.js";
import { answerAside } from "./agent/aside.js";
import { workerRegistry } from "./tools/worker-registry.js";
import { recordSubagentEvent } from "./tools/subagent-stats.js";
import type { Task, PlanOption } from "./tools/registry.js";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { setTerminalTitle } from "./ui/terminal-title.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, loadConfig, saveConfig, type KimiConfig, type ReasoningEffort, plumbingModelOf } from "./config.js";
import { nextMode, type Mode } from "./mode.js";
import { classifyIntent } from "./intent/classify.js";
import { assembleTurn, describeSubagentGuidance, resolveTurnPolicy } from "./agent/session-core.js";
import { getMemoryDb } from "./memory/db.js";
import {
  addCheckpoint,
  generateSessionTitle,
} from "./sessions.js";
import { encodeImageFile } from "./util/image.js";
import { recordUsage, getCostReport, usageEvents } from "./usage-tracker.js";
import type { DailyUsage } from "./usage-tracker.js";
import { MemoryManager } from "./memory/manager.js";
import { loadCustomCommands } from "./commands/loader.js";
import { renderCommand } from "./commands/renderer.js";
import type { CustomCommand, SlashItem } from "./commands/types.js";
import { BUILTIN_COMMANDS, BUILTIN_COMMAND_NAMES } from "./commands/builtins.js";
import type { SaveCustomCommandOptions } from "./commands/save.js";
import { resolveTheme, themeList, DEFAULT_THEME_NAME } from "./ui/theme.js";
import { loadAndMergeThemes } from "./ui/theme-loader.js";
import type { Theme } from "./ui/theme.js";
import { getModelOrInfer, type ModelEntry } from "./models/registry.js";
import { maybeLspNudge } from "./util/lsp-nudge.js";
import { glob } from "./util/glob.js";
import type { FilePickerItem } from "./ui/view-types.js";
import { usePickerController } from "./ui/use-picker-controller.js";
import { useModalHost } from "./ui/use-modal-host.js";
import type { AppBridge, AppModal } from "./ui/app-bridge.js";
import type { HookConfig, HookEvent } from "./hooks/types.js";
import type { PlanCompleteChoice } from "./ui/view-types.js";
import { useSessionManager } from "./ui/use-session-manager.js";
import { useTurnController } from "./ui/use-turn-controller.js";
import {
  interruptTurn as runInterruptTurn,
  interruptOrExit as runInterruptOrExit,
  type InterruptDeps,
} from "./ui/input-handlers.js";
import { dispatchSlashCommand, type SlashContext, executeFreshStart } from "./ui/slash-commands.js";
import { generateContinuationSummary } from "./agent/continuation-summary.js";
import { runInit as runInitImpl } from "./init/run-init.js";
import { switchedMessage } from "./providers/connect.js";
import { endSessions } from "./hooks/session-lifecycle.js";
import type { ProviderId } from "./providers/presets.js";
import { runStartupTasks } from "./ui/run-startup-tasks.js";
import { initLsp as initLspImpl, initMcp as initMcpImpl } from "./ui/manager-init.js";
import { runCompact as runCompactImpl } from "./agent/run-compact.js";
import { compactAfterTurn, compactMidTurn, type AutoCompactionDeps } from "./agent/auto-compaction.js";
import { prepareAutoFresh } from "./agent/auto-fresh.js";
import { classifyTurnFailure, createTurnCallbacks, settleTurnEvents } from "./ui/turn-callbacks.js";
import { buildPromptContent, expandCustomCommand, turnReasoningEffort } from "./ui/prepare-prompt.js";
import { freshSuggestion, INIT_TIP, turnNudges } from "./ui/turn-nudges.js";
import { classifyNextMessage, makeTurnId } from "./trace/index.js";
import { toOpenAIToolDefs } from "./tools/registry.js";
import { distillSessionPlan } from "./agent/distill.js";
import { resolvePlanForFresh } from "./agent/plan-resolver.js";
import { enableUserShellCommands } from "./agent/user-shell.js";
import {
  formatBangContext,
  isTerminalHandedOff,
  parseBangCommand,
  runBangCommand,
} from "./ui/bang-command.js";
import {
  handleCommandDelete as handleCommandDeleteImpl,
  handleCommandSave as handleCommandSaveImpl,
  handleLspSave as handleLspSaveImpl,
} from "./ui/command-handlers.js";
import {
  AUTO_COMPACT_THRESHOLD,
  buildFilePickerIgnoreList,
  capEvents,
  CONTEXT_LIMIT,
  DEFAULT_AUTO_FRESH_SUGGESTION_TURNS,
  detectGitBranch,
  costLookupFromConfig,
  makePrefixMessages,
  mkAssistantId,
  mkKey,
  openBrowser,
  trackRecentFile,
  replaceUserPromptEvent,
} from "./ui/app-helpers.js";

/** The TUI's config is exactly the loaded config. */
export type Cfg = KimiConfig;

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
  initialResumeSessionId,
  initialResumeReason = "crash",
  initialOpenResumePicker,
}: {
  initialCfg: Cfg | null;
  initialUpdateResult?: UpdateCheckResult;
  initialLspScope: "project" | "global";
  initialLspProjectPath: string | null;
  /** The Camouflage view App reports to and takes actions from. */
  bridge: AppBridge;
  /** Reopen this session on start. */
  initialResumeSessionId?: string;
  /** Why it's reopened: after a renderer crash (#862), or the user asked
   *  (`autopilot resume`, `autopilot -c`). */
  initialResumeReason?: ResumeReason;
  /** Open the /resume picker on start (`autopilot resume` without an id). */
  initialOpenResumePicker?: boolean;
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
  // A background subagent finished: say so; its findings reach the agent at
  // the next tool boundary or with your next message.
  useEffect(
    () =>
      workerRegistry.onFinished((w) => {
        if (!w.background || (sessionIdRef.current && w.sessionId !== sessionIdRef.current)) return;
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `Background subagent #${w.index} ${w.status}${w.costUsd ? ` ($${w.costUsd.toFixed(4)})` : ""}: ${w.task.slice(0, 80)}. Its findings go to the agent ${supervisorRef.current.isRunning ? "at the next tool step" : "with your next message"}.`,
          },
        ]);
      }),
    [],
  );

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
    setShowModelPicker,
    setProviderSetup,
    showModePicker, setShowModePicker,
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
  /** Latest queue for async triage callbacks (state closures go stale). */
  const queueRef = useRef<QueuedPrompt[]>([]);
  queueRef.current = queue;
  const triageRef = useRef<ReturnType<typeof createTriageCoordinator> | null>(null);
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
  const updateTaskTracking = useCallback((nextTasks: Task[]) => {
    const previousTasks = tasksRef.current;
    const prevEmpty = previousTasks.length === 0;
    const prevAllDone = previousTasks.length > 0 && previousTasks.every((task) => task.status === "completed");
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
  }, [tasksRef, setTasks, setTasksStartedAt, setTasksStartTokens]);
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
  // One-time hook notices (legacy kimiflare settings path, 1.29.0 exit-code
  // change). Non-blocking: shown as info lines, recorded so they never repeat.
  useEffect(() => {
    let cancelled = false;
    void takeHookStartupNotices(process.cwd()).then((notices) => {
      if (cancelled) return;
      for (const text of notices) setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // #889: a hook that times out, crashes or can't start is shown once per
  // hook per session (both UIs read `events`); later failures are counted.
  useEffect(
    () =>
      hooksManagerRef.current.onFailure((notice) => {
        if (!notice.firstInSession) return;
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: formatHookFailureNotice(notice), tone: "warn" }]);
      }),
    [],
  );
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

  // Reopen a session on start: the one a crashed Camouflage renderer was
  // saving (#862) and the restarted view reopens, or the one
  // `autopilot resume` / `autopilot -c` named.
  const resumedAfterCrashRef = useRef(false);
  useEffect(() => {
    if (!initialResumeSessionId || resumedAfterCrashRef.current || !cfg) return;
    resumedAfterCrashRef.current = true;
    void (async () => {
      const { sessionsDir } = await import("./sessions.js");
      try {
        await doResumeSession(join(sessionsDir(), `${initialResumeSessionId}.json`));
        if (initialResumeReason === "crash") {
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "The Camouflage renderer crashed and was restarted; this conversation reopened where it left off." },
          ]);
        }
      } catch (err) {
        const when = initialResumeReason === "crash" ? " after the renderer crash" : "";
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `Couldn't reopen the conversation${when}: ${(err as Error).message}. Use /resume.` }]);
      }
    })();
  }, [initialResumeSessionId, initialResumeReason, cfg, doResumeSession]);
  const openedResumePickerRef = useRef(false);
  useEffect(() => {
    if (!initialOpenResumePicker || openedResumePickerRef.current || !cfg) return;
    openedResumePickerRef.current = true;
    void openResumePicker();
  }, [initialOpenResumePicker, cfg, openResumePicker]);
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
  // includes showInboxModal but EXCLUDES
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

  /** What automatic compaction needs from the session (refs read at call time). */
  const autoCompactionDeps = (turnId: string | null): AutoCompactionDeps => ({
    compiledContext: compiledContextRef.current,
    getState: () => sessionStateRef.current,
    setState: (state) => {
      sessionStateRef.current = state;
    },
    store: artifactStoreRef.current,
    summarize: (messages, opts) => summarizeMessagesViaLlm({ ...llmAuthFromConfig(cfg!), model: cfg!.model, messages, ...opts }),
    memory: memoryManagerRef.current,
    cwd: process.cwd(),
    trace: traceRef.current,
    turnId,
    notify: (kind, text) => setEvents((e) => [...e, { kind, key: mkKey(), text }]),
    save: saveSessionSafe,
    // M6.1: PreCompact is best-effort and never blocks compaction.
    firePreCompact: (signal) => {
      if (!hooksManagerRef.current.hasEnabledHooks("PreCompact")) return;
      void hooksManagerRef.current
        .fire("PreCompact", { event: "PreCompact", session_id: sessionIdRef.current, cwd: process.cwd() }, null, signal)
        .catch(() => {});
    },
  });

  /** Checkpoint the session, then build the continuation summary a fresh session starts from. */
  const prepareAutoFreshNow = (): Promise<string | null> =>
    prepareAutoFresh({
      messages: messagesRef.current,
      compiledContext: compiledContextRef.current,
      sessionState: sessionStateRef.current,
      artifactStore: artifactStoreRef.current,
      saveCheckpoint: async (checkpoint) => {
        ensureSessionId();
        const { sessionsDir } = await import("./sessions.js");
        await addCheckpoint(join(sessionsDir(), `${sessionIdRef.current}.json`), checkpoint);
      },
      summarize: () =>
        generateContinuationSummary({
          messages: messagesRef.current,
          mode: modeRef.current,
          ...llmAuthFromConfig(cfg!),
          model: plumbingModelOf(cfg!),
          memoryManager: memoryManagerRef.current,
          memoryEnabled: cfg!.memoryEnabled,
        }),
    });

  /** Start a fresh session from a continuation summary (after a silent checkpoint), with a notice. */
  const runAutoFresh = async (notice: string): Promise<void> => {
    try {
      const summary = await prepareAutoFreshNow();
      if (!summary) return;
      executeFreshStart(buildSlashContext(), summary);
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: notice }]);
    } catch (e) {
      setEvents((es) => [...es, { kind: "error", key: mkKey(), text: `Auto-fresh failed: ${(e as Error).message}` }]);
    }
  };

  /** Mid-turn compaction hook: called between tool-iteration cycles in runAgentTurn.
   *  Prevents context overflow during long exploration sessions. */
  const onIterationEnd = useCallback(
    async (messages: ChatMessage[], signal: AbortSignal): Promise<ChatMessage[]> => {
      if (signal.aborted) return messages;
      // Budget-aware: small-context models compact before the hard preflight
      // limit; large ones still compact at the cost-driven 80k cap.
      if (!shouldCompact({ messages, tokenThreshold: cfg ? proactiveCompactionThreshold(cfg.model) : undefined })) return messages;

      return compactMidTurn(messages, autoCompactionDeps(currentTurnIdRef.current), signal);
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
      // EXCLUDES commandPicker and showInboxModal
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
      onTasks: updateTaskTracking,
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
  }, [cfg, busy, updateAssistant, updateTool, updateResponseMeta, updateTaskTracking]);

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

  /** `/provider` finished: the new config is saved and its catalog loaded. */
  const handleProviderSwitched = useCallback(
    async (next: KimiConfig | null, to: ProviderId) => {
      const loaded = next ?? (await loadConfig());
      if (!loaded) {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: "couldn't load the config after switching provider" }]);
        return;
      }
      setCfg(loaded);
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: switchedMessage(loaded, to) }]);
    },
    [mkKey],
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
    setProviderSetup,
    setShowModePicker,
    setShowInboxModal,
    setShowHooksDashboard: modals.setShowHooksDashboard,
    setShowHelpMenu,
    setShowLspWizard,
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
    setHasUpdate, setLatestVersion, setShowThemePicker, setShowModelPicker, setProviderSetup, setShowModePicker,
    setShowInboxModal, setShowHelpMenu,
    setShowMemoryPicker, setShowSkillsPicker, setShowShellPicker,
    setShowChangelogImagePicker, setChangelogImageRepo,
    setShowLspWizard, setShowCommandList,
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
        const expanded = await expandCustomCommand(trimmed, customCommandsRef.current, (cmd, input) =>
          renderCommand(cmd, input, { cwd: process.cwd() }),
        );
        if (expanded) {
          for (const text of expanded.notices) setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
          if (!expanded.prompt.trim()) {
            endTurn();
            return;
          }
          overrideModel = expanded.model;
          overrideEffort = expanded.effort;
          display = trimmed;
          trimmed = expanded.prompt;
        }
      }

      // Track @-mentioned files for recent-files picker boost
      const mentionMatches = trimmed.matchAll(/@(\S+)/g);
      for (const m of mentionMatches) {
        const path = m[1];
        if (path) trackRecentFile(recentFilesRef, path, MAX_RECENT_FILES);
      }

      const { content, images, errors: imageErrors, notices: imageNotices } = await buildPromptContent(trimmed, (path) =>
        encodeImageFile(path, { maxEdge: cfg.imageMaxEdge, quality: cfg.imageQuality }),
      );
      for (const text of imageErrors) setEvents((es) => [...es, { kind: "error", key: mkKey(), text }]);
      for (const text of imageNotices) setEvents((es) => [...es, { kind: "info", key: mkKey(), text }]);

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

      // Occasional /init tip; for long auto/edit sessions, suggest /fresh or start fresh.
      turnCounterRef.current += 1;
      const nudges = turnNudges({
        turn: turnCounterRef.current,
        hasContextFile: ["AGENTS.md", "KIMI.md", "KIMIFLARE.md", "AGENT.md"].some((name) => existsSync(join(process.cwd(), name))),
        contextStale: kimiMdStale,
        mode: modeRef.current,
        freshAfterTurns: cfg?.autoFreshSuggestionTurns ?? DEFAULT_AUTO_FRESH_SUGGESTION_TURNS,
        freshSuggested: freshSuggestedRef.current,
        autoFreshEnabled: cfg?.autoFreshEnabled === true,
      });
      if (nudges.initTip) setEvents((e) => [...e, { kind: "info", key: mkKey(), text: INIT_TIP }]);
      if (nudges.fresh) {
        freshSuggestedRef.current = true;
        if (nudges.fresh === "auto") void runAutoFresh("Auto-fresh triggered: starting new session with continuation context…");
        else setEvents((e) => [...e, { kind: "info", key: mkKey(), text: freshSuggestion(turnCounterRef.current) }]);
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

      const reasoningEffort = turnReasoningEffort(classification.tier, overrideEffort, effortRef.current);
      const effectiveCodeMode = classification.tier === "heavy";
      setCodeMode(effectiveCodeMode);

      const turnScope = sessionScopeRef.current.createChild();
      activeScopeRef.current = turnScope;

      // Pre-turn async work (session-start memory recall + skill routing) is
      // performed inside runAgentTurn so it is covered by the supervisor
      // lifecycle and the turn's abort signal.

      const sharedCallbacks = createTurnCallbacks({
        mkKey,
        mkAssistantId,
        setEvents,
        updateAssistant,
        updateTool,
        beginTurn,
        endTurn,
        setTurnPhase,
        setCurrentToolName,
        setLastActivityAt,
        activeAsstIdRef,
        pendingToolCallsRef,
        findTool: (name) => executorRef.current.list().find((t) => t.name === name),
        onUsage: (u) => {
          usageRef.current = u;
          setUsage(u);
        },
        onUsageFinal: (u, meta) => {
          const sid = ensureSessionId();
          void recordUsage(sid, u, costLookupFromConfig(cfg, meta ?? responseMetaRef.current), cfg?.model);
          void getCostReport(sid).then((report) => setSessionUsage(report.session));
        },
        onResponseMeta: updateResponseMeta,
        onTasks: updateTaskTracking,
        onPlanOptions: (options) => {
          planOptionsRef.current = options;
        },
        askPermission: askForPermission,
        onKimiMdStale: () => {
          if (kimiMdStaleNudgedRef.current) return;
          kimiMdStaleNudgedRef.current = true;
          setKimiMdStale(true);
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: "Project context may be stale. Run /init to refresh AGENTS.md based on recent changes." },
          ]);
        },
        setSkillsActive,
      });

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

        setEvents(settleTurnEvents);
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

      // SessionCore: subagent guidance, the tool set and the completion check,
      // decided the same way as in every other host.
      const policy = {
        ...(await resolveTurnPolicy({
          cfg,
          prompt: display,
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          signal: turnScope.signal,
        })),
        classification,
      };
      const delegationGuidance = policy.guidance;
      const guidanceText = describeSubagentGuidance(delegationGuidance);
      if (guidanceText) setEvents((events) => [...events, { kind: "info", key: mkKey(), text: guidanceText }]);
      const turnTools = policy.tools;
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
        assembleTurn({ cfg, policy, host: {
          ...llmAuthFromConfig(cfg),
          model: overrideModel ?? cfg.model,
          messages: messagesRef.current,
          executor: executorRef.current,
          cwd: process.cwd(),
          signal: turnScope.signal,
          reasoningEffort,
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
          sessionStartRecall: sessionStartRecallRef.current ?? undefined,
          skillsDb: getMemoryDb() ?? undefined,
          skillRoutingConfig: {
            embeddingModel: cfg.memoryEmbeddingModel,
            embeddingAuth: embeddingAuthFromConfig(cfg),
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
        } }),
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

              // Proactive compaction past the model's budget threshold, then an
              // aggressive pass when the history is still huge; if even that
              // leaves it above the fresh-start threshold, start fresh.
              const tokensAfterAggressive = await compactAfterTurn(
                {
                  getMessages: () => messagesRef.current,
                  setMessages: (messages) => {
                    messagesRef.current = messages;
                  },
                  overThreshold: shouldCompact({ messages: messagesRef.current, tokenThreshold: proactiveCompactionThreshold(overrideModel ?? cfg.model) }),
                  estimateTokens: estimatePromptTokens,
                  aggressiveTokenThreshold: cfg?.autoCompactTokenThreshold ?? 500_000,
                  signal: turnScope.signal,
                },
                autoCompactionDeps(turnId),
              );
              if (tokensAfterAggressive !== null && tokensAfterAggressive > (cfg?.autoFreshTokenThreshold ?? 2_000_000)) {
                await runAutoFresh(
                  `Auto-fresh triggered at ~${tokensAfterAggressive.toLocaleString()} tokens: starting new session with continuation context…`,
                );
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
            const failure = classifyTurnFailure(e);
            if (failure.kind === "aborted") {
              // Inject synthetic tool results for any pending tool calls so message
              // history remains valid (assistant msg with tool_calls needs 1:1 results).
              // Idempotent: the interrupt handler may already have done this.
              appendStoppedToolResults(messagesRef.current, pendingToolCallsRef.current);
              setEvents((evts) =>
                evts.map((e) => (e.kind === "tool" && e.status === "running" ? { ...e, status: "error" as const, result: "(stopped)" } : e)),
              );
            } else if (failure.kind === "api_error") {
              const { kind: _kind, ...err } = failure;
              lastApiErrorRef.current = err;
              const statusUrl = providerPresetOf(llmAuthFromConfig(cfg)).statusUrl;
              setEvents((es) => [...es, { kind: "api_error", key: mkKey(), ...err, ...(statusUrl ? { statusUrl } : {}) }]);
            } else {
              setEvents((es) => [...es, { kind: "error", key: mkKey(), text: failure.text }]);
            }
            cleanupTurn();
          },
        },
      );
    },
    [cfg, handleSlash, updateAssistant, updateTool, saveSessionSafe, updateResponseMeta, setShowPlanCompletePicker, runUserShellCommand, ensureTraceStarted, updateTaskTracking],
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

  // --- Mid-turn triage (#725) -------------------------------------------
  // Messages sent while the agent works are queued first; triage may then
  // pull them out to steer the current turn, interrupt it, or answer as an
  // aside. Unsure → stays queued, and Ctrl+G promotes it.
  /** Update the queue ref and the rendered queue together. */
  const setQueueBoth = (update: (queue: QueuedPrompt[]) => QueuedPrompt[]) => {
    queueRef.current = update(queueRef.current);
    setQueue(update);
  };
  const currentActivity = () =>
    describeActivity({
      messages: messagesRef.current,
      tasks: tasksRef.current,
      pendingTools: [...pendingToolCallsRef.current.values()],
      workers: workerRegistry.list(),
    });
  const triage = createTriageCoordinator({
    isBusy: () => busyRef.current || supervisorRef.current.isRunning,
    subagentsRunning: () => workerRegistry.list().length > 0,
    getQueue: () => queueRef.current,
    setQueue: setQueueBoth,
    markDelivered: (key, note) =>
      setEvents((evts) => [
        ...evts.map((e) => (e.kind === "user" && e.key === key ? { ...e, queued: false } : e)),
        { kind: "info", key: mkKey(), text: note },
      ]),
    notice: (text) => setEvents((evts) => [...evts, { kind: "info", key: mkKey(), text }]),
    transcriptQueueNotes: true,
    activity: currentActivity,
    triage: (text, activity) => triageIncoming(text, activity, { apiKey: activeOpenRouterKey(cfg) }),
    answerAside: cfg
      ? (text, activity) => answerAside(text, activity, { ...llmAuthFromConfig(cfg), model: cfg.plumbingModel ?? cfg.model })
      : null,
    steer: (item, content) => pendingSteersRef.current.push({ key: item.key, full: item.full, display: item.display, content }),
    interrupt: () => runInterruptTurn(interruptDepsRef.current!),
  });
  triageRef.current = triage;
  promoteQueuedRef.current = triage.promoteLatest;

  const submit = useCallback(
    (full: string, display?: string) => {
      const trimmedFull = full.trim();
      const trimmedDisplay = (display ?? full).trim() || trimmedFull;
      const busyNow = busyRef.current || supervisorRef.current.isRunning;
      const editTarget = latestPromptRef.current;
      const decision = decideSubmit(trimmedFull, trimmedDisplay, {
        busy: busyNow,
        // The ref, not this render's `queue`: the Camouflage renderer can
        // deliver several lines before App re-renders (type-ahead while a
        // turn starts), and `/queue plan` must see the ones just queued.
        queue: queueRef.current,
        history,
        historyIndex,
        editTarget,
        editTargetVisible: editTarget !== null && events.some((event) => event.kind === "user" && event.key === editTarget.key),
      });
      const clearInput = () => {
        setInput("");
        setHistoryIndex(-1);
      };
      const info = (text: string) => setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);

      switch (decision.do) {
        case "ignore":
          return;
        case "queue-plan":
          setHistory((h) => pushHistory(h, trimmedDisplay));
          clearInput();
          if (decision.notice) info(decision.notice);
          else setQueuePlanDraft([...queueRef.current]);
          return;
        case "edit-unchanged":
          clearInput();
          return;
        case "edit-queued":
        case "edit-rerun": {
          const target = decision.target;
          setHistory((items) =>
            items.length > 0 && items[items.length - 1] === target.historyText ? [...items.slice(0, -1), trimmedDisplay] : items,
          );
          clearInput();
          latestPromptRef.current = { ...target, historyText: trimmedDisplay };
          setEvents((events) => replaceUserPromptEvent(events, target.key, trimmedDisplay));
          if (decision.do === "edit-queued") {
            setQueueBoth(() => decision.queue);
            return;
          }
          const edit: PendingPromptEdit = { key: target.key, full: trimmedFull, display: trimmedDisplay, messagesBefore: decision.target.messagesBefore };
          if (busyNow) {
            pendingPromptEditRef.current = edit;
            runInterruptTurn(interruptDepsRef.current!);
          } else {
            messagesRef.current = [...edit.messagesBefore];
            setEvents((events) => replaceUserPromptEvent(events, edit.key, edit.display, true));
            processMessage(edit.full, edit.display, { queuedKeys: [edit.key], historyText: edit.display });
          }
          return;
        }
        case "run-now":
          clearInput();
          if (!triageRef.current!.promoteLatest()) {
            info(busyNow ? "nothing queued to run now" : "nothing is running — queued messages run next anyway");
          }
          return;
        case "subagent-command":
          // Subagent management must work mid-turn: queueing it would make it useless.
          setHistory((h) => pushHistory(h, trimmedDisplay));
          clearInput();
          void handleSlash(trimmedFull);
          return;
        case "enqueue": {
          // Queue first so order is preserved and "unsure" already means queued;
          // triage then decides whether to pull it out to steer, interrupt, or
          // answer as an aside (#725).
          const key = mkKey();
          setEvents((e) => [...e, { kind: "user", key, text: trimmedDisplay, queued: true }]);
          const queued: QueuedPrompt = {
            full: trimmedFull,
            display: trimmedDisplay,
            key,
            ...(decision.isChatPrompt ? { triage: { source: "pending" as const, reason: "deciding…" } } : {}),
          };
          setQueueBoth((q) => [...q, queued]);
          if (decision.isChatPrompt) {
            latestPromptRef.current = { key, historyText: trimmedDisplay, messagesBefore: null };
            void triageRef.current!.triageQueued(queued);
          }
          setHistory((h) => pushHistory(h, trimmedDisplay));
          clearInput();
          return;
        }
        case "run":
          setHistory((h) => pushHistory(h, trimmedDisplay));
          clearInput();
          processMessage(trimmedFull, trimmedDisplay !== trimmedFull ? trimmedDisplay : undefined, {
            eventKey: mkKey(),
            historyText: trimmedDisplay,
          });
          return;
      }
    },
    [processMessage, handleSlash, queue, history, historyIndex, events],
  );
  submitRef.current = submit;

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
    for (const ev of ["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "UserPromptSubmit", "Stop", "PreCompact"] as const) {
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

  // ── Camouflage view ───────────────────────────────────────────────────
  // Report what's on screen after every render, and keep the view's
  // actions pointing at this render's handlers.
  useEffect(() => {
    const open: AppModal[] = [];
    if (modals.showModelPicker) open.push("model");
    if (modals.providerSetup) open.push("provider");
    if (modals.showModePicker) open.push("mode");
    if (modals.showThemePicker) open.push("theme");
    if (modals.showHelpMenu) open.push("help");
    if (modals.showMemoryPicker) open.push("memory");
    if (modals.showSkillsPicker) open.push("skills");
    if (modals.showShellPicker) open.push("shell");
    if (modals.showPlanCompletePicker) open.push("planComplete");
    if (modals.showCommandList) open.push("commandList");
    if (modals.commandWizard) open.push("commandWizard");
    if (modals.commandPicker) open.push("commandPicker");
    if (modals.showLspWizard) open.push("lspWizard");
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
      denyWithFeedback: (feedback) => {
        // Same as Ink's PermissionModal "Something else": the feedback rides
        // on the decision (for the trace) and is sent as the next message.
        const text = feedback.trim();
        decidePermission({ decision: "deny", scope: "once", ...(text ? { feedback: text } : {}) });
        if (text) {
          denyFeedbackRef.current = true;
          submitRef.current(text);
        }
      },
      pickModel: handleModelPick,
      providerSwitched: (to) => {
        modals.setProviderSetup(null);
        void handleProviderSwitched(null, to);
      },
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
      pickQueuePlan: handleQueuePlanPick,
      closeModal: (m) => {
        const close: Record<AppModal, () => void> = {
          model: () => setShowModelPicker(false),
          provider: () => modals.setProviderSetup(null),
          mode: () => setShowModePicker(false),
          theme: () => modals.setShowThemePicker(false),
          help: () => modals.setShowHelpMenu(false),
          memory: () => modals.setShowMemoryPicker(false),
          skills: () => modals.setShowSkillsPicker(false),
          shell: () => modals.setShowShellPicker(false),
          planComplete: () => handlePlanCompletePick(null),
          commandList: () => modals.setShowCommandList(false),
          commandWizard: () => modals.setCommandWizard(null),
          commandPicker: () => modals.setCommandPicker(null),
          lspWizard: () => modals.setShowLspWizard(false),
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
      turnRunning: busy || supervisorRef.current.isRunning,
      sessionId: sessionIdRef.current,
      providerSetup: modals.providerSetup,
      workers: runningSubagents,
      mode,
      model: cfg?.model ?? "",
      usage,
      sessionUsage,
      contextLimit: modelContextLimit,
      turnPhase,
      currentTool: currentToolName,
      kimiMdStale,
      codeMode,
      intentTier,
      tasks,
      permission: perm ? { tool: perm.tool, args: perm.args } : null,
      modals: open,
      resumeSessions,
      checkpoints: checkpointSession ? { session: checkpointSession, list: checkpointList } : null,
      planOptions,
      queuePlan: queuePlanDraft ? { prompts: queuePlanPreview(queuePlanDraft).map((p) => p.text) } : null,
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

  // Camouflage draws everything from the bridge snapshot; Ink renders nothing.
  return null;
}

/** Why a session is reopened on start (see App's `initialResumeReason`). */
export type ResumeReason = "crash" | "user";

export interface RenderAppOpts {
  /** Reopen this saved session on start. */
  resumeSessionId?: string;
  /** Defaults to "crash" (the renderer-crash fallback, #862). */
  resumeReason?: ResumeReason;
  /** Open the /resume picker on start. */
  openResumePicker?: boolean;
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
  opts: RenderAppOpts = {},
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
      initialResumeSessionId={opts.resumeSessionId}
      initialResumeReason={opts.resumeReason}
      initialOpenResumePicker={opts.openResumePicker}
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
  await endSessions("exit");
}
