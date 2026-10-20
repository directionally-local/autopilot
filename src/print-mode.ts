/**
 * Enhanced print (headless) mode for KimiFlare.
 *
 * Supports one-shot prompts with optional session continuation,
 * file attachments, structured output formats, and cwd override.
 */

import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { runAgentTurn, BudgetExhaustedError, AgentLoopError } from "./agent/loop.js";
import type { AgentCallbacks } from "./agent/loop.js";
import { llmAuthFromConfig } from "./agent/llm-auth.js";
import { recordUsage } from "./usage-tracker.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { ToolExecutor, getWorkerTools, RESEARCH_WORKER_TOOL_NAMES } from "./tools/executor.js";
import type { ChatMessage, ContentPart } from "./agent/messages.js";
import { KimiApiError, humanizeApiError } from "./util/errors.js";
import { saveSession, loadSession, listSessions, sessionsDir, type SessionFile } from "./sessions.js";
import { sessionFileCompactionTarget } from "./agent/context-budget.js";
import { recordSubagentEvent } from "./tools/subagent-stats.js";
import { completionCheckFromConfig } from "./agent/completion-check.js";
import { isImagePath } from "./util/image.js";
import { endSessions } from "./hooks/session-lifecycle.js";
import { buildAttachmentMessage } from "./util/attachments.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { glob } from "./util/glob.js";
import { evaluatePermissionRules } from "./permissions-evaluator.js";
import { assembleTurn, resolveTurnPolicy } from "./agent/session-core.js";
import type { KimiConfig, PermissionRules, ReasoningEffort } from "./config.js";
import { createRecorder, emitSessionStart, makeTurnId, type SessionEndReason } from "./trace/index.js";
import { toOpenAIToolDefs } from "./tools/registry.js";

export type PrintFormat = "text" | "json" | "stream-json";

export interface PrintModeOpts
  extends Pick<KimiConfig, "openrouterApiKey" | "requestyApiKey" | "baseUrl" | "apiKey" | "openrouterProvider" | "subagentPolicy" | "completionCheck" | "imageMaxEdge" | "imageQuality"> {
  model: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  allowAll: boolean;
  showReasoning: boolean;
  coauthor?: boolean;
  coauthorName?: string;
  coauthorEmail?: string;
  updateResult: UpdateCheckResult;
  codeMode?: boolean;
  continueOnLimit?: boolean;
  /** Hard ceiling on tool iterations across `continueOnLimit` resets. */
  maxTotalToolIterations?: number;
  maxInputTokens?: number;
  /** Session continuation */
  continueSession?: boolean;
  sessionId?: string;
  /** File attachments (paths or globs) */
  files?: string[];
  /** Output format */
  format?: PrintFormat;
  /** Working directory override */
  dir?: string;
  /** Session title override */
  title?: string;
  /** Config-based permission rules */
  permissions?: Record<string, PermissionRules>;
  /** Narrow tool permission profile for isolated research workers. */
  workerProfile?: "research";
  /** When false (default), the bash tool blocks `git push` to the default branch. */
  allowDirectPush?: boolean;
  /** When true (default), the system prompt instructs the model to prefer PRs over direct pushes. */
  preferPullRequests?: boolean;
  /** Local session tracing (off unless `trace.enabled`). */
  trace?: KimiConfig["trace"];
  /** Full config, recorded (redacted) on the trace's `session_start` event. */
  traceConfigSnapshot?: KimiConfig;
}

interface JsonToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface JsonToolResult {
  toolCallId: string;
  name: string;
  content: string;
  ok: boolean;
}

interface JsonOutput {
  text: string;
  toolCalls: JsonToolCall[];
  toolResults: JsonToolResult[];
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  durationMs: number;
  sessionId: string;
}

async function resolveSession(opts: PrintModeOpts): Promise<{ sessionFile: SessionFile; isNew: boolean }> {
  if (opts.sessionId) {
    const filePath = resolve(sessionsDir(), `${opts.sessionId}.json`);
    try {
      const file = await loadSession(filePath);
      return { sessionFile: file, isNew: false };
    } catch {
      // Fall through to create new
    }
  }

  if (opts.continueSession) {
    const cwd = opts.dir ? resolve(opts.dir) : process.cwd();
    const sessions = await listSessions(1, cwd);
    if (sessions.length > 0) {
      const filePath = sessions[0]!.filePath;
      const file = await loadSession(filePath);
      return { sessionFile: file, isNew: false };
    }
  }

  // Create new session
  const { makeSessionId } = await import("./sessions.js");
  const id = makeSessionId(opts.prompt);
  return {
    sessionFile: {
      id,
      cwd: opts.dir ? resolve(opts.dir) : process.cwd(),
      model: opts.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      title: opts.title,
    },
    isNew: true,
  };
}

