import { SqliteDatabase } from "../util/sqlite.js";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AsterScope = "workspaces:read" | "models:read" | "conversations:read" | "conversations:write" | "approvals:resolve" | "pairing:approve";
export type AsterConversationStatus = "provisioning" | "ready" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | "interrupted" | "paused" | "destroying" | "cleanup_pending" | "destroyed" | "merged";
/**
 * The coarse state a sidebar draws: one row per conversation, no event replay.
 * Teardown states are terminal, so they read as done rather than as work in progress.
 */
export type AsterConversationState = "working" | "blocked" | "idle" | "done" | "failed";
export type AsterApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

/** Maps a conversation's detailed status onto the state clients render. */
export function asterConversationState(status: AsterConversationStatus): AsterConversationState {
  switch (status) {
    case "provisioning":
    case "running":
      return "working";
    case "waiting_approval":
      return "blocked";
    case "ready":
    case "paused":
      return "idle";
    case "completed":
    case "merged":
    case "destroying":
    case "cleanup_pending":
    case "destroyed":
      return "done";
    case "failed":
    case "cancelled":
    case "interrupted":
      return "failed";
  }
}

/** What a blocked conversation is waiting on: the pending approval's tool and summary. */
export interface AsterWaitingFor {
  tool: string;
  summary: string;
}

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
  kind: "chat" | "code";
  repository: string | null;
  baseBranch: string | null;
  pullRequestNumber: number | null;
  pullRequestURL: string | null;
  status: AsterConversationStatus;
  activeRunId: string | null;
  /** First line of the first user message, trimmed; null until the first turn. */
  title: string | null;
  /** Sum of the usage every turn reported so far, in USD. */
  costUsd: number;
  /** Why the last turn failed; only meaningful while the status is failed. */
  lastError: string | null;
  /** When the last event was recorded (updatedAt for rows that predate the column). */
  lastActivityAt: number;
  lastEventSequence: number;
  oldestEventSequence: number;
  createdAt: number;
  updatedAt: number;
}

/** What a conversation's cell holds: a plain chat workspace, or a cloned GitHub repository. */
export interface AsterConversationProject {
  kind: "chat" | "code";
  repository: string | null;
  branch: string | null;
}

export interface AsterCellMapping {
  conversationId: string;
  credentialId: string;
  workspaceId: string;
  model: string;
  sessionId: string;
  cellName: string;
  cellId: string | null;
  status: "provisioning" | "ready" | "running" | "paused" | "destroying" | "cleanup_pending" | "destroyed" | "failed";
  createAttempted: boolean;
  eventCursor: number;
  createdAt: number;
  updatedAt: number;
}

export type AsterCellReservation =
  | { kind: "created"; mapping: AsterCellMapping }
  | { kind: "replay"; mapping: AsterCellMapping }
  | { kind: "conflict" };

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
  kind: "chat" | "code";
  repository: string | null;
  base_branch: string | null;
  pull_request_number: number | null;
  pull_request_url: string | null;
  status: AsterConversationStatus;
  active_run_id: string | null;
  title: string | null;
  cost_usd: number;
  last_error: string | null;
  last_activity_at: number | null;
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

export type AsterDeviceStatus = "pending" | "approved" | "denied" | "redeemed";

export interface AsterDeviceAuthorization {
  userCode: string;
  clientName: string;
  status: AsterDeviceStatus;
  createdAt: number;
  expiresAt: number;
}

export type AsterDeviceRedemption =
  | { kind: "pending" }
  | { kind: "slow_down" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "issued"; credential: CreatedAsterCredential };

export type AsterDeviceResolution = "approved" | "denied" | "not_found" | "expired" | "already_resolved";

interface DeviceRow extends Record<string, unknown> {
  device_code_hash: string;
  user_code: string;
  client_name: string;
  status: AsterDeviceStatus;
  workspace_ids_json: string | null;
  credential_ttl_ms: number | null;
  created_at: number;
  expires_at: number;
  last_polled_at: number | null;
}

export interface AsterCredentialInfo {
  id: string;
  name: string;
  workspaceIds: string[];
  scopes: AsterScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  status: "active" | "expired" | "revoked";
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
  "workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve", "pairing:approve",
]);
/** What a paired client (laptop CLI, desktop app) may do; never pairing:approve. */
export const ASTER_CLIENT_SCOPES: AsterScope[] = ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"];
// No vowels or look-alikes, so a code can't spell a word and is easy to read aloud.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const MAX_EVENTS_PER_CONVERSATION = 50_000;

