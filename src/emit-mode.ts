/**
 * Camouflage adapter (emit mode).
 *
 * Runs agent turns headlessly and emits NDJSON to stdout in the Camouflage
 * event-protocol shape (see ~/camouflage/crates/protocol/src/lib.rs).
 *
 * Two modes:
 *
 *   One-shot:
 *     kimiflare --emit-events -p "do X" | camouflage-tui --stdin-events
 *
 *   Multi-turn (this commit):
 *     kimiflare --emit-events --multi-turn -p "first prompt"
 *     # then on stdin, one NDJSON line per follow-up:
 *     # {"event_type":"UserInputSubmitted","payload":{"text":"do Y next"}}
 *
 * The TUI emits UserInputSubmitted on stdout when the user hits Enter
 * (--emit-responses); piping that into a multi-turn adapter closes the
 * loop and gives you a real conversational session.
 *
 * Bidirectional permission responses are deferred to a follow-up; for now
 * we resolve permissions inline via --dangerously-allow-all or auto-deny.
 */

import * as readline from "node:readline";
import { execSync } from "node:child_process";
import { runAgentTurn, BudgetExhaustedError, AgentLoopError } from "./agent/loop.js";
import { llmAuthFromConfig, providerIdOf } from "./agent/llm-auth.js";
import { assembleTurn, resolveTurnPolicy } from "./agent/session-core.js";
import { buildSystemPrompt } from "./agent/system-prompt.js";
import { ToolExecutor, ALL_TOOLS, permissionFromHook } from "./tools/executor.js";
import type { ChatMessage } from "./agent/messages.js";
import { KimiApiError, humanizeApiError } from "./util/errors.js";
import { endSessions } from "./hooks/session-lifecycle.js";
import { submitUserPrompt, PROMPT_BLOCKED_EXIT_CODE } from "./hooks/prompt-submit.js";
import { makeSessionId } from "./sessions.js";
import type { KimiConfig, ReasoningEffort } from "./config.js";

export interface EmitModeOpts
  extends Pick<KimiConfig, "openrouterApiKey" | "requestyApiKey" | "baseUrl" | "apiKey" | "openrouterProvider"> {
  model: string;
  reasoningEffort?: ReasoningEffort;
  prompt: string;
  allowAll: boolean;
  /** When true, after the initial turn keep reading stdin for follow-up
   *  UserInputSubmitted events and run another turn per submission. */
  multiTurn?: boolean;
  codeMode?: boolean;
  continueOnLimit?: boolean;
  /** Hard ceiling on tool iterations across `continueOnLimit` resets. */
  maxTotalToolIterations?: number;
  maxInputTokens?: number;
  /** When false (default), the bash tool blocks `git push` to the default branch. */
  allowDirectPush?: boolean;
  /** When true (default), the system prompt instructs the model to prefer PRs over direct pushes. */
  preferPullRequests?: boolean;
}

