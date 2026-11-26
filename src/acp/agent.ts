/**
 * `autopilot acp`: Autopilot as an ACP (Agent Client Protocol) agent, for
 * Zed, T3 Code and other ACP clients. The editor starts this process and
 * talks JSON-RPC over stdio (index.ts); every session here is an ordinary
 * Autopilot session: same config and provider (the free tier sign-in
 * included), same turn policy, hooks, permission policy, MCP servers,
 * compaction and session files as the terminal UI, so a thread started in
 * the editor can be resumed with `autopilot resume` and the other way round.
 *
 * What maps to what:
 *  - session/new, session/load, session/resume, session/list, session/close
 *    → Autopilot sessions (sessions.ts in src/, files under the data dir).
 *  - session/prompt → one turn (runCoreTurn); text, reasoning, tool calls,
 *    the task list (plan) and context usage stream as session/update.
 *  - session/cancel → aborts the turn; the prompt answers "cancelled".
 *  - permission prompts → session/request_permission, with the TUI's policy
 *    (use-permission-controller.ts resolvePermission): plan / edit / auto
 *    modes, PermissionRequest hooks, and irreversible actions asked about in
 *    every mode, auto included.
 *  - modes (edit, plan, auto) and the model → session modes and session
 *    config options (category "mode" and "model").
 *  - MCP servers the client passes (stdio, http, sse) join the config's own.
 *  - authMethods: sign in to the dl free tier, in a terminal the client
 *    opens (`autopilot acp --login`) or from the agent (browser + device
 *    code). Any provider Autopilot is already set up with works as it is.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  agent as acpAgent,
  RequestError,
  PROTOCOL_VERSION,
  type AgentApp,
  type AgentContext,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type PromptResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionUpdate,
  type StopReason,
} from "@agentclientprotocol/sdk";

import { loadConfig, DEFAULT_MODEL, type AutopilotConfig } from "../config.js";
import { ToolExecutor, ALL_TOOLS, toolsForSession, type PermissionDecision, type PermissionRequest } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { McpManager } from "../mcp/manager.js";
import { HooksManager } from "../hooks/manager.js";
import type { AgentCallbacks } from "../agent/loop.js";
import { assembleTurn, lastUserText, resolveTurnPolicy, runCoreTurn } from "../agent/session-core.js";
import { sessionFileCompactionTarget, type CompactionTarget } from "../agent/context-budget.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import type { ChatMessage, ContentPart } from "../agent/messages.js";
import { submitUserPrompt } from "../hooks/prompt-submit.js";
import { endSession } from "../hooks/session-lifecycle.js";
import { listSessions, loadSession, makeSessionId, saveSession, sessionsDir, type SessionFile } from "../sessions.js";
import { isBlockedInPlanMode, type Mode } from "../mode.js";
import { resolvePermission } from "../ui/use-permission-controller.js";
import { ensureCatalogForProvider } from "../models/catalog.js";
import { activeProviderCatalog, featuredModels, getModelOrInfer, listModels, type ModelEntry } from "../models/registry.js";
import { normalizeImageData } from "../util/image.js";
import { expandVars } from "../import/mcp.js";
import { getAppVersion } from "../util/version.js";
import { logger } from "../util/logger.js";

import { SessionStore, type StoredSession } from "./sessions.js";
import { destructivePermissionOptions, fromAcpPermissionOutcome, permissionOptions, toAcpToolCall, toAcpToolUpdate, toolKind, toolTitle } from "./tools.js";

/** How the agent names itself to clients and in the ACP registry. */
export const ACP_AGENT_ID = "dl-autopilot";
export const ACP_AGENT_TITLE = "Autopilot by dl.new";

/** Auth method ids (initialize's authMethods). */
export const AUTH_TERMINAL = "dl-login-terminal";
export const AUTH_AGENT = "dl-login";
/** The arguments a client appends to the agent's command to sign in in a terminal. */
export const LOGIN_ARGS = ["--login"];

const MODES: readonly Mode[] = ["edit", "plan", "auto"];
const MODE_ALIASES: Record<string, Mode> = {
  edit: "edit",
  default: "edit",
  plan: "plan",
  auto: "auto",
  bypass: "auto",
  bypasspermissions: "auto",
  acceptedits: "auto",
};