export class AsterStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath = defaultAsterDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    try { chmodSync(dirname(dbPath), 0o700); } catch { /* permissions are managed by the service account */ }
    this.db = new SqliteDatabase(dbPath);
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
        kind TEXT NOT NULL DEFAULT 'chat',
        repository TEXT,
        base_branch TEXT,
        pull_request_number INTEGER,
        pull_request_url TEXT,
        status TEXT NOT NULL,
        active_run_id TEXT,
        title TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        last_error TEXT,
        last_activity_at INTEGER,
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
      CREATE TABLE IF NOT EXISTS aster_cell_mappings (
        conversation_id TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        model TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        cell_name TEXT NOT NULL UNIQUE,
        cell_id TEXT,
        create_key_hash TEXT NOT NULL,
        create_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        create_attempted INTEGER NOT NULL DEFAULT 0,
        event_cursor INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(credential_id, create_key_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_aster_cells_lifecycle ON aster_cell_mappings(status, updated_at);
      CREATE TABLE IF NOT EXISTS aster_github_grants (
        conversation_id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        token_hash TEXT,
        repository TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS aster_device_authorizations (
        device_code_hash TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        client_name TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_ids_json TEXT,
        credential_ttl_ms INTEGER,
        credential_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        resolved_at INTEGER,
        last_polled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS aster_owner_claims (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_at INTEGER,
        credential_id TEXT
      );
      CREATE TABLE IF NOT EXISTS aster_conversation_projects (
        conversation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        repository TEXT,
        branch TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    const conversationColumns = new Set(
      (this.db.prepare("PRAGMA table_info(aster_conversations)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!conversationColumns.has("kind")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    if (!conversationColumns.has("repository")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN repository TEXT");
    if (!conversationColumns.has("base_branch")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN base_branch TEXT");
    if (!conversationColumns.has("pull_request_number")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN pull_request_number INTEGER");
    if (!conversationColumns.has("pull_request_url")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN pull_request_url TEXT");
    if (!conversationColumns.has("title")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN title TEXT");
    if (!conversationColumns.has("cost_usd")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
    if (!conversationColumns.has("last_error")) this.db.exec("ALTER TABLE aster_conversations ADD COLUMN last_error TEXT");
    if (!conversationColumns.has("last_activity_at")) {
      this.db.exec("ALTER TABLE aster_conversations ADD COLUMN last_activity_at INTEGER");
      // Rows written before the column existed: their last write is the best activity time.
      this.db.exec("UPDATE aster_conversations SET last_activity_at = updated_at WHERE last_activity_at IS NULL");
    }
    const grantColumns = new Set(
      (this.db.prepare("PRAGMA table_info(aster_github_grants)").all() as Array<{ name: string }>).map(({ name }) => name),
    );
    if (!grantColumns.has("branch")) this.db.exec("ALTER TABLE aster_github_grants ADD COLUMN branch TEXT NOT NULL DEFAULT ''");
    if (!grantColumns.has("token_hash")) this.db.exec("ALTER TABLE aster_github_grants ADD COLUMN token_hash TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_aster_github_grants_token_hash ON aster_github_grants(token_hash) WHERE token_hash IS NOT NULL");
    const legacyGrants = this.db.prepare("SELECT conversation_id, token, branch FROM aster_github_grants WHERE token_hash IS NULL").all() as Array<{ conversation_id: string; token: string; branch: string }>;
    for (const grant of legacyGrants) {
      const project = this.getConversationProject(grant.conversation_id);
      this.db.prepare("UPDATE aster_github_grants SET token_hash = ?, branch = ? WHERE conversation_id = ? AND token_hash IS NULL")
        .run(hashToken(grant.token), grant.branch || project?.branch || "", grant.conversation_id);
    }
    try { chmodSync(dbPath, 0o600); } catch { /* existing/read-only database permissions are managed by the caller */ }
  }

  close(): void {
    this.db.close();
  }

  reserveCellConversation(input: {
    conversationId: string;
    credentialId: string;
    workspaceId: string;
    model: string;
    sessionId: string;
    cellName: string;
    idempotencyKey: string;
    kind?: "chat" | "code";
    repository?: string;
    /** Uploaded working-tree changes: part of the request, so a retry must resend the same ones. */
    baseCommit?: string;
    patch?: string;
  }): AsterCellReservation {
    const keyHash = createHash("sha256").update(input.idempotencyKey).digest("hex");
    const fingerprintInput: unknown[] = [input.workspaceId, input.model, input.kind ?? "chat", input.repository?.toLowerCase() ?? null];
    if (input.baseCommit !== undefined) {
      fingerprintInput.push(input.baseCommit, createHash("sha256").update(input.patch ?? "").digest("hex"));
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
    const legacyChatFingerprint = createHash("sha256").update(JSON.stringify([input.workspaceId, input.model])).digest("hex");
    const reserve = this.db.transaction((): AsterCellReservation => {
      const existing = this.db.prepare("SELECT * FROM aster_cell_mappings WHERE credential_id = ? AND create_key_hash = ?")
        .get(input.credentialId, keyHash) as Record<string, unknown> | undefined;
      if (existing) {
        const mapping = cellMappingFromRow(existing);
        const sameRequest = existing.create_fingerprint === fingerprint
          || (input.kind === undefined && input.repository === undefined && existing.create_fingerprint === legacyChatFingerprint);
        return sameRequest ? { kind: "replay", mapping } : { kind: "conflict" };
      }
      const now = Date.now();
      this.db.prepare(`INSERT INTO aster_cell_mappings
        (conversation_id, credential_id, workspace_id, model, session_id, cell_name, create_key_hash, create_fingerprint, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'provisioning', ?, ?)`)
        .run(input.conversationId, input.credentialId, input.workspaceId, input.model, input.sessionId, input.cellName, keyHash, fingerprint, now, now);
      return { kind: "created", mapping: this.getCellMapping(input.conversationId)! };
    });
    return reserve.immediate();
  }

  getCellMapping(conversationId: string): AsterCellMapping | undefined {
    const row = this.db.prepare("SELECT * FROM aster_cell_mappings WHERE conversation_id = ?").get(conversationId) as Record<string, unknown> | undefined;
    return row ? cellMappingFromRow(row) : undefined;
  }

  listCellMappings(): AsterCellMapping[] {
    const rows = this.db.prepare("SELECT * FROM aster_cell_mappings ORDER BY created_at").all() as Array<Record<string, unknown>>;
    return rows.map(cellMappingFromRow);
  }

  getCredentialCellMapping(conversationId: string, credentialId: string): AsterCellMapping | undefined {
    const row = this.db.prepare("SELECT * FROM aster_cell_mappings WHERE conversation_id = ? AND credential_id = ?")
      .get(conversationId, credentialId) as Record<string, unknown> | undefined;
    return row ? cellMappingFromRow(row) : undefined;
  }

  markCellCreateAttempted(conversationId: string): void {
    this.db.prepare("UPDATE aster_cell_mappings SET create_attempted = 1, updated_at = ? WHERE conversation_id = ?")
      .run(Date.now(), conversationId);
  }

  setCellId(conversationId: string, cellId: string): void {
    this.db.prepare("UPDATE aster_cell_mappings SET cell_id = ?, updated_at = ? WHERE conversation_id = ?")
      .run(cellId, Date.now(), conversationId);
  }

  setCellStatus(conversationId: string, status: AsterCellMapping["status"]): void {
    this.db.prepare("UPDATE aster_cell_mappings SET status = ?, updated_at = ? WHERE conversation_id = ?")
      .run(status, Date.now(), conversationId);
  }

  advanceCellEventCursor(conversationId: string, cursor: number): boolean {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("invalid Hotcell event cursor");
    const result = this.db.prepare("UPDATE aster_cell_mappings SET event_cursor = ?, updated_at = ? WHERE conversation_id = ? AND event_cursor < ?")
      .run(cursor, Date.now(), conversationId, cursor);
    return result.changes === 1;
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

  /**
   * Starts a device-code pairing (RFC 8628 shape): the client keeps the device code and
   * polls; the owner approves the short user code. Returns undefined when too many
   * pairings are pending, so an unauthenticated caller can't fill the table.
   */
  createDeviceAuthorization(input: { clientName: string; ttlMs: number; maxPending: number }, now = Date.now()):
    { deviceCode: string; userCode: string; expiresAt: number; intervalMs: number } | undefined {
    const create = this.db.transaction(() => {
      this.db.prepare("DELETE FROM aster_device_authorizations WHERE expires_at <= ? AND status != 'redeemed'").run(now);
      const pending = this.db.prepare("SELECT COUNT(*) AS count FROM aster_device_authorizations WHERE status = 'pending'").get() as { count: number };
      if (pending.count >= input.maxPending) return undefined;
      const deviceCode = `aster_device_${randomBytes(32).toString("base64url")}`;
      let userCode = newUserCode();
      while (this.db.prepare("SELECT 1 FROM aster_device_authorizations WHERE user_code = ?").get(userCode)) userCode = newUserCode();
      const expiresAt = now + input.ttlMs;
      this.db.prepare(`INSERT INTO aster_device_authorizations
        (device_code_hash, user_code, client_name, status, created_at, expires_at)
        VALUES (?, ?, ?, 'pending', ?, ?)`)
        .run(hashToken(deviceCode), userCode, input.clientName, now, expiresAt);
      return { deviceCode, userCode, expiresAt, intervalMs: DEVICE_POLL_INTERVAL_MS };
    });
    return create.immediate();
  }

  getDeviceAuthorization(userCode: string, now = Date.now()): AsterDeviceAuthorization | undefined {
    const row = this.db.prepare("SELECT * FROM aster_device_authorizations WHERE user_code = ?")
      .get(normalizeUserCode(userCode)) as DeviceRow | undefined;
    if (!row || (row.status === "pending" && row.expires_at <= now)) return undefined;
    return deviceFromRow(row);
  }

  listPendingDeviceAuthorizations(now = Date.now()): AsterDeviceAuthorization[] {
    const rows = this.db.prepare("SELECT * FROM aster_device_authorizations WHERE status = 'pending' AND expires_at > ? ORDER BY created_at")
      .all(now) as DeviceRow[];
    return rows.map(deviceFromRow);
  }

  /** The owner's decision on a user code. An approval fixes the credential the client will receive. */
  resolveDeviceAuthorization(
    userCode: string,
    decision: "approve" | "deny",
    grant: { workspaceIds: string[]; credentialTtlMs: number },
    now = Date.now(),
  ): AsterDeviceResolution {
    const resolve = this.db.transaction((): AsterDeviceResolution => {
      const row = this.db.prepare("SELECT * FROM aster_device_authorizations WHERE user_code = ?")
        .get(normalizeUserCode(userCode)) as DeviceRow | undefined;
      if (!row) return "not_found";
      if (row.status !== "pending") return "already_resolved";
      if (row.expires_at <= now) return "expired";
      if (decision === "deny") {
        this.db.prepare("UPDATE aster_device_authorizations SET status = 'denied', resolved_at = ? WHERE user_code = ?").run(now, row.user_code);
        return "denied";
      }
      this.db.prepare(`UPDATE aster_device_authorizations
        SET status = 'approved', workspace_ids_json = ?, credential_ttl_ms = ?, resolved_at = ? WHERE user_code = ?`)
        .run(JSON.stringify(grant.workspaceIds), grant.credentialTtlMs, now, row.user_code);
      return "approved";
    });
    return resolve.immediate();
  }

  /** The client's poll. An approved code is exchanged for its credential exactly once. */
  redeemDeviceAuthorization(deviceCode: string, now = Date.now()): AsterDeviceRedemption {
    const redeem = this.db.transaction((): AsterDeviceRedemption => {
      const row = this.db.prepare("SELECT * FROM aster_device_authorizations WHERE device_code_hash = ?")
        .get(hashToken(deviceCode)) as DeviceRow | undefined;
      if (!row || row.status === "redeemed") return { kind: "expired" };
      if (row.status === "denied") return { kind: "denied" };
      if (row.status === "pending") {
        if (row.expires_at <= now) return { kind: "expired" };
        const tooSoon = row.last_polled_at !== null && now - row.last_polled_at < DEVICE_POLL_INTERVAL_MS - 1_000;
        this.db.prepare("UPDATE aster_device_authorizations SET last_polled_at = ? WHERE device_code_hash = ?").run(now, row.device_code_hash);
        return tooSoon ? { kind: "slow_down" } : { kind: "pending" };
      }
      const credential = this.createCredential({
        name: row.client_name,
        workspaceIds: JSON.parse(row.workspace_ids_json ?? "[]") as string[],
        scopes: ASTER_CLIENT_SCOPES,
        expiresAt: now + (row.credential_ttl_ms ?? 0),
      });
      this.db.prepare("UPDATE aster_device_authorizations SET status = 'redeemed', credential_id = ? WHERE device_code_hash = ?")
        .run(credential.id, row.device_code_hash);
      return { kind: "issued", credential };
    });
    return redeem.immediate();
  }

  /** A one-time link that makes the browser opening it an owner able to approve pairings. */
  createOwnerClaim(ttlMs: number, now = Date.now()): { token: string; expiresAt: number } {
    const token = `aster_claim_${randomBytes(32).toString("base64url")}`;
    const expiresAt = now + ttlMs;
    this.db.prepare("INSERT INTO aster_owner_claims (token_hash, created_at, expires_at) VALUES (?, ?, ?)").run(hashToken(token), now, expiresAt);
    return { token, expiresAt };
  }

  /** Consumes an owner claim and issues the owner's pairing:approve credential. */
  redeemOwnerClaim(token: string, grant: { workspaceIds: string[]; credentialTtlMs: number }, now = Date.now()): CreatedAsterCredential | undefined {
    if (!/^aster_claim_[A-Za-z0-9_-]{40,}$/.test(token)) return undefined;
    const redeem = this.db.transaction((): CreatedAsterCredential | undefined => {
      const row = this.db.prepare("SELECT * FROM aster_owner_claims WHERE token_hash = ?").get(hashToken(token)) as
        { token_hash: string; expires_at: number; claimed_at: number | null } | undefined;
      if (!row || row.claimed_at !== null || row.expires_at <= now) return undefined;
      const credential = this.createCredential({
        name: "Owner (browser)",
        workspaceIds: grant.workspaceIds,
        scopes: ["pairing:approve"],
        expiresAt: now + grant.credentialTtlMs,
      });
      this.db.prepare("UPDATE aster_owner_claims SET claimed_at = ?, credential_id = ? WHERE token_hash = ?").run(now, credential.id, row.token_hash);
      return credential;
    });
    return redeem.immediate();
  }

  /** Conversations a credential created, newest first. */
  listCredentialConversations(credentialId: string, limit: number): AsterConversation[] {
    const rows = this.db.prepare(`SELECT conversation_id FROM aster_cell_mappings
      WHERE credential_id = ? AND status != 'destroyed' ORDER BY created_at DESC LIMIT ?`)
      .all(credentialId, limit) as Array<{ conversation_id: string }>;
    return rows.flatMap(({ conversation_id }) => {
      const conversation = this.getConversation(conversation_id);
      return conversation ? [conversation] : [];
    });
  }

  /** Every credential, newest first, for operators (`autopilot aster token list`). Never the token. */
  listCredentials(now = Date.now()): AsterCredentialInfo[] {
    const rows = this.db.prepare("SELECT * FROM aster_credentials ORDER BY created_at DESC").all() as Array<CredentialRow & { last_used_at: number | null }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      workspaceIds: JSON.parse(row.workspace_ids_json) as string[],
      scopes: JSON.parse(row.scopes_json) as AsterScope[],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastUsedAt: row.last_used_at,
      status: row.revoked_at !== null ? "revoked" : row.expires_at <= now ? "expired" : "active",
    }));
  }

  /** Every credential's conversations, newest first, with who started each (`autopilot aster runs`). */
  listAllConversations(limit: number): Array<AsterConversation & { credentialId: string; credentialName: string | null }> {
    const rows = this.db.prepare(`SELECT m.conversation_id, m.credential_id, c.name AS credential_name
      FROM aster_cell_mappings m LEFT JOIN aster_credentials c ON c.id = m.credential_id
      WHERE m.status != 'destroyed' ORDER BY m.created_at DESC LIMIT ?`)
      .all(limit) as Array<{ conversation_id: string; credential_id: string; credential_name: string | null }>;
    return rows.flatMap((row) => {
      const conversation = this.getConversation(row.conversation_id);
      return conversation ? [{ ...conversation, credentialId: row.credential_id, credentialName: row.credential_name }] : [];
    });
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
    kind?: "chat" | "code";
    repository?: string | null;
    baseBranch?: string | null;
  }): AsterConversation {
    const kind = input.kind ?? "chat";
    const repository = input.repository ?? null;
    const baseBranch = input.baseBranch ?? null;
    if (kind === "code" && (!repository || !baseBranch)) throw new Error("code conversation requires repository and base branch");
    if (kind === "chat" && (repository !== null || baseBranch !== null)) throw new Error("chat conversation cannot bind a repository");
    const now = Date.now();
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO aster_conversations
        (id, workspace_id, model, session_id, worktree_path, cwd, branch, kind, repository, base_branch, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)`)
        .run(input.id, input.workspaceId, input.model, input.sessionId, input.worktreePath, input.cwd, input.branch, kind, repository, baseBranch, now, now);
      if (kind === "code") {
        this.db.prepare(`INSERT OR IGNORE INTO aster_conversation_projects (conversation_id, kind, repository, branch, created_at)
          VALUES (?, 'code', ?, ?, ?)`)
          .run(input.id, repository, input.branch, now);
      }
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
      const updated = this.db.prepare("UPDATE aster_conversations SET status = 'running', active_run_id = ?, last_error = NULL, updated_at = ? WHERE id = ? AND active_run_id IS NULL")
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
      const result = this.db.prepare(`UPDATE aster_conversations SET status = 'running', active_run_id = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND active_run_id IS NULL`).run(runId, now, conversationId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, runId, "status", { status: "running" }, now);
      return true;
    });
    return update.immediate();
  }

  updateConversationStatus(conversationId: string, runId: string, status: AsterConversationStatus, data: Record<string, unknown> = {}): boolean {
    const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted" || status === "merged";
    const lastError = status === "failed" ? failureText(data) : null;
    const update = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare(`UPDATE aster_conversations SET status = ?, active_run_id = ?, last_error = COALESCE(?, last_error), updated_at = ?
        WHERE id = ? AND active_run_id = ?`)
        .run(status, terminal ? null : runId, lastError, now, conversationId, runId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, runId, "status", { status, ...data }, now);
      return true;
    });
    return update.immediate();
  }

  setConversationStatus(conversationId: string, status: AsterConversationStatus, data: Record<string, unknown> = {}): boolean {
    const lastError = status === "failed" ? failureText(data) : null;
    const update = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare("UPDATE aster_conversations SET status = ?, last_error = COALESCE(?, last_error), updated_at = ? WHERE id = ? AND active_run_id IS NULL")
        .run(status, lastError, now, conversationId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, null, "status", { status, ...data }, now);
      return true;
    });
    return update.immediate();
  }

  /** The sidebar title: the first line of the first user message. The first value wins. */
  setConversationTitle(conversationId: string, text: string): void {
    const title = conversationTitle(text);
    if (!title) return;
    this.db.prepare("UPDATE aster_conversations SET title = ? WHERE id = ? AND title IS NULL").run(title, conversationId);
  }

  /** Records a conversation's project once; the first value wins so retries can't change it. */
  setConversationProject(conversationId: string, project: AsterConversationProject): void {
    this.db.prepare(`INSERT OR IGNORE INTO aster_conversation_projects (conversation_id, kind, repository, branch, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(conversationId, project.kind, project.repository, project.branch, Date.now());
  }

  getConversationProject(conversationId: string): AsterConversationProject | undefined {
    const row = this.db.prepare("SELECT kind, repository, branch FROM aster_conversation_projects WHERE conversation_id = ?")
      .get(conversationId) as { kind: string; repository: string | null; branch: string | null } | undefined;
    if (!row) return undefined;
    return { kind: row.kind === "code" ? "code" : "chat", repository: row.repository, branch: row.branch };
  }

  createGitHubGrant(conversationId: string, grantToken: string): void {
    if (grantToken.length < 32 || grantToken.length > 256) throw new Error("invalid GitHub grant token");
    const project = this.getConversationProject(conversationId);
    if (project?.kind !== "code" || !project.repository || !project.branch) throw new Error("GitHub grants require a branch-bound code conversation");
    const tokenHash = hashToken(grantToken);
    // Preserve the legacy NOT NULL column with a non-secret placeholder; the capability itself is hash-only.
    const placeholder = `hashed:${tokenHash}`;
    this.db.prepare(`INSERT INTO aster_github_grants (conversation_id, token, token_hash, repository, branch, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(conversation_id) DO UPDATE SET token = excluded.token, token_hash = excluded.token_hash,
        repository = excluded.repository, branch = excluded.branch, created_at = excluded.created_at, revoked_at = NULL`)
      .run(conversationId, placeholder, tokenHash, project.repository, project.branch, Date.now());
  }

  resolveGitHubGrant(token: string): { conversationId: string; repository: string; branch: string } | undefined {
    if (!token || token.length > 256) return undefined;
    const row = this.db.prepare("SELECT conversation_id, repository, branch FROM aster_github_grants WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(token)) as { conversation_id: string; repository: string; branch: string } | undefined;
    return row ? { conversationId: row.conversation_id, repository: row.repository, branch: row.branch } : undefined;
  }

  setPullRequest(conversationId: string, pullRequest: { number: number; url: string; title: string; summary?: string }): boolean {
    const parsed = URL.canParse(pullRequest.url) ? new URL(pullRequest.url) : undefined;
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || parsed?.protocol !== "https:" || parsed.hostname !== "github.com") {
      throw new Error("invalid pull request metadata");
    }
    const update = this.db.transaction(() => {
      const project = this.getConversationProject(conversationId);
      if (project?.kind !== "code" || !project.repository) return false;
      const result = this.db.prepare("UPDATE aster_conversations SET pull_request_number = ?, pull_request_url = ?, updated_at = ? WHERE id = ?")
        .run(pullRequest.number, pullRequest.url, Date.now(), conversationId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, null, "outcome", {
        pullRequestNumber: pullRequest.number,
        pullRequestURL: pullRequest.url,
        title: pullRequest.title,
        ...(pullRequest.summary ? { summary: pullRequest.summary } : {}),
      }, Date.now());
      return true;
    });
    return update.immediate();
  }

  markMerged(conversationId: string, sha?: string): boolean {
    const update = this.db.transaction(() => {
      const result = this.db.prepare("UPDATE aster_conversations SET status = 'merged', active_run_id = NULL, updated_at = ? WHERE id = ? AND pull_request_number IS NOT NULL AND active_run_id IS NULL")
        .run(Date.now(), conversationId);
      if (result.changes !== 1) return false;
      const row = this.db.prepare("SELECT pull_request_number FROM aster_conversations WHERE id = ?").get(conversationId) as { pull_request_number: number };
      this.insertEvent(conversationId, null, "pull_request.merged", { pullRequestNumber: row.pull_request_number, ...(sha ? { sha } : {}) }, Date.now());
      return true;
    });
    return update.immediate();
  }

  revokeGitHubGrant(conversationId: string): void {
    this.db.prepare("UPDATE aster_github_grants SET revoked_at = ? WHERE conversation_id = ? AND revoked_at IS NULL").run(Date.now(), conversationId);
  }

  /** Switch an idle conversation's model; refused while a turn is active. */
  setConversationModel(conversationId: string, model: string): boolean {
    const update = this.db.transaction(() => {
      const now = Date.now();
      const result = this.db.prepare("UPDATE aster_conversations SET model = ?, updated_at = ? WHERE id = ? AND active_run_id IS NULL")
        .run(model, now, conversationId);
      if (result.changes !== 1) return false;
      this.insertEvent(conversationId, null, "model.changed", { model }, now);
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

  /**
   * The first pending approval of each conversation, in one query, so a list of
   * conversations can say what each blocked one is waiting for without replaying events.
   */
  pendingApprovalSummaries(conversationIds: string[]): Map<string, AsterWaitingFor> {
    const summaries = new Map<string, AsterWaitingFor>();
    if (conversationIds.length === 0) return summaries;
    const placeholders = conversationIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT conversation_id, tool_name, explanation FROM aster_approvals
      WHERE status = 'pending' AND conversation_id IN (${placeholders}) ORDER BY created_at`)
      .all(...conversationIds) as Array<{ conversation_id: string; tool_name: string; explanation: string }>;
    for (const row of rows) {
      if (summaries.has(row.conversation_id)) continue;
      summaries.set(row.conversation_id, { tool: row.tool_name, summary: approvalSummary(row.explanation) });
    }
    return summaries;
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
    // Usage is journaled per run, so the conversation's total is kept here instead of
    // being replayed from the event log every time a client lists conversations.
    const costDelta = type === "usage" ? this.usageCostDelta(conversationId, runId, data) : 0;
    this.db.prepare(`UPDATE aster_conversations
      SET last_event_sequence = ?, updated_at = ?, last_activity_at = ?, cost_usd = ROUND(cost_usd + ?, 6) WHERE id = ?`)
      .run(sequence, now, now, costDelta, conversationId);
    this.db.prepare(`INSERT INTO aster_events (conversation_id, sequence, run_id, event_type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(conversationId, sequence, runId, type, JSON.stringify(data), now);
    return { sequence, conversationId, runId, type, data, createdAt: now };
  }

  /** How much a usage event adds to the conversation total: cumulative per run, or a delta. */
  private usageCostDelta(conversationId: string, runId: string | null, data: Record<string, unknown>): number {
    const cost = typeof data.costUsd === "number" && Number.isFinite(data.costUsd) && data.costUsd > 0 ? data.costUsd : 0;
    if (cost === 0) return 0;
    if (data.cumulative !== true) return cost;
    const previous = this.db.prepare(`SELECT data_json FROM aster_events
      WHERE conversation_id = ? AND run_id IS ? AND event_type = 'usage' ORDER BY sequence DESC LIMIT 1`)
      .get(conversationId, runId) as { data_json: string } | undefined;
    const previousCost = previous ? Number((JSON.parse(previous.data_json) as Record<string, unknown>).costUsd ?? 0) : 0;
    return Math.max(0, cost - (Number.isFinite(previousCost) ? previousCost : 0));
  }
}

export function defaultAsterDbPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.AUTOPILOT_ASTER_DB || join(root, "autopilot", "aster.db");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const MAX_TITLE_CHARS = 200;
const MAX_ERROR_CHARS = 500;
const MAX_APPROVAL_SUMMARY_CHARS = 300;

/** The first line of a user message, trimmed: what a sidebar row shows. */
export function conversationTitle(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim().slice(0, MAX_TITLE_CHARS);
}

/** A failed turn's reason, falling back to its code, bounded for a list response. */
function failureText(data: Record<string, unknown>): string {
  const reason = typeof data.reason === "string" ? data.reason.trim() : "";
  const code = typeof data.code === "string" ? data.code.trim() : "";
  return (reason || code || "failed").slice(0, MAX_ERROR_CHARS);
}

/** The approval's explanation, collapsed to one bounded line. */
function approvalSummary(explanation: string): string {
  return explanation.replace(/\s+/g, " ").trim().slice(0, MAX_APPROVAL_SUMMARY_CHARS);
}

function newUserCode(): string {
  const chars = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]!);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Accepts codes typed in any case, with or without the dash. */
export function normalizeUserCode(code: string): string {
  const compact = code.toUpperCase().replace(/[^A-Z]/g, "");
  return compact.length === 8 ? `${compact.slice(0, 4)}-${compact.slice(4)}` : compact;
}

function deviceFromRow(row: DeviceRow): AsterDeviceAuthorization {
  return { userCode: row.user_code, clientName: row.client_name, status: row.status, createdAt: row.created_at, expiresAt: row.expires_at };
}

function cellMappingFromRow(row: Record<string, unknown>): AsterCellMapping {
  return {
    conversationId: row.conversation_id as string,
    credentialId: row.credential_id as string,
    workspaceId: row.workspace_id as string,
    model: row.model as string,
    sessionId: row.session_id as string,
    cellName: row.cell_name as string,
    cellId: (row.cell_id as string | null) ?? null,
    status: row.status as AsterCellMapping["status"],
    createAttempted: row.create_attempted === 1,
    eventCursor: row.event_cursor as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
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
    kind: row.kind,
    repository: row.repository,
    baseBranch: row.base_branch,
    pullRequestNumber: row.pull_request_number,
    pullRequestURL: row.pull_request_url,
    status: row.status,
    activeRunId: row.active_run_id,
    title: row.title ?? null,
    costUsd: row.cost_usd ?? 0,
    lastError: row.last_error ?? null,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
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
