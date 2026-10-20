/**
 * Slash-command dispatcher extracted from app.tsx.
 *
 * Each handler reads/writes app state through the `SlashContext` interface
 * — the same "deps bag" pattern used by `input-handlers.ts`. The dispatcher
 * matches the first whitespace-delimited token (lowercased) against the
 * registry. Behaviorally identical to the previous in-component
 * `handleSlash` callback.
 */
import React from "react";
import { workerRegistry } from "../tools/worker-registry.js";
import { formatSubagentStats, readSubagentStats } from "../tools/subagent-stats.js";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import QRCode from "qrcode";

import type { Cfg } from "../app.js";
import { configPath, loadConfig, saveConfig, patchPersistedConfig, DEFAULT_MODEL, plumbingModelOf } from "../config.js";
import type { ChatEvent } from "./chat.js";
import type { ChatMessage, Usage } from "../agent/messages.js";
import type { ResponseMeta } from "../agent/client.js";
import { activeOpenRouterKey, llmAuthFromConfig, usesRequesty } from "../agent/llm-auth.js";
import { askJev, presentJevAnswer, type JevQuestion } from "../agent/jev.js";
import { buildJevContext, formatJevContextReceipt } from "../agent/jev-context.js";
import { checkOpenRouterKey, looksLikeOpenRouterKey, OPENROUTER_KEYS_URL } from "../models/openrouter.js";
import { checkRequestyKey } from "../models/requesty.js";
import type { Mode } from "../mode.js";
import type { SubagentPolicy } from "../intent/subagent-policy.js";
import type { DailyUsage } from "../usage-tracker.js";
import {
  carryOverSessionBaseline,
  formatCostReport,
  formatGenerationsSection,
  getCostReport,
  getSessionGenerations,
} from "../usage-tracker.js";
import { resolveTheme, themeNames, DEFAULT_THEME_NAME } from "./theme.js";
import { listModels, getModelOrInfer, migrateLegacyModelId, vendorOf, isFreeModel, type ModelEntry } from "../models/registry.js";
import { validateModelId } from "../agent/client.js";
import { getShellCommand } from "../tools/bash.js";
import {
  createSkill,
  deleteSkill,
  findSkillFile,
  listAllSkills,
  setSkillEnabled,
} from "../skills/manager.js";
import {
  addCheckpoint,
  loadSession,
  type Checkpoint,
} from "../sessions.js";
import {
  type ArtifactStore,
  serializeArtifactStore,
  type SessionState,
} from "../agent/session-state.js";
import { ALL_TOOLS, type ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import type { MemoryManager } from "../memory/manager.js";
import type { HooksManager } from "../hooks/manager.js";
import { RECOMMENDED_HOOKS, getRecommendedHook } from "../hooks/recommended.js";
import {
  appendHook,
  setHookEnabled,
  globalSettingsPath,
  projectSettingsPath,
} from "../hooks/settings.js";
import { HOOK_EVENTS } from "../hooks/types.js";
import type { AbortScope } from "../util/abort-scope.js";
import type { CustomCommand } from "../commands/types.js";
import { checkForUpdate } from "../util/update-check.js";
import { getAppVersion } from "../util/version.js";
import {
  detectGitHubRepo,
  FEEDBACK_WORKER_URL,
  formatTokens,
  mkAssistantId,
  openBrowser,
  rebuildSystemPromptForMode,
} from "./app-helpers.js";
import { startRemoteSession, streamRemoteProgress } from "../remote/worker-client.js";
import { saveRemoteSession, type RemoteSession } from "../remote/session-store.js";
import { deployForTui } from "../remote/deploy.js";
import { authGitHubForTui } from "../remote/tui-auth.js";
import { resolvePlanForFresh } from "../agent/plan-resolver.js";
import { generateContinuationSummary } from "../agent/continuation-summary.js";
import { writeToClipboard } from "../util/clipboard.js";
import type { Task } from "../tools/registry.js";
import type { TraceRecorder } from "../trace/recorder.js";
import type { TurnRecord } from "./use-session-manager.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

export interface SlashContext {
  // App-level
  exit: () => void;
  busy: boolean;
  mkKey: () => string;
  setEvents: SetEvents;

  // Config
  cfg: Cfg | null;
  setCfg: React.Dispatch<React.SetStateAction<Cfg | null>>;

  // Mode / reasoning
  mode: Mode;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  setShowReasoning: React.Dispatch<React.SetStateAction<boolean>>;

  // Misc UI state setters
  setUsage: React.Dispatch<React.SetStateAction<Usage | null>>;
  setSessionUsage: React.Dispatch<React.SetStateAction<DailyUsage | null>>;
  setResponseMeta: React.Dispatch<React.SetStateAction<ResponseMeta | null>>;
  setHasUpdate: React.Dispatch<React.SetStateAction<boolean>>;
  setLatestVersion: React.Dispatch<React.SetStateAction<string | null>>;

  // Modal setters
  setShowThemePicker: (v: boolean) => void;
  setShowModelPicker: (v: boolean) => void;
  setShowModePicker: (v: boolean) => void;
  setShowInboxModal: (v: boolean) => void;
  setShowLspWizard: (v: boolean) => void;
  setShowRemoteDashboard: (v: boolean) => void;
  setShowCommandList: (v: boolean) => void;
  setCommandWizard: (v: { mode: "create" | "edit"; command?: CustomCommand } | null) => void;
  setCommandPicker: (v: { mode: "edit" | "delete" } | null) => void;
  setShowHooksDashboard: (v: boolean) => void;
  setShowHelpMenu: (v: boolean) => void;
  setShowMemoryPicker: (v: boolean) => void;
  setShowSkillsPicker: (v: boolean) => void;
  setShowShellPicker: (v: boolean) => void;
  setShowChangelogImagePicker: (v: boolean) => void;
  setChangelogImageRepo: React.Dispatch<React.SetStateAction<{ owner: string; name: string } | null>>;

  // Task tracking (for non-turn UI like changelog-image generation)
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  setTasksStartedAt: (n: number | null) => void;

  // LSP scope (for /lsp scope)
  lspScope: "project" | "global";
  lspProjectPath: string | null;

  // Async actions exposed by useCallback hooks in App
  resetSession: () => void;
  clearTaskTracking: () => void;
  openResumePicker: () => void | Promise<void>;
  runCompact: () => Promise<void> | void;
  runInit: () => Promise<void> | void;
  initMcp: () => Promise<void> | void;
  initLsp: () => Promise<void> | void;
  ensureSessionId: () => unknown;

  // Refs
  lspManagerRef: React.MutableRefObject<LspManager>;
  mcpManagerRef: React.MutableRefObject<McpManager>;
  hooksManagerRef: React.MutableRefObject<HooksManager>;
  cacheStableRef: React.MutableRefObject<boolean>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  flushTimeoutRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pendingTextRef: React.MutableRefObject<Map<number, { text: string; reasoning: string }>>;
  activeAsstIdRef: React.MutableRefObject<number | null>;
  pendingToolCallsRef: React.MutableRefObject<Map<string, string>>;
  usageRef: React.MutableRefObject<Usage | null>;
  turnCounterRef: React.MutableRefObject<number>;
  responseMetaRef: React.MutableRefObject<ResponseMeta | null>;
  executorRef: React.MutableRefObject<ToolExecutor>;
  mcpToolsRef: React.MutableRefObject<ToolSpec[]>;
  mcpInitRef: React.MutableRefObject<boolean>;
  lspToolsRef: React.MutableRefObject<ToolSpec[]>;
  lspInitRef: React.MutableRefObject<boolean>;
  sessionIdRef: React.MutableRefObject<string | null>;
  compactSuggestedRef: React.MutableRefObject<boolean>;
  updateNudgedRef: React.MutableRefObject<boolean>;
  freshSuggestedRef: React.MutableRefObject<boolean>;
  memoryManagerRef: React.MutableRefObject<MemoryManager | null>;
  artifactStoreRef: React.MutableRefObject<ArtifactStore>;
  sessionStateRef: React.MutableRefObject<SessionState>;
  compiledContextRef: React.MutableRefObject<boolean>;
  lastApiErrorRef: React.MutableRefObject<{ httpStatus?: number; code?: number; message: string } | null>;
  activeScopeRef: React.MutableRefObject<AbortScope | null>;
  sessionPlanRef: React.MutableRefObject<string | null>;
  /** Session trace recorder (src/trace); a no-op unless tracing is enabled. */
  traceRef: React.MutableRefObject<TraceRecorder>;
  /** Turns of this session that have ended, oldest first (for /good, /bad, and revert signals). */
  turnHistoryRef: React.MutableRefObject<TurnRecord[]>;
}

type Handler = (ctx: SlashContext, rest: string[], arg: string) => boolean | Promise<boolean>;

// ── Handlers ─────────────────────────────────────────────────────────────

const handleExit: Handler = (ctx) => {
  void ctx.lspManagerRef.current.stopAll().finally(() => ctx.exit());
  return true;
};

const handleClear: Handler = (ctx) => {
  const { busy, mkKey, setEvents } = ctx;
  if (busy) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "can't /clear while model is running — press Esc to interrupt first" },
    ]);
    return true;
  }
  if (ctx.cacheStableRef.current && ctx.messagesRef.current.length >= 2) {
    ctx.messagesRef.current = [ctx.messagesRef.current[0]!, ctx.messagesRef.current[1]!];
  } else {
    ctx.messagesRef.current = [ctx.messagesRef.current[0]!];
  }
  ctx.resetSession();
  ctx.executorRef.current.clearArtifacts();
  if (ctx.flushTimeoutRef.current) {
    clearTimeout(ctx.flushTimeoutRef.current);
    ctx.flushTimeoutRef.current = null;
  }
  ctx.pendingTextRef.current.clear();
  ctx.activeAsstIdRef.current = null;
  ctx.pendingToolCallsRef.current.clear();
  ctx.usageRef.current = null;
  ctx.turnCounterRef.current = 0;
  // Finished events are printed once via <Static> and aren't part of Ink's
  // live output, so emptying `events` no longer blanks the screen. Clear the
  // visible screen ourselves; scrollback is left alone on purpose.
  if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
  setEvents([]);
  ctx.setUsage(null);
  ctx.setSessionUsage(null);
  ctx.responseMetaRef.current = null;
  ctx.setResponseMeta(null);
  ctx.clearTaskTracking();
  ctx.compactSuggestedRef.current = false;
  ctx.updateNudgedRef.current = false;
  ctx.freshSuggestedRef.current = false;
  ctx.sessionPlanRef.current = null;
  return true;
};

