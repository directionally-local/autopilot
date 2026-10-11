/**
 * `/compact` action extracted from app.tsx.
 *
 * Compacts the conversation either via artifact archiving (when
 * compiledContext is enabled) or via LLM summarization. Surfaces info
 * events and saves the session on success. Identical behavior to the
 * prior in-component `runCompact` callback.
 */
import React from "react";

import type { Cfg } from "../app.js";
import type { ChatEvent } from "./../ui/chat.js";
import type { ChatMessage } from "./messages.js";
import {
  compactMessagesViaArtifacts,
} from "./artifact-compaction.js";
import { summarizeMessagesViaLlm } from "./llm-summarize.js";
import { ArtifactStore, type SessionState } from "./session-state.js";
import type { AbortScope } from "../util/abort-scope.js";
import { logger } from "../util/logger.js";
import { compactEventsVisual } from "../ui/app-helpers.js";
import { llmAuthFromConfig } from "./llm-auth.js";
import type { HooksManager } from "../hooks/manager.js";
import type { TurnSupervisor } from "./supervisor.js";
import type { TraceRecorder } from "../trace/recorder.js";
import { traceCompiledCompaction, traceLlmCompaction } from "../trace/compaction.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

export interface RunCompactDeps {
  cfg: Cfg;
  busy: boolean;
  mkKey: () => string;
  setEvents: SetEvents;

  beginTurn: () => void;
  endTurn: () => void;
  saveSessionSafe: () => Promise<void> | void;
  clearPermissionResolveRef: () => void;

  sessionScopeRef: React.MutableRefObject<AbortScope>;
  activeScopeRef: React.MutableRefObject<AbortScope | null>;
  compiledContextRef: React.MutableRefObject<boolean>;
  artifactStoreRef: React.MutableRefObject<ArtifactStore>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  sessionStateRef: React.MutableRefObject<SessionState>;
  pendingToolCallsRef: React.MutableRefObject<Map<string, string>>;
  /** M6.1: fire PreCompact before compaction runs. Optional — if
   *  omitted, no hooks fire (back-compat for SDK callers). */
  hooks?: HooksManager;
  sessionId?: string | null;
  supervisorRef: React.MutableRefObject<TurnSupervisor>;
  /** Session trace; `/compact` records a `compaction` event on it. */
  trace?: TraceRecorder | null;
}

export async function runCompact(deps: RunCompactDeps): Promise<void> {
  const {
    cfg, busy, mkKey, setEvents,
    beginTurn, endTurn, saveSessionSafe, clearPermissionResolveRef,
    sessionScopeRef, activeScopeRef, compiledContextRef,
    artifactStoreRef, messagesRef, sessionStateRef,
    pendingToolCallsRef,
    hooks, sessionId,
    supervisorRef,
    trace,
  } = deps;

  if (busy || supervisorRef.current.isRunning) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "can't compact while model is running" },
    ]);
    return;
  }
  beginTurn();
  const turnScope = sessionScopeRef.current.createChild();
  activeScopeRef.current = turnScope;

  // M6.1: PreCompact hook (informational, fire-and-forget). Lets the
  // user snapshot the conversation before it shrinks.
  if (hooks?.hasEnabledHooks("PreCompact")) {
    void hooks
      .fire(
        "PreCompact",
        {
          event: "PreCompact",
          session_id: sessionId ?? null,
          cwd: process.cwd(),
        },
        null,
        turnScope.signal,
      )
      .catch(() => {});
  }

  try {
    if (compiledContextRef.current) {
      const store = artifactStoreRef.current;
      const result = compactMessagesViaArtifacts({
        messages: messagesRef.current,
        state: sessionStateRef.current,
        store,
      });
      if (result.metrics.rawTurnsRemoved === 0) {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "nothing to compact yet" }]);
      } else {
        traceCompiledCompaction(trace, result);
        messagesRef.current = result.newMessages;
        sessionStateRef.current = result.newState;
        setEvents((e) =>
          compactEventsVisual(
            [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `compacted ${result.metrics.rawTurnsRemoved} turns → ${result.metrics.estimatedTokensBefore} → ${result.metrics.estimatedTokensAfter} tokens, ${result.metrics.archivedArtifacts} artifacts`,
              },
            ],
            4,
          ),
        );
        await saveSessionSafe();
      }
    } else {
      const before = messagesRef.current;
      const result = await summarizeMessagesViaLlm({
        ...llmAuthFromConfig(cfg),
        model: cfg.model,
        messages: messagesRef.current,
        signal: turnScope.signal,
      });
      if (result.replacedCount === 0) {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "nothing to compact yet" }]);
      } else {
        traceLlmCompaction(trace, before, result);
        messagesRef.current = result.newMessages;
        setEvents((e) =>
          compactEventsVisual(
            [
              ...e,
              {
                kind: "info",
                key: mkKey(),
                text: `compacted ${result.replacedCount} messages into a summary`,
              },
            ],
            4,
          ),
        );
        await saveSessionSafe();
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      setEvents((es) => [
        ...es,
        { kind: "error", key: mkKey(), text: `compact failed: ${(e as Error).message}` },
      ]);
    }
  } finally {
    logger.info("runCompact:finally");
    endTurn();
    activeScopeRef.current = null;
    clearPermissionResolveRef();
    pendingToolCallsRef.current.clear();
  }
}
