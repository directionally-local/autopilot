import type { IncomingMessage, ServerResponse } from "node:http";
import { prFooterEnabled, withPrFooter } from "../util/pr-footer.js";
import { randomUUID } from "node:crypto";
import { statfs, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { AutopilotConfig } from "../config.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import type { ChatMessage } from "../agent/messages.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import { ToolExecutor } from "../tools/executor.js";
import { RunStore } from "../runs/store.js";
import { RunWorktreeManager } from "../runs/worktrees.js";
import { loadSession, saveSession, sessionsDir, type SessionFile } from "../sessions.js";
import { getAppVersion } from "../util/version.js";
import { DlStore, type DlConversationProject, type DlConversation, type DlConversationStatus, type DlPrincipal, type DlScope } from "./dl-store.js";
import { serverEnv } from "./dl-compat.js";
import { DlConfigError, findDlWorkspace, loadDlServerConfig, type DlProviderConfig, type DlServerConfig } from "./dl-workspaces.js";
import { isSelectableModel, modelsResponse } from "./dl-models.js";
import type { DlArtifact, DlCellProject } from "./dl-cell-runtime.js";
import { DlGitHub, DlGitHubError, REPOSITORY_FULL_NAME_RE, type DlCommit } from "./dl-github.js";
import { DlMemory } from "./dl-memory.js";
import { cellRetentionReason, orderRetentionCandidates, type RetentionCandidate, type RetentionCell } from "./dl-cell-retention.js";
import { DlGitHubProxy, createDlGitHubGrantToken } from "./dl-github-proxy.js";
import { finalAssistantMessage, pullRequestBody, pullRequestTitle, type DlTurnEvent } from "./dl-pull-request.js";
import { DlPush } from "./dl-push.js";
import { handleDlPairing, PairingRequestError } from "./dl-pairing.js";
import { containsLikelyProviderSecret, createDlTools, findLikelyProviderSecret, redactLikelySecrets, assertDlCellPath } from "./dl-tools.js";

const API_PREFIX = "/api/v1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// Long pasted documents are fine; the model's context window is the practical limit.
const MAX_USER_TURN_CHARS = 500_000;
const CLIENT_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREATE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_APPROVAL_ARG_BYTES = 24 * 1024;
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_DL_TOOLS = ["read", "write", "edit"] as const;
const BASE_COMMIT_RE = /^[0-9a-f]{40}$/;
// Keeps the whole create request under MAX_BODY_BYTES once JSON-escaped.
const MAX_PATCH_CHARS = 3 * 1024 * 1024;
const MAX_LISTED_CONVERSATIONS = 200;

export interface DlTurnStart {
  runId: string;
  conversation: DlConversation;
  cellId: string;
  cellEventCursor: number;
  userText: string;
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  allowedTools: Set<string>;
  maxToolIterations: number | null;
  maxRuntimeMs: number | null;
  /** Branch-scoped capability used only by the code cell's Git transport. */
  githubProxy?: { token: string; gitUrl: string };
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  publishEvent: (type: string, data: Record<string, unknown>) => void;
  onCellCursor?: (cursor: number) => void;
  finish: (status: "completed" | "failed" | "cancelled", reason?: string) => void;
  /** Long-term memory for this turn: a note to prepend and the full memory file for the cell. */
  memory?: { note: string; snapshot: string };
  /** Runs after a completed turn's output, before its terminal status (e.g. memory extraction). */
  beforeFinish?: () => Promise<void>;
}

export interface DlApiRuntime {
  provisionConversation?: (input: { conversationId: string; sessionId: string; cellName: string; workspaceId: string; workspaceRoot: string; model: string; provider: DlProviderConfig; allowCreate: boolean; onCellCreated: (cellId: string) => void; project?: DlCellProject }) => Promise<{ cellId: string }>;
  findConversationCell?: (conversationId: string) => Promise<{ cellId: string } | undefined>;
  destroyCell?: (cellId: string) => Promise<void>;
  /** Hotcell activity is required to distinguish paused idle cells from live cells. */
  listConversationCells?: () => Promise<RetentionCell[]>;
  /** Preserve local work before a retention sweep destroys a cell volume. */
  prepareCellForCleanup?: (cellId: string, project?: DlCellProject) => Promise<void>;
  pauseCell?: (cellId: string) => Promise<void>;
  resumeCell?: (cellId: string) => Promise<void>;
  startTurn: (turn: DlTurnStart) => void;
  /** Re-attach to a turn the cell kept running across a server restart. */
  resumeTurn?: (turn: DlTurnStart) => void;
  cancelRun: (runId: string) => void;
  setModel?: (cellId: string, model: string) => Promise<void>;
  listCheckpoints?: (cellId: string) => Promise<DlCheckpointInfo[]>;
  restoreCheckpoint?: (cellId: string, conversationId: string, checkpointId: string) => Promise<DlCheckpointInfo>;
  listArtifacts?: (cellId: string) => Promise<DlArtifact[]>;
  readArtifact?: (cellId: string, path: string) => Promise<{ data: Buffer; mimeType: string; name: string }>;
}

export interface DlCheckpointInfo {
  id: string;
  message: string;
  createdAt: string;
}

interface DlWaiter {
  resolve: (decision: "allow" | "deny") => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HttpFailure {
  status: number;
  code: string;
  message: string;
}

export class DlApi {
  private store: DlStore | undefined;
  private recovery: Promise<void> | undefined;
  private readonly waiters = new Map<string, DlWaiter>();
  private readonly connectedEventStreams = new Map<string, number>();
  private readonly runtime: DlApiRuntime;
  private readonly config: AutopilotConfig;
  private cellRetentionTimer: NodeJS.Timeout | undefined;
  private cellRetentionRun: Promise<void> | undefined;
  private cellRetentionLastRunAt: number | undefined;
  private cellRetentionNextRunAt: number | undefined;
  private cellRetentionSleepingCells = 0;
  private cellRetentionDeleted = 0;
  private cellRetentionDisk: { usedBytes: bigint; availableBytes: bigint; totalBytes: bigint } | undefined;

  private readonly github: DlGitHub;

  private memory: DlMemory | undefined;

  constructor(
    config: AutopilotConfig,
    runtime: DlApiRuntime,
    github: DlGitHub = new DlGitHub(),
    memory?: DlMemory,
    push?: Pick<DlPush, "configured" | "notify" | "close" | "register" | "unregister">,
  ) {
    this.config = config;
    this.runtime = runtime;
    this.github = github;
    this.memory = memory;
    this.push = push;
  }

  private githubProxy: DlGitHubProxy | undefined;
  /** Where cells reach the repository-scoped GitHub proxy, when it is running. */
  private githubProxyUrl: string | undefined;

  /**
   * Starts the repository-scoped GitHub proxy when configured
   * (AUTOPILOT_SERVER_GITHUB_PROXY_LISTEN=host:port, AUTOPILOT_SERVER_GITHUB_PROXY_URL as cells see it).
   */
  async startGitHubProxy(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const listen = serverEnv(env, "GITHUB_PROXY_LISTEN");
    const publicUrl = serverEnv(env, "GITHUB_PROXY_URL");
    const token = env.GITHUB_TOKEN;
    if (!listen || !publicUrl || !token || this.githubProxy) return;
    const separator = listen.lastIndexOf(":");
    const proxy = new DlGitHubProxy({ token, resolveGrant: (grant) => this.getStore().resolveGitHubGrant(grant) });
    await proxy.listen(Number(listen.slice(separator + 1)), listen.slice(0, separator));
    this.githubProxy = proxy;
    this.githubProxyUrl = publicUrl.replace(/\/+$/, "");
  }

  private push: Pick<DlPush, "configured" | "notify" | "close" | "register" | "unregister"> | undefined;

  private getPush(): Pick<DlPush, "configured" | "notify" | "close" | "register" | "unregister"> | undefined {
    try {
      return this.push ??= new DlPush();
    } catch {
      return undefined;
    }
  }

  /** "Your task finished" (or failed) on the user's devices; cancelled turns stay silent. */
  private notifyTurnEnd(store: DlStore, conversationId: string, runId: string, status: string, reason: string | undefined, userText: string, after: number): void {
    if (status !== "completed" && status !== "failed") return;
    if ((this.connectedEventStreams.get(conversationId) ?? 0) > 0) return;
    const push = this.getPush();
    if (!push?.configured) return;
    const reply = status === "completed" ? collectAssistantText(store, conversationId, runId, after).trim() : "";
    const title = userText.trim().split("\n")[0] || "dl server";
    const body = status === "completed"
      ? (reply ? `✅ ${reply}` : "✅ Done")
      : `⚠️ Couldn’t finish${reason && reason !== "error" ? `: ${reason}` : ""}`;
    void push.notify({ title, body, conversationId });
  }

  private getMemory(): DlMemory | undefined {
    if (serverEnv(process.env, "MEMORY") === "off") return undefined;
    try {
      return this.memory ??= new DlMemory();
    } catch {
      return undefined;
    }
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const store = this.getStore();
      // Device pairing and owner claim run before bearer auth: they are how a client gets one.
      if (await handleDlPairing(req, res, url, store)) return;
      const principal = store.authenticate(req.headers.authorization);
      if (!principal) {
        sendError(res, 401, "invalid_credential", "A valid dl server bearer credential is required");
        return;
      }
      await this.ensureRecovered(store);
      this.startCellRetentionSweep(store);
      const config = await loadDlServerConfig();
      const method = req.method ?? "GET";
      const path = url.pathname;

      if (path === `${API_PREFIX}/health` && method === "GET") {
        if (!this.hasScope(principal, "workspaces:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks health/read scope");
        return json(res, 200, {
          status: "ok",
          service: "autopilot",
          apiVersion: "v1",
          serviceVersion: getAppVersion(),
          cellRetention: this.cellRetentionSnapshot(),
          capabilities: ["workspaces", "conversations", "turns", "event-replay", "cancellation", "human-approvals", "hotcell-per-conversation", "pause-resume", "destroy", "autonomous-cells", "tool-output", "checkpoints", "model-switch", "artifacts", "memory", "push", "pull-requests", "device-pairing", "conversation-list", "patch-upload", ...(this.runtime.listConversationCells && this.runtime.destroyCell ? ["cell-retention"] : []), ...(this.github.configured ? ["github"] : []), ...(config.modelCatalog === "catalog" ? ["model-catalog"] : [])],
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
        const models = await modelsResponse(config);
        if (models.models.length === 0) return sendError(res, 503, "model_catalog_unavailable", "The model catalog is unavailable; try again shortly");
        return json(res, 200, models);
      }

      if (path === `${API_PREFIX}/conversations` && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => !["workspaceId", "model", "kind", "repository", "baseCommit", "patch"].includes(key))) {
          return sendError(res, 400, "unsupported_field", "Conversation creation accepts workspaceId, model, kind, repository, baseCommit, and patch; paths are server-configured");
        }
        if (body.kind !== undefined && body.kind !== "chat" && body.kind !== "code") {
          return sendError(res, 400, "invalid_kind", "kind must be \"chat\" or \"code\"");
        }
        if (body.kind === "code" && (typeof body.repository !== "string" || !REPOSITORY_FULL_NAME_RE.test(body.repository))) {
          return sendError(res, 400, "repository_required", "Code conversations need a repository as owner/name");
        }
        if (body.kind !== "code" && (body.repository !== undefined || body.baseCommit !== undefined || body.patch !== undefined)) {
          return sendError(res, 400, "unsupported_field", "repository, baseCommit, and patch are only accepted for code conversations");
        }
        // Uncommitted local work: a binary git diff against a commit the repository already has.
        if (body.patch !== undefined && body.baseCommit === undefined) {
          return sendError(res, 400, "base_commit_required", "A patch needs the baseCommit it applies to");
        }
        if (body.baseCommit !== undefined && (typeof body.baseCommit !== "string" || !BASE_COMMIT_RE.test(body.baseCommit))) {
          return sendError(res, 400, "invalid_base_commit", "baseCommit must be a full 40-character commit SHA");
        }
        if (body.patch !== undefined && (typeof body.patch !== "string" || body.patch.length > MAX_PATCH_CHARS)) {
          return sendError(res, 400, "invalid_patch", "patch must be a git diff of at most 3 MiB");
        }
        if (typeof body.patch === "string") {
          // Say where, never what: the message mustn't become the leak it warns about.
          const secret = findLikelyProviderSecret(body.patch);
          if (secret) {
            const where = secret.file ? `${secret.file}${secret.line !== undefined ? `:${secret.line}` : ""}` : "the patch";
            return sendError(res, 400, "patch_contains_secret", `Your local changes include something that looks like an API key (${secret.pattern}) at ${where}; remove it and retry`);
          }
        }
        if (typeof body.workspaceId !== "string" || !principal.workspaceIds.includes(body.workspaceId)) {
          return sendError(res, 403, "workspace_forbidden", "Workspace ID is not in this credential's scope");
        }
        const workspace = findDlWorkspace(config, body.workspaceId);
        if (!workspace) return sendError(res, 404, "workspace_not_found", "Workspace is not configured");
        if (typeof body.model !== "string" || !(await isSelectableModel(config, body.model))) {
          return sendError(res, 400, "model_not_allowed", "Select a model from the configured model list");
        }
        const idempotencyKey = req.headers["idempotency-key"];
        if (typeof idempotencyKey !== "string" || !CREATE_IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
          return sendError(res, 400, "idempotency_key_required", "Conversation creation requires an Idempotency-Key header of 1-128 safe characters");
        }
        const kind = body.kind as "chat" | "code" | undefined;
        const changes = typeof body.baseCommit === "string"
          ? { baseCommit: body.baseCommit, ...(typeof body.patch === "string" && body.patch ? { patch: body.patch } : {}) }
          : undefined;
        return await this.createConversation(res, store, principal, workspace, body.model, config.provider, idempotencyKey, kind, body.repository as string | undefined, changes);
      }

      if (path === `${API_PREFIX}/conversations` && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const limitParam = url.searchParams.get("limit") ?? "50";
        const limit = /^\d{1,4}$/.test(limitParam) ? Math.min(Number(limitParam), MAX_LISTED_CONVERSATIONS) : 0;
        if (limit < 1) return sendError(res, 400, "invalid_limit", `limit must be 1-${MAX_LISTED_CONVERSATIONS}`);
        const conversations = store.listCredentialConversations(principal.credentialId, limit)
          .filter((conversation) => principal.workspaceIds.includes(conversation.workspaceId))
          .map((conversation) => publicConversation(conversation, store.getConversationProject(conversation.id)));
        return json(res, 200, { conversations });
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
          if (error instanceof DlGitHubError) return sendError(res, error.status, error.code, error.message);
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

      const pullRequestMergeMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/pull-request\/merge$/);
      if (pullRequestMergeMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, pullRequestMergeMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const project = store.getConversationProject(conversation.id);
        if (conversation.status === "merged") return json(res, 200, publicConversation(conversation, project));
        if (conversation.status !== "completed" || project?.kind !== "code" || !project.repository || !conversation.pullRequestNumber) {
          return sendError(res, 409, "pull_request_not_ready", "This conversation has no completed pull request to merge");
        }
        const merge = await this.github.mergePullRequest(project.repository, conversation.pullRequestNumber);
        if (!store.markMerged(conversation.id, merge.sha)) return sendError(res, 409, "merge_state_conflict", "The conversation changed before merge could be recorded");
        return json(res, 200, publicConversation(store.getConversation(conversation.id)!, project));
      }

      const pullRequestChecksMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/pull-request\/checks$/);
      if (pullRequestChecksMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, pullRequestChecksMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        const project = store.getConversationProject(conversation.id);
        if (!project?.repository || !project.branch || !conversation.pullRequestNumber) return sendError(res, 404, "pull_request_not_found", "This conversation has no pull request");
        return json(res, 200, { checks: await this.github.listChecks(project.repository, project.branch) });
      }

      const lifecycleMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/(pause|resume)$/);
      if (lifecycleMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, lifecycleMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return lifecycleMatch[2] === "pause"
          ? this.pauseConversation(res, store, conversation)
          : this.resumeConversation(res, store, conversation, config);
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

      return sendError(res, 404, "not_found", "dl server endpoint not found");
    } catch (error) {
      if (isHttpFailure(error)) return sendError(res, error.status, error.code, error.message);
      if (error instanceof PairingRequestError) return sendError(res, error.status, error.code, error.message);
      if (error instanceof DlConfigError) return sendError(res, 503, "dl_not_configured", "dl server workspaces/models are not configured");
      return sendError(res, 500, "internal_error", "dl server request could not be completed");
    }
  }

  close(): void {
    if (this.cellRetentionTimer) clearInterval(this.cellRetentionTimer);
    this.cellRetentionTimer = undefined;
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve("deny");
      this.waiters.delete(id);
    }
    this.store?.close();
    this.store = undefined;
    this.memory?.close();
    this.memory = undefined;
    void this.githubProxy?.close();
    this.githubProxy = undefined;
    this.push?.close();
    this.push = undefined;
  }

  private startCellRetentionSweep(store: DlStore): void {
    if (this.cellRetentionTimer || !this.runtime.listConversationCells || !this.runtime.destroyCell) return;
    const intervalMs = boundedEnvInteger(serverEnv(process.env, "CELL_CLEANUP_INTERVAL_MS"), 10 * 60_000, 1_000, 24 * 60 * 60_000);
    this.cellRetentionNextRunAt = Date.now();
    this.cellRetentionTimer = setInterval(() => {
      this.cellRetentionNextRunAt = Date.now() + intervalMs;
      void this.runCellRetentionCleanup(store).catch(() => {});
    }, intervalMs);
    this.cellRetentionTimer.unref();
    void this.runCellRetentionCleanup(store).catch(() => {});
  }

  /** One sweep; public for deterministic integration tests and operator-triggered maintenance. */
  async runCellRetentionCleanup(store = this.getStore()): Promise<void> {
    if (!this.runtime.listConversationCells || !this.runtime.destroyCell) return;
    if (this.cellRetentionRun) return this.cellRetentionRun;
    const run = this.sweepCellRetention(store);
    this.cellRetentionRun = run;
    try { await run; } finally { this.cellRetentionRun = undefined; }
  }

  private async sweepCellRetention(store: DlStore): Promise<void> {
    this.cellRetentionLastRunAt = Date.now();
    this.cellRetentionDeleted = 0;
    const retentionDays = boundedEnvInteger(serverEnv(process.env, "CELL_RETENTION_DAYS"), 7, 1, 365);
    const cells = await this.runtime.listConversationCells!();
    this.cellRetentionSleepingCells = cells.filter((cell) => cell.status === "paused").length;
    const diskPath = serverEnv(process.env, "CELL_STORAGE_PATH");
    const minimumFreeGb = boundedEnvInteger(serverEnv(process.env, "CELL_MIN_FREE_GB"), 5, 1, 10_000);
    this.cellRetentionDisk = diskPath ? await readDiskStats(diskPath).catch(() => undefined) : undefined;
    let diskPressure = this.cellRetentionDisk !== undefined && this.cellRetentionDisk.availableBytes < BigInt(minimumFreeGb) * 1024n ** 3n;
    const mappings = new Map(store.listCellMappings().map((mapping) => [mapping.conversationId, mapping]));
    const candidates: Array<{ candidate: RetentionCandidate; mapping: ReturnType<DlStore["getCellMapping"]>; project?: DlConversationProject }> = [];

    for (const cell of cells) {
      const mapping = mappings.get(cell.conversationId);
      const conversation = store.getConversation(cell.conversationId);
      if (!mapping || (mapping.status !== "paused" && mapping.status !== "cleanup_pending") || !mapping.cellId || !conversation) continue;
      const pendingApprovals = store.pendingApprovalsForConversation(conversation.id).length;
      const project = store.getConversationProject(conversation.id);
      let pullRequest;
      if (conversation.pullRequestNumber && project?.repository) {
        pullRequest = await this.github.getPullRequest(project.repository, conversation.pullRequestNumber).catch(() => undefined);
      }
      candidates.push({
        candidate: { conversation, cell, pendingApprovals, ...(pullRequest ? { pullRequest } : {}) },
        mapping,
        ...(project ? { project } : {}),
      });
    }

    for (const item of orderRetentionCandidates(candidates.map((entry) => ({ ...entry, cell: entry.candidate.cell })))) {
      if (diskPressure) {
        this.cellRetentionDisk = diskPath ? await readDiskStats(diskPath).catch(() => undefined) : undefined;
        diskPressure = this.cellRetentionDisk !== undefined && this.cellRetentionDisk.availableBytes < BigInt(minimumFreeGb) * 1024n ** 3n;
      }
      const reason = cellRetentionReason(item.candidate, { now: Date.now(), retentionDays, diskPressure });
      if (!reason) continue;
      const { conversation } = item.candidate;
      const cellId = item.mapping?.cellId;
      if (!cellId || !store.beginCellCleanup(conversation.id, cellId)) continue;
      try {
        if (item.project?.kind === "code" && !this.runtime.prepareCellForCleanup) throw new Error("cleanup_preservation_unavailable");
        const project: DlCellProject | undefined = item.project?.kind === "code" && item.project.repository && item.project.branch
          ? { kind: "code", repository: item.project.repository, baseBranch: conversation.baseBranch ?? "main", branch: item.project.branch }
          : item.project?.kind === "chat" ? { kind: "chat" } : undefined;
        await this.runtime.prepareCellForCleanup?.(cellId, project);
        await this.runtime.destroyCell!(cellId);
        store.revokeGitHubGrant(conversation.id);
        if (!store.markCellCleaned(conversation.id, cellId)) continue;
        store.setConversationStatus(conversation.id, "cleaned", { reason });
        store.appendEvent(conversation.id, null, "conversation.sandbox_cleaned", {
          reason,
          ...(conversation.branch ? { branch: conversation.branch } : {}),
          ...(conversation.pullRequestURL ? { pullRequestURL: conversation.pullRequestURL } : {}),
        });
        this.cellRetentionDeleted++;
      } catch {
        // Preservation or deletion failed: keep the cell and retry on the next sweep.
        store.setCellStatus(conversation.id, "cleanup_pending");
      }
    }
    this.cellRetentionNextRunAt = Date.now() + boundedEnvInteger(serverEnv(process.env, "CELL_CLEANUP_INTERVAL_MS"), 10 * 60_000, 1_000, 24 * 60 * 60_000);
  }

  private cellRetentionSnapshot(): Record<string, unknown> {
    const retentionDays = boundedEnvInteger(serverEnv(process.env, "CELL_RETENTION_DAYS"), 7, 1, 365);
    const disk = this.cellRetentionDisk;
    return {
      enabled: Boolean(this.runtime.listConversationCells && this.runtime.destroyCell),
      retentionDays,
      sleepingCells: this.cellRetentionSleepingCells,
      deletedThisSweep: this.cellRetentionDeleted,
      lastRunAt: this.cellRetentionLastRunAt ? new Date(this.cellRetentionLastRunAt).toISOString() : null,
      nextRunAt: this.cellRetentionNextRunAt ? new Date(this.cellRetentionNextRunAt).toISOString() : null,
      disk: disk ? {
        usedBytes: (disk.usedBytes).toString(),
        availableBytes: disk.availableBytes.toString(),
        totalBytes: disk.totalBytes.toString(),
      } : null,
    };
  }

  private getStore(): DlStore {
    return this.store ??= new DlStore();
  }

  private hasScope(principal: DlPrincipal, scope: DlScope): boolean {
    return principal.scopes.includes(scope);
  }

  private async authorizedConversation(store: DlStore, principal: DlPrincipal, id: string): Promise<DlConversation | undefined> {
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
          const status: DlConversationStatus = run.status === "completed" ? "completed" : run.status === "cancelled" ? "cancelled" : "interrupted";
          store.updateConversationStatus(conversation.id, activeRunId, status, { reason: "run_recovered" });
          return store.getConversation(id);
        }
      } finally {
        runs.close();
      }
    }
    return conversation;
  }

  private async ensureRecovered(store: DlStore): Promise<void> {
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
            const status: DlConversationStatus = run?.status === "completed" ? "completed" : run?.status === "cancelled" ? "cancelled" : "interrupted";
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
  private cellTurn(store: DlStore, conversation: DlConversation, runId: string, cellId: string, cursor: number, userText: string): DlTurnStart {
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
    store: DlStore,
    principal: DlPrincipal,
    workspace: { id: string; displayName: string; rootPath: string },
    model: string,
    provider: DlProviderConfig,
    idempotencyKey: string,
    kind?: "chat" | "code",
    repository?: string,
    changes?: { baseCommit: string; patch?: string },
  ): Promise<void> {
    const candidateId = randomUUID();
    const candidateSessionId = randomUUID();
    const reservation = store.reserveCellConversation({
      conversationId: candidateId,
      credentialId: principal.credentialId,
      workspaceId: workspace.id,
      model,
      sessionId: candidateSessionId,
      cellName: `dl-${candidateId}`,
      idempotencyKey,
      kind,
      ...(repository ? { repository } : {}),
      ...(changes ? { baseCommit: changes.baseCommit, patch: changes.patch ?? "" } : {}),
    });
    if (reservation.kind === "conflict") return sendError(res, 409, "idempotency_conflict", "Idempotency-Key was already used for different conversation parameters");

    let mapping = reservation.mapping;
    if (mapping.status === "destroyed") return sendError(res, 410, "conversation_destroyed", "Conversation was already destroyed");
    if (mapping.status === "ready") {
      const existing = store.getConversation(mapping.conversationId);
      if (existing) return json(res, 200, publicConversation(existing, store.getConversationProject(existing.id)));
    }
    // A retained conversation whose sandbox was reclaimed by the retention sweep gets a
    // fresh cell on the same conversation id; its history and branch survive.
    let reopened = false;
    if (mapping.status === "cleaned") {
      if (!store.reopenCleanedCell(mapping.conversationId, randomUUID())) {
        return sendError(res, 409, "cell_not_ready", "Conversation sandbox is being reopened; retry with the same Idempotency-Key");
      }
      mapping = store.getCellMapping(mapping.conversationId)!;
      reopened = true;
    }
    if (!this.runtime.provisionConversation) {
      store.setCellStatus(mapping.conversationId, "failed");
      return sendError(res, 503, "hotcell_unavailable", "Hotcell conversation runtime is not configured");
    }

    // The project is fixed on first attempt; retries with the same Idempotency-Key reuse it.
    let project: DlCellProject | undefined;
    if (kind || reopened) {
      let stored = store.getConversationProject(mapping.conversationId);
      if (!stored) {
        const effectiveKind = kind ?? store.getConversation(mapping.conversationId)?.kind ?? "chat";
        if (effectiveKind === "code") {
          let repo;
          try {
            repo = await this.github.getRepository(repository!);
          } catch (error) {
            if (error instanceof DlGitHubError) return sendError(res, error.status, error.code, error.message);
            throw error;
          }
          stored = { kind: "code", repository: repo.fullName, branch: `dl/${mapping.conversationId.slice(0, 8)}` };
          store.setConversationProject(mapping.conversationId, stored);
          project = { kind: "code", repository: repo.fullName, baseBranch: repo.defaultBranch, branch: stored.branch! };
        } else {
          stored = { kind: "chat", repository: null, branch: null };
          store.setConversationProject(mapping.conversationId, stored);
        }
      }
      if (!project) {
        project = stored.kind === "code"
          ? { kind: "code", repository: stored.repository!, baseBranch: (await this.github.getRepository(stored.repository!).catch(() => undefined))?.defaultBranch ?? "main", branch: stored.branch! }
          : { kind: "chat" };
      }
      if (project.kind === "code" && changes) {
        project.baseCommit = changes.baseCommit;
        if (changes.patch) project.patch = changes.patch;
      }
      // Reopening a cleaned code conversation continues its existing branch instead of
      // starting over from the repository's default branch.
      if (reopened && project.kind === "code") project.resumeBranch = true;
      if (project.kind === "code" && project.repository && this.githubProxyUrl) {
        const grantToken = createDlGitHubGrantToken(process.env.GITHUB_TOKEN ?? "", mapping.conversationId, project.repository, project.branch!);
        store.createGitHubGrant(mapping.conversationId, grantToken);
        project.github = {
          token: grantToken,
          gitUrl: `${this.githubProxyUrl}/git`,
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
        provider,
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
        branch: project?.kind === "code" ? project.branch! : "cell",
        kind: project?.kind ?? "chat",
        repository: project?.kind === "code" ? project.repository! : null,
        baseBranch: project?.kind === "code" ? project.baseBranch ?? "main" : null,
      });
      const sessionFile: SessionFile = {
        id: mapping.sessionId,
        cwd: "/workspace",
        model,
        createdAt: new Date(mapping.createdAt).toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        title: "dl server conversation",
      };
      await saveSession(sessionFile);
      store.setCellStatus(mapping.conversationId, "ready");
      store.appendEvent(mapping.conversationId, null, "conversation.created", { conversationId: mapping.conversationId, workspaceId: workspace.id, model });
      json(res, reservation.kind === "created" ? 201 : 200, publicConversation(conversation, store.getConversationProject(conversation.id)));
    } catch (error) {
      // The client only gets a generic 503; the operator needs the reason (e.g. a missing gateway).
      const code = error && typeof error === "object" && "code" in error ? ` (${String((error as { code: unknown }).code)})` : "";
      process.stderr.write(`dl server: conversation ${mapping.conversationId} failed to provision${code}: ${redactLikelySecrets(error instanceof Error ? error.message : String(error)).slice(0, 500)}\n`);
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
    store: DlStore,
    conversation: DlConversation,
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
          allowedTools: [...ALLOWED_DL_TOOLS],
        });
        runStore.transition(runId, "running");
      } finally {
        runStore.close();
      }
      const tools = createDlTools(conversation.cwd);
      const executor = new ToolExecutor(tools);
      executor.unregister("expand_artifact");
      const allowedTools = new Set(tools.map((tool) => tool.name));
      const publishEvent = (type: string, data: Record<string, unknown>) => {
        store.appendEvent(conversation.id, runId, type, data);
      };
      const turnStartSequence = store.getConversation(conversation.id)?.lastEventSequence ?? 0;
      const conversationProject = store.getConversationProject(conversation.id);
      const githubProxy = conversationProject?.kind === "code" && conversationProject.repository && conversationProject.branch && this.githubProxyUrl
        ? {
            token: createDlGitHubGrantToken(process.env.GITHUB_TOKEN ?? "", conversation.id, conversationProject.repository, conversationProject.branch),
            gitUrl: `${this.githubProxyUrl}/git`,
          }
        : undefined;
      const active: DlTurnStart = {
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
        ...(githubProxy ? { githubProxy } : {}),
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
      const codeProject = store.getConversationProject(conversation.id);
      if (codeProject?.kind === "code" && codeProject.repository && codeProject.branch) {
        const existingBeforeFinish = active.beforeFinish;
        active.beforeFinish = async () => {
          await existingBeforeFinish?.();
          const current = store.getConversation(conversation.id);
          if (current?.pullRequestNumber && current.pullRequestURL) return;
          const repository = await this.github.getRepository(codeProject.repository!);
          // The branch's own commits name the change; the prompt is only the fallback.
          let commits: DlCommit[] = [];
          try {
            commits = await this.github.compareCommits(codeProject.repository!, repository.defaultBranch, codeProject.branch!);
          } catch { /* any lookup failure falls back to the prompt-derived title */ }
          const title = pullRequestTitle(commits, text.replace(/\s+/g, " ").trim().slice(0, 80) || `Changes for ${codeProject.repository}`);
          const summary = pullRequestBody({
            repository: codeProject.repository!,
            prompt: text,
            finalMessage: finalAssistantMessage(turnEvents(store, conversation.id, turnStartSequence), runId),
            commits,
          });
          const pullRequest = await this.github.createPullRequest(codeProject.repository!, {
            title,
            // Ends with "Opened with dl" unless turned off (prFooter: false).
            body: prFooterEnabled() ? withPrFooter(summary) : summary,
            head: codeProject.branch!,
            base: repository.defaultBranch,
          });
          if (!store.setPullRequest(conversation.id, {
            number: pullRequest.number,
            url: pullRequest.url,
            title: pullRequest.title,
            summary,
          })) throw new Error("pull_request_state_conflict");
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
          runs.transition(runId, "failed", "dl_turn_start_failed");
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
    store: DlStore,
    conversation: DlConversation,
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
      assertDlCellPath(request.args.path);
    } catch {
      publish("tool.activity", { tool: request.tool.name, activity: "rejected", reason: "workspace_path_forbidden" });
      return "deny";
    }
    const file = typeof request.args.path === "string" ? request.args.path.split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "workspace file";
    const explanation = request.tool.name === "write" ? `Create or replace ${file} in this workspace` : `Edit ${file} in this workspace`;
    const config = await loadDlServerConfig();
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

  private async expireApproval(store: DlStore, id: string): Promise<void> {
    const approval = store.expireApproval(id);
    if (!approval || approval.status !== "expired") return;
    await this.resumeAfterApproval(store, approval, "deny", "expired");
  }

  private async resolveApproval(res: ServerResponse, store: DlStore, id: string, decision: "allow" | "deny"): Promise<void> {
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

  private async resumeAfterApproval(store: DlStore, approval: import("./dl-store.js").DlApproval, decision: "allow" | "deny", status: string): Promise<void> {
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

  private async pauseConversation(res: ServerResponse, store: DlStore, conversation: DlConversation): Promise<void> {
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

  private async resumeConversation(res: ServerResponse, store: DlStore, conversation: DlConversation, config: DlServerConfig): Promise<void> {
    const mapping = store.getCellMapping(conversation.id);
    if (!mapping) return sendError(res, 404, "conversation_not_found", "Conversation not found");
    if (mapping.status === "cleaned") return this.reopenCleanedConversation(res, store, conversation, config);
    if (!mapping.cellId) return sendError(res, 409, "cell_not_ready", "Conversation cell is not ready");
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

  /**
   * Recreate the sandbox of a conversation whose cell the retention sweep reclaimed.
   * The conversation id, event history and (for code) the pushed branch are retained;
   * only the cell volume is new.
   */
  private async reopenCleanedConversation(res: ServerResponse, store: DlStore, conversation: DlConversation, config: DlServerConfig): Promise<void> {
    if (conversation.activeRunId) return sendError(res, 409, "turn_active", "Wait for the current turn to finish before reopening the sandbox");
    if (!this.runtime.provisionConversation) return sendError(res, 503, "hotcell_unavailable", "Hotcell conversation runtime is not configured");
    const workspace = findDlWorkspace(config, conversation.workspaceId);
    if (!workspace) return sendError(res, 404, "workspace_not_found", "Workspace is not configured");
    const project = store.getConversationProject(conversation.id);
    const sessionId = randomUUID();
    if (!store.reopenCleanedCell(conversation.id, sessionId)) {
      return sendError(res, 409, "cell_not_ready", "Conversation sandbox is already being reopened");
    }
    const mapping = store.getCellMapping(conversation.id)!;
    let cellProject: DlCellProject | undefined;
    if (project?.kind === "code" && project.repository && project.branch) {
      cellProject = {
        kind: "code",
        repository: project.repository,
        baseBranch: conversation.baseBranch ?? "main",
        branch: project.branch,
        resumeBranch: true,
      };
      if (this.githubProxyUrl) {
        const grantToken = createDlGitHubGrantToken(process.env.GITHUB_TOKEN ?? "", conversation.id, project.repository, project.branch);
        store.createGitHubGrant(conversation.id, grantToken);
        cellProject.github = { token: grantToken, gitUrl: `${this.githubProxyUrl}/git` };
      }
    } else if (project?.kind === "chat") {
      cellProject = { kind: "chat" };
    }
    try {
      const provisioned = await this.runtime.provisionConversation({
        conversationId: conversation.id,
        sessionId,
        cellName: mapping.cellName,
        workspaceId: conversation.workspaceId,
        workspaceRoot: workspace.rootPath,
        model: conversation.model,
        provider: config.provider,
        allowCreate: true,
        onCellCreated: (cellId) => store.setCellId(conversation.id, cellId),
        ...(cellProject ? { project: cellProject } : {}),
      });
      store.setCellId(conversation.id, provisioned.cellId);
      store.setCellStatus(conversation.id, "ready");
      store.setConversationStatus(conversation.id, "ready", { reason: "sandbox_reopened" });
      store.appendEvent(conversation.id, null, "conversation.resumed", { sessionId, newCell: true });
      const updated = store.getConversation(conversation.id)!;
      json(res, 200, { ...publicConversation(updated, project), cellStatus: "ready" });
    } catch {
      const current = store.getCellMapping(conversation.id);
      if (current?.cellId && this.runtime.destroyCell) {
        await this.runtime.destroyCell(current.cellId).catch(() => {});
      }
      store.resetCleanedCell(conversation.id);
      sendError(res, 503, "resume_failed", "The conversation's sandbox could not be recreated; retry resume");
    }
  }

  private async destroyConversation(res: ServerResponse, store: DlStore, conversation: DlConversation): Promise<void> {
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
  private readyCell(res: ServerResponse, store: DlStore, conversationId: string): string | undefined {
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
    store: DlStore,
    conversation: DlConversation,
    model: string,
  ): Promise<DlConversation | undefined> {
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

  private async cancelConversation(res: ServerResponse, store: DlStore, conversation: DlConversation): Promise<void> {
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
        runs.transition(runId, "cancelled", "cancelled_by_dl_client");
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

  private streamEvents(req: IncomingMessage, res: ServerResponse, store: DlStore, conversationId: string, cursor: number): void {
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

  private async recover(store: DlStore): Promise<void> {
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
            const status: DlConversationStatus = run?.status === "completed" ? "completed" : run?.status === "cancelled" ? "cancelled" : "interrupted";
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

  private async requireConversation(store: DlStore, principal: DlPrincipal, id: string): Promise<DlConversation | undefined> {
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

/** Every journaled event of a conversation after a sequence number, read in pages. */
function* turnEvents(store: DlStore, conversationId: string, after: number): Generator<DlTurnEvent> {
  let cursor = after;
  for (;;) {
    const events = store.eventsAfter(conversationId, cursor, 500);
    if (events.length === 0) return;
    yield* events;
    cursor = events.at(-1)!.sequence;
  }
}

/** The assistant's streamed reply for one run, rebuilt from its journaled deltas. */
function collectAssistantText(store: DlStore, conversationId: string, runId: string, after: number): string {
  let text = "";
  let cursor = after;
  for (;;) {
    const events = store.eventsAfter(conversationId, cursor, 500);
    if (events.length === 0) break;
    for (const event of events) {
      if (event.runId === runId && event.type === "assistant.delta") {
        const delta = typeof event.data.text === "string" ? event.data.text : typeof event.data.delta === "string" ? event.data.delta : "";
        text += delta;
      }
    }
    cursor = events.at(-1)!.sequence;
    if (text.length > 20_000) break;
  }
  return text;
}

function publicConversation(conversation: DlConversation, project?: DlConversationProject): Record<string, unknown> {
  return {
    ...(project ? { kind: project.kind, repository: project.repository, branch: project.branch } : {}),
    ...(conversation.pullRequestNumber ? { pullRequestNumber: conversation.pullRequestNumber } : {}),
    ...(conversation.pullRequestURL ? { pullRequestURL: conversation.pullRequestURL } : {}),
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

/** A positive integer from the environment, or the fallback when unset or out of range. */
function boundedEnvInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Filesystem usage for the retention health snapshot; unavailable paths are reported as null. */
async function readDiskStats(path: string): Promise<{ usedBytes: bigint; availableBytes: bigint; totalBytes: bigint }> {
  const stats = await statfs(path, { bigint: true });
  return {
    usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
    availableBytes: stats.bavail * stats.bsize,
    totalBytes: stats.blocks * stats.bsize,
  };
}

function publicApproval(approval: import("./dl-store.js").DlApproval): Record<string, unknown> {
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