export function executeFreshStart(
  ctx: SlashContext,
  planText: string,
  overrideMode?: Mode,
  opts: { seedMessages?: boolean } = {},
): { success: boolean } {
  // Capture old session ID before reset so we can carry its cost forward
  const oldSessionId = ctx.sessionIdRef.current;

  // Reset session (reuse /clear logic)
  if (ctx.cacheStableRef.current && ctx.messagesRef.current.length >= 2) {
    ctx.messagesRef.current = [ctx.messagesRef.current[0]!, ctx.messagesRef.current[1]!];
  } else {
    ctx.messagesRef.current = [ctx.messagesRef.current[0]!];
  }
  ctx.resetSession();
  ctx.executorRef.current.clearArtifacts();
  if (ctx.flushTimeoutRef.current) {
    clearTimeout(ctx.flushTimeoutRef.current);
    ctx.flushTimeoutRef.current = null;
  }
  ctx.pendingTextRef.current.clear();
  ctx.activeAsstIdRef.current = null;
  ctx.pendingToolCallsRef.current.clear();
  ctx.usageRef.current = null;
  ctx.turnCounterRef.current = 0;
  ctx.setEvents([]);
  ctx.setUsage(null);
  ctx.setSessionUsage(null);
  ctx.responseMetaRef.current = null;
  ctx.setResponseMeta(null);
  ctx.clearTaskTracking();
  ctx.compactSuggestedRef.current = false;
  ctx.updateNudgedRef.current = false;
  ctx.freshSuggestedRef.current = false;
  ctx.sessionPlanRef.current = null;

  // Rebuild system prompt for the current mode so the agent sees the
  // correct instructions (e.g. auto mode) instead of a stale plan-mode prompt.
  rebuildSystemPromptForMode(
    ctx.messagesRef.current,
    ctx.cacheStableRef.current,
    ctx.cfg?.model ?? DEFAULT_MODEL,
    overrideMode ?? ctx.mode,
    [...ALL_TOOLS, ...ctx.mcpToolsRef.current, ...ctx.lspToolsRef.current],
    ctx.cfg?.preferPullRequests,
  );

  // Seed with plan unless the caller will submit it separately (e.g. the
  // Ink plan-complete picker already calls submitRef.current(plan)).
  if (opts.seedMessages !== false) {
    ctx.messagesRef.current.push({ role: "user", content: planText });
  }

  // Force creation of the new session ID and carry over the old cost baseline
  const newSessionId = ctx.ensureSessionId() as string;
  if (oldSessionId) {
    void carryOverSessionBaseline(oldSessionId, newSessionId).then(() => {
      void getCostReport(newSessionId).then((report) => ctx.setSessionUsage(report.session));
    });
  }

  return writeToClipboard(planText);
}

const handleFresh: Handler = async (ctx) => {
  const { busy, mkKey, setEvents, cfg } = ctx;
  if (busy) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "can't /fresh while model is running — press Esc to interrupt first" },
    ]);
    return true;
  }

  // Mode-aware summary: plan mode uses the captured plan (in-session ref or
  // durable memory topic key); auto/edit/multi-agent produce a handoff document
  // via LLM.
  const summary =
    ctx.mode === "plan"
      ? resolvePlanForFresh({
          mode: ctx.mode,
          messages: ctx.messagesRef.current,
          sessionPlan: ctx.sessionPlanRef.current,
          memoryManager: ctx.memoryManagerRef.current,
          memoryEnabled: cfg?.memoryEnabled,
          repoPath: process.cwd(),
        })
      : await generateContinuationSummary({
          messages: ctx.messagesRef.current,
          mode: ctx.mode,
          ...llmAuthFromConfig(cfg),
          model: plumbingModelOf(cfg),
          memoryManager: ctx.memoryManagerRef.current,
          memoryEnabled: cfg?.memoryEnabled,
        });

  if (!summary) {
    setEvents((e) => [
      ...e,
      { kind: "error", key: mkKey(), text: "No plan or summary found to start fresh with." },
    ]);
    return true;
  }

  const clipResult = executeFreshStart(ctx, summary);

  setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: mkKey(),
      text: clipResult.success
        ? "Summary copied to clipboard. Starting fresh session with continuation context…"
        : "Clipboard unavailable. Starting fresh session with continuation context…",
    },
  ]);

  if (!clipResult.success) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "--- Continuation Context ---\n" + summary },
    ]);
  }

  return true;
};

const handleReasoning: Handler = (ctx) => {
  ctx.setShowReasoning((s) => {
    const next = !s;
    ctx.setEvents((e) => [
      ...e,
      { kind: "info", key: ctx.mkKey(), text: `reasoning: ${next ? "shown" : "hidden"}` },
    ]);
    return next;
  });
  return true;
};

const handleCost: Handler = (ctx, _rest, arg) => {
  const { cfg, setCfg, setEvents, mkKey, sessionIdRef } = ctx;
  if (!cfg) return true;
  if (arg === "on") {
    const next = { ...cfg, costAttribution: true };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "cost attribution enabled" }]);
    return true;
  }
  if (arg === "verify") {
    const key = activeOpenRouterKey(cfg);
    if (!key) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "cost verify checks against OpenRouter's generation records, so it needs OpenRouter as the active provider" }]);
      return true;
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "checking this session's numbers against OpenRouter's generation records…" }]);
    void import("../cost-verify.js")
      .then(async ({ pickSession, verifySession, formatVerifyReport }) => {
        const session = await pickSession(sessionIdRef.current ?? undefined);
        const text = session
          ? formatVerifyReport(await verifySession(session, key))
          : "No OpenRouter generations recorded for this session yet.";
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `cost verify failed: ${(err as Error).message}` }]);
      });
    return true;
  }
  if (arg === "off") {
    const next = { ...cfg, costAttribution: false };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "cost attribution disabled" }]);
    return true;
  }
  void getCostReport(sessionIdRef.current ?? undefined)
    .then(async (report) => {
      const lines = [formatCostReport(report)];
      const sid = sessionIdRef.current;
      const logs = sid ? await getSessionGenerations(sid).catch(() => []) : [];
      const genSection = formatGenerationsSection(logs);
      if (genSection) lines.push("", genSection);
      if (cfg?.costAttribution) {
        const { getCategoryReportText } = await import("../cost-attribution/tui-report.js");
        const catReport = await getCategoryReportText(sessionIdRef.current ?? undefined);
        if (catReport) {
          lines.push("", "─── Cost by task type ───", catReport);
        }
      }
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
    })
    .catch((err) => {
      setEvents((e) => [
        ...e,
        { kind: "error", key: mkKey(), text: `cost report failed: ${(err as Error).message}` },
      ]);
    });
  return true;
};