/** The mode new sessions start in: edit (asks first), or ACP_PERMISSION_MODE. */
export function defaultAcpMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const raw = env.ACP_PERMISSION_MODE?.trim().toLowerCase();
  if (!raw) return "edit";
  const mode = MODE_ALIASES[raw];
  if (!mode) logger.warn("acp:unknown_mode", { mode: raw });
  return mode ?? "edit";
}

function modeState(current: Mode): SessionModeState {
  return {
    currentModeId: current,
    availableModes: [
      { id: "edit", name: "Edit", description: "Asks before edits, commands and other changes" },
      { id: "plan", name: "Plan", description: "Read-only research: no edits or changing commands" },
      { id: "auto", name: "Auto", description: "Runs without asking (irreversible actions still ask)" },
    ],
  };
}

/** Most models a model picker lists; a provider's own catalog is listed whole up to this. */
const MAX_MODEL_OPTIONS = 60;

/** The models offered in the client's model picker: the provider's own list, or OpenRouter's best plus the current one. */
export function modelChoices(current: string): ModelEntry[] {
  const pickable = listModels().filter((m) => m.supports.tools && !m.id.endsWith(":batch"));
  const base = activeProviderCatalog() !== null ? pickable.slice(0, MAX_MODEL_OPTIONS) : featuredModels(pickable);
  const out = base.some((m) => m.id === current) ? base : [getModelOrInfer(current), ...base];
  return out;
}

function configOptions(session: { model: string; mode: Mode }): SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: session.mode,
      options: modeState(session.mode).availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description ?? null })),
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.model,
      options: modelChoices(session.model).map((m) => ({ value: m.id, name: m.name ?? m.id })),
    },
  ];
}

