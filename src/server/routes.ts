/**
 * HTTP route handlers for the KimiFlare headless server.
 */

import { runStopForError } from "../agent/session-core.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { endSessions } from "../hooks/session-lifecycle.js";
import { HooksManager } from "../hooks/manager.js";
import { SHUTDOWN_TIMEOUT_MS } from "../util/exit.js";
import { listModels } from "../models/registry.js";
import { JobManager } from "../jobs/manager.js";
import { hostname } from "node:os";
import { notificationSettingsFromConfig, startNotificationDispatcher } from "../runs/notifications.js";
import { handleDecisionMail } from "../runs/decisions.js";
import { imapSettingsFromEnv, startDecisionPoller } from "../runs/decisions-imap.js";
import { URL } from "node:url";
import type { KimiConfig } from "../config.js";
import { DEFAULT_MODEL } from "../config.js";
import { assembleTurn, lastUserText, resolveTurnPolicy } from "../agent/session-core.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { classifyNextMessage, createRecorder, emitSessionStart, makeTurnId, type TraceRecorder } from "../trace/index.js";
import { toOpenAIToolDefs } from "../tools/registry.js";
import type { ToolSpec } from "../tools/registry.js";
import { runAgentTurn } from "../agent/loop.js";
import type { AgentCallbacks } from "../agent/loop.js";
import { buildSystemPrompt } from "../agent/system-prompt.js";
import { ToolExecutor, ALL_TOOLS } from "../tools/executor.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";
import type { ChatMessage, ContentPart } from "../agent/messages.js";
import { saveSession, loadSession, listSessions, sessionsDir, type SessionFile } from "../sessions.js";
import { sessionFileCompactionTarget } from "../agent/context-budget.js";
import { logger } from "../util/logger.js";
import { createSseStream, type SseClient } from "./sse.js";
import { getOpenApiSpec } from "./openapi.js";
import { evaluatePermissionRules } from "../permissions-evaluator.js";
import { readFile, unlink } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { isImagePath } from "../util/image.js";
import { buildAttachmentMessage } from "../util/attachments.js";

const imageOptions = (config: KimiConfig) => ({ maxEdge: config.imageMaxEdge, quality: config.imageQuality });
import { glob } from "../util/glob.js";
import { RunStore } from "../runs/store.js";
import { RunWorktreeManager, type RunWorktree } from "../runs/worktrees.js";
import { RunWakeScheduler, type RunWakeEvent } from "../runs/wake-scheduler.js";
import type { RunBudgetUpdate, RunRecord } from "../runs/store.js";
import { AsterApi, type AsterApiRuntime } from "./aster-api.js";
import { AsterHotcellRuntime } from "./aster-cell-runtime.js";
import { HotcellProvider, HotcellProviderError } from "./hotcell-provider.js";
import { redactLikelySecrets } from "./aster-tools.js";

function createHotcellAsterRuntime(): AsterApiRuntime | undefined {
  try {
    const idlePauseMs = Number(process.env.AUTOPILOT_ASTER_IDLE_PAUSE_MS ?? 15 * 60 * 1000);
    return new AsterHotcellRuntime(HotcellProvider.fromEnvironment(), {
      idlePauseMs: Number.isFinite(idlePauseMs) && idlePauseMs >= 0 ? idlePauseMs : 15 * 60 * 1000,
    });
  } catch (error) {
    if (error instanceof HotcellProviderError && error.code === "hotcell_not_configured") return undefined;
    throw error;
  }
}

interface ActiveSession {
  sessionFile: SessionFile;
  messages: ChatMessage[];
  executor: ToolExecutor;
  /** Lifecycle hooks (SessionStart/SessionEnd, Stop) for interactive sessions. */
  hooks?: HooksManager;
  sseClients: Set<SseClient>;
  runId?: string;
  allowedTools?: Set<string>;
  controller?: AbortController;
  running?: boolean;
  shuttingDown?: boolean;
  maxToolIterations?: number | null;
  maxRuntimeMs?: number | null;
  conversationId?: string;
  workspaceRoot?: string;
  askAsterPermission?: (request: PermissionRequest) => Promise<PermissionDecision>;
  publishAsterEvent?: (type: string, data: Record<string, unknown>) => void;
  finishAsterTurn?: (status: "completed" | "failed" | "cancelled", reason?: string) => void;
  /** Session trace (no-op unless `config.trace.enabled`). */
  trace?: TraceRecorder;
  /** Turn id minted with the pending user message, consumed by the next turn. */
  nextTurnId?: string;
  /** Turn id of the last turn that ran, for next-message outcome signals. */
  lastTurnId?: string;
}

/** Create the session trace and record `session_start`; a no-op recorder when tracing is off. */
async function startSessionTrace(
  config: KimiConfig,
  sessionFile: SessionFile,
  tools: ToolSpec[],
  messages: ChatMessage[],
): Promise<TraceRecorder> {
  const trace = createRecorder({
    enabled: config.trace?.enabled === true,
    sessionId: sessionFile.id,
    root: config.trace?.root,
  });
  const systemPrompt = messages
    .filter((m) => m.role === "system" && typeof m.content === "string")
    .map((m) => m.content as string)
    .join("\n\n");
  await emitSessionStart(trace, {
    cwd: sessionFile.cwd,
    model: sessionFile.model,
    mode: "server",
    config,
    tools: toOpenAIToolDefs(tools),
    systemPrompt,
  });
  return trace;
}

