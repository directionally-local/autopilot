import type { ChatMessage, Usage } from "../agent/messages.js";
import type { ToolSpec } from "../tools/registry.js";
import type { Task } from "../tools/registry.js";
import type { KimiConfig } from "../config.js";
import type { OpenRouterProviderPrefs } from "../agent/client.js";
import type { PermissionRequest, PermissionDecision } from "../tools/executor.js";

export type { ChatMessage, ToolSpec, Task, KimiConfig, PermissionRequest, PermissionDecision };

export interface CreateSessionOptions {
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
  /** Override config. If omitted, loads from ~/.config/autopilot/config.json */
  config?: Partial<KimiConfig>;
  /** Session ID for persistence. If omitted, creates a new session. */
  sessionId?: string;
  /** Which tools to enable. Defaults to ALL_TOOLS. */
  tools?: ToolSpec[];
  /** Enable local structured memory. Defaults to config value. */
  memoryEnabled?: boolean;
  /** Enable LSP integration. Defaults to config value. */
  lspEnabled?: boolean;
  /** Enable cost attribution. Defaults to config value. */
  costAttribution?: boolean;
  /** OpenRouter provider-routing preferences for this session (merged over config.openrouterProvider). */
  provider?: OpenRouterProviderPrefs;
  /** Custom permission handler. Defaults to auto-deny in plan mode, ask callback in edit mode. */
  permissionHandler?: PermissionHandler;
  /** Called when the agent detects KIMI.md drift. */
  onKimiMdStale?: () => void;
  /**
   * M6.1: enable user-configured lifecycle hooks loaded from
   * `~/.config/autopilot/settings.json` + `<cwd>/.autopilot/settings.json`
   * (the legacy kimiflare paths are read too).
   * Default `false` (SDK is a primitive; opt in if you want the
   * TUI's hook behavior).
   */
  enableHooks?: boolean;
  /**
   * End this session if the process exits without `dispose()`: on
   * `beforeExit`, SIGTERM, SIGINT, SIGHUP or an uncaught exception, run
   * SessionEnd hooks and flush OpenTelemetry within a 3 s budget. The SDK
   * never calls `process.exit` and never changes whether the process exits:
   * when the host has its own signal listener the host still decides; when
   * it doesn't, the signal is re-raised after the work so the process dies
   * from it as before. After an uncaught exception or `process.exit()` the
   * work is only started (nothing asynchronous can finish). `dispose()`
   * remains the reliable way to end a session. Default `true`; pass `false`
   * if your app manages its lifecycle and calls `dispose()` itself.
   */
  handleProcessExit?: boolean;
}

export interface PromptOptions {
  /** Attach images to the prompt. */
  images?: Array<{ path: string } | { data: string; mimeType: string }>;
  /** Override mode for this prompt only. */
  mode?: "plan" | "edit" | "auto";
  /** Override max tool iterations for this prompt only. */
  maxToolIterations?: number;
}

export type SessionEvent =
  // Connection / lifecycle
  | { type: "session.start"; sessionId: string; cwd: string }
  | { type: "session.end"; reason: "complete" | "aborted" | "error"; error?: string }

  // Message streaming
  | { type: "message.start"; messageId: string; role: "user" | "assistant" }
  | { type: "message.delta"; messageId: string; text: string }
  | { type: "message.reasoning"; messageId: string; text: string }
  | { type: "message.end"; messageId: string }

  // Tool execution
  | { type: "tool.start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool.result"; toolCallId: string; toolName: string; result: string; isError: boolean }

  // Usage / cost
  | { type: "usage"; inputTokens: number; outputTokens: number; reasoningTokens?: number; cost?: number }

  // Permission
  | { type: "permission.request"; requestId: string; toolName: string; args: unknown }
  // M2.2: accepts either legacy string or typed `PermissionDecisionResult`
  // shape. Existing wire-format consumers can keep matching on string
  // values; new consumers can switch on the `{ decision, scope }` shape.
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }

  // Tasks
  | { type: "tasks.update"; tasks: Task[] }

  // Warnings
  | { type: "warning"; message: string }
  /** A hook timed out, crashed or couldn't start (#889). Sent once per hook
   *  per session; `count` is how many times it has failed so far. `allowed`
   *  is false when the hook's `failClosed` made the action block. */
  | {
      type: "hook.failed";
      hookId: string;
      event: string;
      failure: "timeout" | "spawn_failed" | "command_not_found" | "nonzero_exit";
      reason: string;
      allowed: boolean;
      failClosed: boolean;
      count: number;
      message: string;
    }
  /** Older turns were archived so the next request fits the model's input budget. */
  | { type: "context.compacted"; tokensBefore: number; tokensAfter: number; turnsRemoved: number; artifactsArchived: number }

  // Status
  | { type: "status"; status: "idle" | "streaming" | "tool_executing" | "compacting" | "error" }

  // Background subagents (`subagent` with background: true)
  | { type: "worker.finished"; workerId: string; index: number; task: string; status: string; costUsd?: number };

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  turnCount: number;
}

export interface SessionStatus {
  isStreaming: boolean;
  isCompacting: boolean;
  pendingSteer: string[];
  pendingFollowUp: string[];
  currentMode: import("../mode.js").Mode;
}

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface KimiFlareSession {
  readonly sessionId: string;
  readonly cwd: string;
  readonly isStreaming: boolean;
  readonly messages: ChatMessage[];
  /** The session's trace recorder (a no-op unless `config.trace.enabled`). Hosts
   *  such as the eval runner append their own outcome events to it. */
  readonly trace: import("../trace/recorder.js").TraceRecorder;

  // Prompting
  /** Run a turn. Called while a turn is streaming, the text is treated as a steer. */
  prompt(text: string, options?: PromptOptions): Promise<void>;
  /** Inject guidance into the running turn: delivered at the next tool
   *  boundary, or before the final answer (the turn continues to address it).
   *  Ignored when no turn is running. */
  steer(text: string): Promise<void>;
  /** Queue a message to run as its own turn after the current (or next)
   *  prompt's turn completes successfully. */
  followUp(text: string): Promise<void>;

  // Control
  abort(): Promise<void>;
  setModel(modelId: string): void;
  setMode(mode: "plan" | "edit" | "auto"): void;
  setReasoningEffort(level: "low" | "medium" | "high"): void;
  resolvePermission(requestId: string, decision: PermissionDecision): void;

  // Events
  subscribe(listener: (event: SessionEvent) => void): () => void;

  // State
  getUsage(): SessionUsage;
  getStatus(): SessionStatus;
  save(): Promise<void>;
  /** Release resources. `traceEndReason` sets the `session_end` reason recorded on the trace (default "exit"). */
  dispose(options?: { traceEndReason?: import("../trace/types.js").SessionEndReason }): void;
}
