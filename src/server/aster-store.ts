import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AsterScope = "workspaces:read" | "models:read" | "conversations:read" | "conversations:write" | "approvals:resolve";
export type AsterConversationStatus = "ready" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export type AsterApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface AsterPrincipal {
  credentialId: string;
  name: string;
  workspaceIds: string[];
  scopes: AsterScope[];
  expiresAt: number;
}

export interface AsterConversation {
  id: string;
  workspaceId: string;
  model: string;
  sessionId: string;
  worktreePath: string;
  cwd: string;
  branch: string;
  status: AsterConversationStatus;
  activeRunId: string | null;
  lastEventSequence: number;
  oldestEventSequence: number;
  createdAt: number;
  updatedAt: number;
}

export interface AsterEvent {
  sequence: number;
  conversationId: string;
  runId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface AsterApproval {
  id: string;
  conversationId: string;
  runId: string;
  toolName: string;
  explanation: string;
  arguments: Record<string, unknown>;
  status: AsterApprovalStatus;
  expiresAt: number;
  decision: "allow" | "deny" | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface NewAsterApproval {
  conversationId: string;
  runId: string;
  toolName: string;
  explanation: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
}

export type AsterTurnReservation =
  | { kind: "absent" }
  | { kind: "reserved" }
  | { kind: "replay"; runId: string; responseStatus: number; response: Record<string, unknown> }
  | { kind: "conflict" }
  | { kind: "busy" }
  | { kind: "not_found" };

export interface ReserveAsterTurnInput {
  conversationId: string;
  clientTurnId: string;
  requestText: string;
  acceptedText: string;
  runId: string;
  response: Record<string, unknown>;
}

interface CredentialRow extends Record<string, unknown> {
  id: string;
  name: string;
  token_hash: string;
  workspace_ids_json: string;
  scopes_json: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

interface ConversationRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  model: string;
  session_id: string;
  worktree_path: string;
  cwd: string;
  branch: string;
  status: AsterConversationStatus;
  active_run_id: string | null;
  last_event_sequence: number;
  oldest_event_sequence: number;
  created_at: number;
  updated_at: number;
}

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  conversation_id: string;
  run_id: string;
  tool_name: string;
  explanation: string;
  arguments_json: string;
  status: AsterApprovalStatus;
  expires_at: number;
  decision: "allow" | "deny" | null;
  created_at: number;
  resolved_at: number | null;
}

export interface CreatedAsterCredential {
  id: string;
  name: string;
  workspaceIds: string[];
  scopes: AsterScope[];
  createdAt: number;
  expiresAt: number;
  token: string;
}

const VALID_SCOPES = new Set<AsterScope>([
  "workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve",
]);
const MAX_EVENTS_PER_CONVERSATION = 50_000;

export class AsterStore {
  private readonly db: Database.Database;