function traceUserMessage(trace: TraceRecorder | undefined, text: string, attachments: number, turnId: string): void {
  if (!trace?.enabled) return;
  trace.emit("user_message", { content_blob: trace.blob(text) ?? "", source: "server", attachments }, turnId);
}

const activeSessions = new Map<string, ActiveSession>();
const activeRuns = new Map<string, ActiveSession>();
const MAX_NODE_TIMEOUT_MS = 2_147_000_000;

function parseOptionalBudgetInteger(body: Record<string, unknown>, name: string, minimum = 1): number | null | undefined {
  if (!Object.hasOwn(body, name)) return undefined;
  const value = body[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(name + " must be null or a safe integer greater than or equal to " + minimum);
  }
  return value;
}

function parseRunBudgetUpdate(body: Record<string, unknown>): RunBudgetUpdate {
  const budgets: RunBudgetUpdate = {
    maxToolIterations: parseOptionalBudgetInteger(body, "maxToolIterations"),
    maxRuntimeMs: parseOptionalBudgetInteger(body, "maxRuntimeMs", 1000),
    maxTotalTokens: parseOptionalBudgetInteger(body, "maxTotalTokens"),
  };
  if (Object.hasOwn(body, "maxCostUsd")) {
    const value = body.maxCostUsd;
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0.01)) {
      throw new Error("maxCostUsd must be null or a finite number greater than or equal to 0.01");
    }
    budgets.maxCostUsd = value as number | null;
  }
  return budgets;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, 400, { error: message });
}

function notFound(res: ServerResponse, message: string): void {
  json(res, 404, { error: message });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function resolveFiles(filePatterns: string[], cwd: string): Promise<string[]> {
  const resolved = new Set<string>();
  for (const pattern of filePatterns) {
    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(resolve(cwd, pattern)));
      if (stat.isFile()) {
        resolved.add(resolve(cwd, pattern));
        continue;
      }
    } catch {
      // Not a literal file, try glob
    }
    const matches = await glob(pattern, { cwd, absolute: true });
    for (const m of matches) {
      resolved.add(m);
    }
  }
  return [...resolved];
}

/** Default cap on runs doing work at once (AUTOPILOT_MAX_CONCURRENT_RUNS / maxConcurrentRuns). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** Why a run can't start or resume right now: the kill switch is on, or too many runs are active. */
function runAdmissionRefusal(config: KimiConfig): { status: number; error: string } | null {
  const store = new RunStore();
  try {
    const halted = store.haltState();
    if (halted) {
      return { status: 503, error: `Runs are halted by the operator (${halted.reason}). Lift it with DELETE /runs/stop-all.` };
    }
    const envLimit = Number(process.env.AUTOPILOT_MAX_CONCURRENT_RUNS);
    const limit = Number.isInteger(envLimit) && envLimit > 0 ? envLimit : config.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    const active = store.countActiveRuns();
    if (active >= limit) {
      return { status: 429, error: `${active} runs are already active (limit ${limit}, AUTOPILOT_MAX_CONCURRENT_RUNS). Wait for one to finish or cancel one.` };
    }
    return null;
  } finally {
    store.close();
  }
}

