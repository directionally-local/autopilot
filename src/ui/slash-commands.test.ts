import { describe, it } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { executeFreshStart, type SlashContext } from "./slash-commands.js";
import { loadSession, saveSession, sessionsDir, type SessionFile } from "../sessions.js";
import type { ChatMessage } from "../agent/messages.js";
import { emptySessionState } from "../agent/session-state.js";

function ref<T>(value: T): { current: T } {
  return { current: value };
}

/** The slice of SlashContext executeFreshStart touches, with a real session save. */
function fakeCtx(oldSessionId: string | null) {
  const sessionIdRef = ref<string | null>(oldSessionId);
  const continuedFromRef = ref<string | null>(null);
  const messagesRef = ref<ChatMessage[]>([{ role: "system", content: "sys" }]);
  let savePromise: Promise<void> | null = null;

  const ctx = {
    exit: () => {},
    busy: false,
    mkKey: () => "k",
    setEvents: () => {},
    cfg: { model: "unknown/model", preferPullRequests: true, memoryEnabled: false },
    setCfg: () => {},
    mode: "edit",
    setMode: () => {},
    setShowReasoning: () => {},
    setUsage: () => {},
    setSessionUsage: () => {},
    setShowModelPicker: () => {},
    setProviderSetup: () => {},
    setShowModePicker: () => {},
    setShowInboxModal: () => {},
    setShowLspWizard: () => {},
    setShowCommandList: () => {},
    setCommandWizard: () => {},
    setCommandPicker: () => {},
    setShowHooksDashboard: () => {},
    setShowHelpMenu: () => {},
    setShowMemoryPicker: () => {},
    setShowSkillsPicker: () => {},
    setShowShellPicker: () => {},
    setShowChangelogImagePicker: () => {},
    setChangelogImageRepo: () => {},
    setTasks: () => {},
    lspScope: "project",
    lspProjectPath: null,
    resetSession: () => {
      sessionIdRef.current = null;
    },
    clearTaskTracking: () => {},
    openResumePicker: () => {},
    runCompact: () => {},
    runInit: () => {},
    initMcp: () => {},
    initLsp: () => {},
    ensureSessionId: () => {
      if (!sessionIdRef.current) sessionIdRef.current = "new-session";
      return sessionIdRef.current;
    },
    saveSessionSafe: () => {
      savePromise = (async () => {
        const file: SessionFile = {
          id: sessionIdRef.current!,
          cwd: "/repo",
          model: "unknown/model",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: messagesRef.current,
          continuedFrom: continuedFromRef.current ?? undefined,
        };
        await saveSession(file);
      })();
      return savePromise;
    },
    lspManagerRef: ref({}),
    mcpManagerRef: ref({}),
    hooksManagerRef: ref({}),
    cacheStableRef: ref(false),
    messagesRef,
    flushTimeoutRef: ref(null),
    pendingTextRef: ref(new Map()),
    activeAsstIdRef: ref(null),
    pendingToolCallsRef: ref(new Map()),
    usageRef: ref(null),
    turnCounterRef: ref(0),
    responseMetaRef: ref(null),
    executorRef: ref({ clearArtifacts: () => {} }),
    mcpToolsRef: ref([]),
    mcpInitRef: ref(false),
    lspToolsRef: ref([]),
    lspInitRef: ref(false),
    sessionIdRef,
    continuedFromRef,
    compactSuggestedRef: ref(false),
    updateNudgedRef: ref(false),
    freshSuggestedRef: ref(false),
    memoryManagerRef: ref(null),
    artifactStoreRef: ref({}),
    sessionStateRef: ref(emptySessionState()),
    compiledContextRef: ref(false),
    lastApiErrorRef: ref(null),
    activeScopeRef: ref(null),
    sessionPlanRef: ref(null),
    traceRef: ref({}),
    turnHistoryRef: ref([]),
  };

  return { ctx: ctx as unknown as SlashContext, messagesRef, continuedFromRef, getSave: () => savePromise };
}

const HANDOFF = "Goal: g\nCompleted: c\nRemaining: r\nCurrent state: s\nContext: x";

describe("executeFreshStart: session link (criterion 5)", () => {
  it("records continuedFrom, cites the old id, and persists the link on the new session", async () => {
    const { ctx, messagesRef, continuedFromRef, getSave } = fakeCtx("old-session");

    executeFreshStart(ctx, HANDOFF);

    assert.equal(continuedFromRef.current, "old-session", "the link is recorded on the new session");
    const seeded = messagesRef.current[messagesRef.current.length - 1]!;
    assert.match(String(seeded.content), /^Continued from session: old-session/);

    await getSave();
    const saved = await loadSession(join(sessionsDir(), "new-session.json"));
    assert.equal(saved.continuedFrom, "old-session");
    assert.match(String(saved.messages[saved.messages.length - 1]!.content), /^Continued from session: old-session/);
  });

  it("does not invent a link when there was no old session", async () => {
    const { ctx, continuedFromRef } = fakeCtx(null);
    executeFreshStart(ctx, HANDOFF);
    assert.equal(continuedFromRef.current, null);
  });
});