export async function runEmitMode(opts: EmitModeOpts): Promise<void> {
  // In emit mode stdout is reserved for NDJSON. Funnel any stray writes
  // (logger bring-up banners, libraries that console.log) to stderr.
  const origLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);

  const stdout = process.stdout;
  const emit = (event_type: string, payload: Record<string, unknown> = {}): void => {
    stdout.write(JSON.stringify({ event_type, payload }) + "\n");
  };

  emit("SessionStarted", {});

  // Seed status-bar segments the TUI will render at the bottom.
  // Mode is hardcoded to "edit" for now (emit-mode doesn't currently
  // surface KimiFlare's mode cycling). Branch is resolved once via
  // `git rev-parse`. Phase/elapsed/tokens update across the session.
  const sessionStartMs = Date.now();
  let promptTokens = 0;
  let cachedTokens = 0;
  let currentPhase: "idle" | "thinking" | "streaming" | "tool" = "idle";
  const branch = tryGitBranch();
  const initialSegments: Record<string, string> = {
    mode: "edit",
    phase: currentPhase,
    elapsed: "0s",
    branch,
  };
  emit("StatusUpdate", { segments: initialSegments });

  const setPhase = (next: typeof currentPhase): void => {
    if (next === currentPhase) return;
    currentPhase = next;
    emit("StatusUpdate", { segments: { phase: next } });
  };

  const setTokens = (prompt: number, cached: number): void => {
    if (prompt === promptTokens && cached === cachedTokens) return;
    promptTokens = prompt;
    cachedTokens = cached;
    const txt = cached > 0
      ? `in ${formatK(prompt)} (${formatK(cached)} cached)`
      : `in ${formatK(prompt)}`;
    emit("StatusUpdate", { segments: { tokens: txt } });
  };

  // Tick the elapsed segment once a second so the TUI status bar stays
  // live during long turns. Stopped in the finally block.
  const elapsedTimer = setInterval(() => {
    const secs = Math.floor((Date.now() - sessionStartMs) / 1000);
    emit("StatusUpdate", { segments: { elapsed: formatElapsed(secs) } });
  }, 1000);

  // Bidirectional permission routing (active in --multi-turn). A single
  // stdin reader fans out: PermissionResponse messages resolve the
  // matching pending askPermission promise; UserInputSubmitted messages
  // go into a queue consumed by the main multi-turn loop after each turn.
  const pendingPermissions = new Map<string, (choice: "allow" | "allow_session" | "deny") => void>();
  const followUpQueue: string[] = [];
  let followUpResolver: ((text: string | null) => void) | null = null;
  let stdinClosed = false;

  function dispatchInbound(line: string): void {
    let msg: { event_type?: string; payload?: any };
    try { msg = JSON.parse(line); }
    catch {
      emit("RuntimeError", {
        message: `multi-turn: invalid JSON on stdin: ${line.slice(0, 80)}`,
        source: "emit-mode",
        kind: "generic",
        severity: "warn",
      });
      return;
    }
    if (msg.event_type === "PermissionResponse" && typeof msg.payload?.request_id === "string") {
      const resolver = pendingPermissions.get(msg.payload.request_id);
      if (resolver) {
        pendingPermissions.delete(msg.payload.request_id);
        const choice = msg.payload.choice;
        if (choice === "allow_once") resolver("allow");
        else if (choice === "allow_session") resolver("allow_session");
        else resolver("deny");
      }
      return;
    }
    if (msg.event_type === "UserInputSubmitted" && typeof msg.payload?.text === "string") {
      if (followUpResolver) {
        const r = followUpResolver;
        followUpResolver = null;
        r(msg.payload.text);
      } else {
        followUpQueue.push(msg.payload.text);
      }
      return;
    }
    // Unknown event_type: silently drop (forward-compat with future TUI events).
  }

  let stdinReader: readline.Interface | null = null;
  if (opts.multiTurn) {
    stdinReader = readline.createInterface({ input: process.stdin });
    stdinReader.on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) dispatchInbound(trimmed);
    });
    stdinReader.on("close", () => {
      stdinClosed = true;
      // Wake the follow-up loop so it can exit.
      if (followUpResolver) {
        const r = followUpResolver;
        followUpResolver = null;
        r(null);
      }
      // Resolve any pending permission asks as deny so the agent doesn't hang.
      for (const [reqId, resolver] of pendingPermissions) {
        pendingPermissions.delete(reqId);
        resolver("deny");
      }
    });
  }

  async function nextFollowUp(): Promise<string | null> {
    if (followUpQueue.length > 0) return followUpQueue.shift()!;
    if (stdinClosed) return null;
    return new Promise<string | null>((resolve) => { followUpResolver = resolve; });
  }

  const cwd = process.cwd();
  // The same hooks as print mode and the TUI, under one session id so
  // SessionStart/SessionEnd bracket the run (#877).
  const { HooksManager, formatHookFailureNotice } = await import("./hooks/manager.js");
  const hooks = new HooksManager(cwd);
  {
    const { pendingProjectConfig, projectTrustNoticeText } = await import("./util/project-config-review.js");
    const trustText = projectTrustNoticeText(pendingProjectConfig(cwd));
    if (trustText) emit("RuntimeError", { message: trustText, source: "hooks", kind: "generic", severity: "warn" });
  }
  // #889: a failing hook is reported once per hook per session.
  hooks.onFailure((notice) => {
    if (!notice.firstInSession) return;
    emit("RuntimeError", { message: formatHookFailureNotice(notice), source: "hooks", kind: "generic", severity: "warn" });
  });
  const sessionId = makeSessionId(opts.prompt);
  const executor = new ToolExecutor(ALL_TOOLS, { hooks });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({ cwd, tools: ALL_TOOLS, model: opts.model, preferPullRequests: opts.preferPullRequests }),
    },
  ];

  let streamCounter = 0;
  let currentStreamId: string | null = null;
  let exitCode = 0;
  let aborted = false;

  const controller = new AbortController();
  const sigintHandler = () => {
    aborted = true;
    controller.abort();
  };
  process.on("SIGINT", sigintHandler);

  /** Run one agent turn with the given user text. Emits the user message,
   *  then drives runAgentTurn with NDJSON-routed callbacks. Errors are
   *  captured per-turn so a single turn's failure doesn't kill a multi-
   *  turn session. */
  async function runTurn(text: string): Promise<void> {
    emit("UserMessageCreated", { text });

    // SessionStart, then UserPromptSubmit (veto-able), as in every host. A
    // blocked prompt never reaches the model; a one-shot run exits with
    // PROMPT_BLOCKED_EXIT_CODE, a multi-turn session waits for the next one.
    const gate = await submitUserPrompt({
      hooks,
      sessionId,
      cwd,
      prompt: text,
      resumed: messages.some((m) => m.role === "assistant"),
      model: opts.model,
      auth: llmAuthFromConfig(opts),
    });
    if (gate.blocked) {
      emit("RuntimeError", {
        message: `prompt blocked by a UserPromptSubmit hook: ${gate.reason}`,
        source: "hooks",
        kind: "generic",
        severity: "error",
      });
      if (!opts.multiTurn) exitCode = PROMPT_BLOCKED_EXIT_CODE;
      return;
    }
    messages.push({ role: "user", content: text });

    try {
      // SessionCore: same classification, subagent policy and completion check as every host.
      const policy = await resolveTurnPolicy({ cfg: opts, prompt: text, tools: ALL_TOOLS, signal: controller.signal });
      await runAgentTurn(assembleTurn({ cfg: opts, policy, host: {
        ...llmAuthFromConfig(opts),
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        messages,
        executor,
        cwd,
        sessionId,
        hooks,
        signal: controller.signal,
        codeMode: opts.codeMode,
        continueOnLimit: opts.continueOnLimit,
        maxTotalToolIterations: opts.maxTotalToolIterations,
        maxInputTokens: opts.maxInputTokens,
        allowDirectPush: opts.allowDirectPush,
        preferPullRequests: opts.preferPullRequests,
        callbacks: {
          onAssistantStart: () => {
            streamCounter += 1;
            currentStreamId = `s${streamCounter}`;
            setPhase("thinking"); // before first token, we're still composing
            emit("AssistantStreamStarted", { stream_id: currentStreamId });
          },
          onTextDelta: (delta) => {
            if (!currentStreamId) {
              streamCounter += 1;
              currentStreamId = `s${streamCounter}`;
              emit("AssistantStreamStarted", { stream_id: currentStreamId });
            }
            setPhase("streaming"); // first delta flips phase
            emit("AssistantTokenDelta", { stream_id: currentStreamId, token: delta });
          },
          onAssistantFinal: () => {
            if (currentStreamId) {
              emit("AssistantMessageCompleted", { stream_id: currentStreamId });
              currentStreamId = null;
            }
            setPhase("idle");
          },
          onToolCallFinalized: (call) => {
            setPhase("tool");
            emit("ToolExecutionStarted", {
              tool_id: call.id,
              tool: call.function.name,
              command: call.function.arguments,
            });
          },
          onToolResult: (result) => {
            if (result.content && result.content.length > 0) {
              emit(result.ok ? "ToolExecutionStdout" : "ToolExecutionStderr", {
                tool_id: result.tool_call_id,
                chunk: result.content,
              });
            }
            emit("ToolExecutionFinished", {
              tool_id: result.tool_call_id,
              exit_code: result.ok ? 0 : 1,
            });
            // After a tool result we typically loop back to thinking
            // (next assistant turn) — flip phase optimistically; the next
            // onAssistantStart/onTextDelta will overwrite.
            setPhase("thinking");
          },
          onUsage: (usage) => {
            setTokens(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? 0);
          },
          onUsageFinal: (usage) => {
            setTokens(usage.prompt_tokens, usage.prompt_tokens_details?.cached_tokens ?? 0);
          },
          onTasks: (tasks) => {
            // Each agent-managed task becomes a row in the Camouflage
            // background-task ribbon. Status mapping:
            //   pending     → running (the task exists but isn't done)
            //   in_progress → running
            //   completed   → done (fades in the UI after a short delay)
            for (const t of tasks) {
              const state = t.status === "completed" ? "done" : "running";
              emit("BackgroundTaskUpdate", {
                task_id: t.id,
                label: t.title,
                state,
              });
            }
          },
          onSkillsSelected: (result) => {
            const n = (result as any)?.selected?.length ?? 0;
            if (n > 0) {
              emit("BackgroundTaskUpdate", {
                task_id: "skills",
                label: `selected ${n} skill${n === 1 ? "" : "s"}`,
                state: "done",
              });
            }
          },
          onMemoryRecalled: (count) => {
            if (count > 0) {
              emit("BackgroundTaskUpdate", {
                task_id: "memory",
                label: `recalled ${count} ${count === 1 ? "memory" : "memories"}`,
                state: "done",
              });
            }
          },
          onWarning: (msg) => {
            emit("RuntimeError", { message: msg, kind: "generic", severity: "warn" });
          },
          onGuardrail: (ev) => {
            emit("RuntimeError", { message: ev.message, kind: "generic", severity: "warn" });
          },
          askPermission: async (req) => {
            const { tool, args } = req;
            const reqId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            emit("PermissionRequested", {
              request_id: reqId,
              tool: tool.name,
              action: JSON.stringify(args),
            });
            // --dangerously-allow-all short-circuits regardless of mode.
            if (opts.allowAll) {
              emit("PermissionGranted", { request_id: reqId });
              return "allow";
            }
            // A PermissionRequest hook may answer before the user does.
            const fromHook = await permissionFromHook(req, "edit");
            if (fromHook) {
              emit(fromHook.decision === "allow" ? "PermissionGranted" : "PermissionDenied", { request_id: reqId });
              return fromHook;
            }
            // In multi-turn mode, wait for the TUI to send PermissionResponse.
            // In one-shot mode, fall back to auto-deny (the user has no way
            // to respond without a live input channel).
            if (opts.multiTurn) {
              const choice = await new Promise<"allow" | "allow_session" | "deny">((resolve) => {
                pendingPermissions.set(reqId, resolve);
              });
              if (choice === "allow" || choice === "allow_session") {
                emit("PermissionGranted", { request_id: reqId });
              } else {
                emit("PermissionDenied", { request_id: reqId });
              }
              return choice;
            }
            emit("PermissionDenied", { request_id: reqId });
            return "deny";
          },
        },
      } }));
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        emit("RuntimeError", {
          message: "cumulative input token budget exhausted",
          kind: "quota_exhausted",
          severity: "error",
        });
        exitCode = 42;
        aborted = true;
      } else if (err instanceof AgentLoopError) {
        emit("RuntimeError", {
          message: "agent loop detected (repeated tool calls)",
          kind: "generic",
          severity: "error",
        });
        exitCode = 43;
        aborted = true;
      } else if (err instanceof KimiApiError) {
        emit("RuntimeError", {
          message: humanizeApiError(err),
          // The provider the request went to ("openrouter", "openai", "ollama", …).
          source: providerIdOf(llmAuthFromConfig(opts)),
          kind: "api_error",
          severity: "error",
        });
        // Recoverable from the user's POV: don't abort multi-turn sessions
        // on a single bad API call; let them try a different prompt.
      } else {
        emit("RuntimeError", {
          message: err instanceof Error ? err.message : String(err),
          kind: "generic",
          severity: "error",
        });
      }
    }
  }

  try {
    // Initial turn from -p.
    await runTurn(opts.prompt);

    // Multi-turn loop: pull follow-up prompts from the queue (fed by the
    // stdin dispatcher above). nextFollowUp() resolves to null on stdin
    // EOF, breaking the loop. PermissionResponse routing happens in the
    // dispatcher, not here, so a permission ask mid-turn never blocks
    // the multi-turn loop.
    if (opts.multiTurn && !aborted) {
      while (!aborted) {
        const text = await nextFollowUp();
        if (text === null) break;
        await runTurn(text);
      }
    }
  } finally {
    clearInterval(elapsedTimer);
    if (stdinReader) stdinReader.close();
    // Final status sweep so the TUI's last visible state is coherent
    // (phase=idle, final elapsed) before SessionEnded arrives.
    const finalSecs = Math.floor((Date.now() - sessionStartMs) / 1000);
    emit("StatusUpdate", { segments: { phase: "idle", elapsed: formatElapsed(finalSecs) } });
    process.off("SIGINT", sigintHandler);
    await endSessions("exit");
    emit("SessionEnded", {});
    console.log = origLog;
    if (exitCode !== 0) process.exitCode = exitCode;
  }
}

function formatK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `${n}`;
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m ${s}s`;
}

function tryGitBranch(): string {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", {
      encoding: "utf8",
      timeout: 200,
    }).trim();
    return out || "—";
  } catch {
    return "—";
  }
}