export function setupRoutes(config: KimiConfig, options: { asterRuntime?: AsterApiRuntime } = {}) {
  /**
   * Resume a run paused for input: optionally switch model, revise budgets
   * and pass the operator's answer, then start the next turn. Shared by the
   * HTTP resume endpoint and emailed decisions.
   */
  async function resumePausedRun(
    store: RunStore,
    run: RunRecord,
    opts: { budgets: RunBudgetUpdate; model?: string; answer?: string; via?: string },
  ): Promise<{ ok: true; run: RunRecord } | { ok: false; error: string }> {
    const active = await getOrRestoreActiveRun(run);
    if (active.running) return { ok: false, error: "The previous turn is still stopping; retry resume shortly" };
    if (opts.model) active.sessionFile.model = opts.model;
    const change = opts.model ? `It now runs on ${opts.model}.` : Object.values(opts.budgets).some((v) => v !== undefined) ? "Its budget was updated." : "The operator asked to continue.";
    const answer = opts.answer ? ` The operator answered: "${opts.answer}"` : "";
    active.messages.push({ role: "user", content: "The run was paused because " + (run.stopReason ?? "it needs input") + ". " + change + answer + " Continue the task from the last saved checkpoint." });
    active.sessionFile.messages = active.messages;
    await saveSession(active.sessionFile);
    const changeTag = [opts.model ? `model:${opts.model}` : "", opts.answer ? "answer" : "", opts.via ? `via:${opts.via}` : ""].filter(Boolean).join(",");
    const resumed = store.resumeWithBudgets(run.id, opts.budgets, changeTag ? { change: changeTag } : {});
    store.recordCheckpoint(run.id);
    launchAgentTurnForSession(active, config, false);
    return { ok: true, run: resumed };
  }

  async function getOrRestoreActiveRun(run: RunRecord): Promise<ActiveSession> {
    if (!run.sessionId) throw new Error("Cannot restore run without a session id: " + run.id);
    const existing = activeRuns.get(run.id) ?? activeSessions.get(run.sessionId);
    if (existing) return existing;
    const sessionFile = await loadSession(resolve(sessionsDir(), run.sessionId + ".json"));
    const allowedTools = new Set(run.allowedTools);
    allowedTools.add("wait_for");
    const tools = ALL_TOOLS.filter((tool) => allowedTools.has(tool.name));
    const active: ActiveSession = {
      sessionFile,
      messages: sessionFile.messages,
      executor: new ToolExecutor(tools),
      sseClients: new Set(),
      runId: run.id,
      allowedTools,
      trace: await startSessionTrace(config, sessionFile, tools, sessionFile.messages),
    };
    activeSessions.set(run.sessionId, active);
    activeRuns.set(run.id, active);
    return active;
  }

  async function recoverQueuedRuns(): Promise<void> {
    const store = new RunStore();
    try {
      while (true) {
        const queuedRuns = store.listRuns({ status: "queued", limit: 500 });
        if (queuedRuns.length === 0) break;
        for (const queued of queuedRuns) {
          try {
            const run = store.transition(queued.id, "running", "resumed_from_checkpoint");
            const active = await getOrRestoreActiveRun(run);
            active.messages.push({ role: "user", content: "The server restarted after the last saved checkpoint. Continue from this state without repeating actions already recorded as complete." });
            active.sessionFile.messages = active.messages;
            await saveSession(active.sessionFile);
            store.recordCheckpoint(run.id);
            launchAgentTurnForSession(active, config, false);
          } catch (error) {
            const current = store.getRun(queued.id);
            if (current && (current.status === "running" || current.status === "queued")) {
              store.transition(current.id, "failed", "checkpoint_restore_failed:" + (error instanceof Error ? error.message : String(error)).slice(0, 400));
            }
            logger.error("server: failed to recover queued run", { runId: queued.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } finally {
      store.close();
    }
  }
  const asterRuntime = options.asterRuntime ?? createHotcellAsterRuntime();
  const asterApi = new AsterApi(config, asterRuntime ?? {
    startTurn: (turn) => turn.finish("failed", "hotcell_unavailable"),
    cancelRun: () => {},
  });

  // Email the operator when a run finishes, fails or needs input (#671). Off
  // unless configured (RESEND_API_KEY + a recipient).
  const notificationSettings = notificationSettingsFromConfig(config);
  const stopNotifications = notificationSettings
    ? startNotificationDispatcher(() => new RunStore(), notificationSettings, { host: hostname() })
    : () => {};
  // Email decisions (#671 1.6): replies to "needs input" emails, polled over IMAP.
  const imapSettings = notificationSettings?.decisionsReplyTo ? imapSettingsFromEnv() : null;
  const stopDecisions = imapSettings && notificationSettings
    ? startDecisionPoller(imapSettings, async (mail) => {
        const store = new RunStore();
        try {
          await handleDecisionMail(mail, store, {
            resume: (run, opts) => resumePausedRun(store, run, { ...opts, via: "email" }).then((r) => (r.ok ? { ok: true as const } : r)),
            cancel: (run) => {
              activeRuns.get(run.id)?.controller?.abort();
              store.transition(run.id, "cancelled", "cancelled_by_operator_email");
              store.cancelTimersForRun(run.id);
            },
            modelExists: (id) => listModels().some((m) => m.id === id),
            confirm: async (to, subject, text) => {
              await notificationSettings.transport.send({ to: [to], from: notificationSettings.from, subject, text, idempotencyKey: `confirm_${randomUUID()}` });
            },
          }, { allowedSenders: notificationSettings.to, requireAuthentication: process.env.AUTOPILOT_DECISIONS_REQUIRE_AUTH !== "0" });
        } finally {
          store.close();
        }
      })
    : () => {};

  const wakeScheduler = new RunWakeScheduler({
    onWake: async (event: RunWakeEvent) => {
      const store = new RunStore();
      let run: RunRecord | undefined;
      try { run = store.getRun(event.runId); } finally { store.close(); }
      if (!run || run.status !== "running" || !run.sessionId) {
        throw new Error(`Cannot restore active run ${event.runId}`);
      }
      const active = await getOrRestoreActiveRun(run);
      active.messages.push({
        role: "user",
        content: event.condition === "job"
          ? `The wait condition has been checked. Job ${event.jobId} is ${event.jobStatus ?? "unknown"}. Continue the task.`
          : `The scheduled wait has elapsed at ${new Date().toISOString()}. Continue the task.`,
      });
      active.sessionFile.messages = active.messages;
      await saveSession(active.sessionFile);
      const checkpointStore = new RunStore();
      try { checkpointStore.recordCheckpoint(run.id); } finally { checkpointStore.close(); }
      launchAgentTurnForSession(active, config, false);
    },
    onError: (error, timer) => logger.error("server: run wake failed", { error: error.message, timerId: timer?.id }),
  });
  wakeScheduler.start();
  void recoverQueuedRuns();

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const method = req.method ?? "GET";
    const pathname = url.pathname;

    if (pathname.startsWith("/api/v1/")) {
      await asterApi.handle(req, res);
      return;
    }

    try {
      // Health check
      if (pathname === "/" && method === "GET") {
        json(res, 200, { status: "ok", version: process.env.npm_package_version ?? "dev" });
        return;
      }

      // OpenAPI docs
      if (pathname === "/doc" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(getOpenApiSpec());
        return;
      }

      // Operator kill switch: cancel every active run and refuse new ones until lifted.
      if (pathname === "/runs/stop-all" && (method === "POST" || method === "DELETE")) {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before managing unattended runs" });
          return;
        }
        const store = new RunStore();
        try {
          if (method === "DELETE") {
            store.unhalt();
            json(res, 200, { halted: false });
            return;
          }
          const body = ((await readBody(req)) ?? {}) as Record<string, unknown>;
          const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 200) : "stopped_by_operator";
          store.halt(reason);
          const cancelled: string[] = [];
          for (const status of ["queued", "running", "waiting", "needs_input"] as const) {
            for (const run of store.listRuns({ status, limit: 10_000 })) {
              activeRuns.get(run.id)?.controller?.abort(new Error(reason));
              store.transition(run.id, "cancelled", reason);
              store.cancelTimersForRun(run.id);
              cancelled.push(run.id);
            }
          }
          const jobsCancelled: string[] = [];
          if (body.jobs === true) {
            const jobs = new JobManager();
            try {
              for (const job of jobs.list({ limit: 10_000 })) {
                if (job.status === "running" || job.status === "starting") {
                  jobs.cancel(job.id);
                  jobsCancelled.push(job.id);
                }
              }
            } finally {
              jobs.close();
            }
          }
          logger.warn("server: operator stopped all runs", { reason, runs: cancelled.length, jobs: jobsCancelled.length });
          json(res, 200, { halted: true, reason, cancelledRuns: cancelled, cancelledJobs: jobsCancelled });
          return;
        } finally {
          store.close();
        }
      }

      // Durable unattended runs are deliberately disabled without server auth.
      const runPathMatch = pathname.match(/^\/runs\/([^/]+)(?:\/(events|cancel|resume))?$/);
      if (pathname === "/runs" && method === "GET") {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before accessing unattended runs" });
          return;
        }
        const store = new RunStore();
        try {
          const limit = Number(url.searchParams.get("limit") ?? 50);
          json(res, 200, { runs: store.listRuns({ limit }) });
        } finally {
          store.close();
        }
        return;
      }
      if (pathname === "/runs" && method === "POST") {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before creating unattended runs" });
          return;
        }
        const refusal = runAdmissionRefusal(config);
        if (refusal) {
          json(res, refusal.status, { error: refusal.error });
          return;
        }
        const parsedBody = await readBody(req);
        if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
          badRequest(res, "request body must be a JSON object");
          return;
        }
        const body = parsedBody as Record<string, unknown>;
        const task = typeof body.task === "string" ? body.task.trim() : "";
        let cwd: string;
        try {
          cwd = typeof body.cwd === "string" ? resolve(body.cwd) : process.cwd();
        } catch {
          badRequest(res, "cwd must be a valid path");
          return;
        }
        const model = typeof body.model === "string" ? body.model : (config.model ?? DEFAULT_MODEL);
        if (!model.trim() || model.length > 200) {
          badRequest(res, "model must be a non-empty string of at most 200 characters");
          return;
        }
        if (body.allowedTools !== undefined && (!Array.isArray(body.allowedTools) || body.allowedTools.some((name) => typeof name !== "string"))) {
          badRequest(res, "allowedTools must be an array of tool names");
          return;
        }
        const allowedTools = Array.isArray(body.allowedTools)
          ? [...new Set(body.allowedTools as string[])]
          : [];
        if (body.worktree !== undefined && typeof body.worktree !== "boolean") {
          badRequest(res, "worktree must be a boolean");
          return;
        }
        const useWorktree = body.worktree !== false;
        if (body.cwd !== undefined && typeof body.cwd !== "string") {
          badRequest(res, "cwd must be a string");
          return;
        }
        if (useWorktree && typeof body.cwd !== "string") {
          badRequest(res, "cwd is required when worktree is enabled; provide a path in a Git repository or set worktree to false");
          return;
        }
        let budgets: RunBudgetUpdate;
        try {
          budgets = parseRunBudgetUpdate(body);
        } catch (error) {
          badRequest(res, error instanceof Error ? error.message : String(error));
          return;
        }
        const maxToolIterations = budgets.maxToolIterations ?? null;
        const maxRuntimeMs = budgets.maxRuntimeMs ?? null;
        const maxTotalTokens = budgets.maxTotalTokens ?? null;
        const maxCostUsd = budgets.maxCostUsd ?? null;
        if (!task || task.length > 20_000) {
          badRequest(res, "task is required and must be at most 20000 characters");
          return;
        }
        if (allowedTools.some((name) => name !== "wait_for" && !ALL_TOOLS.some((tool) => tool.name === name))) {
          badRequest(res, "allowedTools contains an unknown tool");
          return;
        }
        let cwdStat;
        try {
          cwdStat = await import("node:fs/promises").then((m) => m.stat(cwd));
        } catch {
          badRequest(res, "cwd must be an existing directory");
          return;
        }
        if (!cwdStat.isDirectory()) {
          badRequest(res, "cwd must be an existing directory");
          return;
        }
        const toolNames = new Set(allowedTools);
        toolNames.add("wait_for");
        const tools = ALL_TOOLS.filter((tool) => toolNames.has(tool.name));
        const executor = new ToolExecutor(tools);
        const { makeSessionId } = await import("../sessions.js");
        const sessionId = makeSessionId(task);
        const runId = randomUUID();
        const worktreeManager = new RunWorktreeManager();
        let worktree: RunWorktree | undefined;
        if (useWorktree) {
          try {
            worktree = await worktreeManager.create(runId, cwd);
          } catch (error) {
            badRequest(res, error instanceof Error ? error.message : "Unable to create run worktree");
            return;
          }
        }
        const runCwd = worktree?.cwd ?? cwd;
        const sessionFile: SessionFile = {
          id: sessionId,
          cwd: runCwd,
          model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          title: task.slice(0, 80),
        };
        const messages: ChatMessage[] = [
          { role: "system", content: buildSystemPrompt({ cwd: runCwd, tools, model, preferPullRequests: config.preferPullRequests }) },
          { role: "system", content: `This is an unattended run. Only these tools are authorized: ${[...allowedTools, "wait_for"].join(", ")}. Do not request or attempt any other tool.` },
          { role: "user", content: task },
        ];
        sessionFile.messages = messages;
        let run: RunRecord;
        try {
          await saveSession(sessionFile);
          const store = new RunStore();
          try {
            run = store.createRun({
              id: runId,
              task,
              cwd: runCwd,
              sessionId,
              worktree,
              allowedTools,
              maxToolIterations: maxToolIterations as number,
              maxRuntimeMs: maxRuntimeMs as number,
              maxTotalTokens: maxTotalTokens as number,
              maxCostUsd,
            });
            store.transition(run.id, "running");
          } finally {
            store.close();
          }
        } catch (error) {
          await unlink(resolve(sessionsDir(), `${sessionId}.json`)).catch(() => {});
          if (worktree) {
            await worktreeManager.discard(worktree).catch((cleanupError) => {
              logger.warn("server: failed to clean up uninitialized run worktree", { error: String(cleanupError), runId });
            });
          }
          throw error;
        }
        const runTrace = await startSessionTrace(config, sessionFile, tools, messages);
        traceUserMessage(runTrace, task, 0, makeTurnId());
        const active: ActiveSession = {
          trace: runTrace,
          sessionFile,
          messages,
          executor,
          sseClients: new Set(),
          runId: run.id,
          allowedTools: toolNames,
        };
        activeSessions.set(sessionId, active);
        activeRuns.set(run.id, active);
        launchAgentTurnForSession(active, config, false);
        json(res, 202, {
          runId: run.id,
          sessionId,
          status: "running",
          ...(run.branch ? { branch: run.branch, worktreePath: run.worktreePath } : {}),
        });
        return;
      }
      if (runPathMatch) {
        if (!process.env.KIMIFLARE_SERVER_PASSWORD) {
          json(res, 503, { error: "Set KIMIFLARE_SERVER_PASSWORD before accessing unattended runs" });
          return;
        }
        const runId = runPathMatch[1]!;
        const suffix = runPathMatch[2];
        const store = new RunStore();
        try {
          const run = store.getRun(runId);
          if (!run) {
            notFound(res, `run ${runId} not found`);
            return;
          }
          if (suffix === "events" && method === "GET") {
            json(res, 200, { events: store.listEvents(runId) });
            return;
          }
          if (suffix === "resume" && method === "POST") {
            if (run.status !== "needs_input") {
              json(res, 409, { error: "Only a run paused for input can be resumed", run });
              return;
            }
            const refusal = runAdmissionRefusal(config);
            if (refusal) {
              json(res, refusal.status, { error: refusal.error, run });
              return;
            }
            const parsedBody = await readBody(req);
            if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
              badRequest(res, "request body must be a JSON object containing at least one revised budget");
              return;
            }
            const resumeBody = parsedBody as Record<string, unknown>;
            const allowedResumeKeys = new Set(["maxToolIterations", "maxRuntimeMs", "maxTotalTokens", "maxCostUsd", "model"]);
            const unsupportedKey = Object.keys(resumeBody).find((key) => !allowedResumeKeys.has(key));
            if (unsupportedKey) { badRequest(res, "Unsupported resume field: " + unsupportedKey); return; }
            const { model: requestedModel, ...budgetBody } = resumeBody;
            if (requestedModel !== undefined && (typeof requestedModel !== "string" || !requestedModel.trim())) {
              badRequest(res, "model must be a non-empty model id");
              return;
            }
            let budgets: RunBudgetUpdate;
            try { budgets = parseRunBudgetUpdate(budgetBody); }
            catch (error) { badRequest(res, error instanceof Error ? error.message : String(error)); return; }
            // A context overflow is resolved by a larger-context model; budget pauses by a revised budget.
            if (requestedModel === undefined && Object.values(budgets).every((value) => value === undefined)) {
              badRequest(res, "Provide a revised budget (use null to remove a limit) or a model to continue with");
              return;
            }
            const result = await resumePausedRun(store, run, {
              budgets,
              ...(typeof requestedModel === "string" ? { model: requestedModel.trim() } : {}),
            });
            if (!result.ok) {
              json(res, 409, { error: result.error, run });
              return;
            }
            json(res, 202, { run: result.run });
            return;
          }
          if (suffix === "cancel" && method === "POST") {
            if (run.status === "queued" || run.status === "running" || run.status === "waiting" || run.status === "needs_input") {
              activeRuns.get(runId)?.controller?.abort();
              store.transition(runId, "cancelled", "cancelled_by_client");
              store.cancelTimersForRun(runId);
            }
            json(res, 200, { run: store.getRun(runId) });
            return;
          }
          if (!suffix && method === "GET") {
            json(res, 200, { run });
            return;
          }
        } finally {
          store.close();
        }
      }

      // SSE event stream
      if (pathname === "/event" && method === "GET") {
        const client = createSseStream(res);
        client.send("server.connected", { timestamp: Date.now() });
        // Client is kept alive; cleanup happens on disconnect
        return;
      }

      // List sessions
      if (pathname === "/session" && method === "GET") {
        const cwd = url.searchParams.get("cwd") ?? undefined;
        const sessions = await listSessions(30, cwd);
        json(res, 200, { sessions });
        return;
      }

      // Get session
      const sessionMatch = pathname.match(/^\/session\/([^/]+)$/);
      if (sessionMatch && method === "GET") {
        const sessionId = sessionMatch[1]!;
        const active = activeSessions.get(sessionId);
        if (active) {
          json(res, 200, {
            id: active.sessionFile.id,
            cwd: active.sessionFile.cwd,
            model: active.sessionFile.model,
            messages: active.messages,
            title: active.sessionFile.title,
            updatedAt: active.sessionFile.updatedAt,
          });
          return;
        }
        try {
          const file = await loadSession(resolve(sessionsDir(), `${sessionId}.json`));
          json(res, 200, {
            id: file.id,
            cwd: file.cwd,
            model: file.model,
            messages: file.messages,
            title: file.title,
            updatedAt: file.updatedAt,
          });
          return;
        } catch {
          notFound(res, `session ${sessionId} not found`);
          return;
        }
      }

      // Delete session
      if (sessionMatch && method === "DELETE") {
        const sessionId = sessionMatch[1]!;
        activeSessions.delete(sessionId);
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(resolve(sessionsDir(), `${sessionId}.json`));
        } catch {
          // ignore
        }
        json(res, 200, { deleted: sessionId });
        return;
      }

      // Prompt (new session)
      if (pathname === "/prompt" && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const model = typeof body.model === "string" ? body.model : (config.model ?? DEFAULT_MODEL);
        const cwd = typeof body.cwd === "string" ? body.cwd : process.cwd();
        const title = typeof body.title === "string" ? body.title : undefined;
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        const allowAll = body.allowAll === true;

        if (!prompt) {
          badRequest(res, "prompt is required");
          return;
        }

        const { makeSessionId } = await import("../sessions.js");
        const sessionId = makeSessionId(prompt);
        const sessionFile: SessionFile = {
          id: sessionId,
          cwd,
          model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
          title,
        };

        // The same hooks as print mode and the TUI, so SessionStart/SessionEnd
        // (and tool hooks) see server sessions too (#877).
        const hooks = new HooksManager(cwd);
        const executor = new ToolExecutor(ALL_TOOLS, { hooks });
        const messages: ChatMessage[] = [
          {
            role: "system",
            content: buildSystemPrompt({ cwd, tools: ALL_TOOLS, model, preferPullRequests: config.preferPullRequests }),
          },
        ];

        const resolvedFiles = await resolveFiles(files, cwd);
        const { content: userContent } = await buildAttachmentMessage(prompt, resolvedFiles, cwd, imageOptions(config));
        messages.push({ role: "user", content: userContent });

        const trace = await startSessionTrace(config, sessionFile, ALL_TOOLS, messages);
        const firstTurnId = makeTurnId();
        traceUserMessage(trace, prompt, resolvedFiles.length, firstTurnId);
        const active: ActiveSession = {
          sessionFile,
          messages,
          executor,
          hooks,
          sseClients: new Set(),
          trace,
          nextTurnId: firstTurnId,
        };
        activeSessions.set(sessionId, active);

        // Start agent turn in background
        launchAgentTurnForSession(active, config, allowAll);

        json(res, 202, { sessionId, status: "started" });
        return;
      }

      // Follow-up prompt to existing session
      if (pathname === "/session/:id/prompt" && method === "POST") {
        // Actually the regex below handles this
      }

      const sessionPromptMatch = pathname.match(/^\/session\/([^/]+)\/prompt$/);
      if (sessionPromptMatch && method === "POST") {
        const sessionId = sessionPromptMatch[1]!;
        const active = activeSessions.get(sessionId);
        if (!active) {
          notFound(res, `session ${sessionId} not found or expired`);
          return;
        }

        const body = (await readBody(req)) as Record<string, unknown>;
        const prompt = typeof body.prompt === "string" ? body.prompt : "";
        const files = Array.isArray(body.files) ? body.files.filter((f): f is string => typeof f === "string") : [];
        const allowAll = body.allowAll === true;

        if (!prompt) {
          badRequest(res, "prompt is required");
          return;
        }

        const resolvedFiles = await resolveFiles(files, active.sessionFile.cwd);
        const { content: userContent } = await buildAttachmentMessage(prompt, resolvedFiles, active.sessionFile.cwd, imageOptions(config));
        active.messages.push({ role: "user", content: userContent });
        active.nextTurnId = makeTurnId();
        if (active.trace?.enabled && active.lastTurnId) {
          active.trace.emit(
            "outcome",
            { kind: "next_message", turn_id: active.lastTurnId, classification: classifyNextMessage(prompt), classifier: "regex" },
            active.lastTurnId,
          );
        }
        traceUserMessage(active.trace, prompt, resolvedFiles.length, active.nextTurnId);

        launchAgentTurnForSession(active, config, allowAll);

        json(res, 202, { sessionId, status: "started" });
        return;
      }

      // Not found
      notFound(res, `unknown endpoint: ${method} ${pathname}`);
    } catch (err) {
      logger.error("server: request error", { error: (err as Error).message, path: pathname });
      json(res, 500, { error: (err as Error).message });
    }
  }

  let cleaned: Promise<void> | null = null;
  /** Stop everything; resolves once open sessions have ended (SessionEnd hooks, bounded). Idempotent. */
  function cleanup(): Promise<void> {
    if (cleaned) return cleaned;
    cleaned = endSessions("exit", SHUTDOWN_TIMEOUT_MS - 1000);
    wakeScheduler.dispose();
    stopNotifications();
    stopDecisions();
    for (const [, active] of activeSessions) {
      active.shuttingDown = true;
      if (active.trace?.enabled) active.trace.emit("session_end", { reason: "exit" }, null);
      active.controller?.abort(new Error("server_shutdown"));
      for (const client of active.sseClients) {
        client.close();
      }
    }
    activeRuns.clear();
    activeSessions.clear();
    asterApi.close();
    return cleaned;
  }

  return { handleRequest, cleanup };
}