const handleShell: Handler = (ctx, _rest, arg) => {
  const { cfg, setCfg, setEvents, mkKey } = ctx;
  if (!cfg) return true;
  if (!arg) {
    ctx.setShowShellPicker(true);
    return true;
  }
  if (arg === "auto" || arg === "bash" || arg === "cmd" || arg === "powershell") {
    const next = { ...cfg, shell: arg === "auto" ? undefined : arg };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `shell set to ${arg}` }]);
    return true;
  }
  if (arg) {
    // Allow absolute paths as custom shells
    const next = { ...cfg, shell: arg };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `shell set to ${arg}` }]);
    return true;
  }
  const detected = getShellCommand(cfg.shell);
  setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: mkKey(),
      text: `shell: ${cfg.shell ?? "auto"} (${detected.shell} ${detected.args.join(" ")})`,
    },
  ]);
  return true;
};

/** `/subagents list` and the running section of `/subagents`. */
export function formatRunningSubagents(now = Date.now()): string {
  const workers = workerRegistry.list();
  if (workers.length === 0) return "no subagents running";
  return [
    `${workers.length} subagent${workers.length === 1 ? "" : "s"} running:`,
    ...workers.map((w) => `  #${w.index}  ${formatElapsed(now - w.startedAt)}  ${w.status === "cancelling" ? "(cancelling) " : ""}${oneLine(w.task, 90)}`),
    "cancel one with /subagents cancel <n>, or all with /subagents cancel all — the turn keeps going",
  ].join("\n");
}

/** `/subagents cancel <n>|all`: stop specific workers without interrupting the turn. */
export function cancelSubagents(target: string | undefined): string {
  if (!target) return "usage: /subagents cancel <n>|all";
  if (target.toLowerCase() === "all") {
    const n = workerRegistry.cancelAll();
    return n === 0 ? "no subagents running" : `cancelling ${n} subagent${n === 1 ? "" : "s"}; the turn continues without their results`;
  }
  const ref = target.replace(/^#/, "");
  const cancelled = workerRegistry.cancel(/^\d+$/.test(ref) ? Number(ref) : ref);
  if (!cancelled) return `no running subagent #${ref} (see /subagents list)`;
  return `cancelling subagent #${cancelled.index} (${oneLine(cancelled.task, 60)}); the turn continues`;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m${String(sec).padStart(2, "0")}s` : `${sec}s`;
}

function oneLine(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

const handleSubagents: Handler = (ctx, rest, arg) => {
  const { cfg, setCfg, setEvents, mkKey, busy } = ctx;
  const policy = arg as SubagentPolicy;
  if (arg === "stats") {
    void readSubagentStats().then((stats) => {
      setEvents((events) => [...events, { kind: "info", key: mkKey(), text: formatSubagentStats(stats) }]);
    });
    return true;
  }
  if (arg === "list" || arg === "ls") {
    setEvents((events) => [...events, { kind: "info", key: mkKey(), text: formatRunningSubagents() }]);
    return true;
  }
  if (arg.startsWith("cancel") || arg.startsWith("stop")) {
    setEvents((events) => [...events, { kind: "info", key: mkKey(), text: cancelSubagents(rest[1]) }]);
    return true;
  }
  if (!arg || arg === "help") {
    setEvents((events) => [...events, {
      kind: "info",
      key: mkKey(),
      text: `${formatRunningSubagents()}\n\nsubagent policy: ${cfg?.subagentPolicy ?? "auto"}\nusage: /subagents off|suggest|auto · /subagents list · /subagents cancel <n>|all · /subagents stats\n\nauto (default) lets the coordinator assess substantial tasks and delegate independent work; it is conditional, not a promise to spawn. suggest surfaces possible opportunities; off disables automatic suggestions. Explicit user instructions still win. Worker calls use normal permission checks and respect spend, concurrency, timeout, and read-only limits. Subagents run in local Hotcell sandboxes: install and start Hotcell and run "hotcell keys add openrouter". They see your current working tree (including uncommitted changes) and are read-only.`,
    }]);
    return true;
  }
  if (busy) {
    setEvents((events) => [...events, { kind: "info", key: mkKey(), text: "can't change /subagents while the agent is working" }]);
    return true;
  }
  if (policy !== "off" && policy !== "suggest" && policy !== "auto") {
    setEvents((events) => [...events, { kind: "error", key: mkKey(), text: "usage: /subagents off|suggest|auto" }]);
    return true;
  }
  if (!cfg) {
    setEvents((events) => [...events, { kind: "error", key: mkKey(), text: "configure an OpenRouter key or custom endpoint before changing subagent policy" }]);
    return true;
  }
  const next = { ...cfg, subagentPolicy: policy, subagentPolicyExplicit: true };
  setCfg(next);
  void saveConfig(next).catch(() => {});
  setEvents((events) => [...events, {
    kind: "info",
    key: mkKey(),
    text: `subagent policy set to ${policy}${policy === "auto" ? " (worker tool calls still require permission)" : ""}`,
  }]);
  return true;
};

const handleJev: Handler = async (ctx, rest) => {
  const { cfg, setEvents, mkKey } = ctx;
  const info = (text: string, kind: "info" | "error" = "info") =>
    setEvents((events) => [...events, { kind, key: mkKey(), text }]);
  const setResult = (key: string, event: ChatEvent) =>
    setEvents((events) => events.map((item) => item.key === key ? event : item));
  const subcommand = rest[0]?.toLowerCase() ?? "";
  let args = rest.slice(1).join(" ").trim();
  const noContext = /(?:^|\s)--no-context(?=\s|$)/i.test(args);
  const showContext = /(?:^|\s)--show-context(?=\s|$)/i.test(args);
  args = args.replace(/(?:^|\s)--(?:no-context|show-context)(?=\s|$)/gi, " ").trim();

  if (!subcommand || subcommand === "help") {
    info([
      "Jev returns typed decisions, not free-form reasoning, and does not change /model.",
      "It may send recent chat for explicit references and project metadata/license evidence for current-project questions to OpenRouter.",
      "A short context receipt is shown by default; append --show-context to display the exact excerpts sent.",
      "Append --no-context to send only the question.",
      "Jev does not receive system prompts or tool output, read arbitrary source files, or browse the web.",
      "  /jev yes <question>",
      "  /jev choose <question> --options option-a|option-b|...",
      "  /jev score <question> --scale low|medium|high",
    ].join("\n"));
    return true;
  }
  if (ctx.busy) {
    info("can't run /jev while the agent is working — press Esc to interrupt first", "error");
    return true;
  }

  let question: JevQuestion;
  if (subcommand === "yes") {
    if (!args) {
      info("usage: /jev yes <question>", "error");
      return true;
    }
    question = { kind: "yes", prompt: args };
  } else if (subcommand === "choose" || subcommand === "score") {
    const flag = subcommand === "choose" ? "--options" : "--scale";
    const flagIndex = args.toLowerCase().lastIndexOf(`${flag} `);
    if (flagIndex < 0) {
      info(`usage: /jev ${subcommand} <question> ${flag} option-1|option-2|...`, "error");
      return true;
    }
    const prompt = args.slice(0, flagIndex).trim();
    const values = args.slice(flagIndex + flag.length).trim().split("|").map((item) => item.trim()).filter(Boolean);
    if (!prompt || values.length < 2 || values.length > 12 || new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
      info(`${flag} needs a question and 2–12 distinct, non-empty values separated by |`, "error");
      return true;
    }
    question = subcommand === "choose"
      ? { kind: "choose", prompt, options: values }
      : { kind: "score", prompt, scale: values };
  } else {
    info("unknown Jev question type — use /jev yes, /jev choose, or /jev score", "error");
    return true;
  }

  if (question.prompt.length > 4_000) {
    info("Jev questions must be 4,000 characters or fewer", "error");
    return true;
  }
  // Jev is OpenRouter's Decisions API: only available while OpenRouter is the active provider.
  const apiKey = activeOpenRouterKey(cfg);
  if (!apiKey) {
    info(`/jev uses OpenRouter's Decisions API — switch to OpenRouter (and set a key with /key set, from ${OPENROUTER_KEYS_URL}) to use it`, "error");
    return true;
  }

  const eventKey = mkKey();
  setEvents((events) => [
    ...events,
    { kind: "user", key: mkKey(), text: `/jev ${rest.join(" ")}` },
    { kind: "info", key: eventKey, text: "Jev is evaluating…", pending: true },
  ]);
  try {
    const context = noContext ? [] : await buildJevContext(question.prompt, ctx.messagesRef.current, process.cwd());
    const receipt = formatJevContextReceipt(context, showContext);
    setResult(eventKey, { kind: "info", key: eventKey, text: `Jev is evaluating · ${receipt}`, pending: true });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const answer = await askJev(apiKey, question, { context });
    const presentation = presentJevAnswer(question, answer);
    setResult(eventKey, {
      kind: "jev",
      key: eventKey,
      result: presentation.text,
      probability: presentation.probability,
      tone: presentation.tone,
      receipt,
    });
  } catch (error) {
    setResult(eventKey, {
      kind: "error",
      key: eventKey,
      text: `Jev failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return true;
};

const handleModel: Handler = (ctx, rest, arg) => {
  const { cfg, setCfg, setEvents, mkKey } = ctx;
  const sub = rest[0]?.toLowerCase() ?? "";

  // `/model` with no args → open the picker
  if (!arg) {
    ctx.setShowModelPicker(true);
    return true;
  }

  // `/model list [filter]` → textual list grouped by vendor (tool-capable models only)
  if (sub === "list") {
    const filter = rest.slice(1).join(" ").toLowerCase();
    const all = listModels().filter(
      (m) => m.supports.tools && (!filter || m.id.toLowerCase().includes(filter)),
    );
    const byVendor = new Map<string, ModelEntry[]>();
    for (const m of all) {
      const v = isFreeModel(m) ? "free" : vendorOf(m.id);
      const arr = byVendor.get(v) ?? [];
      arr.push(m);
      byVendor.set(v, arr);
    }
    const lines: string[] = [`available models (current: ${cfg?.model ?? "unknown"}):`];
    for (const [vendor, list] of [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${vendor}:`);
      for (const m of list) {
        const marker = m.id === cfg?.model ? "●" : " ";
        const ctxStr = m.contextWindow >= 1_000_000
          ? `${(m.contextWindow / 1_000_000).toFixed(1)}M`
          : `${Math.round(m.contextWindow / 1_000)}k`;
        const price = isFreeModel(m)
          ? "free"
          : `$${Number(m.pricing.inputPerMtok.toPrecision(4))}/$${Number(m.pricing.outputPerMtok.toPrecision(4))}`;
        lines.push(`    ${marker} ${m.id}  (${ctxStr} ctx, ${price} per Mtok)`);
      }
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
    return true;
  }

  // `/model <id>` → set directly. Old Cloudflare ids (@cf/…) are translated.
  const id = migrateLegacyModelId(rest.join(" ").trim());
  try {
    // Requesty managed policy ids ("claude-sonnet-4-5") have no vendor prefix.
    if (!(cfg && usesRequesty(llmAuthFromConfig(cfg)))) validateModelId(id);
    else if (!id) throw new Error("empty model id");
  } catch {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `invalid model id: ${id} — OpenRouter ids look like vendor/model, e.g. ${DEFAULT_MODEL}` },
    ]);
    return true;
  }
  const entry = getModelOrInfer(id);
  const known = listModels().some((m) => m.id === id);
  setCfg((prev) => {
    if (!prev) return prev;
    const updated = { ...prev, model: id };
    void saveConfig(updated).catch(() => {});
    return updated;
  });
  setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: mkKey(),
      text: known
        ? ctx.busy
          ? `model selected: ${id}. The current turn continues with ${cfg?.model ?? "the current model"}; your next message will use ${id}. Conversation history is kept.${entry.supports.tools ? "" : " ⚠ no tool calling — the agent can't edit files or run commands with this model"}`
          : `model switched: ${cfg?.model ? `${cfg.model} → ` : ""}${id}. Your next message will use this model; conversation history is kept.${entry.supports.tools ? "" : " ⚠ no tool calling — the agent can't edit files or run commands with this model"}`
        : ctx.busy
          ? `model selected: ${id} · not in OpenRouter's catalog — check the id with /model list if requests fail. The current turn continues with ${cfg?.model ?? "the current model"}; your next message will use ${id}. Conversation history is kept.`
          : `model selected: ${id} · not in OpenRouter's catalog — check the id with /model list if requests fail. Your next message will use this model; conversation history is kept.`,
    },
  ]);
  return true;
};