  constructor(dbPath = defaultAsterDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(dbPath), 0o700); } catch { /* permissions are managed by the service account */ }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aster_credentials (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        workspace_ids_json TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS aster_conversations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        worktree_path TEXT NOT NULL,
        cwd TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        active_run_id TEXT,
        last_event_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_aster_conversations_workspace ON aster_conversations(workspace_id, updated_at);
      CREATE TABLE IF NOT EXISTS aster_events (
        conversation_id TEXT NOT NULL REFERENCES aster_conversations(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        run_id TEXT,
        event_type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_aster_events_run ON aster_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS aster_approvals (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES aster_conversations(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        explanation TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        decision TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_aster_approvals_pending ON aster_approvals(conversation_id, status, expires_at);
      CREATE TABLE IF NOT EXISTS aster_turn_idempotency (
        conversation_id TEXT NOT NULL REFERENCES aster_conversations(id) ON DELETE CASCADE,
        client_turn_id TEXT NOT NULL,
        request_text TEXT NOT NULL,
        accepted_text TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE,
        response_status INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, client_turn_id)
      );
    `);
    try { chmodSync(dbPath, 0o600); } catch { /* existing/read-only database permissions are managed by the caller */ }
  }

  close(): void {
    this.db.close();
  }

  createCredential(input: { name: string; workspaceIds: string[]; scopes: AsterScope[]; expiresAt: number }): CreatedAsterCredential {
    const name = input.name.trim();
    if (!name || name.length > 100) throw new Error("credential name must be 1 to 100 characters");
    const workspaceIds = [...new Set(input.workspaceIds)];
    if (workspaceIds.length === 0 || workspaceIds.length > 100 || workspaceIds.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id))) {
      throw new Error("credential must be scoped to valid workspace IDs");
    }
    const scopes = [...new Set(input.scopes)];
    if (scopes.length === 0 || scopes.some((scope) => !VALID_SCOPES.has(scope))) throw new Error("credential scopes are invalid");
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw new Error("credential expiry must be in the future");
    const id = randomUUID();
    const token = `aster_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    this.db.prepare(`INSERT INTO aster_credentials
      (id, name, token_hash, workspace_ids_json, scopes_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, name, hashToken(token), JSON.stringify(workspaceIds), JSON.stringify(scopes), now, input.expiresAt);
    return { id, name, workspaceIds, scopes, createdAt: now, expiresAt: input.expiresAt, token };
  }

  authenticate(authorization: string | undefined, now = Date.now()): AsterPrincipal | undefined {
    const match = authorization?.match(/^Bearer (aster_[A-Za-z0-9_-]{40,})$/);
    if (!match) return undefined;
    const row = this.db.prepare("SELECT * FROM aster_credentials WHERE token_hash = ?")
      .get(hashToken(match[1]!)) as CredentialRow | undefined;
    if (!row || row.revoked_at !== null || row.expires_at <= now) return undefined;
    this.db.prepare("UPDATE aster_credentials SET last_used_at = ? WHERE id = ?").run(now, row.id);
    return {
      credentialId: row.id,
      name: row.name,
      workspaceIds: JSON.parse(row.workspace_ids_json) as string[],
      scopes: JSON.parse(row.scopes_json) as AsterScope[],
      expiresAt: row.expires_at,
    };
  }

  revokeCredential(id: string, now = Date.now()): boolean {
    const result = this.db.prepare("UPDATE aster_credentials SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now, id);
    return result.changes > 0;
  }

  createConversation(input: {
    id: string;
    workspaceId: string;
    model: string;
    sessionId: string;
    worktreePath: string;
    cwd: string;
    branch: string;
  }): AsterConversation {
    const now = Date.now();
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO aster_conversations
        (id, workspace_id, model, session_id, worktree_path, cwd, branch, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`)
        .run(input.id, input.workspaceId, input.model, input.sessionId, input.worktreePath, input.cwd, input.branch, now, now);
      this.insertEvent(input.id, null, "status", { status: "ready" }, now);
    });
    create.immediate();
    return this.getConversation(input.id)!;
  }

  getConversation(id: string): AsterConversation | undefined {
    const row = this.db.prepare("SELECT * FROM aster_conversations WHERE id = ?").get(id) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  listActiveConversations(): AsterConversation[] {
    const rows = this.db.prepare("SELECT * FROM aster_conversations WHERE active_run_id IS NOT NULL").all() as ConversationRow[];
    return rows.map(rowToConversation);
  }

  lookupTurn(conversationId: string, clientTurnId: string, requestText: string): AsterTurnReservation {
    const row = this.db.prepare("SELECT run_id, request_text, response_status, response_json FROM aster_turn_idempotency WHERE conversation_id = ? AND client_turn_id = ?")
      .get(conversationId, clientTurnId) as { run_id: string; request_text: string; response_status: number; response_json: string } | undefined;
    if (!row) return { kind: "absent" };
    if (row.request_text !== requestText) return { kind: "conflict" };
    return {
      kind: "replay",
      runId: row.run_id,
      responseStatus: row.response_status,
      response: JSON.parse(row.response_json) as Record<string, unknown>,
    };
  }

  reserveTurn(input: ReserveAsterTurnInput): AsterTurnReservation {
    const reserve = this.db.transaction((): AsterTurnReservation => {
      const existing = this.db.prepare("SELECT run_id, request_text, response_status, response_json FROM aster_turn_idempotency WHERE conversation_id = ? AND client_turn_id = ?")
        .get(input.conversationId, input.clientTurnId) as { run_id: string; request_text: string; response_status: number; response_json: string } | undefined;
      if (existing) {
        if (existing.request_text !== input.requestText) return { kind: "conflict" };
        return {
          kind: "replay",
          runId: existing.run_id,
          responseStatus: existing.response_status,
          response: JSON.parse(existing.response_json) as Record<string, unknown>,
        };
      }

      const conversation = this.getConversation(input.conversationId);
      if (!conversation) return { kind: "not_found" };
      if (conversation.activeRunId) return { kind: "busy" };
      const now = Date.now();
      const updated = this.db.prepare("UPDATE aster_conversations SET status = 'running', active_run_id = ?, updated_at = ? WHERE id = ? AND active_run_id IS NULL")
        .run(input.runId, now, input.conversationId);
      if (updated.changes !== 1) return { kind: "busy" };
      this.insertEvent(input.conversationId, input.runId, "status", { status: "running" }, now);
      this.db.prepare("INSERT INTO aster_turn_idempotency (conversation_id, client_turn_id, request_text, accepted_text, run_id, response_status, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.conversationId, input.clientTurnId, input.requestText, input.acceptedText, input.runId, 202, JSON.stringify(input.response), now);
      return { kind: "reserved" };
    });
    return reserve.immediate();
  }

  beginTurn(conversationId: string, runId: string): boolean {
    const update = this.db.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (!conversation || conversation.activeRunId) return false;
      const now = Date.now();
      const result = this.db.prepare(`UPDATE aster_conversations SET status = 'running', active_run_id = ?, updated_at = ?
        WHERE id = ? AND active_run_id IS NULL`).run(runId, now, conversationId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, runId, "status", { status: "running" }, now);
      return true;
    });
    return update.immediate();
  }

  updateConversationStatus(conversationId: string, runId: string, status: AsterConversationStatus, data: Record<string, unknown> = {}): boolean {
    const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
    const update = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare(`UPDATE aster_conversations SET status = ?, active_run_id = ?, updated_at = ?
        WHERE id = ? AND active_run_id = ?`)
        .run(status, terminal ? null : runId, now, conversationId, runId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, runId, "status", { status, ...data }, now);
      return true;
    });
    return update.immediate();
  }

  appendEvent(conversationId: string, runId: string | null, type: string, data: Record<string, unknown>): AsterEvent {
    const append = this.db.transaction(() => this.insertEvent(conversationId, runId, type, data, Date.now()));
    return append.immediate();
  }

  eventsAfter(conversationId: string, after: number, limit = 200): AsterEvent[] {
    const rows = this.db.prepare(`SELECT * FROM aster_events WHERE conversation_id = ? AND sequence > ?
      ORDER BY sequence LIMIT ?`).all(conversationId, after, Math.max(1, Math.min(500, Math.trunc(limit)))) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: row.sequence as number,
      conversationId: row.conversation_id as string,
      runId: (row.run_id as string | null) ?? null,
      type: row.event_type as string,
      data: JSON.parse(row.data_json as string) as Record<string, unknown>,
      createdAt: row.created_at as number,
    }));
  }

  createApproval(input: NewAsterApproval): AsterApproval {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO aster_approvals
      (id, conversation_id, run_id, tool_name, explanation, arguments_json, status, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .run(id, input.conversationId, input.runId, input.toolName, input.explanation, JSON.stringify(input.arguments), input.expiresAt, now);
    return this.getApproval(id)!;
  }

  getApproval(id: string): AsterApproval | undefined {
    const row = this.db.prepare("SELECT * FROM aster_approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  pendingApprovalsForConversation(conversationId: string): AsterApproval[] {
    const rows = this.db.prepare("SELECT * FROM aster_approvals WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at")
      .all(conversationId) as ApprovalRow[];
    return rows.map(rowToApproval);
  }

  getConversationForApproval(approvalId: string): AsterConversation | undefined {
    const row = this.db.prepare(`SELECT c.* FROM aster_conversations c
      JOIN aster_approvals a ON a.conversation_id = c.id WHERE a.id = ?`).get(approvalId) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }

  expireApproval(id: string, now = Date.now()): AsterApproval | undefined {
    const update = this.db.transaction(() => {
      const approval = this.getApproval(id);
      if (!approval) return undefined;
      if (approval.status === "pending" && approval.expiresAt <= now) {
        this.db.prepare("UPDATE aster_approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, id);
        return this.getApproval(id);
      }
      return approval;
    });
    return update.immediate();
  }

  cancelPendingApprovals(conversationId: string, now = Date.now()): AsterApproval[] {
    const update = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM aster_approvals WHERE conversation_id = ? AND status = 'pending'").all(conversationId) as ApprovalRow[];
      for (const row of rows) this.db.prepare("UPDATE aster_approvals SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
      return rows.map((row) => ({ ...rowToApproval(row), status: "cancelled" as const, resolvedAt: now }));
    });
    return update.immediate();
  }

  expirePendingApprovals(now = Date.now()): AsterApproval[] {
    const update = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM aster_approvals WHERE status = 'pending' AND expires_at <= ?").all(now) as ApprovalRow[];
      for (const row of rows) this.db.prepare("UPDATE aster_approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
      return rows.map((row) => ({ ...rowToApproval(row), status: "expired" as const, resolvedAt: now }));
    });
    return update.immediate();
  }

  expireAllPendingApprovals(now = Date.now()): AsterApproval[] {
    const update = this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM aster_approvals WHERE status = 'pending'").all() as ApprovalRow[];
      for (const row of rows) this.db.prepare("UPDATE aster_approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, row.id);
      return rows.map((row) => ({ ...rowToApproval(row), status: "expired" as const, resolvedAt: now }));
    });
    return update.immediate();
  }

  resolveApproval(id: string, decision: "allow" | "deny", now = Date.now()): { approval?: AsterApproval; conflict: boolean; changed: boolean } {
    const update = this.db.transaction(() => {
      const current = this.getApproval(id);
      if (!current) return { conflict: false, changed: false };
      if (current.status === "pending" && current.expiresAt <= now) {
        this.db.prepare("UPDATE aster_approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(now, id);
        return { approval: this.getApproval(id), conflict: true, changed: true };
      }
      if (current.status !== "pending") {
        return { approval: current, conflict: current.decision !== decision, changed: false };
      }
      this.db.prepare("UPDATE aster_approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
        .run(decision === "allow" ? "approved" : "denied", decision, now, id);
      return { approval: this.getApproval(id), conflict: false, changed: true };
    });
    return update.immediate();
  }

  private insertEvent(conversationId: string, runId: string | null, type: string, data: Record<string, unknown>, now: number): AsterEvent {
    const row = this.db.prepare("SELECT last_event_sequence FROM aster_conversations WHERE id = ?").get(conversationId) as { last_event_sequence: number } | undefined;
    if (!row) throw new Error("Conversation not found");
    const sequence = row.last_event_sequence + 1;
    this.db.prepare("UPDATE aster_conversations SET last_event_sequence = ?, updated_at = ? WHERE id = ?").run(sequence, now, conversationId);
    this.db.prepare(`INSERT INTO aster_events (conversation_id, sequence, run_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(conversationId, sequence, runId, type, JSON.stringify(data), now);
    return { sequence, conversationId, runId, type, data, createdAt: now };
  }
}

function defaultAsterDbPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.AUTOPILOT_ASTER_DB || join(root, "autopilot", "aster.db");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToConversation(row: ConversationRow): AsterConversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    model: row.model,
    sessionId: row.session_id,
    worktreePath: row.worktree_path,
    cwd: row.cwd,
    branch: row.branch,
    status: row.status,
    activeRunId: row.active_run_id,
    lastEventSequence: row.last_event_sequence,
    oldestEventSequence: row.oldest_event_sequence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToApproval(row: ApprovalRow): AsterApproval {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    toolName: row.tool_name,
    explanation: row.explanation,
    arguments: JSON.parse(row.arguments_json) as Record<string, unknown>,
    status: row.status,
    expiresAt: row.expires_at,
    decision: row.decision,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}
