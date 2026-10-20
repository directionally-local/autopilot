import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { KimiConfig } from "../config.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import type { ChatMessage } from "../agent/messages.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import { ToolExecutor } from "../tools/executor.js";
import { RunStore } from "../runs/store.js";
import { RunWorktreeManager } from "../runs/worktrees.js";
import { loadSession, saveSession, sessionsDir, type SessionFile } from "../sessions.js";
import { getAppVersion } from "../util/version.js";
import { AsterStore, type AsterConversationProject, type AsterConversation, type AsterConversationStatus, type AsterPrincipal, type AsterScope } from "./aster-store.js";
import { AsterConfigError, findAsterWorkspace, loadAsterServerConfig, type AsterServerConfig } from "./aster-workspaces.js";
import { loadOpenRouterCatalog } from "../models/openrouter-catalog.js";
import type { AsterArtifact, AsterCellProject } from "./aster-cell-runtime.js";
import { AsterGitHub, AsterGitHubError, REPOSITORY_FULL_NAME_RE } from "./aster-github.js";
import { AsterMemory } from "./aster-memory.js";
import { AsterGitHubProxy } from "./aster-github-proxy.js";
import { AsterPush } from "./aster-push.js";
import { containsLikelyProviderSecret, createAsterTools, redactLikelySecrets, assertAsterCellPath } from "./aster-tools.js";

const API_PREFIX = "/api/v1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// Long pasted documents are fine; the model's context window is the practical limit.
const MAX_USER_TURN_CHARS = 500_000;
const CLIENT_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREATE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_APPROVAL_ARG_BYTES = 24 * 1024;
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ASTER_TOOLS = ["read", "write", "edit"] as const;

export interface AsterTurnStart {
  runId: string;
  conversation: AsterConversation;
  cellId: string;
  cellEventCursor: number;
  userText: string;
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  allowedTools: Set<string>;
  maxToolIterations: number | null;
  maxRuntimeMs: number | null;
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  publishEvent: (type: string, data: Record<string, unknown>) => void;
  onCellCursor?: (cursor: number) => void;
  finish: (status: "completed" | "failed" | "cancelled", reason?: string) => void;
  /** Long-term memory for this turn: a note to prepend and the full memory file for the cell. */
  memory?: { note: string; snapshot: string };
  /** Runs after a completed turn's output, before its terminal status (e.g. memory extraction). */
  beforeFinish?: () => Promise<void>;
}

export interface AsterApiRuntime {
  provisionConversation?: (input: { conversationId: string; sessionId: string; cellName: string; workspaceId: string; workspaceRoot: string; model: string; allowCreate: boolean; onCellCreated: (cellId: string) => void; project?: AsterCellProject }) => Promise<{ cellId: string }>;
  findConversationCell?: (conversationId: string) => Promise<{ cellId: string } | undefined>;
  destroyCell?: (cellId: string) => Promise<void>;
  pauseCell?: (cellId: string) => Promise<void>;
  resumeCell?: (cellId: string) => Promise<void>;
  startTurn: (turn: AsterTurnStart) => void;
  /** Re-attach to a turn the cell kept running across a server restart. */
  resumeTurn?: (turn: AsterTurnStart) => void;
  cancelRun: (runId: string) => void;
  setModel?: (cellId: string, model: string) => Promise<void>;
  listCheckpoints?: (cellId: string) => Promise<AsterCheckpointInfo[]>;
  restoreCheckpoint?: (cellId: string, conversationId: string, checkpointId: string) => Promise<AsterCheckpointInfo>;
  listArtifacts?: (cellId: string) => Promise<AsterArtifact[]>;
  readArtifact?: (cellId: string, path: string) => Promise<{ data: Buffer; mimeType: string; name: string }>;
}

export interface AsterCheckpointInfo {
  id: string;
  message: string;
  createdAt: string;
}

interface AsterModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  inputPerMtok?: number;
  outputPerMtok?: number;
  created?: number;
  reasoning?: boolean;
  vision?: boolean;
}