/**
 * /settings — feature toggles. `/settings` lists them; `/settings <name> on|off`
 * flips one and persists it to the config file.
 */
const SETTINGS: Record<string, { key: "modesEnabled"; describe: string }> = {
  modes: {
    key: "modesEnabled",
    describe: "plan / edit / auto permission modes (off: every turn runs in auto)",
  },
};

const handleSettings: Handler = (ctx, rest) => {
  const { cfg, setCfg, setEvents, mkKey } = ctx;
  const info = (text: string) => setEvents((e) => [...e, { kind: "info", key: mkKey(), text }]);
  if (!cfg) return true;
  const name = rest[0]?.toLowerCase();
  const value = rest[1]?.toLowerCase();
  if (!name) {
    const lines = ["settings (change with /settings <name> on|off):"];
    for (const [n, s] of Object.entries(SETTINGS)) {
      lines.push(`  ${n.padEnd(8)} ${cfg[s.key] ? "on " : "off"}  ${s.describe}`);
    }
    info(lines.join("\n"));
    return true;
  }
  const setting = SETTINGS[name];
  if (!setting || (value !== "on" && value !== "off")) {
    info(`usage: /settings ${Object.keys(SETTINGS).join("|")} on|off`);
    return true;
  }
  const on = value === "on";
  setCfg((prev) => (prev ? { ...prev, [setting.key]: on } : prev));
  void patchPersistedConfig({ [setting.key]: on }).catch(() => undefined);
  if (setting.key === "modesEnabled") {
    info(
      on
        ? "modes on — now in edit (prompts before mutating tools). Shift+Tab cycles edit → plan → auto; /mode switches directly."
        : "modes off — every turn runs in auto.",
    );
  }
  return true;
};

/** /key — show, replace or clear the OpenRouter API key. */
const handleKey: Handler = async (ctx, rest) => {
  const { cfg, setCfg, setEvents, mkKey } = ctx;
  const info = (text: string, kind: "info" | "error" = "info") =>
    setEvents((e) => [...e, { kind, key: mkKey(), text }]);
  const sub = rest[0]?.toLowerCase() ?? "";
  const envKey = process.env.OPENROUTER_API_KEY || process.env.KIMIFLARE_OPENROUTER_KEY;

  if (sub === "set") {
    const candidate = rest.slice(1).join("").trim();
    if (!candidate) {
      info(`usage: /key set <sk-or-…>  (create a key at ${OPENROUTER_KEYS_URL})`);
      return true;
    }
    if (!looksLikeOpenRouterKey(candidate)) {
      info("that doesn't look like an OpenRouter key — they start with sk-or-", "error");
      return true;
    }
    info("checking key with OpenRouter…");
    const res = await checkOpenRouterKey(candidate);
    if (!res.ok) {
      info(res.reason === "invalid" ? "OpenRouter rejected that key — nothing was saved" : `couldn't verify the key: ${res.message}`, "error");
      return true;
    }
    await patchPersistedConfig({ openrouterApiKey: candidate });
    setCfg((prev) => (prev ? { ...prev, openrouterApiKey: candidate } : prev));
    info(
      `OpenRouter key saved to ${configPath()}` +
        (envKey ? " — note: OPENROUTER_API_KEY in your environment still takes precedence" : ""),
    );
    return true;
  }

  if (sub === "clear") {
    await patchPersistedConfig({ openrouterApiKey: undefined });
    info(
      envKey
        ? "removed the key from the config file (the one in OPENROUTER_API_KEY is still used)"
        : "OpenRouter key removed — autopilot (formerly kimiflare) will ask for one on next launch",
    );
    return true;
  }

  if (cfg && usesRequesty(llmAuthFromConfig(cfg)) && cfg.requestyApiKey) {
    const rq = cfg.requestyApiKey;
    const rqSource = process.env.REQUESTY_API_KEY ? "environment" : "config file";
    const rqRes = await checkRequestyKey(rq);
    const rqMasked = `${rq.slice(0, 8)}…${rq.slice(-4)}`;
    info(
      rqRes.ok ? `Requesty key ${rqMasked} (${rqSource}) · valid` : `Requesty key ${rqMasked} (${rqSource}): ${rqRes.message}`,
      rqRes.ok ? "info" : "error",
    );
    return true;
  }
  const key = cfg?.openrouterApiKey;
  if (!key) {
    info(`no OpenRouter key configured — run /key set <key> (create one at ${OPENROUTER_KEYS_URL})`);
    return true;
  }
  const masked = `${key.slice(0, 8)}…${key.slice(-4)}`;
  const source = envKey ? "environment" : "config file";
  const res = await checkOpenRouterKey(key);
  if (!res.ok) {
    info(`key ${masked} (${source}): ${res.message}`, "error");
    return true;
  }
  const parts = [`key ${masked} (${source})`];
  if (res.info.label) parts.push(`label: ${res.info.label}`);
  if (typeof res.info.usage === "number") parts.push(`spent: $${res.info.usage.toFixed(2)}`);
  if (typeof res.info.limitRemaining === "number") parts.push(`credit left: $${res.info.limitRemaining.toFixed(2)}`);
  if (res.info.isFreeTier) parts.push("free tier (free models only)");
  info(parts.join(" · "));
  return true;
};

