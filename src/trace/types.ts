/**
 * Trace event schema (v1).
 *
 * One `trace.jsonl` per session, one JSON object per line. Every line is a
 * {@link TraceEvent}: the shared {@link TraceEventBase} fields plus a
 * `payload` whose shape is determined by `type` (see {@link TracePayloads}).
 *
 * Large bodies never live inline: a `*_blob` field holds the sha256 of a
 * file under `<sessionTraceDir>/blobs/<sha256>` (see blobs.ts).
 *
 * Schema source: docs/plans/trace-and-dataset-dev-plan.md §1.2.
 */

export const TRACE_SCHEMA_VERSION = 1 as const;

export type TraceEventType =
  | "session_start"
  | "user_message"
  | "llm_request"
  | "llm_response"
  | "tool_call"
  | "permission_decision"
  | "tool_result"
  | "code_mode_call"
  | "compaction"
  | "guardrail"
  | "completion_check"
  | "subagent"
  | "turn_end"
  | "outcome"
  | "session_end";

export interface TraceEventBase {
  v: typeof TRACE_SCHEMA_VERSION;
  /** ISO-8601 timestamp of the emit. */
  ts: string;
  /** Monotonically increasing per session file, starting at 0. */
  seq: number;
  session_id: string;
  turn_id: string | null;
  type: TraceEventType;
}

/** Which surface created the session. */
export type TraceSessionMode = "tui" | "print" | "sdk" | "server" | "eval" | "worker";

export interface SessionStartPayload {
  autopilot_version: string;
  /** git HEAD of the running Autopilot checkout, or null when not a checkout. */
  harness_commit: string | null;
  cwd: string;
  repo_remote?: string | null;
  repo_head?: string | null;
  model: string;
  mode: TraceSessionMode;
  /** KimiConfig with credential-bearing keys replaced by "<redacted>". */
  config: Record<string, unknown>;
  tool_profile: string;
  /** Active model profile (#999), absent when the model uses the default behavior. */
  model_profile?: string;
  /** sha256 of the JSON array of ToolDef sent to the model. */
  tool_schemas_sha: string;
  /** Blob sha of that same JSON array. */
  tools_blob: string;
  system_prompt_sha: string;
}

export type UserMessageSource = "typed" | "deny_feedback" | "continuation" | "eval" | "sdk" | "print" | "server";

export interface UserMessagePayload {
  content_blob: string;
  source: UserMessageSource;
  /** Number of attachments (images, files) on the message. */
  attachments: number;
}

export interface LlmRequestPayload {
  request_id: string;
  attempt: number;
  model: string;
  /** Request body minus `messages` and `tools`. */
  params: Record<string, unknown>;
  /** Blob sha of the exact serialized body sent over the wire. */
  request_blob: string;
  messages_sha: string;
  tools_sha: string;
  estimated_tokens: number;
  /** Bytes of the serialized body (uploaded in full on every call). */
  body_bytes?: number;
}

export interface TraceToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface TraceUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  cost?: number;
}

export interface LlmResponsePayload {
  request_id: string;
  text_blob: string;
  reasoning_blob?: string;
  reasoning_details?: unknown[];
  tool_calls: TraceToolCall[];
  finish_reason: string | null;
  usage?: TraceUsage;
  generation_id?: string;
  latency_ms: number;
  /** Request start → response headers: includes uploading the body, so slow uploads show up here. */
  headers_ms?: number;
  /** Request start → first streamed token. */
  first_token_ms?: number;
  aborted: boolean;
  error?: string;
}

export interface ToolCallPayload {
  tool_call_id: string;
  name: string;
  args_blob: string;
  /** The parsed arguments, inline when their JSON is ≤ 2 KB. */
  args_inline?: Record<string, unknown>;
  needs_permission: boolean;
  code_mode_redirected: boolean;
}

export type PermissionDecision = "allow" | "allow_session" | "deny" | "auto";

export interface PermissionDecisionPayload {
  tool_call_id: string;
  decision: PermissionDecision;
  feedback_text?: string;
  latency_ms: number;
  /** True when the user was actually prompted; false for automatic decisions.
   *  Auto decisions record `latency_ms: 0`, so without this flag a trace cannot
   *  tell "no prompt" apart from "answered instantly" (#968). */
  prompted?: boolean;
}