async function resolveFiles(filePatterns: string[], cwd: string): Promise<string[]> {
  const resolved = new Set<string>();
  for (const pattern of filePatterns) {
    // If it's a literal existing file, use it directly
    try {
      const stat = await import("node:fs/promises").then((m) => m.stat(resolve(cwd, pattern)));
      if (stat.isFile()) {
        resolved.add(resolve(cwd, pattern));
        continue;
      }
    } catch {
      // Not a literal file, try glob
    }
    // Try glob
    const matches = await glob(pattern, { cwd, absolute: true });
    for (const m of matches) {
      resolved.add(m);
    }
  }
  return [...resolved];
}

export async function runPrintMode(opts: PrintModeOpts): Promise<void> {
  const startMs = Date.now();

  if (opts.updateResult.hasUpdate) {
    process.stderr.write(
      `\x1b[33mkimiflare update available: ${opts.updateResult.localVersion} → ${opts.updateResult.latestVersion}\x1b[0m\n` +
        `\x1b[33m  npm i -g autopilot-ai@latest  then restart\x1b[0m\n\n`,
    );
  }

  const cwd = opts.dir ? resolve(opts.dir) : process.cwd();

  // M6.1: print mode loads the same hooks as the TUI.
  const baseWorkerTools = getWorkerTools(opts.workerProfile);
  const { HooksManager } = await import("./hooks/manager.js");
  const hooks = new HooksManager(cwd);
  const { takeHookStartupNotices } = await import("./hooks/notices.js");
  for (const notice of await takeHookStartupNotices(cwd)) process.stderr.write(`${notice}\n`);

  // Resolve session
  const { sessionFile, isNew } = await resolveSession(opts);
  if (opts.title && isNew) {
    sessionFile.title = opts.title;
  }

  // SessionCore: classification, subagent guidance (Jev only on OpenRouter)
  // and the completion check, decided the same way as in every host.
  const policy = await resolveTurnPolicy({
    cfg: opts,
    prompt: opts.prompt,
    tools: baseWorkerTools,
    subagentPolicy: opts.subagentPolicy ?? "auto",
    ...(opts.workerProfile === "research" ? { workerProfile: "research" as const } : {}),
  });
  const delegationGuidance = policy.guidance;
  const workerTools = policy.tools;
  const executor = new ToolExecutor(workerTools, { hooks });
  // The research worker profile never delegates; only coordinator runs count.
  if (opts.workerProfile !== "research") {
    void recordSubagentEvent({
      kind: "turn",
      ts: Date.now(),
      sessionId: sessionFile.id,
      offered: workerTools.some((tool) => tool.name === "subagent"),
      guidance: delegationGuidance.kind,
    });
  }

  // Build messages
  const messages: ChatMessage[] = [];
  const systemPrompt = buildSystemPrompt({ cwd, tools: workerTools, model: opts.model, preferPullRequests: opts.preferPullRequests});
  if (isNew || sessionFile.messages.length === 0) {
    messages.push({ role: "system", content: systemPrompt });
  } else {
    // Continue: load existing messages, filter out old system prompts, keep context
    // Keep the compiled session state from earlier compaction; it summarizes
    // archived turns. Other system messages are rebuilt for this run.
    const nonSystem = sessionFile.messages.filter(
      (m) => m.role !== "system" || (typeof m.content === "string" && m.content.startsWith("[compiled session state]")),
    );
    messages.push({ role: "system", content: systemPrompt });
    messages.push(...nonSystem);
  }

  // Session trace (no-op unless enabled; nothing is written when disabled).
  const trace = createRecorder({
    enabled: opts.trace?.enabled === true,
    sessionId: sessionFile.id,
    root: opts.trace?.root,
  });
  await emitSessionStart(trace, {
    cwd,
    model: opts.model,
    mode: "print",
    config: opts.traceConfigSnapshot,
    tools: toOpenAIToolDefs(workerTools),
    systemPrompt,
    toolProfile: opts.workerProfile ?? "full",
  });
  let traceCostUsd = 0;
  let traceEndReason: SessionEndReason = "exit";

  // Build user message with file attachments
  const files = opts.files ? await resolveFiles(opts.files, cwd) : [];
  const { content: userContent, notices: imageNotices } = await buildAttachmentMessage(opts.prompt, files, cwd, {
    maxEdge: opts.imageMaxEdge,
    quality: opts.imageQuality,
  });
  for (const notice of imageNotices) process.stderr.write(`${notice}\n`);
  messages.push({ role: "user", content: userContent });
  const turnId = makeTurnId();
  if (trace.enabled) {
    trace.emit(
      "user_message",
      { content_blob: trace.blob(opts.prompt) ?? "", source: "print", attachments: files.length },
      turnId,
    );
  }

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());

  // Output state
  const format = opts.format ?? "text";
  let printedReasoningHeader = false;
  let printedAnswerHeader = false;
  const jsonOutput: JsonOutput = {
    text: "",
    toolCalls: [],
    toolResults: [],
    durationMs: 0,
    sessionId: sessionFile.id,
  };

  function emitStreamJson(eventType: string, payload: Record<string, unknown>): void {
    if (format === "stream-json") {
      process.stdout.write(JSON.stringify({ event: eventType, ...payload }) + "\n");
    }
  }

  // Usage is recorded like the TUI does, so `autopilot cost` and /cost see
  // headless runs too. Writes are awaited before exit.
  const usageWrites: Promise<void>[] = [];
  const auth = llmAuthFromConfig(opts);
  const callbacks: AgentCallbacks = {
    onUsageFinal: (u, meta) => {
      const lookup =
        opts.openrouterApiKey && !auth.customEndpoint && meta?.generationId
          ? { apiKey: opts.openrouterApiKey, meta }
          : undefined;
      usageWrites.push(recordUsage(sessionFile.id, u, lookup, opts.model).catch(() => undefined));
      if (typeof u.cost === "number") traceCostUsd += u.cost;
    },
    onReasoningDelta: opts.showReasoning
      ? (delta) => {
          if (format === "text") {
            if (!printedReasoningHeader) {
              process.stderr.write("\x1b[2m--- reasoning ---\n");
              printedReasoningHeader = true;
            }
            process.stderr.write(delta);
          }
        }
      : undefined,
    onTextDelta: (delta) => {
      if (format === "text") {
        if (opts.showReasoning && printedReasoningHeader && !printedAnswerHeader) {
          process.stderr.write("\n--- answer ---\x1b[0m\n");
          printedAnswerHeader = true;
        }
        process.stdout.write(delta);
      } else if (format === "json") {
        jsonOutput.text += delta;
      } else if (format === "stream-json") {
        emitStreamJson("text_delta", { delta });
      }
    },
    onToolCallFinalized: (call) => {
      if (format === "text") {
        process.stderr.write(`\x1b[2m[tool ${call.function.name}(${call.function.arguments})]\x1b[0m\n`);
      } else if (format === "json") {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments);
        } catch {
          /* ignore */
        }
        jsonOutput.toolCalls.push({ id: call.id, name: call.function.name, arguments: args });
      } else if (format === "stream-json") {
        emitStreamJson("tool_call", { id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    },
    onToolResult: (result) => {
      if (format === "text") {
        const snippet = result.content.length > 400 ? result.content.slice(0, 400) + "..." : result.content;
        process.stderr.write(`\x1b[2m[result: ${snippet.replace(/\n/g, " ⏎ ")}]\x1b[0m\n`);
      } else if (format === "json") {
        jsonOutput.toolResults.push({
          toolCallId: result.tool_call_id,
          name: result.name,
          content: result.content,
          ok: result.ok,
        });
      } else if (format === "stream-json") {
        emitStreamJson("tool_result", {
          toolCallId: result.tool_call_id,
          name: result.name,
          content: result.content,
          ok: result.ok,
        });
      }
    },
    onUsage: (usage) => {
      if (format === "json") {
        jsonOutput.usage = {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        };
      } else if (format === "stream-json") {
        emitStreamJson("usage", {
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          totalTokens: usage.total_tokens ?? 0,
        });
      }
    },
    onGuardrail: (ev) => {
      if (format === "text") {
        process.stderr.write(`\x1b[33mkimiflare: ${ev.message}\x1b[0m\n`);
      } else if (format === "stream-json") {
        emitStreamJson("warning", { message: ev.message, guardrail: ev.kind });
      }
    },
    onWarning: (msg) => {
      if (format === "text") {
        process.stderr.write(`\x1b[33mkimiflare: ${msg}\x1b[0m\n`);
      } else if (format === "stream-json") {
        emitStreamJson("warning", { message: msg });
      }
    },
    askPermission: async ({ tool, args }) => {
      if (opts.workerProfile === "research") {
        return RESEARCH_WORKER_TOOL_NAMES.has(tool.name) && tool.isReadOnly === true ? "allow" : "deny";
      }
      if (opts.allowAll) return "allow";

      // Evaluate config-based permission rules
      if (opts.permissions) {
        const rule = evaluatePermissionRules({ tool: tool.name, args, cwd }, opts.permissions);
        if (rule === "allow") return "allow";
        if (rule === "deny") {
          const msg = `[permission denied by config rule: ${tool.name}(${JSON.stringify(args)})]`;
          if (format === "text") process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`);
          else if (format === "stream-json") emitStreamJson("permission_denied", { tool: tool.name, args, reason: "config_rule" });
          return "deny";
        }
        // "ask" falls through to default deny in headless mode
      }

      const msg = `[permission denied: ${tool.name}(${JSON.stringify(args)}) — pass --dangerously-allow-all to approve in print mode, or configure permissions in config.json]`;
      if (format === "text") {
        process.stderr.write(`\x1b[31m${msg}\x1b[0m\n`);
      } else if (format === "stream-json") {
        emitStreamJson("permission_denied", { tool: tool.name, args });
      }
      return "deny";
    },
  };

  try {
    await runAgentTurn(assembleTurn({ cfg: opts, policy, host: {
      ...auth,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      sessionId: sessionFile.id,
      messages,
      executor,
      hooks,
      cwd,
      signal: controller.signal,
      codeMode: opts.codeMode,
      continueOnLimit: opts.continueOnLimit,
      maxTotalToolIterations: opts.maxTotalToolIterations,
      maxInputTokens: opts.maxInputTokens,
      coauthor:
        opts.coauthor !== false
          ? { name: opts.coauthorName || "autopilot", email: opts.coauthorEmail || "kimiflare@proton.me" }
          : undefined,
      allowDirectPush: opts.allowDirectPush,
      preferPullRequests: opts.preferPullRequests,
      // --continue sessions grow across runs; archive older turns onto the
      // session file (saved below) instead of failing on context size.
      compaction: sessionFileCompactionTarget(sessionFile),
      callbacks,
      trace,
      turnId,
    } }));
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      const msg = "[Budget exhausted — exiting with code 42]";
      if (format === "text") process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
      else if (format === "stream-json") emitStreamJson("error", { message: msg, code: 42 });
      process.exitCode = 42;
      return;
    }
    if (err instanceof AgentLoopError) {
      const msg = "[Agent loop detected — exiting with code 43]";
      if (format === "text") process.stderr.write(`\n\x1b[33m${msg}\x1b[0m\n`);
      else if (format === "stream-json") emitStreamJson("error", { message: msg, code: 43 });
      process.exitCode = 43;
      return;
    }
    if (err instanceof KimiApiError) {
      const msg = `Error: ${humanizeApiError(err)}`;
      if (format === "text") process.stderr.write(`\n\x1b[31m${msg}\x1b[0m\n`);
      else if (format === "stream-json") emitStreamJson("error", { message: msg, code: 1 });
      process.exitCode = 1;
      return;
    }
    traceEndReason = "crash";
    throw err;
  } finally {
    await endSessions("exit");
    await Promise.all(usageWrites);
    trace.emit("session_end", { reason: traceEndReason, total_cost_usd: traceCostUsd || undefined }, null);
    await trace.flush();
  }

  // Save session
  sessionFile.messages = messages;
  sessionFile.updatedAt = new Date().toISOString();
  await saveSession(sessionFile);

  // Final output
  jsonOutput.durationMs = Date.now() - startMs;

  if (format === "text") {
    process.stdout.write("\n");
  } else if (format === "json") {
    process.stdout.write(JSON.stringify(jsonOutput, null, 2) + "\n");
  } else if (format === "stream-json") {
    emitStreamJson("done", { sessionId: sessionFile.id, durationMs: jsonOutput.durationMs });
  }
}
