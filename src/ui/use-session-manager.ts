import React, { useCallback, useRef, useState } from "react";
import { setTerminalTitle } from "./terminal-title.js";
import {
  listSessions,
  loadSession,
  loadSessionFromCheckpoint,
  makeSessionId,
  saveSession,
  type Checkpoint,
  type SessionSummary,
} from "../sessions.js";
import {
  ArtifactStore,
  deserializeArtifactStore,
  emptySessionState,
  serializeArtifactStore,
  type SessionState,
} from "../agent/session-state.js";
import type { ChatMessage, Usage } from "../agent/messages.js";
import type { ResponseMeta } from "../agent/client.js";
import { hasLlmAuth, llmAuthFromConfig } from "../agent/llm-auth.js";
import type { MemoryManager } from "../memory/manager.js";
import { injectRecalledMemoryOnce } from "../memory/recall-inject.js";
import { getCostReport } from "../usage-tracker.js";
import type { DailyUsage } from "../usage-tracker.js";
import type { ChatEvent } from "./view-types.js";
import { setLogSessionId } from "../util/log-sink.js";
import { createNoopRecorder, createRecorder, emitSessionStart, type TraceRecorder } from "../trace/index.js";
import type { ToolDef } from "../agent/messages.js";
import type { SessionEndReason, TraceSessionMode } from "../trace/types.js";
import type { Mode } from "../mode.js";
import { DEFAULT_AUTO_FRESH_SUGGESTION_TURNS } from "./app-helpers.js";
import { generateContinuationSummary } from "../agent/continuation-summary.js";
import { plumbingModelOf } from "../config.js";

/**
 * Pull the first chunk of user text out of a message list — used to
 * derive a stable session id on the first turn. Returns `"session"` if
 * no user message has any text content, mirroring the pre-extraction
 * fallback in `app.tsx`.
 */
export function extractFirstUserText(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "session";
  if (typeof firstUser.content === "string") {
    return firstUser.content || "session";
  }
  if (Array.isArray(firstUser.content)) {
    const textPart = firstUser.content.find((p) => p.type === "text");
    if (textPart?.text) return textPart.text;
  }
  return "session";
}

/**
 * Build a brief, zero-latency summary from session state for display on
 * `/resume`. Returns `null` when there's nothing useful to show.
 */