export interface ToolResultPayload {
  tool_call_id: string;
  name: string;
  ok: boolean;
  error_code?: string;
  raw_blob: string;
  raw_bytes: number;
  reduced_blob: string;
  reduced_bytes: number;
  artifact_id?: string;
  exit_code?: number;
  timed_out?: boolean;
  duration_ms: number;
}

export interface CodeModeCallPayload {
  parent_tool_call_id: string;
  name: string;
  args_blob: string;
  raw_blob: string;
  ok: boolean;
  duration_ms: number;
}

export type CompactionMethod = "compiled" | "llm" | "preflight";

export interface CompactionPayload {
  method: CompactionMethod;
  tokens_before: number;
  tokens_after: number;
  turns_removed: number;
  artifacts_archived?: number;
  summary_blob?: string;
}

export type GuardrailKind =
  | "loop_recovery"
  | "loop_stopped"
  | "limit_ceiling"
  | "code_mode_redirect_cap"
  /** `maxToolIterations` reached and the counter reset automatically. */
  | "limit_reset"
  /** `maxToolIterations` reached with `toolLimitBehavior: "stop"`. */
  | "limit_stopped";

export interface GuardrailPayload {
  kind: GuardrailKind;
  message: string;
}

export interface CompletionCheckPayload {
  probability: number;
  nudged: boolean;
}

export interface SubagentPayload {
  worker_id: string;
  mode: string;
  child_session_id?: string;
  status: string;
  cost_usd?: number;
  duration_ms?: number;
}

export type TurnEndReason = "complete" | "aborted" | "error" | "guardrail" | "needs_input";

export interface TurnEndPayload {
  reason: TurnEndReason;
  /** Tool names in call order. */
  tools_used: string[];
  cost_usd?: number;
  duration_ms: number;
  final_text_blob?: string;
}

export type VerificationCategory = "test" | "lint" | "typecheck" | "build";
export type NextMessageClassification = "continue" | "correction" | "new_task" | "question" | "other";
export type RevertHow = "clear" | "restore_checkpoint" | "git_checkout";

/** Outcome signals a dataset builder can filter or weight on (plan §3.1). */
export type OutcomePayload =
  | {
      kind: "git_delta";
      turn_id: string;
      files_changed: number;
      insertions: number;
      deletions: number;
      /** Blob of the raw `git diff --numstat` output after the turn. */
      numstat_blob: string;
      /** Blob of the patch, when it is at most 512 KB. */
      patch_blob?: string;
    }
  | {
      kind: "verification";
      turn_id: string;
      tool_call_id: string;
      command: string;
      category: VerificationCategory;
      exit_code: number;
    }
  | { kind: "rating"; turn_id: string; value: "good" | "bad"; reason?: string }
  | { kind: "next_message"; turn_id: string; classification: NextMessageClassification; classifier: "regex" }
  | { kind: "reverted"; turn_id: string; how: RevertHow }
  | {
      kind: "test_verdict";
      task_id: string;
      passed: boolean;
      command: string;
      exit_code: number;
      duration_ms: number;
      log_blob: string;
    };

export type SessionEndReason = "exit" | "clear" | "restore_checkpoint" | "crash" | "eval_done";

export interface SessionEndPayload {
  reason: SessionEndReason;
  total_cost_usd?: number;
}

export interface TracePayloads {
  session_start: SessionStartPayload;
  user_message: UserMessagePayload;
  llm_request: LlmRequestPayload;
  llm_response: LlmResponsePayload;
  tool_call: ToolCallPayload;
  permission_decision: PermissionDecisionPayload;
  tool_result: ToolResultPayload;
  code_mode_call: CodeModeCallPayload;
  compaction: CompactionPayload;
  guardrail: GuardrailPayload;
  completion_check: CompletionCheckPayload;
  subagent: SubagentPayload;
  turn_end: TurnEndPayload;
  outcome: OutcomePayload;
  session_end: SessionEndPayload;
}

export type PayloadFor<T extends TraceEventType> = TracePayloads[T];

export type TraceEvent<T extends TraceEventType = TraceEventType> = T extends TraceEventType
  ? TraceEventBase & { type: T; payload: PayloadFor<T> }
  : never;
