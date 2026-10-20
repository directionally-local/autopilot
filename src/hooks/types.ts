/**
 * User-configured lifecycle hooks (M6.1). A hook is a shell command
 * the harness fires at a specific moment in an agent turn. The agent
 * doesn't decide whether a hook fires — the harness does, based on
 * config the user pre-registers in
 *   `~/.config/kimiflare/settings.json`      (global)
 *   `.kimiflare/settings.json`               (per-project, overrides)
 *
 * See README "## Hooks" for the user-facing schema docs and examples.
 */

/** The five lifecycle events a hook can subscribe to. */
export type HookEvent =
  /** A tool call is about to run. Blocking: exit 2 (reason on stderr) or a
   *  `permissionDecision: "deny"` JSON on stdout cancels the call; other
   *  failures (non-zero exit, timeout, missing command) log and allow. */
  | "PreToolUse"
  /** A tool call just finished. Informational; exit code ignored. */
  | "PostToolUse"
  /** The user submitted a prompt. Blocking, same rules as PreToolUse
   *  (exit 2 or `decision: "block"` cancels the turn). */
  | "UserPromptSubmit"
  /** A turn ended cleanly. Informational; common use is notification
   *  (terminal bell, desktop notification). */
  | "Stop"
  /** Auto-compaction is about to run. Informational; common use is
   *  snapshotting the conversation before it shrinks. */
  | "PreCompact"
  /** A session's first turn in this process (new, or resumed). Informational. */
  | "SessionStart"
  /** The host is shutting down (or the session was cleared). Informational. */
  | "SessionEnd";

/** All hook events, useful for iteration. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
] as const;

export interface HookConfig {
  /** Stable id for `/hooks enable|disable <id>`. Falls back to a
   *  hash of `event + command` when omitted, so user-written entries
   *  without an id still get a deterministic handle. */
  id?: string;
  /** A regex (anchored, case-sensitive). For `PreToolUse` and
   *  `PostToolUse`, matched against the tool name. Empty / omitted =
   *  matches everything. Ignored for events without a matcher field. */
  matcher?: string;
  /** The shell command to run. Receives the event payload as JSON on
   *  stdin and as `KIMIFLARE_HOOK_*` environment variables. */
  command: string;
  /** Per-hook timeout in milliseconds. Default 30 000. Hung hooks are
   *  killed and logged as a warning; the action proceeds (fail-open),
   *  including for `PreToolUse`. */
  timeoutMs?: number;
  /** Bundled "recommended" hooks ship with `enabled: false` so the
   *  user opts in via `/hooks enable <id>`. User-written hooks default
   *  to `enabled: true`. */
  enabled?: boolean;
  /** Optional one-liner shown by `/hooks list`. */
  description?: string;
  /** Internal: where the hook came from. Set by the loader, not by
   *  users. */
  source?: "global" | "project" | "recommended";
}

/** Shape of `~/.config/kimiflare/settings.json` and the
 *  `.kimiflare/settings.json` project file. Only the `hooks` key is
 *  meaningful here; future settings (M6.2 pattern allowlists, etc.)
 *  will add sibling keys. */
export interface KimiflareSettings {
  hooks?: Partial<Record<HookEvent, HookConfig[]>>;
}

// ── Per-event payload shapes ─────────────────────────────────────────────
// Sent to the hook on stdin as JSON, also exposed as KIMIFLARE_HOOK_*
// env vars (a few fields per event, for shell-one-liner ergonomics; the
// full KIMIFLARE_HOOK_PAYLOAD copy only for payloads up to 32 KiB).

export interface BaseHookPayload {
  event: HookEvent;
  session_id: string | null;
  cwd: string;
}

/** Intent classification tier carried into PreToolUse / PostToolUse /
 *  UserPromptSubmit payloads when known. Optional because:
 *    - Code-mode sub-calls don't always have it.
 *    - SDK / CLI consumers may not run intent classification.
 *  When absent, the hook command sees no `tier` field in the JSON
 *  payload and no `KIMIFLARE_HOOK_TIER` env var. */
export type IntentTier = "light" | "medium" | "heavy";

export interface PreToolUsePayload extends BaseHookPayload {
  event: "PreToolUse";
  tool: string;
  /** The model's id for this call (also on PostToolUse), to pair the two. */
  tool_call_id?: string;
  args: Record<string, unknown>;
  tier?: IntentTier;
}

export interface PostToolUsePayload extends BaseHookPayload {
  event: "PostToolUse";
  tool: string;
  tool_call_id?: string;
  args: Record<string, unknown>;
  tier?: IntentTier;
  result: {
    ok: boolean;
    content: string;
    errorCode?: string;
  };
}

export interface UserPromptSubmitPayload extends BaseHookPayload {
  event: "UserPromptSubmit";
  prompt: string;
  tier?: IntentTier;
}

export interface StopPayload extends BaseHookPayload {
  event: "Stop";
}

export interface PreCompactPayload extends BaseHookPayload {
  event: "PreCompact";
}

export interface SessionStartPayload extends BaseHookPayload {
  event: "SessionStart";
  /** "startup" for a new session, "resume" when it already has history. */
  source: "startup" | "resume";
  model?: string;
  provider?: string;
}

export interface SessionEndPayload extends BaseHookPayload {
  event: "SessionEnd";
  reason: "exit" | "clear";
}

export type HookPayload =
  | PreToolUsePayload
  | PostToolUsePayload
  | UserPromptSubmitPayload
  | StopPayload
  | PreCompactPayload
  | SessionStartPayload
  | SessionEndPayload;

/** Outcome of running one hook. */
export interface HookOutcome {
  /** Hook id (for logging / surfacing). */
  id: string;
  /** Process exit code; `null` on timeout / spawn failure. */
  exitCode: number | null;
  /** Stdout, trimmed and capped at 4 KB. */
  stdout: string;
  /** Stderr, trimmed and capped at 4 KB. */
  stderr: string;
  /** True if the hook timed out before exiting. */
  timedOut: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** JSON decision parsed from stdout (exit 0 only), if any. */
  decision?: "allow" | "deny" | "ask";
  /** `permissionDecisionReason` / `reason` from that JSON. */
  decisionReason?: string;
}

/** Aggregated outcome of all hooks fired for one event. */
export interface HookEventOutcome {
  outcomes: HookOutcome[];
  /** True if a hook blocked the action: exit 2, or a deny/block JSON
   *  decision. Only meaningful for `PreToolUse` and `UserPromptSubmit`. */
  vetoed: boolean;
  /** Why it was blocked (exit 2: stderr, else stdout; JSON: the decision
   *  reason) — shown to the model / user. */
  vetoReason: string;
  /** Combined JSON decision across hooks (deny > ask > allow). Absent when
   *  no hook printed one. `ask` means: run the normal permission prompt
   *  even if the tool or session would otherwise skip it. */
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
}