/** Plan/edit/auto modes are feature-flagged (cfg.modesEnabled, off by default).
 *  Returns false — after telling the user how to turn them on — when off. */
function modesGate(ctx: SlashContext): boolean {
  if (ctx.cfg?.modesEnabled) return true;
  ctx.setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: ctx.mkKey(),
      text: "Modes are off — every turn runs in auto. Turn plan/edit/auto modes on with  /settings modes on",
    },
  ]);
  return false;
}

const handleMode: Handler = (ctx, _rest, arg) => {
  if (!modesGate(ctx)) return true;
  const { setEvents, mkKey, mode } = ctx;
  if (!arg) {
    ctx.setShowModePicker(true);
    return true;
  }
  if (arg === "edit" || arg === "plan" || arg === "auto") {
    const prevMode = mode;
    ctx.setMode(arg);
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `mode: ${arg}` }]);
    // Nudge about /fresh when switching from plan to auto/edit with heavy context
    if (prevMode === "plan" && (arg === "auto" || arg === "edit")) {
      const nonSystemCount = ctx.messagesRef.current.filter((m) => m.role !== "system").length;
      if (nonSystemCount > 10) {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: "Tip: you have extensive planning context. Run `/fresh` to start clean with just the plan." },
        ]);
      }
    }
    return true;
  }
  setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /mode edit|plan|auto" }]);
  return true;
};

const handleMultiAgent: Handler = (ctx) => {
  ctx.setEvents((events) => [...events, {
    kind: "info",
    key: ctx.mkKey(),
    text: "Remote multi-agent workers and Cloudflare setup are disabled. Research delegation now runs locally through Hotcell; use /subagents auto (or /subagents off).",
  }]);
  return true;
};

const handleTheme: Handler = (ctx, _rest, arg) => {
  const { setEvents, mkKey } = ctx;
  if (!arg) {
    ctx.setShowThemePicker(true);
    return true;
  }
  const next = resolveTheme(arg);
  if (next.name === DEFAULT_THEME_NAME && arg !== DEFAULT_THEME_NAME) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `unknown theme "${arg}" — available: ${themeNames().join(", ")}` },
    ]);
    return true;
  }
  ctx.setCfg((prev) => {
    if (!prev) return prev;
    const updated = { ...prev, theme: next.name };
    void saveConfig(updated).catch(() => {});
    return updated;
  });
  setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `theme: ${next.label} — restart to apply` }]);
  return true;
};

const handlePlan: Handler = (ctx) => {
  if (!modesGate(ctx)) return true;
  ctx.setMode("plan");
  ctx.setEvents((e) => [...e, { kind: "info", key: ctx.mkKey(), text: "mode: plan" }]);
  return true;
};

const handleAuto: Handler = (ctx) => {
  if (!modesGate(ctx)) return true;
  ctx.setMode("auto");
  ctx.setEvents((e) => [...e, { kind: "info", key: ctx.mkKey(), text: "mode: auto" }]);
  return true;
};

const handleEdit: Handler = (ctx) => {
  if (!modesGate(ctx)) return true;
  ctx.setMode("edit");
  ctx.setEvents((e) => [...e, { kind: "info", key: ctx.mkKey(), text: "mode: edit" }]);
  return true;
};

