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
import { AsterStore, type AsterConversation, type AsterConversationStatus, type AsterPrincipal, type AsterScope } from "./aster-store.js";
import { AsterConfigError, findAsterWorkspace, loadAsterServerConfig } from "./aster-workspaces.js";
import { containsLikelyProviderSecret, createAsterTools, redactLikelySecrets, assertAsterWorkspacePath } from "./aster-tools.js";

const API_PREFIX = "/api/v1";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_USER_TURN_CHARS = 20_000;
const CLIENT_TURN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_APPROVAL_ARG_BYTES = 24 * 1024;
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_ASTER_TOOLS = ["read", "write", "edit"] as const;

export interface AsterTurnStart {
  runId: string;
  conversation: AsterConversation;
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  allowedTools: Set<string>;
  maxToolIterations: number;
  maxRuntimeMs: number;
  askPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  publishEvent: (type: string, data: Record<string, unknown>) => void;
  finish: (status: "completed" | "failed" | "cancelled", reason?: string) => void;
}

export interface AsterApiRuntime {
  startTurn: (turn: AsterTurnStart) => void;
  cancelRun: (runId: string) => void;
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
  private readonly runtime: AsterApiRuntime;
  private readonly config: KimiConfig;

  constructor(config: KimiConfig, runtime: AsterApiRuntime) {
    this.config = config;
    this.runtime = runtime;
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
          capabilities: ["workspaces", "conversations", "turns", "event-replay", "cancellation", "human-approvals"],
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
        return json(res, 200, { models: config.models });
      }

      if (path === `${API_PREFIX}/conversations` && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const body = await readJsonBody(req);
        if (Object.keys(body).some((key) => key !== "workspaceId" && key !== "model")) {
          return sendError(res, 400, "unsupported_field", "Conversation creation accepts only workspaceId and model; paths are server-configured");
        }
        if (typeof body.workspaceId !== "string" || !principal.workspaceIds.includes(body.workspaceId)) {
          return sendError(res, 403, "workspace_forbidden", "Workspace ID is not in this credential's scope");
        }
        const workspace = findAsterWorkspace(config, body.workspaceId);
        if (!workspace) return sendError(res, 404, "workspace_not_found", "Workspace is not configured");
        if (typeof body.model !== "string" || !config.models.includes(body.model)) {
          return sendError(res, 400, "model_not_allowed", "Select a model from the configured model list");
        }
        return await this.createConversation(res, store, workspace, body.model);
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
        if (Object.keys(body).some((key) => key !== "text" && key !== "clientTurnId")) return sendError(res, 400, "unsupported_field", "Turns accept text and an optional clientTurnId; workspace and model are fixed by the conversation");
        const hasClientTurnId = Object.hasOwn(body, "clientTurnId");
        const clientTurnId = hasClientTurnId && typeof body.clientTurnId === "string" ? body.clientTurnId : undefined;
        if (hasClientTurnId && (!clientTurnId || !CLIENT_TURN_ID_RE.test(clientTurnId))) return sendError(res, 400, "invalid_client_turn_id", "clientTurnId must be 1-128 ASCII letters, digits, '.', '_', ':', or '-' and start with a letter or digit");
        const requestText = typeof body.text === "string" ? body.text : "";
        const text = requestText.trim();
        if (!text || text.length > MAX_USER_TURN_CHARS) return sendError(res, 400, "invalid_turn", `Turn text must be 1-${MAX_USER_TURN_CHARS} characters`);
        if (containsLikelyProviderSecret(text)) return sendError(res, 400, "secret_input_rejected", "Provider credentials must not be sent in conversation text");
        return await this.appendTurn(res, store, conversation, clientTurnId, requestText, text);
      }

