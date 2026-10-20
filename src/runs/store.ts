import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunWorktree } from "./worktrees.js";

export type RunStatus = "queued" | "running" | "waiting" | "needs_input" | "completed" | "failed" | "cancelled" | "interrupted_unknown";
export type RunEventType = "state" | "tool_intent" | "tool_result" | "usage" | "checkpoint";
export type TimerCondition = "time" | "job" | "approval";
export type TimerStatus = "scheduled" | "claimed" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  sessionId: string | null;
  cwd: string;
  sourceCwd: string | null;
  repositoryRoot: string | null;
  worktreePath: string | null;
  branch: string | null;
  task: string;
  status: RunStatus;
  stopReason: string | null;
  allowedTools: string[];
  maxToolIterations: number | null;
  maxRuntimeMs: number | null;
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
  costUnknownResponses: number;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export class RunToolBudgetExceededError extends Error {
  readonly reason = "max_tool_iterations_exceeded";
  constructor() {
    super("max_tool_iterations_exceeded");
    this.name = "RunToolBudgetExceededError";
  }
}

export interface RunBudgetUpdate {
  maxToolIterations?: number | null;
  maxRuntimeMs?: number | null;
  maxTotalTokens?: number | null;
  maxCostUsd?: number | null;
}

export interface RunEvent {
  sequence: number;
  runId: string;
  type: RunEventType;
  toolCallId: string | null;
  toolName: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface RunTimer {
  id: string;
  runId: string;
  condition: TimerCondition;
  jobId: string | null;
  wakeAt: number;
  intervalMs: number;
  status: TimerStatus;
  attempts: number;
  maxAttempts: number;
  leaseUntil: number | null;
  lastError: string | null;
  createdAt: number;
}

interface RunRow extends Record<string, unknown> {
  id: string;
  session_id: string | null;
  cwd: string;
  source_cwd: string | null;
  repository_root: string | null;
  worktree_path: string | null;
  branch: string | null;
  task: string;
  status: RunStatus;
  stop_reason: string | null;
  allowed_tools_json: string;
  max_tool_iterations: number;
  max_runtime_ms: number;
  max_total_tokens: number;
  max_cost_usd: number | null;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cost_usd: number;
  cost_unknown_responses: number;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface TimerRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  condition_type: TimerCondition;
  job_id: string | null;
  wake_at: number;
  interval_ms: number;
  status: TimerStatus;
  attempts: number;
  max_attempts: number;
  lease_until: number | null;
  last_error: string | null;
  created_at: number;
}

const ALLOWED_TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["queued", "waiting", "needs_input", "completed", "failed", "cancelled", "interrupted_unknown"]),
  waiting: new Set(["running", "needs_input", "failed", "cancelled"]),
  needs_input: new Set(["queued", "running", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  interrupted_unknown: new Set(),
};

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/**
 * SQLite persistence for unattended runs, tool-boundary checkpoints, and
 * durable wake timers. Constructing a store only opens/migrates the schema;
 * call reconcileInterruptedRuns explicitly once at supervisor startup.
 */
/** Run states the operator is told about. */
export const NOTIFIABLE_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "needs_input", "cancelled", "interrupted_unknown"]);

/**
 * pending → sending → sent. A rejected send is `retry` (transient) or
 * `failed`; a send whose outcome is unknown (timeout after submission) is
 * `uncertain` and retried only with the same idempotency key. `skipped`:
 * notifications aren't configured.
 */
export type NotificationStatus = "pending" | "sending" | "sent" | "retry" | "uncertain" | "failed" | "skipped";

export interface RunNotification {
  id: string;
  runId: string;
  kind: RunStatus;
  reason: string | null;
  status: NotificationStatus;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: number;
}

interface RunNotificationRow {
  id: string;
  run_id: string;
  kind: string;
  reason: string | null;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  created_at: number;
}

function toNotification(r: RunNotificationRow): RunNotification {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as RunStatus,
    reason: r.reason,
    status: r.status as NotificationStatus,
    attempts: r.attempts,
    providerMessageId: r.provider_message_id,
    lastError: r.last_error,
    createdAt: r.created_at,
  };
}

