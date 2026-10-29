import type { ToolDef } from "../agent/messages.js";

export interface PlanOption {
  label: string;
  plan: string;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  onTasks?: (tasks: Task[]) => void;
  onPlanOptions?: (options: PlanOption[]) => void;
  coauthor?: { name: string; email: string };
  memoryManager?: import("../memory/manager.js").MemoryManager | null;
  sessionId?: string;
  githubToken?: string;
  /** Shell override for the bash tool. If omitted, the tool auto-detects based on platform. */
  shell?: string;
  /**
   * Intent tier classified for this turn, when known. Carried into
   * hook payloads (PreToolUse / PostToolUse) so user hooks can branch
   * on tier — e.g. skip auto-format for light-tier turns, or audit
   * every heavy-tier action. Optional because code-mode sub-calls
   * and SDK consumers may not have a tier.
   */
  intentTier?: "light" | "medium" | "heavy";
  /** Credentials for tools that need to call an LLM (see llm-auth.ts). */
  llmAuth?: import("../agent/llm-auth.js").LlmAuth;
  /** Model id for tools that need to call an LLM. */
  model?: string;
  /** Optional override for the durable managed-jobs database (primarily for embedding/tests). */
  jobsDbPath?: string;
  /** Run identifier for durable tool-boundary journaling in unattended runs. */
  runId?: string;
  /** Notifies the host that a durable run budget paused execution. */
  onRunBudgetExceeded?: (reason: string) => void;
  /** Optional override for the durable run/event/timer database. */
  runsDbPath?: string;
  /** When false (default), the bash tool blocks `git push` to the repository's
   *  default branch and directs the model to open a PR instead. */
  allowDirectPush?: boolean;
  /** When true (default), the bash tool also blocks commit-creating git
   *  commands (`commit`, `merge`, `rebase`, `cherry-pick`, `revert`) and
   *  `reset --hard` on the default branch, directing the model to branch first. */
  preferPullRequests?: boolean;
  /** Session trace recorder for this call (set by the agent loop). Tools and
   *  the executor emit on it; absent or disabled means no-op. */
  trace?: import("../trace/recorder.js").TraceRecorder;
  /** Turn id stamped on trace events for this call. */
  turnId?: string | null;
  /** Set when the call is an `api.*` invocation from inside an `execute_code`
   *  sandbox: the id of the parent `execute_code` tool call. The executor then
   *  records a `code_mode_call` instead of a top-level tool_call/tool_result. */
  codeModeParentToolCallId?: string;
  /** Set by the executor when this call's ToolSpec.permissionReason asked
   *  for permission and the call was approved: the reason approved. Lets a
   *  tool tell an approved sensitive call from one that only became
   *  sensitive after the check (e.g. a hostname that re-resolved). */
  approvedSensitiveReason?: string;
  /** Per-session sha256 snapshots recorded by read and checked by edit/write. */
  fileReadHashes?: Map<string, string>;
}

export interface ToolRender {
  title: string;
  body?: string;
  diff?: { path: string; before: string; after: string };
}

export interface RunWaitRequest {
  runId: string;
  timerId: string;
  condition: "time" | "job";
  jobId?: string;
  wakeAt: number;
}

export interface ToolOutput {
  content: string;
  rawBytes: number;
  reducedBytes: number;
  /** Internal control signal: persist the wait and end this agent turn. */
  waitRequest?: RunWaitRequest;
  /** Structured facts about the execution (bash: exit code, timeout), for the trace. */
  meta?: ToolOutputMeta;
}

export interface ToolOutputMeta {
  exitCode?: number | null;
  timedOut?: boolean;
  /** bash: killed because the turn was aborted. */
  aborted?: boolean;
  /** bash: the raw streams, kept apart for PostToolUse hooks (not traced). */
  stdout?: string;
  stderr?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolSpec<Args = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  needsPermission: boolean;
  /** For a tool that normally runs without a prompt: a reason this
   *  particular call needs the user's permission (e.g. it reads a
   *  credentials file, or fetches a private network address), or null.
   *  Checked after the arguments are parsed; may be async (e.g. to resolve
   *  a hostname). */
  permissionReason?: (args: Args, ctx: ToolContext) => string | null | Promise<string | null>;
  /** What an approval of a permissionReason call covers, e.g. a URL's
   *  origin. Defaults to the resolved `path` argument, else the whole
   *  arguments. */
  permissionTarget?: (args: Args, ctx: ToolContext) => string;
  /** When true, the tool only reads state and never mutates the workspace.
   *  Read-only tools within a single turn may be executed in parallel. */
  isReadOnly?: boolean;
  /** When true, calls may run concurrently with each other and with
   *  read-only calls even though the tool is not read-only — for work
   *  that is isolated from the workspace (e.g. sandboxed subagents).
   *  Permission prompts for a concurrent batch are serialized and
   *  same-tool calls are approved together (see agent/permission-gate.ts). */
  concurrent?: boolean;
  /** In Code Mode, expose this tool directly next to `execute_code` instead
   *  of inside the sandbox API (for long-running or parallel tools that the
   *  synchronous, time-limited sandbox cannot host). */
  codeModeDirect?: boolean;
  render?: (args: Args) => ToolRender;
  run: (args: Args, ctx: ToolContext) => Promise<string | ToolOutput>;
}

export function toOpenAIToolDefs(tools: ToolSpec[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
}

export function isValidStatus(s: unknown): s is TaskStatus {
  return s === "pending" || s === "in_progress" || s === "completed";
}

export function validateTasks(input: unknown): Task[] {
  if (!Array.isArray(input)) throw new Error("tasks must be an array");
  return input.map((t, i) => {
    if (!t || typeof t !== "object") throw new Error(`tasks[${i}] must be an object`);
    const rec = t as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : String(i + 1);
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (!title) throw new Error(`tasks[${i}].title is required`);
    const status: TaskStatus = isValidStatus(rec.status) ? rec.status : "pending";
    return { id, title, status };
  });
}