      const cancelMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)\/cancel$/);
      if (cancelMatch && method === "POST") {
        if (!this.hasScope(principal, "conversations:write")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/write scope");
        const conversation = await this.authorizedConversation(store, principal, cancelMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return this.cancelConversation(res, store, conversation);
      }

      const conversationMatch = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
      if (conversationMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const conversation = await this.authorizedConversation(store, principal, conversationMatch[1]!);
        if (!conversation) return sendError(res, 404, "conversation_not_found", "Conversation not found");
        return json(res, 200, publicConversation(conversation));
      }

      const approvalMatch = path.match(/^\/api\/v1\/approvals\/([^/]+)$/);
      if (approvalMatch && method === "GET") {
        if (!this.hasScope(principal, "conversations:read")) return sendError(res, 403, "insufficient_scope", "Credential lacks conversation/read scope");
        const approval = store.getApproval(approvalMatch[1]!);
        if (!approval) return sendError(res, 404, "approval_not_found", "Approval not found");
        const conversation = store.getConversation(approval.conversationId);
        if (!conversation || !principal.workspaceIds.includes(conversation.workspaceId)) return sendError(res, 404, "approval_not_found", "Approval not found");
        return json(res, 200, publicApproval(approval));
      }
      if (approvalMatch && method === "POST") {
        if (!this.hasScope(principal, "approvals:resolve")) return sendError(res, 403, "insufficient_scope", "Credential lacks approval/resolve scope");
        const approval = store.getApproval(approvalMatch[1]!);
        if (!approval) return sendError(res, 404, "approval_not_found", "Approval not found");
        const conversation = store.getConversation(approval.conversationId);
        if (!conversation || !principal.workspaceIds.includes(conversation.workspaceId)) return sendError(res, 404, "approval_not_found", "Approval not found");
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
    if (!conversation || !principal.workspaceIds.includes(conversation.workspaceId)) return undefined;
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
          }
        }
      } finally {
        runs.close();
      }
    })();
    return this.recovery;
  }

  private async createConversation(res: ServerResponse, store: AsterStore, workspace: { id: string; displayName: string; rootPath: string }, model: string): Promise<void> {
    const id = randomUUID();
    const sessionId = randomUUID();
    const worktreeManager = new RunWorktreeManager();
    let worktree;
    try {
      worktree = await worktreeManager.create(id, workspace.rootPath);
    } catch {
      sendError(res, 409, "workspace_repository_unavailable", "Configured workspace must be an accessible Git repository");
      return;
    }
    const tools = createAsterTools(worktree.cwd);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt({ cwd: worktree.cwd, tools, model, preferPullRequests: true }) },
      { role: "system", content: "You are operating through Aster. Only read, write, and edit tools are available. All file access is confined to the selected workspace. Never request, reveal, store, or repeat provider credentials or secrets." },
    ];
    const sessionFile: SessionFile = {
      id: sessionId,
      cwd: worktree.cwd,
      model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages,
      title: "Aster conversation",
    };
    try {
      await saveSession(sessionFile);
      const conversation = store.createConversation({
        id,
        workspaceId: workspace.id,
        model,
        sessionId,
        worktreePath: worktree.worktreePath,
        cwd: worktree.cwd,
        branch: worktree.branch,
      });
      store.appendEvent(id, null, "conversation.created", { conversationId: id, workspaceId: workspace.id, model });
      json(res, 201, publicConversation(conversation));
    } catch {
      await unlink(resolve(sessionsDir(), `${sessionId}.json`)).catch(() => {});
      await worktreeManager.discard(worktree).catch(() => {});
      sendError(res, 500, "conversation_create_failed", "Conversation could not be created");
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
      const active: AsterTurnStart = {
        runId,
        conversation,
        sessionFile,
        messages: sessionFile.messages,
        executor,
        allowedTools,
        maxToolIterations: run.maxToolIterations,
        maxRuntimeMs: run.maxRuntimeMs,
        askPermission: (request) => this.askForApproval(store, conversation, runId, request, publishEvent),
        publishEvent,
        finish: (status, reason) => {
          const updated = store.updateConversationStatus(conversation.id, runId, status, reason ? { reason } : {});
          if (updated) store.appendEvent(conversation.id, runId, status, reason ? { reason } : {});
        },
      };
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
    const workspaceRoot = conversation.cwd;
    try {
      await assertAsterWorkspacePath(workspaceRoot, request.args.path, request.tool.name === "write");
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
        res.end();
      } finally {
        polling = false;
        if (!closed) setTimeout(() => { void pump(); }, 500).unref();
      }
    };
    res.on("close", () => { closed = true; });
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
    return conversation && principal.workspaceIds.includes(conversation.workspaceId) ? conversation : undefined;
  }
}

function parseCursor(header: string | string[] | undefined, query: string | null): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header) ?? query ?? "0";
  if (!/^\d{1,16}$/.test(value)) return undefined;
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) ? cursor : undefined;
}

function publicConversation(conversation: AsterConversation): Record<string, unknown> {
  return {
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