interface AsterWaiter {
  resolve: (decision: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

export class AsterApi {
  private store: AsterStore | undefined;
  private recovery: Promise<void> | undefined;
  private readonly waiters = new Map<string, AsterWaiter>();
  private readonly connectedEventStreams = new Map<string, number>();
  private readonly runtime: AsterApiRuntime;
  private readonly config: KimiConfig;

  private readonly github: AsterGitHub;

  private memory: AsterMemory | undefined;

  constructor(
    config: KimiConfig,
    runtime: AsterApiRuntime,
    github: AsterGitHub = new AsterGitHub(),
    memory?: AsterMemory,
    push?: Pick<AsterPush, "configured" | "notify" | "close" | "register" | "unregister">,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.github = github;
    this.memory = memory;
    this.push = push;
  }

  private githubProxy: AsterGitHubProxy | undefined;
  /** Where cells reach the repository-scoped GitHub proxy, when it is running. */
  private githubProxyUrl: string | undefined;

  /**
   * Starts the repository-scoped GitHub proxy when configured
   * (AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN=host:port, AUTOPILOT_ASTER_GITHUB_PROXY_URL as cells see it).
   */
  async startGitHubProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const listen = env.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN;
    const publicUrl = env.AUTOPILOT_ASTER_GITHUB_PROXY_URL;
    const token = env.GITHUB_TOKEN;
    if (!listen || !publicUrl || !token || this.githubProxy) return;
    const separator = listen.lastIndexOf(":");
    const proxy = new AsterGitHubProxy({ token, resolveGrant: (grant) => this.getStore().resolveGitHubGrant(grant) });
    await proxy.listen(Number(listen.slice(separator + 1)), listen.slice(0, separator));
    this.githubProxy = proxy;
    this.githubProxyUrl = publicUrl.replace(/\/+$/, "");
  }

  private push: Pick<AsterPush, "configured" | "notify" | "close" | "register" | "unregister"> | undefined;

  private getPush(): Pick<AsterPush, "configured" | "notify" | "close" | "register" | "unregister"> | undefined {
    try {
      return this.push ??= new AsterPush();
    } catch {
      return undefined;
    }
  }

  /** "Your task finished" (or failed) on the user's devices; cancelled turns stay silent. */
  private notifyTurnEnd(store: AsterStore, conversationId: string, runId: string, status: string, reason: string | undefined, userText: string, after: number): void {
    if (status !== "completed" && status !== "failed") return;
    if ((this.connectedEventStreams.get(conversationId) ?? 0) > 0) return;
    const push = this.getPush();
    if (!push?.configured) return;
    const reply = status === "completed" ? collectAssistantText(store, conversationId, runId, after).trim() : "";
    const title = userText.trim().split("\n")[0] || "Aster";
    const body = status === "completed"
      ? (reply ? `✅ ${reply}` : "✅ Done")
      : `⚠️ Couldn’t finish${reason && reason !== "error" ? `: ${reason}` : ""}`;
    void push.notify({ title, body, conversationId });
  }

  private getMemory(): AsterMemory | undefined {
    if (process.env.AUTOPILOT_ASTER_MEMORY === "off") return undefined;
    try {
      return this.memory ??= new AsterMemory();
    } catch {
      return undefined;
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      const store = this.getStore();
      const principal = store.authenticate(req.headers.authorization);
      if (!principal) {
        sendError(res, 401, "invalid_credential", "A valid Aster bearer credential is required");
        return;
      }
      await this.ensureRecovered(store);
      const config = await loadAsterServerConfig();
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (path === `${API_PREFIX}/health` && method === "GET") {
        if (!this.hasScope(principal, "workspaces:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks health/read scope");
        return json(res, 200, {
          status: "ok",
          service: "autopilot",
          apiVersion: "v1",
          serviceVersion: getAppVersion(),
          capabilities: ["workspaces", "conversations", "turns", "event-replay", "cancellation", "human-approvals", "hotcell-per-conversation", "pause-resume", "destroy", "autonomous-cells", "tool-output", "checkpoints", "model-switch", "artifacts", "memory", "push", ...(this.github.configured ? ["github"] : []), ...(config.modelCatalog === "openrouter" ? ["model-catalog"] : [])],
        });
      }

      if (path === `${API_PREFIX}/workspaces` && method === "GET") {
        if (!this.hasScope(principal, "workspaces:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks workspace/read scope");
        return json(res, 200, {
          workspaces: config.workspaces
            .filter((workspace) => principal.workspaceIds.includes(workspace.id))
            .map(({ id, displayName }) => ({ id, displayName })),
        });
      }

      if (path === `${API_PREFIX}/models` && method === "GET") {
        if (!this.hasScope(principal, "models:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks model/read scope");
        const models = await selectableModels(config);
        if (models.length === 0) return sendError(res, 503, "model_catalog_unavailable", "The model catalog is unavailable; try again shortly");
        return json(res, 200, { models: models.map((model) => model.id), catalog: models });
      }

      if (path === `${API_PREFIX}/conversations` && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => !["workspaceId", "model", "kind", "repository"].includes(key))) {
          return sendError(res, 400, "unsupported_field", "Conversation creation accepts workspaceId, model, kind, and repository; paths are server-configured");
        }
        if (body.kind !== undefined && body.kind !== "chat" && body.kind !== "code") {
          return sendError(res, 400, "invalid_kind", "kind must be \"chat\" or \"code\"");
        }
        if (body.kind === "code" && (typeof body.repository !== "string" || !REPOSITORY_FULL_NAME_RE.test(body.repository))) {
          return sendError(res, 400, "repository_required", "Code conversations need a repository as owner/name");
        }
        if (body.kind !== "code" && body.repository !== undefined) {
          return sendError(res, 400, "unsupported_field", "repository is only accepted for code conversations");
        }
        if (typeof body.workspaceId !== "string" || !principal.workspaceIds.includes(body.workspaceId)) {
          return sendError(res, 403, "workspace_forbidden", "Workspace ID is not in this credential's scope");
        }
        const workspace = findAsterWorkspace(config, body.workspaceId);
        if (!workspace) return sendError(res, 404, "workspace_not_found", "Workspace is not configured");
        if (typeof body.model !== "string" || !(await isSelectableModel(config, body.model))) {
          return sendError(res, 400, "model_not_allowed", "Select a model from the configured model list");
        }
        const idempotencyKey = req.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !CREATE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
          return sendError(res, 400, "idempotency_key_required", "Conversation creation requires an Idempotency-Key header of 1-128 safe characters");
        }
        const kind = body.kind as "chat" | "code" | undefined;
        return await this.createConversation(res, store, principal, workspace, body.model, idempotencyKey, kind, body.repository as string | undefined);
      }

      if (path === `${API_PREFIX}/devices` && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const body = await readJsonBody(req);
        const environment = body.environment === "development" ? "development" : "production";
        const push = this.getPush();
        if (!push || typeof body.token !== "string" || !push.register(body.token, environment)) {
          return sendError(res, 400, "invalid_device_token", "A hex APNs device token is required");
        }
        return json(res, 200, { registered: true, notifications: push.configured });
      }
      const deviceMatch = path.match(/^\/api\/v1\/devices\/([0-9a-fA-F]{64,200})$/);
      if (deviceMatch && method === "DELETE") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        this.getPush()?.unregister(deviceMatch[1]!);
        return json(res, 200, { unregistered: true });
      }

      if (path === `${API_PREFIX}/memory` && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const memory = this.getMemory();
        return json(res, 200, { enabled: Boolean(memory?.enabled), items: memory ? memory.list() : [] });
      }
      const memoryMatch = path.match(/^\/api\/v1\/memory\/([^/]+)$/);
      if (memoryMatch && method === "DELETE") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const memory = this.getMemory();
        if (!memory || !memory.delete(memoryMatch[1]!)) return sendError(res, 404, "memory_not_found", "Memory item not found");
        return json(res, 200, { deleted: memoryMatch[1] });
      }

      if (path === `${API_PREFIX}/github/repositories` && (method === "GET" || method === "POST")) {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        try {
          if (method === "GET") {
            return json(res, 200, { repositories: await this.github.listRepositories(url.searchParams.get("q") ?? "") });
          }
          const body = await readJsonBody(req);
          if (typeof body.name !== "string") return sendError(res, 400, "invalid_repository_name", "name is required");
          const repository = await this.github.createRepository({
            name: body.name.trim(),
            private: body.private !== false,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
          });
          return json(res, 201, { repository });
        } catch (error) {
          if (error instanceof AsterGitHubError) return sendError(res, error.status, error.code, error.message);
          throw error;
        }
      }

      const eventsMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/events$/);
      if (eventsMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, eventsMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const cursor = parseCursor(req.headers["last-event-id"], url.searchParams.get("after"));
        if (cursor === undefined) return sendError(res, 400, "invalid_event_cursor", "Event cursor must be a non-negative integer");
        return this.streamEvents(req, res, store, conversation.id, cursor);
      }