export class RunStore {
  private readonly db: Database.Database;

  constructor(dbPath = defaultRunsDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    // Legacy budget columns are NOT NULL; -1 represents an unlimited (null) policy.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        cwd TEXT NOT NULL,
        source_cwd TEXT,
        repository_root TEXT,
        worktree_path TEXT,
        branch TEXT,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        stop_reason TEXT,
        allowed_tools_json TEXT NOT NULL DEFAULT '[]',
        max_tool_iterations INTEGER NOT NULL DEFAULT -1,
        max_runtime_ms INTEGER NOT NULL DEFAULT -1,
        max_total_tokens INTEGER NOT NULL DEFAULT -1,
        max_cost_usd REAL DEFAULT NULL,
        total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
        total_completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        cost_unknown_responses INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status_updated ON runs(status, updated_at);
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name TEXT,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(run_id, tool_call_id, event_type)
      );
      CREATE INDEX IF NOT EXISTS idx_run_events_run_sequence ON run_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS run_timers (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        condition_type TEXT NOT NULL,
        job_id TEXT,
        wake_at INTEGER NOT NULL,
        interval_ms INTEGER NOT NULL DEFAULT 10000,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_until INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_timers_due ON run_timers(status, wake_at);
      CREATE INDEX IF NOT EXISTS idx_run_timers_run ON run_timers(run_id, status);
      CREATE TABLE IF NOT EXISTS run_notifications (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        reason TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        provider_message_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_run_notifications_status ON run_notifications(status, created_at);
    `);
    const timerColumns = this.db.prepare("PRAGMA table_info(run_timers)").all() as Array<{ name: string }>;
    if (!timerColumns.some((column) => column.name === "interval_ms")) {
      this.db.exec("ALTER TABLE run_timers ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 10000");
    }
    const runColumns = this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    const runColumnNames = new Set(runColumns.map((column) => column.name));
    if (!runColumnNames.has("allowed_tools_json")) this.db.exec("ALTER TABLE runs ADD COLUMN allowed_tools_json TEXT NOT NULL DEFAULT '[]'");
    if (!runColumnNames.has("max_tool_iterations")) this.db.exec("ALTER TABLE runs ADD COLUMN max_tool_iterations INTEGER NOT NULL DEFAULT -1");
    if (!runColumnNames.has("max_runtime_ms")) this.db.exec("ALTER TABLE runs ADD COLUMN max_runtime_ms INTEGER NOT NULL DEFAULT -1");
    if (!runColumnNames.has("source_cwd")) this.db.exec("ALTER TABLE runs ADD COLUMN source_cwd TEXT");
    if (!runColumnNames.has("repository_root")) this.db.exec("ALTER TABLE runs ADD COLUMN repository_root TEXT");
    if (!runColumnNames.has("worktree_path")) this.db.exec("ALTER TABLE runs ADD COLUMN worktree_path TEXT");
    if (!runColumnNames.has("branch")) this.db.exec("ALTER TABLE runs ADD COLUMN branch TEXT");
    if (!runColumnNames.has("max_total_tokens")) this.db.exec("ALTER TABLE runs ADD COLUMN max_total_tokens INTEGER NOT NULL DEFAULT -1");
    if (!runColumnNames.has("max_cost_usd")) this.db.exec("ALTER TABLE runs ADD COLUMN max_cost_usd REAL DEFAULT NULL");
    if (!runColumnNames.has("total_prompt_tokens")) this.db.exec("ALTER TABLE runs ADD COLUMN total_prompt_tokens INTEGER NOT NULL DEFAULT 0");
    if (!runColumnNames.has("total_completion_tokens")) this.db.exec("ALTER TABLE runs ADD COLUMN total_completion_tokens INTEGER NOT NULL DEFAULT 0");
    if (!runColumnNames.has("total_cost_usd")) this.db.exec("ALTER TABLE runs ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0");
    if (!runColumnNames.has("cost_unknown_responses")) this.db.exec("ALTER TABLE runs ADD COLUMN cost_unknown_responses INTEGER NOT NULL DEFAULT 0");
    try { chmodSync(dbPath, 0o600); } catch { /* existing/read-only database permissions are managed by the caller */ }
  }

  close(): void {
    this.db.close();
  }

  createRun(input: {
    id?: string;
    task: string;
    cwd: string;
    sessionId?: string;
    worktree?: RunWorktree;
    allowedTools?: string[];
    maxToolIterations?: number | null;
    maxRuntimeMs?: number | null;
    maxTotalTokens?: number | null;
    maxCostUsd?: number | null;
  }): RunRecord {
    const task = input.task.trim();
    if (!task) throw new Error("task must not be empty");
    if (!input.cwd) throw new Error("cwd must not be empty");
    const allowedTools = [...new Set(input.allowedTools ?? [])];
    if (allowedTools.some((name) => typeof name !== "string" || !name.trim())) {
      throw new Error("allowedTools must contain non-empty tool names");
    }
    const maxToolIterations = input.maxToolIterations ?? null;
    validateOptionalPositiveInteger("maxToolIterations", maxToolIterations);
    const maxRuntimeMs = input.maxRuntimeMs ?? null;
    validateOptionalPositiveInteger("maxRuntimeMs", maxRuntimeMs, 1000);
    const maxTotalTokens = input.maxTotalTokens ?? null;
    validateOptionalPositiveInteger("maxTotalTokens", maxTotalTokens);
    const maxCostUsd = input.maxCostUsd ?? null;
    if (maxCostUsd !== null && (!Number.isFinite(maxCostUsd) || maxCostUsd < 0.01)) {
      throw new Error("maxCostUsd must be null or a finite number greater than or equal to 0.01");
    }
    const id = input.id ?? input.worktree?.runId ?? randomUUID();
    if (!id.trim()) throw new Error("id must not be empty");
    if (input.worktree && input.worktree.runId !== id) throw new Error("worktree runId must match run id");
    const now = Date.now();
    const worktree = input.worktree;
    const create = this.db.transaction(() => {
      this.db.prepare(`INSERT INTO runs
        (id, session_id, cwd, source_cwd, repository_root, worktree_path, branch, task, status, allowed_tools_json, max_tool_iterations, max_runtime_ms, max_total_tokens, max_cost_usd, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.sessionId ?? null, worktree?.cwd ?? input.cwd, worktree?.sourceCwd ?? null, worktree?.repositoryRoot ?? null, worktree?.worktreePath ?? null, worktree?.branch ?? null, task, JSON.stringify(allowedTools), maxToolIterations ?? -1, maxRuntimeMs ?? -1, maxTotalTokens ?? -1, maxCostUsd, now, now);
      this.appendEvent(id, "state", null, null, { status: "queued" }, now);
    });
    create.immediate();
    return this.getRun(id)!;
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(options: { status?: RunStatus; limit?: number } = {}): RunRecord[] {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 50)));
    const rows = options.status
      ? this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY updated_at DESC LIMIT ?").all(options.status, limit) as RunRow[]
      : this.db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map(rowToRun);
  }

  transition(id: string, status: RunStatus, reason?: string): RunRecord {
    const update = this.db.transaction(() => {
      const current = this.getRun(id);
      if (!current) throw new Error(`Run not found: ${id}`);
      if (current.status !== status && !ALLOWED_TRANSITIONS[current.status].has(status)) {
        throw new Error(`Invalid run transition: ${current.status} -> ${status}`);
      }
      const now = Date.now();
      const startedAt = status === "running" ? current.startedAt ?? now : current.startedAt;
      const finishedAt = ["completed", "failed", "cancelled", "interrupted_unknown"].includes(status) ? now : null;
      this.db.prepare(`UPDATE runs SET status = ?, stop_reason = ?, updated_at = ?, started_at = ?, finished_at = ? WHERE id = ?`)
        .run(status, reason ?? null, now, startedAt, finishedAt, id);
      this.appendEvent(id, "state", null, null, { status, reason: reason ?? null }, now);
      return this.getRun(id)!;
    });
    return update.immediate();
  }

  /**
   * Resume a paused run and atomically apply any revised limits. A budget
   * pause needs a revised budget; `opts.change` names another fix (e.g. a
   * larger-context model) when the limits stay as they are.
   */
  resumeWithBudgets(id: string, budgets: RunBudgetUpdate, opts: { change?: string } = {}): RunRecord {
    if (!opts.change && Object.values(budgets).every((value) => value === undefined)) {
      throw new Error("At least one run budget must be updated to resume");
    }
    if (budgets.maxToolIterations !== undefined) validateOptionalPositiveInteger("maxToolIterations", budgets.maxToolIterations);
    if (budgets.maxRuntimeMs !== undefined) validateOptionalPositiveInteger("maxRuntimeMs", budgets.maxRuntimeMs, 1000);
    if (budgets.maxTotalTokens !== undefined) validateOptionalPositiveInteger("maxTotalTokens", budgets.maxTotalTokens);
    if (budgets.maxCostUsd !== undefined && budgets.maxCostUsd !== null && (!Number.isFinite(budgets.maxCostUsd) || budgets.maxCostUsd < 0.01)) {
      throw new Error("maxCostUsd must be null or a finite number greater than or equal to 0.01");
    }

    const resume = this.db.transaction(() => {
      const current = this.getRun(id);
      if (!current) throw new Error("Run not found: " + id);
      if (current.status !== "needs_input") throw new Error("Run " + id + " is not waiting for input (status: " + current.status + ")");
      const maxToolIterations = budgets.maxToolIterations === undefined ? current.maxToolIterations : budgets.maxToolIterations;
      const maxRuntimeMs = budgets.maxRuntimeMs === undefined ? current.maxRuntimeMs : budgets.maxRuntimeMs;
      const maxTotalTokens = budgets.maxTotalTokens === undefined ? current.maxTotalTokens : budgets.maxTotalTokens;
      const maxCostUsd = budgets.maxCostUsd === undefined ? current.maxCostUsd : budgets.maxCostUsd;
      const now = Date.now();
      this.db.prepare(`UPDATE runs SET status = 'running', stop_reason = NULL, updated_at = ?, finished_at = NULL,
        max_tool_iterations = ?, max_runtime_ms = ?, max_total_tokens = ?, max_cost_usd = ? WHERE id = ?`)
        .run(now, maxToolIterations ?? -1, maxRuntimeMs ?? -1, maxTotalTokens ?? -1, maxCostUsd, id);
      this.appendEvent(id, "state", null, null, { status: "running", reason: "resumed", budgets: { maxToolIterations, maxRuntimeMs, maxTotalTokens, maxCostUsd }, ...(opts.change ? { change: opts.change } : {}) }, now);
      return this.getRun(id)!;
    });
    return resume.immediate();
  }

  /** Persist a tool intent before execution. Only hashes are retained, never raw arguments. */
  recordToolIntent(runId: string, toolCallId: string, toolName: string, args: unknown): void {
    const record = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Run not found: ${runId}`);
      if (run.status !== "running") throw new Error(`Run ${runId} is not running (status: ${run.status})`);
      if (run.maxToolIterations !== null && this.countToolIterations(runId) >= run.maxToolIterations) {
        const now = Date.now();
        this.db.prepare("UPDATE runs SET status = 'needs_input', stop_reason = 'max_tool_iterations_exceeded', updated_at = ?, finished_at = NULL WHERE id = ?").run(now, runId);
        this.appendEvent(runId, "state", null, null, { status: "needs_input", reason: "max_tool_iterations_exceeded" }, now);
        return false;
      }
      this.appendEvent(runId, "tool_intent", toolCallId, toolName, { argumentSha256: sha256(stableJson(args)) });
      return true;
    });
    if (!record.immediate()) throw new RunToolBudgetExceededError();
  }

  /** Persist completion metadata after execution without storing tool output text. */
  recordToolResult(
    runId: string,
    toolCallId: string,
    toolName: string,
    result: { ok: boolean; content: string; errorCode?: string },
  ): void {
    this.assertRunActive(runId);
    this.appendEvent(runId, "tool_result", toolCallId, toolName, {
      ok: result.ok,
      outputSha256: sha256(result.content),
      outputBytes: Buffer.byteLength(result.content, "utf8"),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    });
  }

  /** Mark that the current run session was durably saved after its last tool results. */
  recordCheckpoint(runId: string): void {
    const run = this.getRun(runId);
    if (!run || (run.status !== "running" && run.status !== "needs_input")) {
      throw new Error("Run " + runId + " is not active at a checkpoint");
    }
    this.appendEvent(runId, "checkpoint", null, null, {});
  }

  listEvents(runId: string): RunEvent[] {
    const rows = this.db.prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      sequence: row.sequence as number,
      runId: row.run_id as string,
      type: row.event_type as RunEventType,
      toolCallId: (row.tool_call_id as string | null) ?? null,
      toolName: (row.tool_name as string | null) ?? null,
      metadata: JSON.parse(row.metadata_json as string) as Record<string, unknown>,
      createdAt: row.created_at as number,
    }));
  }

  countToolIterations(runId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ? AND event_type = 'tool_intent'")
      .get(runId) as { count: number };
    return row.count;
  }

  recordUsage(runId: string, usage: { promptTokens: number; completionTokens: number; costUsd?: number }): {
    run: RunRecord;
    budgetExceededReason: string | null;
  } {
    for (const [name, value] of [["promptTokens", usage.promptTokens], ["completionTokens", usage.completionTokens]] as const) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    }
    if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
      throw new Error("costUsd must be a non-negative finite number");
    }

    const record = this.db.transaction(() => {
      const current = this.getRun(runId);
      if (!current) throw new Error(`Run not found: ${runId}`);
      if (current.status !== "running") throw new Error(`Run ${runId} is not running (status: ${current.status})`);
      const now = Date.now();
      const totalPromptTokens = current.totalPromptTokens + usage.promptTokens;
      const totalCompletionTokens = current.totalCompletionTokens + usage.completionTokens;
      const totalCostUsd = current.totalCostUsd + (usage.costUsd ?? 0);
      const costUnknownResponses = current.costUnknownResponses + (usage.costUsd === undefined ? 1 : 0);
      this.db.prepare(`UPDATE runs SET total_prompt_tokens = ?, total_completion_tokens = ?, total_cost_usd = ?,
        cost_unknown_responses = ?, updated_at = ? WHERE id = ?`)
        .run(totalPromptTokens, totalCompletionTokens, totalCostUsd, costUnknownResponses, now, runId);

      const totalTokens = totalPromptTokens + totalCompletionTokens;
      const budgetExceededReason = current.maxTotalTokens !== null && totalTokens >= current.maxTotalTokens
        ? "max_total_tokens_exceeded"
        : current.maxCostUsd !== null && usage.costUsd === undefined
          ? "cost_unavailable"
          : current.maxCostUsd !== null && totalCostUsd >= current.maxCostUsd
            ? "max_cost_usd_exceeded"
            : null;
      this.appendEvent(runId, "usage", null, null, {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        costUsd: usage.costUsd ?? null,
        totalPromptTokens,
        totalCompletionTokens,
        totalCostUsd,
        costUnknownResponses,
      }, now);

      if (budgetExceededReason) {
        this.db.prepare("UPDATE runs SET status = 'needs_input', stop_reason = ?, updated_at = ?, finished_at = NULL WHERE id = ?")
          .run(budgetExceededReason, now, runId);
        this.appendEvent(runId, "state", null, null, { status: "needs_input", reason: budgetExceededReason }, now);
      }
      return { run: this.getRun(runId)!, budgetExceededReason };
    });
    return record.immediate();
  }

  /**
   * On daemon startup, requeue runs with a saved checkpoint and no unmatched
   * tool intent. Ambiguous tool actions remain interrupted and are never replayed.
   */
  reconcileInterruptedRuns(now = Date.now()): RunRecord[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status = 'running'").all() as RunRow[];
    const reconcile = this.db.transaction((running: RunRow[]) => {
      const interrupted: RunRecord[] = [];
      for (const row of running) {
        const pending = this.db.prepare(`SELECT i.tool_call_id, i.tool_name FROM run_events i
          LEFT JOIN run_events r ON r.run_id = i.run_id AND r.tool_call_id = i.tool_call_id AND r.event_type = 'tool_result'
          WHERE i.run_id = ? AND i.event_type = 'tool_intent' AND r.sequence IS NULL
          ORDER BY i.sequence LIMIT 1`).get(row.id) as { tool_call_id: string; tool_name: string } | undefined;
        const checkpoint = this.db.prepare("SELECT MAX(sequence) AS sequence FROM run_events WHERE run_id = ? AND event_type = 'checkpoint'").get(row.id) as { sequence: number | null };
        const uncheckpointed = this.db.prepare("SELECT tool_call_id, tool_name FROM run_events WHERE run_id = ? AND event_type = 'tool_intent' AND sequence > ? ORDER BY sequence LIMIT 1")
          .get(row.id, checkpoint.sequence ?? 0) as { tool_call_id: string; tool_name: string } | undefined;
        const activeTimer = this.db.prepare("SELECT id FROM run_timers WHERE run_id = ? AND status IN ('scheduled', 'claimed') AND condition_type IN ('time', 'job') LIMIT 1").get(row.id);
        const uncertain = pending ?? uncheckpointed;
        const status = uncertain ? "interrupted_unknown" : activeTimer ? "waiting" : "queued";
        const reason = pending
          ? `ambiguous_tool:${pending.tool_name}:${pending.tool_call_id}`
          : uncheckpointed
            ? `tool_result_not_checkpointed:${uncheckpointed.tool_name}:${uncheckpointed.tool_call_id}`
            : activeTimer ? "process_restart_wait_recovered" : "process_restart_recovered";
        this.db.prepare("UPDATE runs SET status = ?, stop_reason = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'")
          .run(status, reason, now, uncertain ? now : null, row.id);
        this.appendEvent(row.id, "state", null, null, { status, reason }, now);
        const updated = this.getRun(row.id);
        if (updated) interrupted.push(updated);
      }
      return interrupted;
    });
    return reconcile.immediate(rows);
  }

  scheduleTimer(input: {
    runId: string;
    condition: TimerCondition;
    wakeAt: number;
    intervalMs?: number;
    jobId?: string;
    maxAttempts?: number;
  }): RunTimer {
    if (!Number.isFinite(input.wakeAt)) throw new Error("wakeAt must be a finite timestamp");
    if (input.condition === "job" && !input.jobId) throw new Error("job timers require jobId");
    const maxAttempts = input.maxAttempts ?? 5;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
      throw new Error("maxAttempts must be an integer from 1 through 100");
    }
    const intervalMs = input.intervalMs ?? 10_000;
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 7 * 24 * 60 * 60 * 1000) {
      throw new Error("intervalMs must be an integer from 1000 through 604800000");
    }
    this.assertRunExists(input.runId);
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`INSERT INTO run_timers
      (id, run_id, condition_type, job_id, wake_at, interval_ms, status, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`)
      .run(id, input.runId, input.condition, input.jobId ?? null, Math.trunc(input.wakeAt), intervalMs, maxAttempts, now);
    return this.getTimer(id)!;
  }

  getTimer(id: string): RunTimer | undefined {
    const row = this.db.prepare("SELECT * FROM run_timers WHERE id = ?").get(id) as TimerRow | undefined;
    return row ? rowToTimer(row) : undefined;
  }

  nextTimerAt(): number | null {
    const row = this.db.prepare(`SELECT MIN(CASE WHEN status = 'scheduled' THEN wake_at ELSE lease_until END) AS next_at
      FROM run_timers WHERE status IN ('scheduled', 'claimed') AND condition_type IN ('time', 'job')`).get() as { next_at: number | null };
    return row.next_at;
  }

  listFailedTimers(limit = 100): RunTimer[] {
    const rows = this.db.prepare(`SELECT t.* FROM run_timers t
      JOIN runs r ON r.id = t.run_id
      WHERE t.status = 'failed' AND r.status = 'waiting'
      ORDER BY t.wake_at LIMIT ?`)
      .all(Math.max(1, Math.min(500, Math.trunc(limit)))) as TimerRow[];
    return rows.map(rowToTimer);
  }

  /** Reschedule a successful job-status check without consuming failure retries. */
  rescheduleTimer(id: string, wakeAt: number): RunTimer {
    const transaction = this.db.transaction(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      if (timer.status !== "claimed" || timer.condition !== "job") {
        throw new Error(`Timer ${id} is not a claimed job timer`);
      }
      this.db.prepare(`UPDATE run_timers SET status = 'scheduled', wake_at = ?, attempts = 0,
        lease_until = NULL, last_error = NULL WHERE id = ?`).run(Math.trunc(wakeAt), id);
      return this.getTimer(id)!;
    });
    return transaction.immediate();
  }

  /** Atomically lease timers due now; expired claims are safely retried. */
  claimDueTimers(now = Date.now(), limit = 50, leaseMs = DEFAULT_LEASE_MS): RunTimer[] {
    const cappedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const claim = this.db.transaction(() => {
      this.db.prepare(`UPDATE run_timers SET status = 'failed', lease_until = NULL,
        last_error = COALESCE(last_error, 'lease expired after maximum attempts')
        WHERE status = 'claimed' AND lease_until <= ? AND attempts >= max_attempts`).run(now);
      const rows = this.db.prepare(`SELECT * FROM run_timers
        WHERE ((status = 'scheduled' AND wake_at <= ?)
           OR (status = 'claimed' AND lease_until <= ?))
          AND condition_type IN ('time', 'job')
          AND attempts < max_attempts
        ORDER BY wake_at LIMIT ?`).all(now, now, cappedLimit) as TimerRow[];
      const update = this.db.prepare(`UPDATE run_timers SET status = 'claimed', attempts = attempts + 1, lease_until = ?
        WHERE id = ? AND attempts < max_attempts
          AND ((status = 'scheduled' AND wake_at <= ?) OR (status = 'claimed' AND lease_until <= ?))`);
      const claimed: RunTimer[] = [];
      for (const row of rows) {
        const result = update.run(now + leaseMs, row.id, now, now);
        if (result.changes === 1) {
          const updated = this.getTimer(row.id);
          if (updated) claimed.push(updated);
        }
      }
      return claimed;
    });
    return claim.immediate();
  }

  completeTimer(id: string): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status !== "claimed") throw new Error(`Timer ${id} is not claimed`);
      this.db.prepare("UPDATE run_timers SET status = 'completed', lease_until = NULL, last_error = NULL WHERE id = ?").run(id);
    });
  }

  retryTimer(id: string, error: string, now = Date.now()): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status !== "claimed") throw new Error(`Timer ${id} is not claimed`);
      if (timer.attempts >= timer.maxAttempts) {
        this.db.prepare("UPDATE run_timers SET status = 'failed', lease_until = NULL, last_error = ? WHERE id = ?").run(error.slice(0, 1000), id);
      } else {
        const delay = Math.min(MAX_RETRY_MS, DEFAULT_RETRY_MS * 2 ** Math.max(0, timer.attempts - 1));
        this.db.prepare("UPDATE run_timers SET status = 'scheduled', wake_at = ?, lease_until = NULL, last_error = ? WHERE id = ?")
          .run(now + delay, error.slice(0, 1000), id);
      }
    });
  }

  cancelTimersForRun(runId: string): number {
    this.assertRunExists(runId);
    const result = this.db.prepare("UPDATE run_timers SET status = 'cancelled', lease_until = NULL WHERE run_id = ? AND status IN ('scheduled', 'claimed')")
      .run(runId);
    return result.changes;
  }

  cancelTimer(id: string): RunTimer {
    return this.updateTimer(id, (timer) => {
      if (timer.status === "completed" || timer.status === "failed") return;
      this.db.prepare("UPDATE run_timers SET status = 'cancelled', lease_until = NULL WHERE id = ?").run(id);
    });
  }

  private updateTimer(id: string, update: (timer: RunTimer) => void): RunTimer {
    const transaction = this.db.transaction(() => {
      const timer = this.getTimer(id);
      if (!timer) throw new Error(`Timer not found: ${id}`);
      update(timer);
      return this.getTimer(id)!;
    });
    return transaction.immediate();
  }

  private appendEvent(runId: string, type: RunEventType, toolCallId: string | null, toolName: string | null, metadata: Record<string, unknown>, createdAt = Date.now()): void {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO run_events
      (run_id, event_type, tool_call_id, tool_name, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(runId, type, toolCallId, toolName, JSON.stringify(metadata), createdAt);
    // Notification intent is persisted with the state change itself (same
    // transaction), before anything is sent: a provider outage can't block
    // the run, and a restart can't lose or duplicate the notification.
    const status = type === "state" ? metadata.status : undefined;
    if (inserted.changes > 0 && typeof status === "string" && NOTIFIABLE_STATUSES.has(status as RunStatus)) {
      this.db.prepare(`INSERT INTO run_notifications (id, run_id, kind, reason, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`)
        .run(`ntf_${randomUUID()}`, runId, status, typeof metadata.reason === "string" ? metadata.reason : null, createdAt, createdAt);
    }
  }

  /** Notifications waiting to be sent (pending, or retryable after a failed attempt), oldest first. */
  pendingNotifications(limit = 20): RunNotification[] {
    return (this.db.prepare(`SELECT * FROM run_notifications WHERE status IN ('pending', 'retry', 'uncertain') ORDER BY created_at LIMIT ?`).all(limit) as RunNotificationRow[]).map(toNotification);
  }

  listNotifications(runId: string): RunNotification[] {
    return (this.db.prepare(`SELECT * FROM run_notifications WHERE run_id = ? ORDER BY created_at`).all(runId) as RunNotificationRow[]).map(toNotification);
  }

  /** Record a delivery attempt's outcome. */
  updateNotification(id: string, update: { status: NotificationStatus; providerMessageId?: string; error?: string; countAttempt?: boolean }): void {
    this.db.prepare(`UPDATE run_notifications SET status = ?, provider_message_id = COALESCE(?, provider_message_id),
      last_error = ?, attempts = attempts + ?, updated_at = ? WHERE id = ?`)
      .run(update.status, update.providerMessageId ?? null, update.error ?? null, update.countAttempt ? 1 : 0, Date.now(), id);
  }

  /** After a crash, a send that was in flight may or may not have been delivered. */
  recoverInFlightNotifications(): number {
    return this.db.prepare(`UPDATE run_notifications SET status = 'uncertain', last_error = 'in flight when the server stopped', updated_at = ? WHERE status = 'sending'`).run(Date.now()).changes;
  }

  private assertRunExists(runId: string): void {
    if (!this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
  }

  private assertRunActive(runId: string): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.status !== "running") throw new Error(`Run ${runId} is not running (status: ${run.status})`);
  }
}

function defaultRunsDbPath(): string {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return process.env.AUTOPILOT_RUNS_DB || join(root, "autopilot", "runs.db");
}

function validateOptionalPositiveInteger(name: string, value: number | null, minimum = 1): void {
  if (value !== null && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new Error(name + " must be null or a safe integer greater than or equal to " + minimum);
  }
}

function stableJson(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowToRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    cwd: row.cwd,
    sourceCwd: row.source_cwd,
    repositoryRoot: row.repository_root,
    worktreePath: row.worktree_path,
    branch: row.branch,
    task: row.task,
    status: row.status,
    stopReason: row.stop_reason,
    allowedTools: JSON.parse(row.allowed_tools_json) as string[],
    maxToolIterations: row.max_tool_iterations < 0 ? null : row.max_tool_iterations,
    maxRuntimeMs: row.max_runtime_ms < 0 ? null : row.max_runtime_ms,
    maxTotalTokens: row.max_total_tokens < 0 ? null : row.max_total_tokens,
    maxCostUsd: row.max_cost_usd,
    totalPromptTokens: row.total_prompt_tokens,
    totalCompletionTokens: row.total_completion_tokens,
    totalCostUsd: row.total_cost_usd,
    costUnknownResponses: row.cost_unknown_responses,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function rowToTimer(row: TimerRow): RunTimer {
  return {
    id: row.id,
    runId: row.run_id,
    condition: row.condition_type,
    jobId: row.job_id,
    wakeAt: row.wake_at,
    intervalMs: row.interval_ms,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}