const handleSkills: Handler = (ctx, rest) => {
  const { setEvents, mkKey } = ctx;
  const sub = rest[0]?.toLowerCase() ?? "";
  const subRest = rest.slice(1).join(" ").trim();

  if (sub === "") {
    ctx.setShowSkillsPicker(true);
    return true;
  }

  if (sub === "list") {
    void listAllSkills(process.cwd())
      .then((all) => {
        const lines: string[] = [];
        if (all.project.length > 0) {
          lines.push("project skills:");
          for (const s of all.project) {
            const status = s.enabled ? "✓" : "✗";
            lines.push(`  ${status} ${s.name} — ${s.description || "no description"} (${s.estimatedTokens} tokens)`);
          }
        }
        if (all.global.length > 0) {
          lines.push("global skills:");
          for (const s of all.global) {
            const status = s.enabled ? "✓" : "✗";
            lines.push(`  ${status} ${s.name} — ${s.description || "no description"} (${s.estimatedTokens} tokens)`);
          }
        }
        if (lines.length === 0) {
          lines.push("no skills found. create one with /skills add <name>");
        }
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to list skills: ${(err as Error).message}` }]);
      });
    return true;
  }

  if (sub === "add") {
    const name = subRest.trim();
    if (!name) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills add <name>" }]);
      return true;
    }
    void createSkill({ name, scope: "project", cwd: process.cwd() })
      .then((result) => {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `created skill '${name}' → ${result.filepath}` },
          { kind: "info", key: mkKey(), text: `edit the file to add your instructions` },
        ]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to create skill: ${(err as Error).message}` }]);
      });
    return true;
  }

  if (sub === "edit") {
    const name = subRest.trim();
    if (!name) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills edit <name>" }]);
      return true;
    }
    void findSkillFile(name, process.cwd())
      .then((filepath) => {
        if (!filepath) {
          setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `skill '${name}' not found` }]);
          return;
        }
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `skill '${name}' → ${filepath}` },
          { kind: "info", key: mkKey(), text: `open it in your editor to make changes` },
        ]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to find skill: ${(err as Error).message}` }]);
      });
    return true;
  }

  if (sub === "delete") {
    const name = subRest.trim();
    if (!name) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills delete <name>" }]);
      return true;
    }
    void deleteSkill(name, process.cwd())
      .then((result) => {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `deleted skill '${name}' (${result.filepath})` }]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to delete skill: ${(err as Error).message}` }]);
      });
    return true;
  }

  if (sub === "enable") {
    const name = subRest.trim();
    if (!name) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills enable <name>" }]);
      return true;
    }
    void setSkillEnabled(name, true, process.cwd())
      .then((result) => {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `enabled skill '${name}' (${result.filepath})` }]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to enable skill: ${(err as Error).message}` }]);
      });
    return true;
  }

  if (sub === "disable") {
    const name = subRest.trim();
    if (!name) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /skills disable <name>" }]);
      return true;
    }
    void setSkillEnabled(name, false, process.cwd())
      .then((result) => {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `disabled skill '${name}' (${result.filepath})` }]);
      })
      .catch((err) => {
        setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `failed to disable skill: ${(err as Error).message}` }]);
      });
    return true;
  }

  setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: mkKey(),
      text: "usage: /skills list | add <name> | edit <name> | delete <name> | enable <name> | disable <name>",
    },
  ]);
  return true;
};

const handleMemory: Handler = (ctx, _rest, arg) => {
  const { cfg, setCfg, setEvents, mkKey, memoryManagerRef } = ctx;
  if (!cfg) return true;
  if (!arg) {
    ctx.setShowMemoryPicker(true);
    return true;
  }
  if (arg === "on") {
    const next = { ...cfg, memoryEnabled: true };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "memory", key: mkKey(), text: "memory enabled" }]);
    return true;
  }
  if (arg === "off") {
    const next = { ...cfg, memoryEnabled: false };
    setCfg(next);
    void saveConfig(next).catch(() => {});
    setEvents((e) => [...e, { kind: "memory", key: mkKey(), text: "memory disabled" }]);
    return true;
  }
  if (!cfg.memoryEnabled) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "memory is disabled. Use /memory on to enable it, or set KIMIFLARE_MEMORY_ENABLED=1" },
    ]);
    return true;
  }
  if (arg === "clear") {
    const cleared = memoryManagerRef.current?.clearRepo(process.cwd()) ?? 0;
    setEvents((e) => [...e, { kind: "memory", key: mkKey(), text: `cleared ${cleared} memories for this repo` }]);
    return true;
  }
  if (arg.startsWith("search ")) {
    const query = arg.slice(7).trim();
    if (!query) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /memory search <query>" }]);
      return true;
    }
    void memoryManagerRef.current?.recall({ text: query, repoPath: process.cwd(), limit: 10 }).then((results) => {
      if (results.length === 0) {
        setEvents((es) => [...es, { kind: "info", key: mkKey(), text: "no memories found" }]);
      } else {
        const lines = results.map((r) => `  [${r.memory.category}] ${r.memory.content} (score: ${r.combinedScore.toFixed(2)})`);
        setEvents((es) => [...es, { kind: "info", key: mkKey(), text: `memories:\n${lines.join("\n")}` }]);
      }
    });
    return true;
  }
  const stats = memoryManagerRef.current?.getStats();
  if (stats) {
    const sizeKb = Math.round(stats.dbSizeBytes / 1024);
    const lines = [
      `total: ${stats.totalCount} memories (${sizeKb} KB)`,
      `  fact: ${stats.byCategory.fact}, event: ${stats.byCategory.event}, instruction: ${stats.byCategory.instruction}`,
      `  task: ${stats.byCategory.task}, preference: ${stats.byCategory.preference}`,
      `last cleanup: ${stats.lastCleanupAt ? new Date(stats.lastCleanupAt).toISOString() : "never"}`,
    ];
    const vec = memoryManagerRef.current?.embeddingStatus(process.cwd());
    if (vec) {
      lines.push(
        vec.model
          ? `vector recall: ${vec.model} via ${vec.provider} — ${vec.current} indexed` +
              (vec.stale > 0 ? `, ${vec.stale} waiting to be (re-)embedded (100 per startup)` : "")
          : `vector recall: off — ${vec.provider} has no embeddings API; recall uses text and topic keys. ` +
              `Set memoryEmbeddingModel, or embeddingProvider to a provider with embeddings.`,
      );
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
  } else {
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "memory manager not initialized" }]);
  }
  return true;
};

const handleResume: Handler = (ctx) => {
  void ctx.openResumePicker();
  return true;
};

const handleCheckpoint: Handler = (ctx, rest, arg) => {
  const { setEvents, mkKey, sessionIdRef } = ctx;

  // `/checkpoint list` → list checkpoints (replaces old `/checkpoints`)
  if (arg === "list") {
    const currentId = sessionIdRef.current;
    if (!currentId) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "no active session" }]);
      return true;
    }
    void (async () => {
      try {
        const { sessionsDir } = await import("../sessions.js");
        const file = await loadSession(join(sessionsDir(), `${currentId}.json`));
        const cps = file.checkpoints ?? [];
        if (cps.length === 0) {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "no checkpoints in this session" }]);
          return;
        }
        const lines = [
          "checkpoints:",
          ...cps.map(
            (cp, i) =>
              `  ${i + 1}. "${cp.label}" — turn ${cp.turnIndex} · ${new Date(cp.timestamp).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}`,
          ),
        ];
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
      } catch (e) {
        setEvents((es) => [
          ...es,
          { kind: "error", key: mkKey(), text: `failed to list checkpoints: ${(e as Error).message}` },
        ]);
      }
    })();
    return true;
  }

  const label = rest.join(" ").trim() || `checkpoint ${new Date().toLocaleString()}`;
  const turnIndex = ctx.messagesRef.current.length;
  if (turnIndex === 0) {
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "nothing to checkpoint yet" }]);
    return true;
  }
  const cp: Checkpoint = {
    id: `cp_${Date.now()}`,
    label,
    turnIndex,
    timestamp: new Date().toISOString(),
    sessionState: ctx.compiledContextRef.current ? ctx.sessionStateRef.current : undefined,
    artifactStore: serializeArtifactStore(ctx.artifactStoreRef.current),
  };
  void (async () => {
    try {
      ctx.ensureSessionId();
      const { sessionsDir } = await import("../sessions.js");
      const filePath = join(sessionsDir(), `${ctx.sessionIdRef.current}.json`);
      await addCheckpoint(filePath, cp);
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `checkpoint saved: "${label}"` }]);
    } catch (e) {
      setEvents((es) => [
        ...es,
        { kind: "error", key: mkKey(), text: `checkpoint failed: ${(e as Error).message}` },
      ]);
    }
  })();
  return true;
};

const handleCompact: Handler = (ctx) => {
  void ctx.runCompact();
  return true;
};

const handleInit: Handler = (ctx) => {
  void ctx.runInit();
  return true;
};

const handleUpdate: Handler = (ctx, _rest, arg) => {
  const { setEvents, mkKey } = ctx;
  if (arg === "camouflage") {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "The Camouflage renderer ships with autopilot; updating autopilot updates it." },
    ]);
    return true;
  }
  void checkForUpdate(true).then((result) => {
    if (result.hasUpdate) {
      ctx.setHasUpdate(true);
      ctx.setLatestVersion(result.latestVersion);
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `update available: ${result.localVersion} → ${result.latestVersion}` },
      ]);
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: "run:  npm i -g autopilot-ai@latest  then restart" },
      ]);
    } else {
      ctx.setHasUpdate(false);
      ctx.setLatestVersion(null);
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "no update available" }]);
    }
  });
  return true;
};

const handleMcp: Handler = (ctx, _rest, arg) => {
  const { setEvents, mkKey, busy } = ctx;
  if (arg === "list") {
    const servers = ctx.mcpManagerRef.current.listServers();
    if (servers.length === 0) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: "no MCP servers connected — add them to ~/.config/kimiflare/config.json" },
      ]);
    } else {
      const lines = servers.map((s) => `  ${s.name} (${s.type}) — ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`);
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "MCP servers:\n" + lines.join("\n") }]);
    }
    return true;
  }
  if (arg === "reload") {
    if (busy) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "can't /mcp reload while model is running" }]);
      return true;
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "reloading MCP servers..." }]);
    for (const tool of ctx.mcpToolsRef.current) {
      ctx.executorRef.current.unregister(tool.name);
    }
    ctx.mcpToolsRef.current = [];
    ctx.mcpInitRef.current = false;
    void ctx.initMcp();
    return true;
  }
  setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /mcp list | reload" }]);
  return true;
};

const handleLsp: Handler = (ctx, _rest, arg) => {
  const { setEvents, mkKey, busy, lspScope, lspProjectPath } = ctx;
  if (arg === "list") {
    const servers = ctx.lspManagerRef.current.listActive();
    const scopeLine =
      lspScope === "project" && lspProjectPath ? ` (project: ${lspProjectPath})` : " (global config)";
    if (servers.length === 0) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `no LSP servers active${scopeLine}` }]);
    } else {
      const lines = servers.map(
        (s) => `  ${s.id} (${s.rootUri}) — ${s.state}, ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}`,
      );
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `LSP servers${scopeLine}:\n` + lines.join("\n") },
      ]);
    }
    return true;
  }
  if (arg === "reload") {
    if (busy) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "can't /lsp reload while model is running" }]);
      return true;
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "reloading LSP servers..." }]);
    for (const tool of ctx.lspToolsRef.current) {
      ctx.executorRef.current.unregister(tool.name);
    }
    ctx.lspToolsRef.current = [];
    ctx.lspInitRef.current = false;
    void Promise.resolve(ctx.initLsp()).catch((e) => {
      setEvents((es) => [
        ...es,
        { kind: "error", key: mkKey(), text: `LSP reload failed: ${(e as Error).message}` },
      ]);
    });
    return true;
  }
  if (arg === "scope") {
    const scopeText =
      lspScope === "project" && lspProjectPath
        ? `project scope: ${lspProjectPath}`
        : "global scope: ~/.config/kimiflare/config.json";
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: scopeText }]);
    return true;
  }
  if (arg === "config" || arg === "") {
    ctx.setShowLspWizard(true);
    return true;
  }
  setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /lsp list | reload | scope | config" }]);
  return true;
};

const handleHooks: Handler = (ctx, rest, arg) => {
  const { setEvents, mkKey } = ctx;
  const cwd = process.cwd();

  // M6.1: `/hooks` (no args) opens the interactive dashboard. Typing
  // `/hooks list` keeps the old text-dump behavior for users who
  // prefer that.
  if (arg === "") {
    ctx.setShowHooksDashboard(true);
    return true;
  }

  if (arg === "list") {
    const lines: string[] = [];
    let any = false;
    for (const ev of HOOK_EVENTS) {
      const hooks = ctx.hooksManagerRef.current.hooksFor(ev);
      if (hooks.length === 0) continue;
      any = true;
      lines.push(`${ev}:`);
      for (const h of hooks) {
        const id = h.id ?? "?";
        const en = h.enabled === false ? " [disabled]" : "";
        const src = h.source ? ` (${h.source})` : "";
        const matcher = h.matcher ? `  matcher=${h.matcher}` : "";
        const desc = h.description ? `\n      ${h.description}` : "";
        lines.push(`  ${id}${en}${src}${matcher}\n      $ ${h.command}${desc}`);
      }
    }
    if (!any) {
      lines.push("no hooks configured. Type `/hooks` for the interactive dashboard.");
    }
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
    return true;
  }

  if (arg === "recommended") {
    const lines = ["Recommended hooks (all disabled by default):"];
    for (const r of RECOMMENDED_HOOKS) {
      lines.push(`  ${r.id}  [${r.event}]`);
      if (r.hook.description) lines.push(`      ${r.hook.description}`);
    }
    lines.push("");
    lines.push("Enable one with: /hooks enable <id> [global|project]");
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: lines.join("\n") }]);
    return true;
  }

  if (arg === "path") {
    setEvents((e) => [
      ...e,
      {
        kind: "info",
        key: mkKey(),
        text:
          `global: ${globalSettingsPath()}\n` +
          `project: ${projectSettingsPath(cwd)}`,
      },
    ]);
    return true;
  }

  if (arg === "reload") {
    ctx.hooksManagerRef.current.reload();
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "hooks reloaded" }]);
    return true;
  }

  // `enable <id> [global|project]` — adds a recommended hook to
  // settings.json with `enabled: true`. If the id refers to an
  // existing user hook (recommended or otherwise), flips its
  // `enabled` flag instead.
  if (arg === "enable" || arg === "disable") {
    const id = rest[1];
    if (!id) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `usage: /hooks ${arg} <id> [global|project]` },
      ]);
      return true;
    }
    const scope: "global" | "project" = rest[2] === "global" ? "global" : "project";

    if (arg === "enable") {
      // Existing hook by id → just flip; recommended hook → append.
      const flipped = setHookEnabled(cwd, id, true);
      if (flipped) {
        ctx.hooksManagerRef.current.reload();
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `hook ${id} enabled in ${flipped}` }]);
        return true;
      }
      const rec = getRecommendedHook(id);
      if (!rec) {
        setEvents((e) => [
          ...e,
          { kind: "info", key: mkKey(), text: `no hook with id ${id}. Try /hooks recommended` },
        ]);
        return true;
      }
      const path = appendHook(scope, cwd, rec.event, { ...rec.hook, enabled: true });
      ctx.hooksManagerRef.current.reload();
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `enabled ${rec.id} (${rec.event}) in ${path}` },
      ]);
      return true;
    }

    // disable
    const flipped = setHookEnabled(cwd, id, false);
    if (!flipped) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `no hook with id ${id} to disable` },
      ]);
      return true;
    }
    ctx.hooksManagerRef.current.reload();
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `hook ${id} disabled in ${flipped}` }]);
    return true;
  }

  setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: mkKey(),
      text:
        "usage: /hooks [list | recommended | path | reload | enable <id> [global|project] | disable <id>]",
    },
  ]);
  return true;
};

const handleHello: Handler = (ctx) => {
  const { setEvents, mkKey } = ctx;
  const session = crypto.randomUUID();
  const url = `${FEEDBACK_WORKER_URL}/?s=${session}&v=${getAppVersion()}`;
  openBrowser(url);
  void (async () => {
    try {
      const qr = await QRCode.toString(url, { type: "terminal", small: true });
      const lines = qr.split("\n").map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
      setEvents((e) => [
        ...e,
        {
          kind: "qrcode",
          key: mkKey(),
          lines,
          caption: "Scan this QR code with your phone to send a voice note:",
        },
        { kind: "info", key: mkKey(), text: "Also opened voice note page in your browser." },
      ]);
    } catch {
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: "Opened voice note page in your browser. Record your message there and hit Send when you're done.",
        },
      ]);
    }
  })();
  return true;
};

const handleInbox: Handler = (ctx) => {
  ctx.setShowInboxModal(true);
  return true;
};

const handleLogout: Handler = (ctx) => {
  // Remove stored credentials but keep every other setting (theme, MCP
  // servers, …). A key in OPENROUTER_API_KEY is outside our control.
  void patchPersistedConfig({
    openrouterApiKey: undefined,
    requestyApiKey: undefined,
    apiKey: undefined,
    accountId: undefined,
    apiToken: undefined,
  }).catch(() => undefined);
  const envKey = process.env.OPENROUTER_API_KEY || process.env.KIMIFLARE_OPENROUTER_KEY;
  ctx.setEvents((e) => [
    ...e,
    {
      kind: "info",
      key: ctx.mkKey(),
      text:
        `credentials cleared from ${configPath()}` +
        (envKey ? " (OPENROUTER_API_KEY in your environment will still be used next launch)" : ""),
    },
  ]);
  ctx.setCfg(null);
  return true;
};

const handleCommand: Handler = (ctx, rest) => {
  const { setEvents, mkKey } = ctx;
  const sub = rest[0]?.toLowerCase() ?? "";
  // `/command` (no args) opens the interactive list — same as `/command list`
  if (sub === "" || sub === "list") {
    ctx.setShowCommandList(true);
    return true;
  }
  if (sub === "create") {
    ctx.setCommandWizard({ mode: "create" });
    return true;
  }
  if (sub === "edit") {
    ctx.setCommandPicker({ mode: "edit" });
    return true;
  }
  if (sub === "delete") {
    ctx.setCommandPicker({ mode: "delete" });
    return true;
  }
  setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "usage: /command create | edit | delete | list" }]);
  return true;
};

const handleRemote: Handler = (ctx, rest, arg) => {
  const { setEvents, mkKey, cfg, setCfg, activeScopeRef } = ctx;
  if (arg === "status" || arg === "cancel") {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `Use \`autopilot remote ${arg}\` from your shell.` },
    ]);
    return true;
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    ctx.setShowRemoteDashboard(true);
    return true;
  }

  const repo = detectGitHubRepo(cfg?.githubRepo);
  if (!repo) {
    setEvents((e) => [
      ...e,
      {
        kind: "info",
        key: mkKey(),
        text: "Could not detect GitHub repo. Run from a repo with a GitHub remote, or set githubRepo in config.",
      },
    ]);
    return true;
  }

  (async () => {
    if (!cfg?.remoteWorkerUrl) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: "Remote infrastructure not deployed yet. Setting up now (~2 min)..." },
      ]);

      try {
        for await (const step of deployForTui()) {
          setEvents((e) => [
            ...e,
            { kind: step.error ? "error" : "info", key: mkKey(), text: step.message },
          ]);
          if (step.done) break;
        }
      } catch {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: "Deploy failed. Fix the issue above and try /remote again." },
        ]);
        return;
      }

      const { loadConfig: reloadConfig } = await import("../config.js");
      const newCfg = await reloadConfig();
      if (newCfg) setCfg(newCfg);
    }

    const currentCfg = cfg ?? (await loadConfig());
    if (!currentCfg?.remoteWorkerUrl) {
      setEvents((e) => [
        ...e,
        { kind: "error", key: mkKey(), text: "Deploy seemed to succeed but config wasn't saved. Try again." },
      ]);
      return;
    }

    if (!currentCfg.githubOAuthToken) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: "GitHub not authenticated. Starting OAuth device flow..." },
      ]);

      try {
        for await (const step of authGitHubForTui()) {
          setEvents((e) => [
            ...e,
            { kind: step.error ? "error" : "info", key: mkKey(), text: step.message },
          ]);
          if (step.done) break;
        }
      } catch {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: "GitHub auth failed. Try `autopilot auth github` from shell." },
        ]);
        return;
      }

      const { loadConfig: reloadConfig } = await import("../config.js");
      const newCfg = await reloadConfig();
      if (newCfg) setCfg(newCfg);
    }

    const finalCfg = (await loadConfig()) ?? currentCfg;

    const ttl = finalCfg.remoteTtlMinutes ?? 30;
    const budget = finalCfg.remoteMaxInputTokens ?? 5_000_000;
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `Starting remote session for ${repo.owner}/${repo.name}...` },
      { kind: "info", key: mkKey(), text: `Budget: ${formatTokens(budget)} tokens. TTL: ${ttl} min.` },
    ]);

    try {
      const data = await startRemoteSession({
        prompt,
        repo,
        cfg: finalCfg,
        ttlMinutes: finalCfg.remoteTtlMinutes,
        tokensBudget: finalCfg.remoteMaxInputTokens,
      });
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `Session started: ${data.sessionId}` }]);

      for await (const ev of streamRemoteProgress(
        finalCfg.remoteWorkerUrl!,
        data.sessionId,
        activeScopeRef.current?.signal,
      )) {
        const event = ev as Record<string, unknown>;
        if (event.type === "text_delta") {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: String(event.text ?? "") }]);
        } else if (event.type === "tool_call") {
          setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `→ ${String(event.name ?? "")}` }]);
        } else if (event.type === "done") {
          const prUrl = event.prUrl as string | undefined;
          const tokensUsed = event.tokensUsed as number | undefined;
          const tokensBudget = event.tokensBudget as number | undefined;
          setEvents((e) => [
            ...e,
            { kind: "info", key: mkKey(), text: prUrl ? `Done — PR: ${prUrl}` : "Done" },
          ]);
          await saveRemoteSession({
            sessionId: data.sessionId,
            prompt,
            repo: `${repo.owner}/${repo.name}`,
            workerUrl: finalCfg.remoteWorkerUrl!,
            status: "done",
            prUrl,
            tokensUsed,
            tokensBudget,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        } else if (event.type === "error") {
          const message = String(event.message ?? "");
          const category = event.category as RemoteSession["errorCategory"] | undefined;
          setEvents((e) => [...e, { kind: "error", key: mkKey(), text: `Remote error: ${message}` }]);
          await saveRemoteSession({
            sessionId: data.sessionId,
            prompt,
            repo: `${repo.owner}/${repo.name}`,
            workerUrl: finalCfg.remoteWorkerUrl!,
            status: "error",
            errorCategory: category ?? "unknown",
            errorSummary: message,
            errorMessage: message,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      setEvents((e) => [
        ...e,
        { kind: "error", key: mkKey(), text: `Failed: ${err instanceof Error ? err.message : String(err)}` },
      ]);
    }
  })();

  return true;
};

const handleHelp: Handler = (ctx) => {
  ctx.setShowHelpMenu(true);
  return true;
};

const handleChangelogImage: Handler = (ctx, rest) => {
  const { cfg, setEvents, mkKey, setShowChangelogImagePicker, setChangelogImageRepo, setTasks, setTasksStartedAt } = ctx;
  if (!cfg) {
    setEvents((e) => [...e, { kind: "error", key: mkKey(), text: "Not configured yet." }]);
    return true;
  }

  // Parse args: /changelog-image [owner/repo] [days]
  let owner = cfg.githubRepo?.split("/")[0];
  let repo = cfg.githubRepo?.split("/")[1];
  let days = 7;

  if (rest.length > 0 && rest[0]!.includes("/")) {
    const parts = rest[0]!.split("/");
    owner = parts[0];
    repo = parts[1];
  }
  if (rest.length > 1) {
    const d = parseInt(rest[1]!, 10);
    if (!Number.isNaN(d)) days = d;
  }

  const runGeneration = (o: string, r: string, d: number) => {
    const asstId = mkAssistantId();
    setEvents((e) => [
      ...e,
      {
        kind: "assistant",
        key: `asst_${asstId}`,
        id: asstId,
        text: `Generating changelog image for ${o}/${r} (last ${d} day${d === 1 ? "" : "s"})…`,
        reasoning: "",
        streaming: true,
      },
    ]);

    const taskList: Task[] = [
      { id: "fetch-prs", title: "Fetch merged PRs", status: "pending" },
      { id: "fetch-release", title: "Fetch latest release", status: "pending" },
      { id: "summarize", title: "Summarize with LLM", status: "pending" },
      { id: "render", title: "Render changelog image", status: "pending" },
      { id: "save", title: "Save PNG file", status: "pending" },
    ];
    setTasks(taskList);
    setTasksStartedAt(Date.now());

    const updateTask = (id: string, status: Task["status"]) => {
      setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    };

    void (async () => {
      try {
        const { changelogImageTool } = await import("../tools/changelog-image.js");

        updateTask("fetch-prs", "in_progress");
        updateTask("fetch-release", "in_progress");
        const result = await changelogImageTool.run({ owner: o, repo: r, days: d }, {
          cwd: process.cwd(),
          githubToken: cfg.githubOAuthToken,
          llmAuth: llmAuthFromConfig(cfg),
          model: cfg.model,
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
        setTasksStartedAt(null);
      }
    })();
  };

  const tryOpenPicker = (o: string | undefined, r: string | undefined) => {
    if (o && r) {
      // If no explicit args given, open the TUI picker
      if (rest.length === 0) {
        setChangelogImageRepo({ owner: o, name: r });
        setShowChangelogImagePicker(true);
        return;
      }
      runGeneration(o, r, days);
      return;
    }
    setEvents((e) => [
      ...e,
      {
        kind: "error",
        key: mkKey(),
        text: "Usage: /changelog-image [owner/repo] [days]\nSet githubRepo in config or pass owner/repo explicitly.",
      },
    ]);
  };

  if (owner && repo) {
    tryOpenPicker(owner, repo);
    return true;
  }

  // Auto-detect from git remote
  void import("../ui/app-helpers.js").then(({ detectGitHubRepo }) => {
    const detected = detectGitHubRepo();
    tryOpenPicker(detected?.owner, detected?.name);
  });

  return true;
};

/** `/good` and `/bad [reason]`: an explicit rating of the most recent turn,
 *  recorded as `outcome{rating}` on the session trace. */
function rateLastTurn(ctx: SlashContext, value: "good" | "bad", reason: string): boolean {
  const { mkKey, setEvents } = ctx;
  const last = ctx.turnHistoryRef.current.at(-1);
  if (!last) {
    setEvents((e) => [...e, { kind: "info", key: mkKey(), text: "nothing to rate yet — finish a turn first" }]);
    return true;
  }
  const trace = ctx.traceRef.current;
  if (!trace.enabled) {
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: "session tracing is off, so the rating was not recorded (enable with KIMIFLARE_TRACE=1)" },
    ]);
    return true;
  }
  trace.emit("outcome", { kind: "rating", turn_id: last.turnId, value, ...(reason ? { reason } : {}) }, last.turnId);
  setEvents((e) => [
    ...e,
    { kind: "info", key: mkKey(), text: `recorded ${value === "good" ? "👍 good" : "👎 bad"} for the last turn${reason ? `: ${reason}` : ""}` },
  ]);
  return true;
}