/** Turn ACP prompt content into an Autopilot user message. */
export function acpPromptToMessage(prompt: ContentBlock[], opts: { imageMaxEdge?: number; imageQuality?: number } = {}): ChatMessage {
  const parts: ContentPart[] = [];
  for (const block of prompt) {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text });
        break;
      case "image": {
        const image = normalizeImageData(block.data, block.mimeType, { maxEdge: opts.imageMaxEdge, quality: opts.imageQuality });
        parts.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.base64}` } });
        break;
      }
      case "resource": {
        const res = block.resource;
        if ("text" in res) parts.push({ type: "text", text: `<context uri="${res.uri}">\n${res.text}\n</context>` });
        else parts.push({ type: "text", text: `[attached: ${res.uri}]` });
        break;
      }
      case "resource_link":
        parts.push({ type: "text", text: `[${block.name || "file"}: ${block.uri}]` });
        break;
      default:
        break;
    }
  }
  // Consecutive text parts read as one message.
  const merged: ContentPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part.type === "text" && last?.type === "text") last.text = `${last.text}\n\n${part.text}`;
    else merged.push(part.type === "text" ? { ...part } : part);
  }
  if (merged.length === 0) return { role: "user", content: "" };
  if (merged.length === 1 && merged[0]!.type === "text") return { role: "user", content: merged[0]!.text };
  return { role: "user", content: merged };
}

interface AcpSession extends StoredSession {
  cwd: string;
  config: AutopilotConfig;
  model: string;
  mode: Mode;
  executor: ToolExecutor;
  hooks: HooksManager;
  mcp: McpManager;
  baseTools: ToolSpec[];
  messages: ChatMessage[];
  createdAt: string;
  compactionState: Pick<SessionFile, "sessionState" | "artifactStore">;
  compaction: CompactionTarget;
  abort: AbortController | null;
}

export interface AcpAgentOptions {
  /** Sign in to the free tier from `authenticate` (the agent auth method). Default: device code in the browser. */
  signIn?: () => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** The ACP agent app: register handlers, then `connect(stream)` (index.ts). */
export function createAcpAgent(opts: AcpAgentOptions = {}): AgentApp {
  const env = opts.env ?? process.env;
  const sessions = new SessionStore<AcpSession>();
  let clientCaps: ClientCapabilities | undefined;

  const app = acpAgent({ name: ACP_AGENT_ID });

  app.onRequest("initialize", ({ params }) => {
    clientCaps = params.clientCapabilities;
    return initializeResponse(params);
  });

  app.onRequest("authenticate", async ({ params }) => {
    if (params.methodId !== AUTH_AGENT && params.methodId !== AUTH_TERMINAL) {
      throw RequestError.invalidParams(undefined, `Unknown auth method: ${params.methodId}`);
    }
    // The terminal method runs in a terminal the client opens; once it exits the config has the sign-in.
    if (params.methodId === AUTH_AGENT) await (opts.signIn ?? signInWithBrowser)();
    if (!(await loadConfig())) throw RequestError.authRequired(undefined, "Not signed in yet.");
    return {};
  });

  app.onRequest("session/new", async ({ params }) => {
    const session = await openSession({ cwd: params.cwd, mcpServers: params.mcpServers, file: null });
    sessions.set(session);
    return { sessionId: session.id, modes: modeState(session.mode), configOptions: configOptions(session) };
  });

  app.onRequest("session/load", async ({ params, client }) => {
    const file = await readSessionFile(params.sessionId);
    const session = await openSession({ cwd: params.cwd, mcpServers: params.mcpServers, file });
    sessions.set(session);
    await replayHistory(client, session);
    return { modes: modeState(session.mode), configOptions: configOptions(session) };
  });

  app.onRequest("session/resume", async ({ params }) => {
    const file = await readSessionFile(params.sessionId);
    const session = await openSession({ cwd: params.cwd, mcpServers: params.mcpServers ?? [], file });
    sessions.set(session);
    return { modes: modeState(session.mode), configOptions: configOptions(session) };
  });

  app.onRequest("session/list", async ({ params }) => {
    const summaries = await listSessions(100, params.cwd ?? undefined);
    return {
      sessions: summaries.map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.title ?? s.firstPrompt,
        updatedAt: s.updatedAt,
      })),
    };
  });

  app.onRequest("session/close", async ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (!session) return {};
    session.abort?.abort();
    await save(session).catch(() => {});
    sessions.delete(session.id);
    return {};
  });

  app.onRequest("session/set_mode", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    setMode(session, params.modeId);
    await notify(client, session.id, { sessionUpdate: "current_mode_update", currentModeId: session.mode });
    await notify(client, session.id, { sessionUpdate: "config_option_update", configOptions: configOptions(session) });
    return {};
  });

  app.onRequest("session/set_config_option", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    if (typeof params.value !== "string") throw RequestError.invalidParams(undefined, `${params.configId} takes a value id`);
    if (params.configId === "mode") {
      setMode(session, params.value);
      await notify(client, session.id, { sessionUpdate: "current_mode_update", currentModeId: session.mode });
    } else if (params.configId === "model") {
      const id = params.value.trim();
      if (!id || /\s/.test(id)) throw RequestError.invalidParams(undefined, `Not a model id: ${params.value}`);
      session.model = id;
    } else {
      throw RequestError.invalidParams(undefined, `Unknown config option: ${params.configId}`);
    }
    return { configOptions: configOptions(session) };
  });

  app.onNotification("session/cancel", ({ params }) => {
    sessions.get(params.sessionId)?.abort?.abort();
  });

  app.onRequest("session/prompt", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    if (session.abort) throw RequestError.invalidRequest(undefined, "A prompt is already running in this session");
    return runPrompt(client, session, params.prompt);
  });

  return app;

  // ── Sessions ────────────────────────────────────────────────────────────

  function requireSession(id: string): AcpSession {
    const session = sessions.get(id);
    if (!session) throw RequestError.sessionNotFound(id);
    return session;
  }

  async function readSessionFile(id: string): Promise<SessionFile> {
    // Session ids are file names: never a path.
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) throw RequestError.sessionNotFound(id);
    const path = join(sessionsDir(), `${id}.json`);
    if (!existsSync(path)) throw RequestError.sessionNotFound(id);
    return loadSession(path);
  }

  async function openSession(input: { cwd: string; mcpServers: McpServer[]; file: SessionFile | null }): Promise<AcpSession> {
    if (!isAbsolute(input.cwd)) throw RequestError.invalidParams(undefined, `cwd must be an absolute path: ${input.cwd}`);
    const config = await loadConfig();
    if (!config) {
      throw RequestError.authRequired(
        undefined,
        "Sign in to dl's free tier (or set up a provider) first: run `dl` or `autopilot auth directionally-local` in a terminal.",
      );
    }
    const cwd = resolve(input.cwd);
    // The picker, context sizes and capabilities follow the active provider's catalog.
    await ensureCatalogForProvider(llmAuthFromConfig(config)).catch(() => {});
    const hooks = new HooksManager(cwd);
    const executor = new ToolExecutor(ALL_TOOLS, { hooks });
    const mcp = new McpManager();
    await connectMcpServers(mcp, config, input.mcpServers);
    const mcpTools = mcp.getAllTools();
    for (const tool of mcpTools) executor.register(tool);
    const baseTools = toolsForSession({ memoryEnabled: false, extra: mcpTools });
    const mode = defaultAcpMode(env);
    const model = input.file?.model || config.model || DEFAULT_MODEL;
    const now = new Date().toISOString();
    const compactionState = { sessionState: input.file?.sessionState, artifactStore: input.file?.artifactStore };
    const session: AcpSession = {
      id: input.file?.id ?? makeSessionId("acp"),
      cwd,
      config,
      model,
      mode,
      executor,
      hooks,
      mcp,
      baseTools,
      messages: [
        { role: "system", content: systemPrompt({ cwd, tools: baseTools, model, mode, config }) },
        ...(input.file?.messages.filter((m) => m.role !== "system") ?? []),
      ],
      createdAt: input.file?.createdAt ?? now,
      compactionState,
      compaction: sessionFileCompactionTarget(compactionState),
      abort: null,
      dispose() {
        this.abort?.abort();
        void endSession(this.id, "exit").catch(() => {});
        void mcp.disconnectAll().catch(() => {});
      },
    };
    return session;
  }

  function setMode(session: AcpSession, modeId: string): void {
    const mode = MODE_ALIASES[modeId.toLowerCase()];
    if (!mode || !MODES.includes(mode)) throw RequestError.invalidParams(undefined, `Unknown mode: ${modeId}`);
    session.mode = mode;
    session.executor.clearSessionPermissions();
    session.messages[0] = { role: "system", content: systemPrompt({ ...session, tools: session.baseTools }) };
  }

  async function save(session: AcpSession): Promise<void> {
    await saveSession({
      id: session.id,
      cwd: session.cwd,
      model: session.model,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      messages: session.messages,
      sessionState: session.compactionState.sessionState,
      artifactStore: session.compactionState.artifactStore,
    });
  }

  // ── A turn ──────────────────────────────────────────────────────────────

  async function runPrompt(client: AgentContext, session: AcpSession, prompt: ContentBlock[]): Promise<PromptResponse> {
    const controller = new AbortController();
    session.abort = controller;
    const { signal } = controller;
    let stopReason: StopReason = "end_turn";
    let messageId = randomUUID();
    /** The tool call that is about to run, so a permission request names the call the client already shows. */
    let runningToolCall: { id: string; name: string } | undefined;
    const update = (u: SessionUpdate) => void notify(client, session.id, u);
    const say = (text: string) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, messageId });
    const notice = (severity: "info" | "warning" | "error", title: string) => {
      if (clientCaps?.session?.notices) update({ sessionUpdate: "notice", severity, title });
      else say(`\n\n_${title}_\n\n`);
    };

    try {
      const message = acpPromptToMessage(prompt, { imageMaxEdge: session.config.imageMaxEdge, imageQuality: session.config.imageQuality });
      const gate = await submitUserPrompt({
        hooks: session.hooks,
        sessionId: session.id,
        cwd: session.cwd,
        prompt: lastUserText([message]),
        resumed: session.messages.some((m) => m.role === "assistant"),
        model: session.model,
        auth: llmAuthFromConfig(session.config),
      });
      if (gate.blocked) {
        notice("warning", `A UserPromptSubmit hook blocked this message${gate.reason ? `: ${gate.reason}` : "."}`);
        return { stopReason: "refusal" };
      }
      session.messages.push(message);

      const callbacks: AgentCallbacks = {
        onAssistantStart: () => {
          messageId = randomUUID();
        },
        onTextDelta: (text) => say(text),
        onReasoningDelta: (text) => update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text }, messageId }),
        onInfo: (text) => notice("info", text),
        onWarning: (text) => notice("warning", text),
        onGuardrail: (event) => {
          notice("warning", event.message);
          if (event.kind === "limit_stopped") stopReason = "max_turn_requests";
        },
        onToolCallFinalized: (call) => update({ sessionUpdate: "tool_call", ...toAcpToolCall(call, session.cwd), status: "pending" }),
        onToolWillExecute: (id, name) => {
          runningToolCall = { id, name };
          update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
        },
        onToolResult: (result) => update({ sessionUpdate: "tool_call_update", ...toAcpToolUpdate(result) }),
        onTasks: (tasks) =>
          update({
            sessionUpdate: "plan",
            entries: tasks.map((t) => ({
              content: t.title,
              status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending",
              priority: "medium",
            })),
          }),
        onUsageFinal: (usage) =>
          update({
            sessionUpdate: "usage_update",
            used: usage.prompt_tokens + usage.completion_tokens,
            size: getModelOrInfer(session.model).contextWindow,
            ...(typeof usage.cost === "number" && Number.isFinite(usage.cost) ? { cost: { amount: usage.cost, currency: "USD" } } : {}),
          }),
        askPermission: (req) =>
          resolvePermission(req, session.mode, { rules: session.config.permissions, cwd: session.cwd }, {
            onPlanModeBlocked: (toolName) => notice("info", `Plan mode: ${toolName} isn't run. Switch to Edit or Auto to make changes.`),
            prompt: () => askClient(client, session, req, runningToolCall, false, signal),
            promptDestructive: () => askClient(client, session, req, runningToolCall, true, signal),
          }),
      };

      const policy = await resolveTurnPolicy({ cfg: session.config, prompt: lastUserText(session.messages), tools: session.baseTools, signal });
      await runCoreTurn(
        assembleTurn({
          cfg: { ...session.config, model: session.model },
          policy,
          host: {
            ...llmAuthFromConfig(session.config),
            model: session.model,
            messages: session.messages,
            executor: session.executor,
            hooks: session.hooks,
            cwd: session.cwd,
            signal,
            callbacks,
            sessionId: session.id,
            compaction: session.compaction,
            toolLimitBehavior: "stop",
          },
        }),
        () => save(session).catch((error: unknown) => logger.warn("acp:save_failed", { error: (error as Error).message })),
      );
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        stopReason = "cancelled";
      } else {
        const text = error instanceof Error ? error.message : String(error);
        notice("error", text);
        say(`\n\n${text}`);
      }
    } finally {
      session.abort = null;
    }
    return { stopReason: signal.aborted ? "cancelled" : stopReason };
  }

  async function askClient(
    client: AgentContext,
    session: AcpSession,
    req: PermissionRequest,
    running: { id: string; name: string } | undefined,
    destructive: boolean,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    if (signal.aborted) return { decision: "deny", scope: "once" };
    const toolCallId = running && running.name === req.tool.name ? running.id : `permission-${randomUUID()}`;
    const why = req.destructive
      ? `${req.destructive.title}\n${req.destructive.subtitle}`
      : req.sensitiveReason
        ? `This ${req.sensitiveReason}.`
        : req.hookAskReason;
    try {
      const response = await client.request(
        "session/request_permission",
        {
          sessionId: session.id,
          toolCall: {
            toolCallId,
            title: req.destructive?.title ?? toolTitle(req.tool.name, req.args),
            kind: toolKind(req.tool.name),
            rawInput: req.args,
            ...(why ? { content: [{ type: "content", content: { type: "text", text: why } }] } : {}),
          },
          options: destructive ? destructivePermissionOptions() : permissionOptions(),
        },
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      );
      return fromAcpPermissionOutcome(response.outcome, { destructive });
    } catch {
      return { decision: "deny", scope: "once" };
    }
  }

  /** session/load: send the saved conversation back as updates so the client shows it. */
  async function replayHistory(client: AgentContext, session: AcpSession): Promise<void> {
    const toolNames = new Map<string, string>();
    for (const m of session.messages) {
      if (m.role === "user") {
        for (const block of messageBlocks(m)) await notify(client, session.id, { sessionUpdate: "user_message_chunk", content: block });
      } else if (m.role === "assistant") {
        if (m.reasoning_content) await notify(client, session.id, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: m.reasoning_content } });
        for (const block of messageBlocks(m)) await notify(client, session.id, { sessionUpdate: "agent_message_chunk", content: block });
        for (const call of m.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name);
          await notify(client, session.id, { sessionUpdate: "tool_call", ...toAcpToolCall(call, session.cwd), status: "completed" });
        }
      } else if (m.role === "tool" && m.tool_call_id) {
        const text = typeof m.content === "string" ? m.content : messageBlocks(m).map((b) => (b.type === "text" ? b.text : "")).join("");
        await notify(client, session.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: m.tool_call_id,
          status: "completed",
          content: text ? [{ type: "content", content: { type: "text", text } }] : [],
        });
      }
    }
  }
}

