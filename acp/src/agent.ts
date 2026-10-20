import type {
  Agent,
  AgentSideConnection,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  CancelNotification,
  SetSessionModeRequest,
  SetSessionModeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  SessionModeState,
  ContentBlock,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";

import { loadConfig, DEFAULT_MODEL } from "#kimiflare/config.js";
import { ToolExecutor, ALL_TOOLS } from "#kimiflare/tools/executor.js";
import type {
  PermissionRequest,
  PermissionDecision,
} from "#kimiflare/tools/executor.js";
import { McpManager } from "#kimiflare/mcp/manager.js";
import { runAgentTurn, BudgetExhaustedError } from "#kimiflare/agent/loop.js";
import { llmAuthFromConfig } from "#kimiflare/agent/llm-auth.js";
import type { AgentCallbacks } from "#kimiflare/agent/loop.js";
import { buildSystemPrompt } from "#kimiflare/agent/system-prompt.js";
import type { ChatMessage, Usage } from "#kimiflare/agent/messages.js";
import {
  makeSessionId,
  saveSession,
  listSessions as kimiListSessions,
} from "#kimiflare/sessions.js";
import type { Mode } from "#kimiflare/mode.js";
import { isBlockedInPlanMode, isReadOnlyBash } from "#kimiflare/mode.js";
import type { Task } from "#kimiflare/tools/registry.js";

import {
  getSession,
  setSession,
  deleteSession,
  type AcpSession,
} from "./sessions.js";
import {
  toAcpToolCall,
  toAcpToolUpdate,
  permissionOptions,
  fromAcpPermissionOutcome,
} from "./tools.js";

// ---------------------------------------------------------------------------
// Permission mode resolution
// ---------------------------------------------------------------------------

const VALID_MODES = ["edit", "plan", "auto"] as const;
type AcpMode = (typeof VALID_MODES)[number];

const MODE_ALIASES: Record<string, AcpMode> = {
  edit: "edit",
  plan: "plan",
  auto: "auto",
  bypass: "auto",
  bypasspermissions: "auto",
  acceptedits: "auto",
};

function resolveDefaultMode(): AcpMode {
  const raw = process.env.ACP_PERMISSION_MODE;
  if (!raw) return "edit";
  const normalized = raw.trim().toLowerCase();
  const resolved = MODE_ALIASES[normalized];
  if (!resolved) {
    console.error(
      `Unknown ACP_PERMISSION_MODE "${raw}", falling back to "edit"`,
    );
    return "edit";
  }
  return resolved;
}

const DEFAULT_ACP_MODE = resolveDefaultMode();

const AVAILABLE_MODES: SessionModeState = {
  currentModeId: DEFAULT_ACP_MODE,
  availableModes: [
    {
      id: "edit",
      name: "Edit",
      description:
        "Default mode — prompts for permission before mutating tools",
    },
    {
      id: "plan",
      name: "Plan",
      description: "Read-only research — blocks writes/edits/mutating bash",
    },
    {
      id: "auto",
      name: "Auto",
      description: "Autonomous — auto-approves every tool call (use with care)",
    },
  ],
};

export class KimiflareAcpAgent implements Agent {
  private client: AgentSideConnection;

  constructor(client: AgentSideConnection) {
    this.client = client;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: 1,
      agentInfo: { name: "kimiflare", version: "0.1.0" },
      agentCapabilities: {
        promptCapabilities: { image: true },
        sessionCapabilities: {
          close: {},
          list: {},
        },
      },
    };
  }

  async authenticate(): Promise<void> {
    // kimiflare uses env vars / config file — no interactive auth needed
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const config = await loadConfig();
    if (!config) {
      throw RequestError.authRequired(
        undefined,
        "No LLM provider credentials configured. Run `autopilot auth <provider>` (see `autopilot auth status`), or set a provider key such as OPENROUTER_API_KEY, OPENAI_API_KEY or DEEPSEEK_API_KEY.",
      );
    }

    const cwd = params.cwd;
    const sessionId = makeSessionId("acp-session");
    const executor = new ToolExecutor(ALL_TOOLS);
    const mcpManager = new McpManager();

    // Connect MCP servers from config
    if (config.mcpServers) {
      for (const [name, srv] of Object.entries(config.mcpServers)) {
        if (srv.enabled === false) continue;
        try {
          if (srv.type === "remote" && srv.url) {
            await mcpManager.addRemoteServer(name, srv.url, srv.headers);
          } else if (srv.command) {
            await mcpManager.addLocalServer(name, srv.command, srv.env);
          } else {
            // Fix #3: warn on malformed MCP server config
            console.error(
              `MCP server "${name}" has no command or url — skipping.`,
            );
          }
        } catch (err) {
          console.error(`Failed to connect MCP server "${name}":`, err);
        }
      }
    }

    // Connect MCP servers from ACP client
    for (const srv of params.mcpServers ?? []) {
      try {
        if ("url" in srv) {
          // HTTP or SSE transport
          const headers: Record<string, string> = {};
          if ("headers" in srv && Array.isArray(srv.headers)) {
            for (const h of srv.headers) {
              headers[h.name] = h.value;
            }
          }
          await mcpManager.addRemoteServer(
            srv.name,
            srv.url,
            Object.keys(headers).length > 0 ? headers : undefined,
          );
        } else {
          // Stdio transport
          const env: Record<string, string> = {};
          if (Array.isArray(srv.env)) {
            for (const e of srv.env) {
              env[e.name] = e.value;
            }
          }
          await mcpManager.addLocalServer(
            srv.name,
            [srv.command, ...srv.args],
            Object.keys(env).length > 0 ? env : undefined,
          );
        }
      } catch (err) {
        console.error(`Failed to connect client MCP server:`, err);
      }
    }

    // Register MCP tools with the executor
    for (const tool of mcpManager.getAllTools()) {
      executor.register(tool);
    }

    const allTools = executor.list();
    const initialMode: AcpMode = VALID_MODES.includes(DEFAULT_ACP_MODE)
      ? DEFAULT_ACP_MODE
      : "edit";
    const systemPrompt = buildSystemPrompt({
      cwd,
      tools: allTools,
      model: config.model,
      mode: initialMode,
    });
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

    const now = new Date().toISOString();
    const session: AcpSession = {
      id: sessionId,
      cwd,
      config,
      executor,
      mcpManager,
      messages,
      mode: initialMode,
      abortController: new AbortController(),
      promptRunning: false,
      memoryManager: null,
      createdAt: now,
    };
    setSession(sessionId, session);

    return {
      sessionId,
      modes: { ...AVAILABLE_MODES },
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = getSession(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Unknown session: ${params.sessionId}`,
      );
    }
    // Note: promptRunning is not mutex-guarded. This is acceptable for
    // stdio-based single-client usage but would need a lock for concurrent
    // multi-session scenarios.
    if (session.promptRunning) {
      throw RequestError.invalidRequest(
        undefined,
        "A prompt is already running in this session",
      );
    }

    session.promptRunning = true;
    session.abortController = new AbortController();
    const { signal } = session.abortController;

    // Build user message from ACP ContentBlocks
    const userContent = acpContentToKimi(params.prompt);
    session.messages.push(userContent);

    // Track cumulative usage for the response
    let totalUsage: Usage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    };
    let messageId = randomUUID();

    // Track the current tool call ID so the permission callback can reference it
    let currentToolCallId: string | undefined;

    const callbacks: AgentCallbacks = {
      onTextDelta: (text) => {
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
              messageId,
            },
          })
          .catch(() => {});
      },

      onReasoningDelta: (text) => {
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text },
              messageId,
            },
          })
          .catch(() => {});
      },

      onAssistantStart: () => {
        messageId = randomUUID();
      },

      onToolCallFinalized: (tc) => {
        // Stash the current tool call ID for the permission callback
        currentToolCallId = tc.id;
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call",
              ...toAcpToolCall(tc),
            },
          })
          .catch(() => {});
      },

      onToolResult: (result) => {
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "tool_call_update",
              ...toAcpToolUpdate(result),
            },
          })
          .catch(() => {});
      },

      onTasks: (tasks: Task[]) => {
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "plan",
              entries: tasks.map((t) => ({
                id: t.id,
                content: t.title,
                status: t.status as "pending" | "in_progress" | "completed",
                priority: "medium" as const,
              })),
            },
          })
          .catch(() => {});
      },

      onUsage: (usage) => {
        totalUsage = usage;
      },

      onUsageFinal: (usage) => {
        totalUsage = usage;
        this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "usage_update",
              size: 262144,
              used: usage.prompt_tokens + usage.completion_tokens,
            },
          })
          .catch(() => {});
      },

      askPermission: async (
        req: PermissionRequest,
      ): Promise<PermissionDecision> => {
        // Auto mode: allow everything
        if (session.mode === "auto") return "allow";

        // Plan mode: block mutating tools (except read-only bash)
        if (session.mode === "plan" && isBlockedInPlanMode(req.tool.name)) {
          if (req.tool.name === "bash") {
            const cmd =
              typeof req.args.command === "string" ? req.args.command : "";
            if (isReadOnlyBash(cmd)) return "allow";
          }
          return "deny";
        }

        // Edit mode: ask the client for permission
        if (!req.tool.needsPermission) return "allow";

        try {
          const toolCallForPerm = {
            // Fix #9: use the actual tool call ID so Zed can match it to
            // the previously-emitted tool_call notification
            toolCallId: currentToolCallId ?? req.sessionKey,
            title: req.tool.name,
            status: "in_progress" as const,
            rawInput: req.args,
          };

          const response = await this.client.requestPermission({
            sessionId: session.id,
            toolCall: toolCallForPerm,
            options: permissionOptions(),
          });

          return fromAcpPermissionOutcome(response.outcome);
        } catch {
          return "deny";
        }
      },
    };

    const coauthor = session.config.coauthor
      ? {
          name: session.config.coauthorName ?? "autopilot",
          email: session.config.coauthorEmail ?? "kimiflare@proton.me",
        }
      : undefined;

    let stopReason: "end_turn" | "cancelled" = "end_turn";

    try {
      await runAgentTurn({
        // Credentials and routing follow the active provider, like every other host.
        ...llmAuthFromConfig(session.config),
        model: session.config.model || DEFAULT_MODEL,
        messages: session.messages,
        tools: session.executor.list(),
        executor: session.executor,
        cwd: session.cwd,
        signal,
        callbacks,
        reasoningEffort: session.config.reasoningEffort,
        coauthor,
        sessionId: session.id,
        keepLastImageTurns: session.config.imageHistoryTurns,
        memoryManager: session.memoryManager,
        codeMode: session.config.codeMode,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        stopReason = "cancelled";
      } else if (err instanceof BudgetExhaustedError) {
        // Fix #2: notify the client that the budget was exhausted
        await this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "\n\n[Token budget exhausted. The session has reached its cumulative input token limit.]",
              },
              messageId,
            },
          })
          .catch(() => {});
        stopReason = "end_turn";
      } else {
        // Fix #4: send a user-visible error message before returning
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.client
          .sessionUpdate({
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `\n\n[Error: ${errMsg}]`,
              },
              messageId,
            },
          })
          .catch(() => {});
        stopReason = "end_turn";
      }
    } finally {
      session.promptRunning = false;
      // Save session in the background
      this.saveSessionState(session).catch(() => {});
    }

    return {
      stopReason,
      usage: {
        inputTokens: totalUsage.prompt_tokens,
        outputTokens: totalUsage.completion_tokens,
        totalTokens: totalUsage.total_tokens,
        cachedReadTokens: totalUsage.prompt_tokens_details?.cached_tokens ?? 0,
        cachedWriteTokens: 0,
      },
    };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = getSession(params.sessionId);
    if (session) {
      session.abortController.abort();
    }
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    const session = getSession(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Unknown session: ${params.sessionId}`,
      );
    }

    const newMode = params.modeId as AcpMode;
    if (!(VALID_MODES as readonly string[]).includes(newMode)) {
      throw RequestError.invalidParams(
        undefined,
        `Unknown mode: ${params.modeId}`,
      );
    }

    session.mode = newMode;
    session.executor.clearSessionPermissions();

    // Rebuild system prompt with the new mode
    const allTools = session.executor.list();
    const systemPrompt = buildSystemPrompt({
      cwd: session.cwd,
      tools: allTools,
      model: session.config.model,
      mode: newMode,
    });

    // Replace the system message(s) at the start
    const firstNonSystem = session.messages.findIndex(
      (m) => m.role !== "system",
    );
    const insertAt =
      firstNonSystem === -1 ? session.messages.length : firstNonSystem;
    session.messages.splice(0, insertAt, {
      role: "system",
      content: systemPrompt,
    });

    // Notify the client of the mode change
    this.client
      .sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: newMode,
        },
      })
      .catch(() => {});

    return {};
  }

  async listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const summaries = await kimiListSessions(30);
    const cwd = params.cwd;
    const filtered = cwd ? summaries.filter((s) => s.cwd === cwd) : summaries;
    return {
      sessions: filtered.map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.firstPrompt,
        lastUpdateTime: s.updatedAt,
      })),
    };
  }

  async closeSession(
    params: CloseSessionRequest,
  ): Promise<CloseSessionResponse> {
    const session = getSession(params.sessionId);
    if (!session) return {};

    // Cancel any in-progress work
    session.abortController.abort();

    // Save session with the original createdAt
    await this.saveSessionState(session).catch(() => {});

    // Disconnect MCP servers
    await session.mcpManager.disconnectAll().catch(() => {});

    deleteSession(params.sessionId);
    return {};
  }

  // Fix #6 & #13: centralized save that preserves the original createdAt
  private async saveSessionState(session: AcpSession): Promise<void> {
    await saveSession({
      id: session.id,
      cwd: session.cwd,
      model: session.config.model || DEFAULT_MODEL,
      createdAt: session.createdAt,
      updatedAt: new Date().toISOString(),
      messages: session.messages,
    });
  }
}

/**
 * Convert ACP ContentBlock[] prompt to a kimiflare ChatMessage.
 */
function acpContentToKimi(prompt: ContentBlock[]): ChatMessage {
  if (prompt.length === 1 && prompt[0]!.type === "text") {
    return { role: "user", content: prompt[0]!.text };
  }

  const parts = prompt
    .map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text" as const, text: block.text };
        case "image":
          return {
            type: "image_url" as const,
            image_url: { url: block.data },
          };
        case "resource": {
          // Embedded resources — extract text content
          const res = block.resource;
          if (res && "text" in res) {
            const label = res.uri ? `[${res.uri}]\n` : "";
            return { type: "text" as const, text: label + res.text };
          }
          return null;
        }
        case "resource_link":
          return { type: "text" as const, text: `[resource: ${block.uri}]` };
        default:
          return null;
      }
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (parts.length === 0) {
    return { role: "user", content: "" };
  }
  if (parts.length === 1 && parts[0]!.type === "text") {
    return { role: "user", content: parts[0]!.text };
  }
  return { role: "user", content: parts };
}