function launchAgentTurnForSession(active: ActiveSession, config: KimiConfig, allowAll: boolean): void {
  void runAgentTurnForSession(active, config, allowAll).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("server: agent turn startup failed", {
      sessionId: active.sessionFile.id,
      error: active.conversationId ? "aster_agent_start_failed" : redactLikelySecrets(message),
    });
    active.running = false;
    active.controller = undefined;
    if (!active.runId) return;
    try {
      const store = new RunStore();
      try {
        const run = store.getRun(active.runId);
        if (run && ["queued", "running", "waiting"].includes(run.status)) {
          store.transition(run.id, "failed", active.conversationId ? "aster_agent_start_failed" : `server_turn_start_failed:${redactLikelySecrets(message)}`.slice(0, 500));
          store.cancelTimersForRun(run.id);
        }
      } finally {
        store.close();
      }
    } catch (storeError) {
      logger.error("server: failed to record agent startup failure", {
        runId: active.runId,
        error: active.conversationId ? "aster_run_state_update_failed" : storeError instanceof Error ? redactLikelySecrets(storeError.message) : "unknown",
      });
    }
  });
}

async function runAgentTurnForSession(active: ActiveSession, config: KimiConfig, allowAll: boolean): Promise<void> {
  if (active.running) return;
  active.running = true;
  const controller = new AbortController();
  active.controller = controller;
  const { sessionFile, messages, executor } = active;
  let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
  let yielded = false;
  let runStore: RunStore | undefined;
  let run: RunRecord | undefined;
  if (active.runId) {
    runStore = new RunStore();
    run = runStore.getRun(active.runId);
    if (!run || run.status !== "running") {
      runStore.close();
      active.running = false;
      active.finishAsterTurn?.("failed", "run_not_active");
      return;
    }
    const armRuntimeBudget = (): void => {
      if (!runStore || !active.runId) return;
      const current = runStore.getRun(active.runId);
      if (!current || current.status !== "running" || current.maxRuntimeMs === null || current.startedAt === null) return;
      const remainingMs = current.maxRuntimeMs - (Date.now() - current.startedAt);
      if (remainingMs <= 0) {
        controller.abort(new Error("max_runtime_exceeded"));
        return;
      }
      runtimeTimer = setTimeout(armRuntimeBudget, Math.min(remainingMs, MAX_NODE_TIMEOUT_MS));
      runtimeTimer.unref();
    };
    armRuntimeBudget();
  }

  const callbacks: AgentCallbacks = {
    onTextDelta: (delta) => {
      if (active.publishAsterEvent) active.publishAsterEvent("assistant.delta", { delta: redactLikelySecrets(delta) });
      for (const client of active.sseClients) {
        client.send("assistant.delta", { delta });
      }
    },
    onToolCallFinalized: (call) => {
      if (active.publishAsterEvent) {
        active.publishAsterEvent("tool.activity", { tool: call.function.name, activity: "proposed" });
      }
      for (const client of active.sseClients) {
        client.send("tool.call", {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
    },
    onToolResult: (result) => {
      if (active.publishAsterEvent) {
        active.publishAsterEvent("tool.activity", { tool: result.name, activity: result.ok ? "completed" : "failed", ok: result.ok });
      }
      for (const client of active.sseClients) {
        client.send("tool.result", {
          toolCallId: result.tool_call_id,
          name: result.name,
          content: result.content,
          ok: result.ok,
        });
      }
    },
    onUsage: (usage) => {
      if (active.publishAsterEvent) {
        active.publishAsterEvent("usage", {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
          ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
        });
      }
      for (const client of active.sseClients) {
        client.send("usage.update", {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        });
      }
    },
    onUsageFinal: (usage) => {
      if (!runStore || !active.runId) return;
      const result = runStore.recordUsage(active.runId, {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        ...(usage.cost !== undefined ? { costUsd: usage.cost } : {}),
      });
      if (result.budgetExceededReason) throw new Error(result.budgetExceededReason);
    },
    onWarning: (msg) => {
      if (active.publishAsterEvent) active.publishAsterEvent("status", { detail: redactLikelySecrets(msg) });
      for (const client of active.sseClients) {
        client.send("warning", { message: msg });
      }
    },
    onRunYield: (request) => {
      if (!runStore || !active.runId || request.runId !== active.runId) return;
      runStore.transition(active.runId, "waiting", `timer:${request.timerId}`);
      active.publishAsterEvent?.("status", { status: "waiting", condition: request.condition, wakeAt: request.wakeAt });
      yielded = true;
    },
    onRunBudgetExceeded: (reason) => controller.abort(new Error(reason)),
    askPermission: async ({ tool, args, sessionKey }) => {
      if (active.askAsterPermission) return active.askAsterPermission({ tool, args, sessionKey });
      if (active.runId) {
        if (active.allowedTools?.has(tool.name)) return "allow";
        return "deny";
      }
      if (allowAll) return "allow";

      // Evaluate config-based permission rules
      if (config.permissions) {
        const rule = evaluatePermissionRules({ tool: tool.name, args, cwd: sessionFile.cwd }, config.permissions);
        if (rule === "allow") return "allow";
        if (rule === "deny") {
          for (const client of active.sseClients) {
            client.send("permission.denied", { tool: tool.name, args, reason: "config_rule" });
          }
          return "deny";
        }
      }

      for (const client of active.sseClients) {
        client.send("permission.request", { tool: tool.name, args });
      }
      // In server mode without allowAll, we auto-deny after a brief wait
      // since there's no interactive user. Future: support async permission
      // approval via a separate endpoint.
      return "deny";
    },
  };

  // Archived turns land on the session file, so every save below persists them.
  const compaction = sessionFileCompactionTarget(sessionFile);
  const turnId = active.nextTurnId ?? makeTurnId();
  active.nextTurnId = undefined;
  active.lastTurnId = turnId;
  try {
    if (run && runStore) {
      // SessionCore: same classification, subagent policy and completion check as every host.
      const policy = await resolveTurnPolicy({
        cfg: config,
        prompt: lastUserText(messages),
        tools: ALL_TOOLS.filter((tool) => active.allowedTools?.has(tool.name)),
        signal: controller.signal,
      });
      await runAgentTurn(assembleTurn({ cfg: config, policy, host: {
        ...llmAuthFromConfig(config),
        model: sessionFile.model,
        reasoningEffort: config.reasoningEffort,
        sessionId: sessionFile.id,
        runId: run.id,
        runsDbPath: process.env.AUTOPILOT_RUNS_DB,
        messages,
        executor,
        cwd: sessionFile.cwd,
        signal: controller.signal,
        toolLimitBehavior: "continue",
        codeMode: false,
        allowDirectPush: config.allowDirectPush,
        preferPullRequests: config.preferPullRequests,
        compaction,
        callbacks,
        trace: active.trace,
        turnId,
        onIterationEnd: async (updatedMessages) => {
          sessionFile.messages = updatedMessages;
          sessionFile.updatedAt = new Date().toISOString();
          await saveSession(sessionFile);
          if (runStore && active.runId) {
            const current = runStore.getRun(active.runId);
            if (current?.status === "running" || current?.status === "needs_input") runStore.recordCheckpoint(active.runId);
          }
          return updatedMessages;
        },
      } }));
    } else {
      const policy = await resolveTurnPolicy({ cfg: config, prompt: lastUserText(messages), tools: ALL_TOOLS, signal: controller.signal });
      await runAgentTurn(assembleTurn({ cfg: config, policy, host: {
        ...llmAuthFromConfig(config),
        model: sessionFile.model,
        reasoningEffort: config.reasoningEffort,
        sessionId: sessionFile.id,
        messages,
        executor,
        ...(active.hooks ? { hooks: active.hooks } : {}),
        cwd: sessionFile.cwd,
        signal: controller.signal,
        codeMode: config.codeMode,
        allowDirectPush: config.allowDirectPush,
        preferPullRequests: config.preferPullRequests,
        compaction,
        callbacks,
        trace: active.trace,
        turnId,
      } }));
    }

    sessionFile.messages = messages;
    sessionFile.updatedAt = new Date().toISOString();
    await saveSession(sessionFile);
    if (runStore && active.runId && runStore.getRun(active.runId)?.status === "running") {
      runStore.recordCheckpoint(active.runId);
    }
    if (runStore && active.runId) {
      const current = runStore.getRun(active.runId);
      if (current?.status === "running" && !yielded) {
        runStore.transition(active.runId, "completed");
      }
    }
    active.finishAsterTurn?.("completed");

    for (const client of active.sseClients) {
      client.send("session.completed", { sessionId: sessionFile.id });
    }
  } catch (err) {
    const rawMessage = (err as Error).message;
    const message = active.conversationId ? "aster_agent_turn_failed" : redactLikelySecrets(rawMessage);
    logger.error("server: agent turn failed", { sessionId: sessionFile.id, error: message });
    if (runStore && active.runId) {
      const current = runStore.getRun(active.runId);
      if (current?.status === "running" && !active.shuttingDown) {
        const runtimeBudgetExceeded = controller.signal.aborted && run?.maxRuntimeMs !== null && run?.maxRuntimeMs !== undefined && run.startedAt !== null && Date.now() - run.startedAt >= run.maxRuntimeMs;
        // SessionCore decides: budget limits pause the run for a decision; anything else fails it.
        const stop = runStopForError(err, { runtimeBudgetExceeded, model: sessionFile.model });
        runStore.transition(active.runId, stop.status, stop.status === "failed" ? message : stop.reason);
        if (stop.status === "needs_input") {
          for (const client of active.sseClients) client.send("run.needs_input", { runId: active.runId, reason: stop.reason });
        }
      }
    }
    if (active.finishAsterTurn) {
      const runStatus = active.runId ? runStore?.getRun(active.runId)?.status : undefined;
      const finalStatus = runStatus === "cancelled" ? "cancelled" : runStatus === "completed" ? "completed" : "failed";
      active.finishAsterTurn(finalStatus, finalStatus === "failed" ? "agent_turn_failed" : undefined);
    }
    for (const client of active.sseClients) {
      client.send("error", { message, sessionId: sessionFile.id });
    }
  } finally {
    if (runtimeTimer) clearTimeout(runtimeTimer);
    active.controller = undefined;
    active.running = false;
    runStore?.close();
  }
}