const handleGood: Handler = (ctx, rest) => rateLastTurn(ctx, "good", rest.join(" ").trim());
const handleBad: Handler = (ctx, rest) => rateLastTurn(ctx, "bad", rest.join(" ").trim());

// ── Registry ─────────────────────────────────────────────────────────────

const handlers: Record<string, Handler> = {
  "/exit": handleExit,
  "/clear": handleClear,
  "/fresh": handleFresh,
  "/reasoning": handleReasoning,
  "/cost": handleCost,
  "/shell": handleShell,
  "/model": handleModel,
  "/jev": handleJev,
  "/subagents": handleSubagents,
  "/key": handleKey,
  "/settings": handleSettings,
  "/mode": handleMode,
  "/multi-agent": handleMultiAgent,
  "/theme": handleTheme,
  "/plan": handlePlan,
  "/auto": handleAuto,
  "/edit": handleEdit,
  "/skills": handleSkills,
  "/memory": handleMemory,
  "/resume": handleResume,
  "/checkpoint": handleCheckpoint,
  "/compact": handleCompact,
  "/good": handleGood,
  "/bad": handleBad,
  "/init": handleInit,
  "/update": handleUpdate,
  "/mcp": handleMcp,
  "/lsp": handleLsp,
  "/hooks": handleHooks,
  "/hello": handleHello,
  "/inbox": handleInbox,
  "/logout": handleLogout,
  "/command": handleCommand,
  "/remote": handleRemote,
  "/changelog-image": handleChangelogImage,
  "/help": handleHelp,
};

/**
 * Match the first whitespace-delimited token of `cmd` (lowercased) against
 * the slash-command registry. Returns true if a handler consumed the
 * command, false if `cmd` is unrecognized (so the caller can fall through
 * to custom-command lookup).
 */
export function dispatchSlashCommand(ctx: SlashContext, cmd: string): boolean | Promise<boolean> {
  const raw = cmd.trim();
  const [head, ...rest] = raw.split(/\s+/);
  const c = (head ?? "").toLowerCase();
  const arg = rest.join(" ").trim().toLowerCase();
  const handler = handlers[c];
  if (!handler) return false;
  return handler(ctx, rest, arg);
}