      const turnMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/turns$/);
      if (turnMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, turnMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => key !== "text" && key !== "clientTurnId" && key !== "model")) return sendError(res, 400, "unsupported_field", "Turns accept text, an optional clientTurnId, and an optional model; the workspace is fixed by the conversation");
        const hasClientTurnId = Object.hasOwn(body, "clientTurnId");
        const clientTurnId = hasClientTurnId && typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;
        if (hasClientTurnId && (!clientTurnId || !CLIENT_TURN_ID_RE.test(clientTurnId))) return sendError(res, 400, "invalid_client_turn_id", "clientTurnId must be 1-128 ASCII letters, digits, '.', '_', ':', or '-' and start with a letter or digit");
        const requestText = typeof body.text === "string" ? body.text : "";
        const text = requestText.trim();
        if (!text || text.length > MAX_USER_TURN_CHARS) return sendError(res, 400, "invalid_turn", `Turn text must be 1-${MAX_USER_TURN_CHARS} characters`);
        if (containsLikelyProviderSecret(text)) return sendError(res, 400, "secret_input_rejected", "Provider credentials must not be sent in conversation text");
        let target = conversation;
        if (Object.hasOwn(body, "model")) {
          if (typeof body.model !== "string" || !(await isSelectableModel(config, body.model))) {
            return sendError(res, 400, "model_not_allowed", "Select a model from the model catalog");
          }
          if (body.model !== conversation.model) {
            const switched = await this.switchModel(res, store, conversation, body.model);
            if (!switched) return;
            target = switched;
          }
        }
        return await this.appendTurn(res, store, target, clientTurnId, requestText, text);
      }

      const cancelMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, cancelMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return this.cancelConversation(res, store, conversation);
      }

      const lifecycleMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/(pause|resume)$/);
      if (lifecycleMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, lifecycleMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return lifecycleMatch[2] === "pause"
          ? this.pauseConversation(res, store, conversation)
          : this.resumeConversation(res, store, conversation);
      }

      const artifactsMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/artifacts(\/file)?$/);
      if (artifactsMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, artifactsMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const cell = this.readyCell(res, store, conversation.id);
        if (!cell) return;
        if (!this.runtime.listArtifacts || !this.runtime.readArtifact) return sendError(res, 503, "artifacts_unavailable", "Artifacts are not configured");
        if (!artifactsMatch[2]) return json(res, 200, { artifacts: await this.runtime.listArtifacts(cell) });
        try {
          const artifact = await this.runtime.readArtifact(cell, url.searchParams.get("path") ?? "");
          res.writeHead(200, {
            "content-type": artifact.mimeType,
            "content-length": artifact.data.length,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(artifact.name)}`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(artifact.data);
          return;
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (code === "invalid_artifact_path") return sendError(res, 400, code, "Artifact path is invalid");
          if (code === "artifact_too_large") return sendError(res, 413, code, "Artifact is larger than 50 MB");
          return sendError(res, 404, "artifact_not_found", "Artifact not found");
        }
      }

      const checkpointsMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/checkpoints$/);
      if (checkpointsMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, checkpointsMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const cell = this.readyCell(res, store, conversation.id);
        if (!cell) return;
        if (!this.runtime.listCheckpoints) return sendError(res, 503, "checkpoints_unavailable", "Checkpoints are not configured");
        return json(res, 200, { checkpoints: await this.runtime.listCheckpoints(cell) });
      }

      const restoreMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/checkpoints\/([0-9a-f]{7,40})\/restore$/);
      if (restoreMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, restoreMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        if (conversation.activeRunId) return sendError(res, 409, "turn_active", "Wait for the current turn to finish or cancel it before restoring");
        const cell = this.readyCell(res, store, conversation.id);
        if (!cell) return;
        if (!this.runtime.restoreCheckpoint) return sendError(res, 503, "checkpoints_unavailable", "Checkpoints are not configured");
        try {
          const checkpoint = await this.runtime.restoreCheckpoint(cell, conversation.id, restoreMatch[2]!);
          store.appendEvent(conversation.id, null, "checkpoint.restored", { restoredFrom: restoreMatch[2]!, ...checkpoint });
          return json(res, 200, { checkpoint });
        } catch (error) {
          if (error instanceof Error && error.message === "checkpoint_not_found") return sendError(res, 404, "checkpoint_not_found", "Checkpoint not found");
          return sendError(res, 500, "checkpoint_restore_failed", "The workspace could not be restored");
        }
      }

      const conversationMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (conversationMatch && method === "DELETE") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, conversationMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return this.destroyConversation(res, store, conversation);
      }
      if (conversationMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, conversationMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return json(res, 200, publicConversation(conversation, store.getConversationProject(conversation.id)));
      }

      const approvalMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const approval = store.getApproval(approvalMatch[1]!);
        if (!approval) return sendError(res, 404, "approval_not_found", "Approval not found");
        const conversation = store.getConversation(approval.conversationId);
        const mapping = store.getCellMapping(approval.conversationId);
        if (!conversation || mapping?.credentialId !== principal.credentialId || !principal.workspaceIds.includes(conversation.workspaceId)) return sendError(res, 404, "approval_not_found", "Approval not found");
        return json(res, 200, publicApproval(approval));
      }
      if (approvalMatch && method === "POST") {
        if (!this.hasScope(principal, "approvals:resolve")) return sendError(res, 403, "insufficient_scope", "Credential lacks approval/resolve scope");
        const approval = store.getApproval(approvalMatch[1]!);
        if (!approval) return sendError(res, 404, "approval_not_found", "Approval not found");
        const conversation = store.getConversation(approval.conversationId);
        const mapping = store.getCellMapping(approval.conversationId);
        if (!conversation || mapping?.credentialId !== principal.credentialId || !principal.workspaceIds.includes(conversation.workspaceId)) return sendError(res, 404, "approval_not_found", "Approval not found");
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => key !== "decision")) return sendError(res, 400, "unsupported_field", "Approval resolution accepts decision only");
        if (body.decision !== "allow" && body.decision !== "deny") return sendError(res, 400, "invalid_approval_decision", "decision must be allow or deny");
        return this.resolveApproval(res, store, approval.id, body.decision);
      }

      return sendError(res, 404, "not_found", "Aster endpoint not found");
    } catch (error) {
      if (isHttpFailure(error)) return sendError(res, error.status, error.code, error.message);
      if (error instanceof AsterConfigError) return sendError(res, 503, "aster_not_configured", "Aster workspaces/models are not configured");
      return sendError(res, 500, "internal_error", "Aster request could not be completed");
    }
  }

  close(): void {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("deny");
      this.waiters.delete(id);
    }
    this.store?.close();
    this.store = undefined;
    this.memory?.close();
    this.memory = undefined;
    this.githubProxy?.close();
    this.githubProxy = undefined;
    this.push?.close();
    this.push = undefined;
  }

  private getStore(): AsterStore {
    return this.store ??= new AsterStore();
  }

  private hasScope(principal: AsterPrincipal, scope: AsterScope): boolean {
    return principal.scopes.includes(scope);
  }

  private async authorizedConversation(store: AsterStore, principal: AsterPrincipal, id: string): Promise<AsterConversation | undefined> {
    if (!CONVERSATION_ID_RE.test(id)) return undefined;
    const conversation = store.getConversation(id);
    const mapping = store.getCellMapping(id);
    if (!conversation || mapping?.credentialId !== principal.credentialId || !principal.workspaceIds.includes(conversation.workspaceId)) return undefined;
    const activeRunId = conversation.activeRunId;
    if (activeRunId) {
      const runs = new RunStore();
      try {
        const run = runs.getRun(activeRunId);
        if (run && ["interrupted_unknown", "cancelled", "failed", "completed"].includes(run.status)) {
          const status: AsterConversationStatus = run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "interrupted";
          store.updateConversationStatus(conversation.id, activeRunId, status, { reason: "run_recovered" });
          return store.getConversation(id);
        }
      } finally {
        runs.close();
      }
    }
    return conversation;
  }

  private async ensureRecovered(store: AsterStore): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const runs = new RunStore();
      try {
        runs.reconcileInterruptedRuns();
        for (const approval of store.expireAllPendingApprovals()) {
          const run = runs.getRun(approval.runId);
          if (run && ["running", "waiting", "needs_input", "queued"].includes(run.status)) {
            runs.transition(run.id, "cancelled", "server_restarted_during_approval");
            runs.cancelTimersForRun(run.id);
          }
          store.updateConversationStatus(approval.conversationId, approval.runId, "interrupted", { reason: "approval_expired_on_restart" });
          store.appendEvent(approval.conversationId, approval.runId, "approval.expired", { approvalId: approval.id });
        }
        for (const conversation of store.listActiveConversations()) {
          const run = conversation.activeRunId ? runs.getRun(conversation.activeRunId) : undefined;
          if (!run || ["interrupted_unknown", "cancelled", "failed", "completed"].includes(run.status)) {
            const status: AsterConversationStatus = run?.status === "completed" ? "completed" : run?.status === "cancelled" ? "cancelled" : "interrupted";
            store.updateConversationStatus(conversation.id, conversation.activeRunId!, status, { reason: "server_restart_recovery" });
          } else if (run.status === "needs_input") {
            runs.transition(run.id, "cancelled", "approval_expired_on_restart");
            store.updateConversationStatus(conversation.id, run.id, "interrupted", { reason: "approval_expired_on_restart" });
          } else {
            // Still running in its cell: re-attach instead of leaving the conversation busy forever.
            const mapping = store.getCellMapping(conversation.id);
            if (mapping?.cellId && this.runtime.resumeTurn) {
              this.runtime.resumeTurn(this.cellTurn(store, conversation, run.id, mapping.cellId, mapping.eventCursor, run.task ?? ""));
            } else {
              runs.transition(run.id, "failed", "server_restarted");
              store.updateConversationStatus(conversation.id, run.id, "interrupted", { reason: "server_restart_recovery" });
            }
          }
        }
      } finally {
        runs.close();
      }
    })();
    return this.recovery;
  }

  /** A turn handle for re-attaching to a cell turn after a restart (no prompt is sent). */
  private cellTurn(store: AsterStore, conversation: AsterConversation, runId: string, cellId: string, cursor: number, userText: string): AsterTurnStart {
    const publishEvent = (type: string, data: Record<string, unknown>) => {
      store.appendEvent(conversation.id, runId, type, data);
    };
    return {
      runId,
      conversation,
      cellId,
      cellEventCursor: cursor,
      userText,
      sessionFile: {} as SessionFile,
      messages: [],
      executor: new ToolExecutor([]),
      allowedTools: new Set(),
      maxToolIterations: null,
      maxRuntimeMs: null,
      askPermission: async () => "deny",
      publishEvent,
      onCellCursor: (next) => store.advanceCellEventCursor(conversation.id, next),
      finish: (status, reason) => {
        const runs = new RunStore();
        try {
          const run = runs.getRun(runId);
          if (run && ["queued", "running", "waiting", "needs_input"].includes(run.status)) runs.transition(runId, status, reason ?? status);
        } catch { /* run bookkeeping is best-effort */ } finally {
          runs.close();
        }
        const updated = store.updateConversationStatus(conversation.id, runId, status, reason ? { reason } : {});
        if (updated) store.appendEvent(conversation.id, runId, status, reason ? { reason } : {});
        if (updated) this.notifyTurnEnd(store, conversation.id, runId, status, reason, userText, 0);
      },
    };
  }

  private async createConversation(
    res: ServerResponse,
    store: AsterStore,
    principal: AsterPrincipal,
    workspace: { id: string; displayName: string; rootPath: string },
    model: string,
    idempotencyKey: string,
    kind?: "chat" | "code",
    repository?: string,
  ): Promise<void> {
    const candidateId = randomUUID();
    const candidateSessionId = randomUUID();
    const reservation = store.reserveCellConversation({
      conversationId: candidateId,
      credentialId: principal.credentialId,
      workspaceId: workspace.id,
      model,
      sessionId: candidateSessionId,
      cellName: `aster-${candidateId}`,
      idempotencyKey,
    });
    if (reservation.kind === "conflict") return sendError(res, 409, "idempotency_conflict", "Idempotency-Key was already used for different conversation parameters");

    const mapping = reservation.mapping;
    if (mapping.status === "destroyed") return sendError(res, 410, "conversation_destroyed", "Conversation was already destroyed");
    if (mapping.status === "ready") {
      const existing = store.getConversation(mapping.conversationId);
      if (existing) return json(res, 200, publicConversation(existing, store.getConversationProject(existing.id)));
    }
    if (!this.runtime.provisionConversation) {
      store.setCellStatus(mapping.conversationId, "failed");
      return sendError(res, 503, "hotcell_unavailable", "Hotcell conversation runtime is not configured");
    }

    // The project is fixed on first attempt; retries with the same Idempotency-Key reuse it.
    let project: AsterCellProject | undefined;
    if (kind) {
      let stored = store.getConversationProject(mapping.conversationId);
      if (!stored) {
        if (kind === "code") {
          let repo;
          try {
            repo = await this.github.getRepository(repository!);
          } catch (error) {
            if (error instanceof AsterGitHubError) return sendError(res, error.status, error.code, error.message);
            throw error;
          }
          store.setConversationProject(mapping.conversationId, {
            kind,
            repository: repo.fullName,
            branch: `aster/${mapping.conversationId.slice(0, 8)}`,
          });
          stored = { kind, repository: repo.fullName, branch: `aster/${mapping.conversationId.slice(0, 8)}` };
          project = { kind, repository: repo.fullName, baseBranch: repo.defaultBranch, branch: stored.branch! };
        } else {
          store.setConversationProject(mapping.conversationId, { kind, repository: null, branch: null });
          stored = { kind, repository: null, branch: null };
        }
      }
      if (!project) {
        project = stored.kind === "code"
          ? { kind: "code", repository: stored.repository!, baseBranch: (await this.github.getRepository(stored.repository!).catch(() => undefined))?.defaultBranch ?? "main", branch: stored.branch! }
          : { kind: "chat" };
      }
      if (project.kind === "code" && project.repository && this.githubProxyUrl) {
        project.github = {
          token: store.getOrCreateGitHubGrant(mapping.conversationId, project.repository),
          gitUrl: `${this.githubProxyUrl}/git`,
          apiUrl: `${this.githubProxyUrl}/api`,
        };
      }
    }

    try {
      const allowCreate = !mapping.createAttempted;
      if (allowCreate) store.markCellCreateAttempted(mapping.conversationId);
      const provisioned = await this.runtime.provisionConversation({
        conversationId: mapping.conversationId,
        sessionId: mapping.sessionId,
        cellName: mapping.cellName,
        workspaceId: workspace.id,
        workspaceRoot: workspace.rootPath,
        model,
        allowCreate,
        onCellCreated: (cellId) => store.setCellId(mapping.conversationId, cellId),
        ...(project ? { project } : {}),
      });
      store.setCellId(mapping.conversationId, provisioned.cellId);
      const conversation = store.getConversation(mapping.conversationId) ?? store.createConversation({
        id: mapping.conversationId,
        workspaceId: workspace.id,
        model,
        sessionId: mapping.sessionId,
        worktreePath: "/workspace",
        cwd: "/workspace",
        branch: "cell",
      });
      const sessionFile: SessionFile = {
        id: mapping.sessionId,
        cwd: "/workspace",
        model,
        createdAt: new Date(mapping.createdAt).toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        title: "Aster conversation",
      };
      await saveSession(sessionFile);
      store.setCellStatus(mapping.conversationId, "ready");
      store.appendEvent(mapping.conversationId, null, "conversation.created", { conversationId: mapping.conversationId, workspaceId: workspace.id, model });
      json(res, reservation.kind === "created" ? 201 : 200, publicConversation(conversation, store.getConversationProject(conversation.id)));
    } catch {
      const current = store.getCellMapping(mapping.conversationId);
      if (current?.cellId && this.runtime.destroyCell) {
        try {
          await this.runtime.destroyCell(current.cellId);
          store.setCellStatus(mapping.conversationId, "failed");
        } catch {
          store.setCellStatus(mapping.conversationId, "cleanup_pending");
        }
      } else {
        store.setCellStatus(mapping.conversationId, "failed");
      }
      sendError(res, 503, "conversation_provisioning_failed", "Conversation provisioning failed; retry with the same Idempotency-Key to reconcile its state");
    }
  }

  private async appendTurn(
    res: ServerResponse,
    store: AsterStore,
    conversation: AsterConversation,
    clientTurnId: string | undefined,
    requestText: string,
    text: string,
  ): Promise<void> {
    const idempotent = clientTurnId !== undefined;
    if (clientTurnId !== undefined) {
      const previous = store.lookupTurn(conversation.id, clientTurnId, requestText);
      if (previous.kind === "replay") {
        json(res, previous.responseStatus, previous.response);
        return;
      }
      if (previous.kind === "conflict") {
        sendError(res, 409, "idempotency_conflict", "clientTurnId was already used with different text");
        return;
      }
    }

    const cellMapping = store.getCellMapping(conversation.id);
    if (cellMapping?.status === "paused") {
      sendError(res, 409, "conversation_paused", "Conversation is paused; resume it before submitting a turn");
      return;
    }
    if (!cellMapping?.cellId || ["provisioning", "destroying", "cleanup_pending", "destroyed", "failed"].includes(cellMapping.status)) {
      sendError(res, 409, "conversation_cell_unavailable", "Conversation cell is not available");
      return;
    }

    const runId = randomUUID();
    if (!idempotent && !store.beginTurn(conversation.id, runId)) {
      sendError(res, 409, "conversation_busy", "A turn is already active for this conversation");
      return;
    }

    const sessionPath = resolve(sessionsDir(), conversation.sessionId + ".json");
    let sessionFile: SessionFile;
    try {
      sessionFile = await loadSession(sessionPath);
    } catch {
      if (!idempotent) store.updateConversationStatus(conversation.id, runId, "interrupted", { reason: "session_missing" });
      sendError(res, 409, "conversation_state_unavailable", "Conversation state is unavailable; no new turn was started");
      return;
    }
    if (sessionFile.cwd !== conversation.cwd) {
      if (!idempotent) store.updateConversationStatus(conversation.id, runId, "failed", { reason: "workspace_mismatch" });
      sendError(res, 500, "conversation_state_invalid", "Conversation workspace binding is invalid");
      return;
    }

    const acceptedResponse: Record<string, unknown> = {
      conversationId: conversation.id,
      runId,
      status: "running",
    };
    if (clientTurnId !== undefined) acceptedResponse.clientTurnId = clientTurnId;
    if (clientTurnId !== undefined) {
      const reservation = store.reserveTurn({
        conversationId: conversation.id,
        clientTurnId,
        requestText,
        acceptedText: text,
        runId,
        response: acceptedResponse,
      });
      if (reservation.kind === "replay") {
        json(res, reservation.responseStatus, reservation.response);
        return;
      }
      if (reservation.kind === "conflict") {
        sendError(res, 409, "idempotency_conflict", "clientTurnId was already used with different text");
        return;
      }
      if (reservation.kind === "busy") {
        sendError(res, 409, "conversation_busy", "A turn is already active for this conversation");
        return;
      }
      if (reservation.kind === "not_found") {
        sendError(res, 404, "conversation_not_found", "Conversation not found");
        return;
      }
    }

    const previousLength = sessionFile.messages.length;
    sessionFile.messages.push({ role: "user", content: text });
    sessionFile.updatedAt = new Date().toISOString();
    try {
      await saveSession(sessionFile);
      const runStore = new RunStore();
      let run;
      try {
        run = runStore.createRun({
          id: runId,
          task: text,
          cwd: conversation.cwd,
          sessionId: conversation.sessionId,
          allowedTools: [...ALLOWED_ASTER_TOOLS],
        });
        runStore.transition(runId, "running");
      } finally {
        runStore.close();
      }
      const tools = createAsterTools(conversation.cwd);
      const executor = new ToolExecutor(tools);
      executor.unregister("expand_artifact");
      const allowedTools = new Set(tools.map((tool) => tool.name));
      const publishEvent = (type: string, data: Record<string, unknown>) => {
        store.appendEvent(conversation.id, runId, type, data);
      };
      const turnStartSequence = store.getConversation(conversation.id)?.lastEventSequence ?? 0;
      const active: AsterTurnStart = {
        runId,
        conversation,
        cellId: cellMapping.cellId,
        cellEventCursor: cellMapping.eventCursor,
        userText: text,
        sessionFile,
        messages: sessionFile.messages,
        executor,
        allowedTools,
        maxToolIterations: run.maxToolIterations,
        maxRuntimeMs: run.maxRuntimeMs,
        askPermission: (request) => this.askForApproval(store, conversation, runId, request, publishEvent),
        publishEvent,
        onCellCursor: (cursor) => store.advanceCellEventCursor(conversation.id, cursor),
        finish: (status, reason) => {
          const updated = store.updateConversationStatus(conversation.id, runId, status, reason ? { reason } : {});
          if (updated) store.appendEvent(conversation.id, runId, status, reason ? { reason } : {});
          if (updated) this.notifyTurnEnd(store, conversation.id, runId, status, reason, text, turnStartSequence);
        },
      };
      const memory = this.getMemory();
      if (memory) {
        active.memory = { note: memory.brief(conversation.id, text), snapshot: memory.snapshot() };
        const firstSequence = store.getConversation(conversation.id)?.lastEventSequence ?? 0;
        active.beforeFinish = async () => {
          const reply = collectAssistantText(store, conversation.id, runId, firstSequence);
          const project = store.getConversationProject(conversation.id);
          const changes = await memory.remember({ conversationId: conversation.id, project, userText: text, assistantText: reply });
          if (changes.length) publishEvent("memory.updated", { items: changes });
        };
      }
      this.runtime.startTurn(active);
      json(res, 202, acceptedResponse);
    } catch {
      sessionFile.messages.length = previousLength;
      await saveSession(sessionFile).catch(() => {});
      const runs = new RunStore();
      try {
        const run = runs.getRun(runId);
        if (run && ["queued", "running", "waiting", "needs_input"].includes(run.status)) {
          runs.transition(runId, "failed", "aster_turn_start_failed");
          runs.cancelTimersForRun(runId);
        }
      } finally {
        runs.close();
      }
      store.updateConversationStatus(conversation.id, runId, "failed", { reason: "turn_start_failed" });
      store.appendEvent(conversation.id, runId, "failed", { code: "turn_start_failed" });
      if (idempotent) json(res, 202, acceptedResponse);
      else sendError(res, 500, "turn_start_failed", "Turn could not be started");
    }
  }

  private async askForApproval(
    store: AsterStore,
    conversation: AsterConversation,
    runId: string,
    request: PermissionRequest,
    publish: (type: string, data: Record<string, unknown>) => void,
  ): Promise<PermissionDecision> {
    if (request.tool.name !== "write" && request.tool.name !== "edit") return "deny";
    const argsJson = JSON.stringify(request.args);
    if (Buffer.byteLength(argsJson, "utf8") > MAX_APPROVAL_ARG_BYTES || containsLikelyProviderSecret(argsJson)) {
      publish("tool.activity", { tool: request.tool.name, activity: "rejected", reason: "unsafe_payload" });
      return "deny";
    }
    try {
      assertAsterCellPath(request.args.path);
    } catch {
      publish("tool.activity", { tool: request.tool.name, activity: "rejected", reason: "workspace_path_forbidden" });
      return "deny";
    }
    const file = typeof request.args.path === "string" ? request.args.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "workspace file";
    const explanation = request.tool.name === "write" ? `Create or replace ${file} in this workspace` : `Edit ${file} in this workspace`;
    const config = await loadAsterServerConfig();
    const approval = store.createApproval({
      conversationId: conversation.id,
      runId,
      toolName: request.tool.name,
      explanation,
      arguments: request.args,
      expiresAt: Date.now() + config.approvalTtlMs,
    });
    const runs = new RunStore();
    try {
      const run = runs.getRun(runId);
      if (run?.status === "running") runs.transition(runId, "needs_input", `approval:${approval.id}`);
    } finally {
      runs.close();
    }
    store.updateConversationStatus(conversation.id, runId, "waiting_approval", { approvalId: approval.id });
    publish("approval.required", { approvalId: approval.id, tool: approval.toolName, explanation: approval.explanation, expiresAt: approval.expiresAt });
    const push = this.getPush();
    if (push?.configured) {
      void push.notify({
        title: "Approval required",
        body: approval.toolName + ": " + approval.explanation,
        conversationId: conversation.id,
        category: "APPROVAL",
        approvalId: approval.id,
      });
    }

    return new Promise<PermissionDecision>((resolveDecision) => {
      const timer = setTimeout(() => { void this.expireApproval(store, approval.id); }, config.approvalTtlMs);
      timer.unref();
      this.waiters.set(approval.id, { resolve: resolveDecision, timer });
    });
  }

  private async expireApproval(store: AsterStore, id: string): Promise<void> {
    const approval = store.expireApproval(id);
    if (!approval || approval.status !== "expired") return;
    await this.resumeAfterApproval(store, approval, "deny", "expired");
  }

  private async resolveApproval(res: ServerResponse, store: AsterStore, id: string, decision: "allow" | "deny"): Promise<void> {
    const result = store.resolveApproval(id, decision);
    if (!result.approval) {
      sendError(res, 404, "approval_not_found", "Approval not found");
      return;
    }
    const approval = result.approval;
    if (approval.status === "expired") {
      if (result.changed) await this.resumeAfterApproval(store, approval, "deny", "expired");
      sendError(res, 410, "approval_expired", "Approval has expired; the action was not executed");
      return;
    }
    if (result.conflict) {
      sendError(res, 409, "approval_already_resolved", "Approval was already resolved with a different decision");
      return;
    }
    if (approval.status === "approved" || approval.status === "denied") {
      if (result.changed) await this.resumeAfterApproval(store, approval, decision, approval.status);
      json(res, 200, { approvalId: id, status: approval.status, decision: approval.decision });
      return;
    }
    sendError(res, 409, "approval_not_pending", "Approval is not pending");
  }

  private async resumeAfterApproval(store: AsterStore, approval: import("./aster-store.js").AsterApproval, decision: "allow" | "deny", status: string): Promise<void> {
    const runs = new RunStore();
    try {
      const run = runs.getRun(approval.runId);
      if (run?.status === "needs_input") runs.transition(approval.runId, "running", `approval_${status}:${approval.id}`);
    } finally {
      runs.close();
    }
    store.updateConversationStatus(approval.conversationId, approval.runId, "running", { approvalId: approval.id, decision: status });
    store.appendEvent(approval.conversationId, approval.runId, status === "expired" ? "approval.expired" : "approval.resolved", {
      approvalId: approval.id,
      decision: status === "expired" ? "deny" : decision,
    });
    const waiter = this.waiters.get(approval.id);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(approval.id);
      waiter.resolve(status === "expired" ? "deny" : decision);
    }
  }

  private async pauseConversation(res: ServerResponse, store: AsterStore, conversation: AsterConversation): Promise<void> {
    const mapping = store.getCellMapping(conversation.id);
    if (!mapping || !mapping.cellId) return sendError(res, 409, "cell_not_ready", "Conversation cell is not ready");
    if (mapping.status === "paused") return json(res, 200, { ...publicConversation(conversation), cellStatus: "paused" });
    if (conversation.activeRunId) return sendError(res, 409, "turn_active", "Pause is only available at a safe boundary; cancel or wait for the active turn first");
    if (!this.runtime.pauseCell) return sendError(res, 503, "hotcell_pause_unavailable", "Hotcell pause is not configured");
    try {
      await this.runtime.pauseCell(mapping.cellId);
      store.setCellStatus(conversation.id, "paused");
      store.setConversationStatus(conversation.id, "paused", { reason: "safe_boundary" });
      store.appendEvent(conversation.id, null, "conversation.paused", { strategy: "safe_boundary" });
      const updated = store.getConversation(conversation.id)!;
      json(res, 200, { ...publicConversation(updated), cellStatus: "paused" });
    } catch {
      sendError(res, 503, "pause_failed", "Conversation could not be paused; its lifecycle state was not changed");
    }
  }

  private async resumeConversation(res: ServerResponse, store: AsterStore, conversation: AsterConversation): Promise<void> {
    const mapping = store.getCellMapping(conversation.id);
    if (!mapping || !mapping.cellId) return sendError(res, 409, "cell_not_ready", "Conversation cell is not ready");
    if (mapping.status !== "paused") return json(res, 200, { ...publicConversation(conversation), cellStatus: mapping.status });
    if (!this.runtime.resumeCell) return sendError(res, 503, "hotcell_resume_unavailable", "Hotcell resume is not configured");
    try {
      await this.runtime.resumeCell(mapping.cellId);
      store.setCellStatus(conversation.id, "ready");
      store.setConversationStatus(conversation.id, "ready", { reason: "resumed" });
      store.appendEvent(conversation.id, null, "conversation.resumed", { sessionId: mapping.sessionId });
      const updated = store.getConversation(conversation.id)!;
      json(res, 200, { ...publicConversation(updated), cellStatus: "ready" });
    } catch {
      sendError(res, 503, "resume_failed", "Conversation could not be resumed; the persisted cell state is unchanged");
    }
  }

  private async destroyConversation(res: ServerResponse, store: AsterStore, conversation: AsterConversation): Promise<void> {
    const mapping = store.getCellMapping(conversation.id);
    if (!mapping) return sendError(res, 404, "conversation_not_found", "Conversation not found");
    if (mapping.status === "destroyed") return json(res, 200, { conversationId: conversation.id, status: "destroyed" });
    if (!this.runtime.destroyCell) return sendError(res, 503, "hotcell_destroy_unavailable", "Hotcell cleanup is not configured");

    store.setCellStatus(conversation.id, "destroying");
    // The cell's repository access ends with the conversation.
    store.revokeGitHubGrant(conversation.id);
    if (conversation.activeRunId) {
      for (const approval of store.cancelPendingApprovals(conversation.id)) {
        const waiter = this.waiters.get(approval.id);
        if (waiter) { clearTimeout(waiter.timer); this.waiters.delete(approval.id); waiter.resolve("deny"); }
      }
      this.runtime.cancelRun(conversation.activeRunId);
      store.updateConversationStatus(conversation.id, conversation.activeRunId, "cancelled", { reason: "conversation_destroyed" });
    }
    try {
      if (mapping.cellId) await this.runtime.destroyCell(mapping.cellId);
      await unlink(resolve(sessionsDir(), mapping.sessionId + ".json")).catch(() => {});
      store.setCellStatus(conversation.id, "destroyed");
      store.setConversationStatus(conversation.id, "destroyed");
      store.appendEvent(conversation.id, null, "conversation.destroyed", { conversationId: conversation.id });
      json(res, 200, { conversationId: conversation.id, status: "destroyed" });
    } catch {
      store.setCellStatus(conversation.id, "cleanup_pending");
      sendError(res, 503, "cleanup_pending", "Cell cleanup is pending; retry DELETE to revoke credentials and remove the cell");
    }
  }

  /** The conversation's cell id when it can take control requests; otherwise sends the error. */
  private readyCell(res: ServerResponse, store: AsterStore, conversationId: string): string | undefined {
    const mapping = store.getCellMapping(conversationId);
    if (mapping?.status === "paused") {
      sendError(res, 409, "conversation_paused", "Conversation is paused; resume it first");
      return undefined;
    }
    if (!mapping?.cellId || mapping.status !== "ready") {
      sendError(res, 409, "conversation_cell_unavailable", "Conversation cell is not available");
      return undefined;
    }
    return mapping.cellId;
  }

  /** Switch the cell session first, then the record, so a failed switch leaves both on the old model. */
  private async switchModel(
    res: ServerResponse,
    store: AsterStore,
    conversation: AsterConversation,
    model: string,
  ): Promise<AsterConversation | undefined> {
    if (conversation.activeRunId) {
      sendError(res, 409, "conversation_busy", "A turn is already active for this conversation");
      return undefined;
    }
    const cell = this.readyCell(res, store, conversation.id);
    if (!cell) return undefined;
    if (!this.runtime.setModel) {
      sendError(res, 503, "model_switch_unavailable", "Model switching is not configured");
      return undefined;
    }
    try {
      await this.runtime.setModel(cell, model);
    } catch {
      sendError(res, 503, "model_switch_failed", "The conversation's model could not be switched");
      return undefined;
    }
    if (!store.setConversationModel(conversation.id, model)) {
      sendError(res, 409, "conversation_busy", "A turn is already active for this conversation");
      return undefined;
    }
    try {
      const sessionPath = resolve(sessionsDir(), conversation.sessionId + ".json");
      const sessionFile = await loadSession(sessionPath);
      sessionFile.model = model;
      await saveSession(sessionFile);
    } catch { /* the host session copy is informational; the cell owns the live session */ }
    return store.getConversation(conversation.id);
  }

  private async cancelConversation(res: ServerResponse, store: AsterStore, conversation: AsterConversation): Promise<void> {
    const runId = conversation.activeRunId;
    if (!runId) {
      json(res, 200, publicConversation(conversation));
      return;
    }
    const approvals = store.cancelPendingApprovals(conversation.id);
    for (const approval of approvals) {
      const waiter = this.waiters.get(approval.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.waiters.delete(approval.id);
        waiter.resolve("deny");
      }
      store.appendEvent(conversation.id, runId, "approval.resolved", { approvalId: approval.id, decision: "cancelled" });
    }
    const runs = new RunStore();
    try {
      const run = runs.getRun(runId);
      if (run && ["queued", "running", "waiting", "needs_input"].includes(run.status)) {
        runs.transition(runId, "cancelled", "cancelled_by_aster_client");
        runs.cancelTimersForRun(runId);
      }
    } finally {
      runs.close();
    }
    this.runtime.cancelRun(runId);
    store.updateConversationStatus(conversation.id, runId, "cancelled", { reason: "client_cancelled" });
    store.appendEvent(conversation.id, runId, "cancelled", { code: "cancelled_by_client" });
    const updated = store.getConversation(conversation.id);
    json(res, 200, updated ? publicConversation(updated) : { conversationId: conversation.id, status: "cancelled" });
  }

  private streamEvents(req: IncomingMessage, res: ServerResponse, store: AsterStore, conversationId: string, cursor: number): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let last = cursor;
    let closed = false;
    let polling = false;
    let released = false;
    const connected = this.connectedEventStreams.get(conversationId) ?? 0;
    this.connectedEventStreams.set(conversationId, connected + 1);
    const release = () => {
      if (released) return;
      released = true;
      const remaining = (this.connectedEventStreams.get(conversationId) ?? 1) - 1;
      if (remaining > 0) this.connectedEventStreams.set(conversationId, remaining);
      else this.connectedEventStreams.delete(conversationId);
    };
    let lastHeartbeat = Date.now();
    const pump = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = store.eventsAfter(conversationId, last, 200);
        for (const event of events) {
          if (closed) break;
          res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
          last = event.sequence;
        }
        if (!events.length && Date.now() - lastHeartbeat >= 15_000) {
          res.write(": heartbeat\n\n");
          lastHeartbeat = Date.now();
        }
      } catch {
        closed = true;
        release();
        res.end();
      } finally {
        polling = false;
        if (!closed) setTimeout(() => { void pump(); }, 500).unref();
      }
    };
    res.on("close", () => { closed = true; release(); });
    res.on("finish", release);
    void pump();
  }

  private async recover(store: AsterStore): Promise<void> {
    if (this.recovery) return this.recovery;
    this.recovery = (async () => {
      const runs = new RunStore();
      try {
        runs.reconcileInterruptedRuns();
        for (const approval of store.expireAllPendingApprovals()) {
          const run = runs.getRun(approval.runId);
          if (run && ["queued", "running", "waiting", "needs_input"].includes(run.status)) {
            runs.transition(run.id, "cancelled", "server_restarted_during_approval");
            runs.cancelTimersForRun(run.id);
          }
          store.updateConversationStatus(approval.conversationId, approval.runId, "interrupted", { reason: "server_restart_during_approval" });
          store.appendEvent(approval.conversationId, approval.runId, "approval.expired", { approvalId: approval.id });
        }
        for (const conversation of store.listActiveConversations()) {
          const run = conversation.activeRunId ? runs.getRun(conversation.activeRunId) : undefined;
          if (!run || ["interrupted_unknown", "cancelled", "failed", "completed"].includes(run.status)) {
            const status: AsterConversationStatus = run?.status === "completed" ? "completed" : run?.status === "cancelled" ? "cancelled" : "interrupted";
            store.updateConversationStatus(conversation.id, conversation.activeRunId!, status, { reason: "server_restart_recovery" });
          } else if (run.status === "needs_input") {
            runs.transition(run.id, "cancelled", "approval_expired_on_restart");
            store.updateConversationStatus(conversation.id, run.id, "interrupted", { reason: "approval_expired_on_restart" });
          }
        }
      } finally {
        runs.close();
      }
    })();
    return this.recovery;
  }

  private async requireConversation(store: AsterStore, principal: AsterPrincipal, id: string): Promise<AsterConversation | undefined> {
    if (!CONVERSATION_ID_RE.test(id)) return undefined;
    const conversation = store.getConversation(id);
    const mapping = store.getCellMapping(id);
    return conversation && mapping?.credentialId === principal.credentialId && principal.workspaceIds.includes(conversation.workspaceId) ? conversation : undefined;
  }
}

function parseCursor(header: string | string[] | undefined, query: string | null): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header) ?? query ?? "0";
  if (!/^\d{1,16}$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

/** The assistant's streamed reply for one run, rebuilt from its journaled deltas. */
function collectAssistantText(store: AsterStore, conversationId: string, runId: string, after: number): string {
  let text = "";
  let cursor = after;
  for (;;) {
    const events = store.eventsAfter(conversationId, cursor, 500);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.runId === runId && event.type === "assistant.delta" && typeof event.data.text === "string") text += event.data.text;
    }
    cursor = events.at(-1)!.sequence;
    if (text.length > 20_000) break;
  }
  return text;
}

function publicConversation(conversation: AsterConversation, project?: AsterConversationProject): Record<string, unknown> {
  return {
    ...(project ? { kind: project.kind, repository: project.repository, branch: project.branch } : {}),
    conversationId: conversation.id,
    workspaceId: conversation.workspaceId,
    model: conversation.model,
    status: conversation.status,
    activeRunId: conversation.activeRunId,
    lastEventId: conversation.lastEventSequence,
    createdAt: new Date(conversation.createdAt).toISOString(),
    updatedAt: new Date(conversation.updatedAt).toISOString(),
  };
}

function publicApproval(approval: import("./aster-store.js").AsterApproval): Record<string, unknown> {
  return {
    approvalId: approval.id,
    conversationId: approval.conversationId,
    runId: approval.runId,
    status: approval.status,
    tool: approval.toolName,
    explanation: approval.explanation,
    arguments: approval.arguments,
    expiresAt: new Date(approval.expiresAt).toISOString(),
    decision: approval.decision,
  };
}

/**
 * Models a conversation may use. With the OpenRouter catalog, only tool-calling models
 * are offered: the cell agent needs tools to do anything.
 */
async function selectableModels(config: AsterServerConfig): Promise<AsterModelInfo[]> {
  if (config.modelCatalog === "fixed") return config.models.map((id) => ({ id }));
  const catalog = await loadOpenRouterCatalog();
  return catalog
    .filter((model) => model.supports.tools)
    .map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      contextWindow: model.contextWindow,
      inputPerMtok: model.pricing.inputPerMtok,
      outputPerMtok: model.pricing.outputPerMtok,
      ...(model.created !== undefined ? { created: model.created } : {}),
      reasoning: model.supports.reasoning,
      vision: model.supports.vision === true,
    }));
}

async function isSelectableModel(config: AsterServerConfig, model: string): Promise<boolean> {
  if (!model.trim() || model.length > 200) return false;
  if (config.modelCatalog === "fixed") return config.models.includes(model);
  return (await selectableModels(config)).some((entry) => entry.id === model);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw httpFailure(413, "request_too_large", "Request body exceeds 64 KiB");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw httpFailure(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw httpFailure(400, "invalid_json", "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function httpFailure(status: number, code: string, message: string): HttpFailure {
  return { status, code, message };
}

function isHttpFailure(error: unknown): error is HttpFailure {
  return !!error && typeof error === "object" && "status" in error && "code" in error && "message" in error;
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}