function messageBlocks(m: ChatMessage): ContentBlock[] {
  if (typeof m.content === "string") return m.content ? [{ type: "text", text: m.content }] : [];
  const out: ContentBlock[] = [];
  for (const part of m.content ?? []) {
    if (part.type === "text") {
      if (part.text) out.push({ type: "text", text: part.text });
    } else {
      const match = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
      if (match) out.push({ type: "image", mimeType: match[1]!, data: match[2]! });
    }
  }
  return out;
}

function systemPrompt(s: { cwd: string; tools: ToolSpec[]; model: string; mode: Mode; config: AutopilotConfig }): string {
  return buildSystemPrompt({ cwd: s.cwd, tools: s.tools, model: s.model, mode: s.mode, preferPullRequests: s.config.preferPullRequests, memoryEnabled: false });
}

async function notify(client: AgentContext, sessionId: string, update: SessionUpdate): Promise<void> {
  await client.notify("session/update", { sessionId, update }).catch(() => {});
}

/** The client advertised it can open a terminal for the agent's sign-in (stable `auth.terminal`, or the older `_meta`). */
export function clientSupportsTerminalAuth(caps: ClientCapabilities | undefined): boolean {
  return caps?.auth?.terminal === true || caps?._meta?.["terminal-auth"] === true;
}