export function buildLocalResumeSummary(state: SessionState): string | null {
  const parts: string[] = [];
  if (state.task) parts.push(`Task: ${state.task}`);
  if (state.files_modified.length > 0) {
    parts.push(`Modified: ${state.files_modified.join(", ")}`);
  }
  if (state.next_actions.length > 0) {
    parts.push(`Next: ${state.next_actions.slice(0, 3).join("; ")}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}

export interface SessionManagerDeps {
  /** Model name + other config needed at save/resume time. Null while booting. */
  cfg: {
    model: string;
    autoFreshSuggestionTurns?: number;
    openrouterApiKey?: string;
    requestyApiKey?: string;
    baseUrl?: string;
    apiKey?: string;
    openrouterProvider?: import("../agent/client.js").OpenRouterProviderPrefs;
    plumbingModel?: string;
    memoryEnabled?: boolean;
    /** Local session tracing (src/trace); off unless `enabled`. */
    trace?: { enabled: boolean; root?: string };
  } | null;
  /** Current agent mode. */
  mode: Mode;
  // Refs the hook needs to read/write at save and resume time. These
  // belong to the wider app (the agent loop mutates them too), so they're
  // injected rather than owned.
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  sessionStateRef: React.MutableRefObject<SessionState>;
  artifactStoreRef: React.MutableRefObject<ArtifactStore>;
  compiledContextRef: React.MutableRefObject<boolean>;
  responseMetaRef: React.MutableRefObject<ResponseMeta | null>;
  memoryManagerRef: React.MutableRefObject<MemoryManager | null>;
  // State setters the resume flow needs to reach into.
  setEvents: React.Dispatch<React.SetStateAction<ChatEvent[]>>;
  setHistory: (h: string[]) => void;
  setUsage: (u: Usage | null) => void;
  setSessionUsage: (s: DailyUsage | null) => void;
  setResponseMeta: (m: ResponseMeta | null) => void;
  /** Stable key generator for event-list items. */
  mkKey: () => string;
}

export interface SessionManager {
  // Identity refs (kept here, but returned so other code can keep
  // calling `sessionIdRef.current` unchanged).
  sessionIdRef: React.MutableRefObject<string | null>;
  sessionCreatedAtRef: React.MutableRefObject<string | null>;
  sessionTitleRef: React.MutableRefObject<string | null>;

  // Picker state (powers the resume + checkpoint modals).
  resumeSessions: SessionSummary[] | null;
  setResumeSessions: (s: SessionSummary[] | null) => void;
  checkpointSession: SessionSummary | null;
  setCheckpointSession: (s: SessionSummary | null) => void;
  checkpointList: Checkpoint[];
  setCheckpointList: (c: Checkpoint[]) => void;
  hasPickerOpen: boolean;

  // Resume loading state.
  resuming: boolean;
  resumingMessage: string;
  resumeProgress: number;
  resumeStage: string;

  // Operations.
  ensureSessionId: () => string;
  saveSessionSafe: () => Promise<void>;
  openResumePicker: () => Promise<void>;
  doResumeSession: (filePath: string, checkpointId?: string) => Promise<void>;
  handleResumePick: (picked: SessionSummary | null) => Promise<void>;
  handleCheckpointPick: (checkpointId: string | null) => Promise<void>;
  /** Clears the identity refs. Used by /clear. */
  resetSession: () => void;

  // Session trace (src/trace). A no-op recorder unless tracing is enabled.
  traceRef: React.MutableRefObject<TraceRecorder>;
  /** Recorder for the current session id; creates it on first use. */
  ensureTrace: () => TraceRecorder;
  /** Emit `session_start` once per recorder, with what the model will see. Returns the recorder. */
  ensureTraceStarted: (info: TraceStartInfo) => Promise<TraceRecorder>;
  /** Emit `session_end` (if a session was started) and drop the recorder. */
  endTrace: (reason: SessionEndReason) => void;
  /** Ended turns of the current session, oldest first. */
  turnHistoryRef: React.MutableRefObject<TurnRecord[]>;
  /** Record that a turn ended (for /good, /bad, next-message, and revert signals). */
  noteTurnEnded: (turnId: string) => void;
}

/** A turn that has ended, for outcome signals that arrive after the fact. */
export interface TurnRecord {
  turnId: string;
  endedAt: number;
}

export interface TraceStartInfo {
  tools: ToolDef[];
  systemPrompt: string;
  model: string;
  mode: TraceSessionMode;
  config: import("../trace/session-start.js").CollectSessionStartOptions["config"];
  toolProfile?: string;
}

export function useSessionManager(deps: SessionManagerDeps): SessionManager {
  const sessionIdRef = useRef<string | null>(null);
  const sessionCreatedAtRef = useRef<string | null>(null);
  const sessionTitleRef = useRef<string | null>(null);

  const [resumeSessions, setResumeSessions] = useState<SessionSummary[] | null>(null);
  const [checkpointSession, setCheckpointSession] = useState<SessionSummary | null>(null);
  const [checkpointList, setCheckpointList] = useState<Checkpoint[]>([]);
  const [resuming, setResuming] = useState(false);
  const [resumingMessage, setResumingMessage] = useState("Pulling context…");
  const [resumeProgress, setResumeProgress] = useState(0);
  const [resumeStage, setResumeStage] = useState("");

  // Ref for the smooth-progress interval so we can cancel / replace it.
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopSmoothProgress = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);
  const startSmoothProgress = useCallback(
    (from: number, to: number, durationMs: number) => {
      stopSmoothProgress();
      const startTime = Date.now();
      const startVal = from;
      progressTimerRef.current = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const t = Math.min(1, elapsed / durationMs);
        // ease-out cubic — fast start, gentle landing
        const ease = 1 - Math.pow(1 - t, 3);
        setResumeProgress(startVal + (to - startVal) * ease);
        if (t >= 1) stopSmoothProgress();
      }, 50);
    },
    [stopSmoothProgress],
  );

  // Clean up the smooth-progress timer on unmount.
  React.useEffect(() => {
    return () => {
      if (progressTimerRef.current) clearInterval(progressTimerRef.current);
    };
  }, []);

  // Stash deps in a ref so the public callbacks keep stable identities.
  // Same pattern as M4.1's PermissionController and M4.2's PickerController.
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const ensureSessionId = useCallback(() => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const text = extractFirstUserText(depsRef.current.messagesRef.current);
    sessionIdRef.current = makeSessionId(text);
    setLogSessionId(sessionIdRef.current);
    return sessionIdRef.current;
  }, []);

  // --- Session trace lifecycle -------------------------------------------
  const traceRef = useRef<TraceRecorder>(createNoopRecorder());
  const traceStartedRef = useRef(false);

  const turnHistoryRef = useRef<TurnRecord[]>([]);
  const noteTurnEnded = useCallback((turnId: string) => {
    turnHistoryRef.current.push({ turnId, endedAt: Date.now() });
    if (turnHistoryRef.current.length > 100) turnHistoryRef.current.shift();
  }, []);

  const endTrace = useCallback((reason: SessionEndReason) => {
    const trace = traceRef.current;
    if (trace.enabled && traceStartedRef.current) trace.emit("session_end", { reason }, null);
    traceStartedRef.current = false;
    traceRef.current = createNoopRecorder();
  }, []);

  /** `outcome{reverted}` for the turns a /clear or checkpoint restore throws away. */
  const traceReverted = useCallback((how: "clear" | "restore_checkpoint", turns: TurnRecord[]) => {
    const trace = traceRef.current;
    if (!trace.enabled) return;
    for (const turn of turns) trace.emit("outcome", { kind: "reverted", turn_id: turn.turnId, how }, turn.turnId);
  }, []);

  const ensureTrace = useCallback((): TraceRecorder => {
    const id = ensureSessionId();
    const cfgTrace = depsRef.current.cfg?.trace;
    const wantEnabled = cfgTrace?.enabled === true;
    const current = traceRef.current;
    if (current.sessionId === id && current.enabled === wantEnabled) return current;
    if (current.enabled && traceStartedRef.current) current.emit("session_end", { reason: "exit" }, null);
    traceStartedRef.current = false;
    traceRef.current = createRecorder({ enabled: wantEnabled, sessionId: id, root: cfgTrace?.root });
    return traceRef.current;
  }, [ensureSessionId]);

  const ensureTraceStarted = useCallback(
    async (info: TraceStartInfo): Promise<TraceRecorder> => {
      const trace = ensureTrace();
      if (!trace.enabled || traceStartedRef.current) return trace;
      traceStartedRef.current = true;
      await emitSessionStart(trace, {
        cwd: process.cwd(),
        model: info.model,
        mode: info.mode,
        config: info.config,
        tools: info.tools,
        systemPrompt: info.systemPrompt,
        toolProfile: info.toolProfile,
      });
      return trace;
    },
    [ensureTrace],
  );

  // Close the trace when the app unmounts (/exit) or the process exits
  // (Ctrl+C, crash). The write is synchronous, so it is safe in the exit
  // handler; `endTrace` is idempotent, so both paths may run.
  React.useEffect(() => {
    const onExit = () => endTrace("exit");
    process.on("exit", onExit);
    return () => {
      process.off("exit", onExit);
      endTrace("exit");
    };
  }, [endTrace]);

  const saveSessionSafe = useCallback(async () => {
    const d = depsRef.current;
    if (!d.cfg) return;
    ensureSessionId();
    const now = new Date().toISOString();
    if (!sessionCreatedAtRef.current) {
      sessionCreatedAtRef.current = now;
    }
    try {
      await saveSession({
        id: sessionIdRef.current!,
        cwd: process.cwd(),
        model: d.cfg.model,
        createdAt: sessionCreatedAtRef.current,
        updatedAt: now,
        title: sessionTitleRef.current ?? undefined,
        messages: d.messagesRef.current,
        sessionState: d.compiledContextRef.current ? d.sessionStateRef.current : undefined,
        artifactStore: serializeArtifactStore(d.artifactStoreRef.current),
      });
    } catch (e) {
      d.setEvents((es) => [
        ...es,
        { kind: "error", key: d.mkKey(), text: `session save failed: ${(e as Error).message}` },
      ]);
    }
  }, [ensureSessionId]);

  const openResumePicker = useCallback(async () => {
    const sessions = await listSessions(200, process.cwd());
    setResumeSessions(sessions);
  }, []);

  const doResumeSession = useCallback(
    async (filePath: string, checkpointId?: string) => {
      const d = depsRef.current;
      try {
        setResumeProgress(0);
        setResumeStage("Loading session file…");
        startSmoothProgress(0, 10, 400);
        const loaded = checkpointId ? await loadSessionFromCheckpoint(filePath, checkpointId) : null;
        const file = loaded ? loaded.file : await loadSession(filePath);

        setResumeProgress(10);
        setResumeStage("Restoring artifact store…");
        startSmoothProgress(10, 20, 400);
        d.messagesRef.current = file.messages;
        // Restoring a checkpoint of the current session discards the turns
        // that ended after it: a negative signal for those turns.
        if (loaded && file.id === sessionIdRef.current) {
          const since = Date.parse(loaded.checkpoint.timestamp);
          traceReverted("restore_checkpoint", turnHistoryRef.current.filter((t) => Number.isNaN(since) || t.endedAt > since));
        }
        endTrace(checkpointId ? "restore_checkpoint" : "exit");
        turnHistoryRef.current = [];
        sessionIdRef.current = file.id;
        sessionTitleRef.current = file.title ?? null;
        if (file.title) setTerminalTitle(file.title);
        setLogSessionId(file.id);
        sessionCreatedAtRef.current = file.createdAt;
        if (file.sessionState && d.compiledContextRef.current) {
          d.sessionStateRef.current = file.sessionState;
        }
        if (file.artifactStore) {
          d.artifactStoreRef.current = deserializeArtifactStore(file.artifactStore);
        } else {
          d.artifactStoreRef.current = new ArtifactStore();
        }

        setResumeProgress(20);
        setResumeStage("Recalling memories…");
        startSmoothProgress(20, 35, 3000);
        const manager = d.memoryManagerRef.current;
        if (manager) {
          try {
            const cwd = process.cwd();
            const results = await manager.recall({ text: cwd, repoPath: cwd, limit: 5 });
            if (results.length > 0) {
              const text = await manager.synthesizeRecalled(results);
              injectRecalledMemoryOnce(d.messagesRef.current, text);
            }
          } catch {
            // Non-fatal
          }
        }

        setResumeProgress(35);
        setResumeStage("Building local summary…");
        startSmoothProgress(35, 40, 600);
        const nonSystemCount = file.messages.filter((m) => m.role !== "system").length;
        const msg = checkpointId
          ? `resumed session ${file.id} from checkpoint`
          : `resumed session ${file.id} (${nonSystemCount} msgs)`;
        d.setEvents([{ kind: "info", key: d.mkKey(), text: msg }]);

        const localSummary = buildLocalResumeSummary(d.sessionStateRef.current);
        if (localSummary) {
          d.setEvents((es) => [
            ...es,
            { kind: "info", key: d.mkKey(), text: localSummary },
          ]);
        }

        if (d.cfg && hasLlmAuth(llmAuthFromConfig(d.cfg))) {
          setResumeProgress(40);
          setResumeStage("Generating continuation summary…");
          // Smooth crawl from 40 % → 80 % over 12 s.  If tokens stream fast
          // the onProgress boosts will pull it ahead of the timer.
          startSmoothProgress(40, 80, 12000);
          try {
            const summary = await generateContinuationSummary({
              messages: d.messagesRef.current,
              mode: d.mode,
              ...llmAuthFromConfig(d.cfg),
              model: plumbingModelOf(d.cfg),
              memoryManager: d.memoryManagerRef.current,
              memoryEnabled: d.cfg.memoryEnabled,
              onProgress: (charDelta) => {
                // Each token (~4 chars) boosts ~1 %.  This is visible even
                // for single-token deltas and keeps the bar ahead of the
                // fallback timer when the model is fast.
                setResumeProgress((prev) => Math.min(90, prev + charDelta * 0.008));
              },
            });
            if (summary) {
              d.setEvents((es) => [
                ...es,
                { kind: "info", key: d.mkKey(), text: summary },
              ]);
              d.messagesRef.current.push({
                role: "system",
                content: `[session resume summary]\n${summary}`,
              });
            }
          } catch {
            // Non-fatal — local summary already shown
          }
        }

        stopSmoothProgress();
        setResumeProgress(95);
        setResumeStage("Finalizing…");
        startSmoothProgress(95, 100, 400);

        // Suggest /fresh for long auto/edit sessions resumed without a checkpoint
        if (!checkpointId) {
          const threshold = d.cfg?.autoFreshSuggestionTurns ?? DEFAULT_AUTO_FRESH_SUGGESTION_TURNS;
          if (
            threshold > 0 &&
            nonSystemCount >= threshold &&
            (d.mode === "auto" || d.mode === "edit")
          ) {
            d.setEvents((es) => [
              ...es,
              {
                kind: "info",
                key: d.mkKey(),
                text: `This session has ${nonSystemCount} turns. The model may slow down with accumulated context. Run /fresh to continue with a summarized state, or /compact to compress history.`,
              },
            ]);
          }
        }

        setResumeProgress(100);
        const userMsgs = file.messages
          .filter((m) => m.role === "user" && m.content)
          .map((m) => {
            if (!m.content) return "";
            if (typeof m.content === "string") return m.content;
            const textPart = m.content.find((p) => p.type === "text");
            return textPart?.text ?? "";
          })
          .filter((text) => text.length > 0);
        if (userMsgs.length > 0) d.setHistory(userMsgs);
        d.setUsage(null);
        d.setSessionUsage(null);
        d.responseMetaRef.current = null;
        d.setResponseMeta(null);
        void getCostReport(file.id).then((report) => d.setSessionUsage(report.session));
      } catch (e) {
        stopSmoothProgress();
        d.setEvents((es) => [
          ...es,
          { kind: "error", key: d.mkKey(), text: `failed to load session: ${(e as Error).message}` },
        ]);
      }
    },
    [startSmoothProgress, stopSmoothProgress],
  );

  const handleResumePick = useCallback(
    async (picked: SessionSummary | null) => {
      setResumeSessions(null);
      if (!picked) return;
      if (picked.checkpointCount > 0) {
        // Load checkpoints and show picker.
        try {
          const file = await loadSession(picked.filePath);
          setCheckpointList(file.checkpoints ?? []);
          setCheckpointSession(picked);
        } catch (e) {
          depsRef.current.setEvents((es) => [
            ...es,
            { kind: "error", key: depsRef.current.mkKey(), text: `failed to load checkpoints: ${(e as Error).message}` },
          ]);
          setResuming(true);
          setResumingMessage("Pulling context…");
          setResumeProgress(0);
          setResumeStage("");
          try {
            await doResumeSession(picked.filePath);
          } finally {
            setResuming(false);
          }
        }
        return;
      }
      setResuming(true);
      setResumingMessage("Pulling context…");
      setResumeProgress(0);
      setResumeStage("");
      try {
        await doResumeSession(picked.filePath);
      } finally {
        setResuming(false);
      }
    },
    [doResumeSession],
  );

  const handleCheckpointPick = useCallback(
    async (checkpointId: string | null) => {
      const session = checkpointSession;
      setCheckpointSession(null);
      setCheckpointList([]);
      if (!session || !checkpointId) {
        // User cancelled or went back — reopen the session list.
        if (session) {
          setResumeSessions(await listSessions(200, process.cwd()));
        }
        return;
      }
      setResuming(true);
      setResumingMessage("Pulling context…");
      setResumeProgress(0);
      setResumeStage("");
      try {
        if (checkpointId === "__start__") {
          await doResumeSession(session.filePath);
          return;
        }
        await doResumeSession(session.filePath, checkpointId);
      } finally {
        setResuming(false);
      }
    },
    [checkpointSession, doResumeSession],
  );

  const resetSession = useCallback(() => {
    // A /clear within two turns of a turn is a negative signal for it.
    traceReverted("clear", turnHistoryRef.current.slice(-2));
    turnHistoryRef.current = [];
    endTrace("clear");
    sessionIdRef.current = null;
    setLogSessionId(null);
    sessionCreatedAtRef.current = null;
    sessionTitleRef.current = null;
    setTerminalTitle("autopilot");
    const d = depsRef.current;
    d.sessionStateRef.current = emptySessionState();
    d.artifactStoreRef.current = new ArtifactStore();
  }, [endTrace, traceReverted]);

  return {
    sessionIdRef,
    sessionCreatedAtRef,
    sessionTitleRef,
    resumeSessions, setResumeSessions,
    checkpointSession, setCheckpointSession,
    checkpointList, setCheckpointList,
    hasPickerOpen: resumeSessions !== null || checkpointSession !== null,
    resuming,
    resumingMessage,
    resumeProgress,
    resumeStage,
    ensureSessionId,
    saveSessionSafe,
    openResumePicker,
    doResumeSession,
    handleResumePick,
    handleCheckpointPick,
    resetSession,
    traceRef,
    ensureTrace,
    ensureTraceStarted,
    endTrace,
    turnHistoryRef,
    noteTurnEnded,
  };
}