export function authMethods(caps: ClientCapabilities | undefined): AuthMethod[] {
  const methods: AuthMethod[] = [];
  if (clientSupportsTerminalAuth(caps)) {
    methods.push({
      type: "terminal",
      id: AUTH_TERMINAL,
      name: "Sign in to dl",
      description: "Free tier: sign in with GitHub in a terminal. Uses any provider Autopilot is already set up with otherwise.",
      args: LOGIN_ARGS,
    });
  }
  methods.push({
    id: AUTH_AGENT,
    name: "Sign in to dl in the browser",
    description: "Free tier: opens GitHub's device sign-in in your browser.",
  });
  return methods;
}

function initializeResponse(params: InitializeRequest): InitializeResponse {
  return {
    protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
    agentInfo: { name: ACP_AGENT_ID, title: ACP_AGENT_TITLE, version: getAppVersion() },
    authMethods: authMethods(params.clientCapabilities),
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { list: {}, close: {}, resume: {} },
    },
  };
}

/** MCP servers from config.json, then the ones the client passes for this session. Failures are logged, never fatal. */
async function connectMcpServers(mcp: McpManager, config: AutopilotConfig, fromClient: McpServer[]): Promise<void> {
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    if (server.enabled === false) continue;
    try {
      if (server.type === "local" && server.command?.length) {
        await mcp.addLocalServer(name, server.command, expandMap(server.env), { timeoutMs: server.timeoutMs });
      } else if ((server.type === "remote" || server.type === "http") && server.url) {
        await mcp.addRemoteServer(name, expandVars(server.url), expandMap(server.headers), { timeoutMs: server.timeoutMs }, server.type === "http" ? "http" : "sse");
      }
    } catch (error) {
      logger.warn("acp:mcp_failed", { name, error: (error as Error).message });
    }
  }
  for (const server of fromClient) {
    try {
      if ("url" in server) {
        const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
        await mcp.addRemoteServer(server.name, server.url, Object.keys(headers).length ? headers : undefined, undefined, server.type === "http" ? "http" : "sse");
      } else {
        const env = Object.fromEntries(server.env.map((e) => [e.name, e.value]));
        await mcp.addLocalServer(server.name, [server.command, ...server.args], Object.keys(env).length ? { ...inheritedEnv(), ...env } : undefined);
      }
    } catch (error) {
      logger.warn("acp:mcp_failed", { name: server.name, error: (error as Error).message });
    }
  }
}

function expandMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandVars(v)]));
}

/** A stdio MCP server given its own env still needs PATH and HOME to start. */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "TMPDIR", "SystemRoot", "APPDATA", "LOCALAPPDATA", "USERPROFILE"]) {
    const v = process.env[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** The agent auth method: the free tier's GitHub device sign-in, opened in the browser. */
async function signInWithBrowser(): Promise<void> {
  const dl = await import("../providers/directionally-local.js");
  const { switchProvider } = await import("../providers/keys.js");
  const { openBrowser } = await import("../ui/app-helpers.js");
  await dl.dlSignIn((code) => {
    if (!openBrowser(code.verificationUriComplete)) {
      throw RequestError.authRequired(undefined, `Open ${code.verificationUriComplete} and enter ${code.userCode} to sign in.`);
    }
  }, { where: "cli" });
  await switchProvider(await loadConfig().catch(() => null), "directionally-local");
}
