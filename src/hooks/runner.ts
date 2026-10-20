import { spawn } from "node:child_process";
import type {
  HookConfig,
  HookEvent,
  HookEventOutcome,
  HookFailure,
  HookFailureKind,
  HookOutcome,
  HookPayload,
  IntentTier,
  PermissionRequestPayload,
  PostToolUseFailurePayload,
  PostToolUsePayload,
  PreToolUsePayload,
} from "./types.js";
import { logger } from "../util/logger.js";
import { join } from "node:path";
import { sessionsDir } from "../sessions.js";
import { claudeToolFields, hookMatcherMatches, hookMatcherNames } from "./claude-compat.js";
import { BEACON_HARNESS_ATTR, HARNESS_NAME } from "../util/harness.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_CAP_BYTES = 4 * 1024;
/** Raw stdout kept for JSON-decision parsing (before the 4 KB display cap). */
const DECISION_STDOUT_CAP_BYTES = 64 * 1024;

/**
 * Largest payload copied into `KIMIFLARE_HOOK_PAYLOAD`. Linux rejects any
 * single env var over 128 KiB (MAX_ARG_STRLEN) with E2BIG, and every OS caps
 * the env + argv total, so a big `write` used to make the spawn fail. Above
 * this the env copy is omitted (`KIMIFLARE_HOOK_PAYLOAD_OMITTED=1`) and the
 * hook reads the payload from stdin, which has no size limit.
 */
export const HOOK_ENV_PAYLOAD_MAX_BYTES = 32 * 1024;

/** Exit code that blocks a blocking event (Claude Code semantics). */
export const HOOK_BLOCK_EXIT_CODE = 2;

/** Events a hook can block (exit 2, or a deny/block JSON decision). */
function isVetoEvent(event: HookEvent): boolean {
  return event === "PreToolUse" || event === "UserPromptSubmit" || event === "PermissionRequest";
}

/** Events whose payload describes one tool call (tool, args, tool_call_id). */
type ToolEventPayload = PreToolUsePayload | PostToolUsePayload | PostToolUseFailurePayload | PermissionRequestPayload;

function isToolEventPayload(payload: HookPayload): payload is ToolEventPayload {
  return (
    payload.event === "PreToolUse" ||
    payload.event === "PostToolUse" ||
    payload.event === "PostToolUseFailure" ||
    payload.event === "PermissionRequest"
  );
}

export type HookPermissionDecision = "allow" | "deny" | "ask";

export interface ParsedHookDecision {
  decision: HookPermissionDecision;
  reason?: string;
}

/**
 * Read a Claude Code-style JSON decision from a hook's stdout:
 *   { "hookSpecificOutput": { "permissionDecision": "allow"|"deny"|"ask",
 *                             "permissionDecisionReason": "..." } }
 * plus the older top-level `{ "decision": "block"|"approve", "reason" }`
 * form (still what Claude Code's UserPromptSubmit hooks print). Returns
 * null for anything else, including non-JSON stdout, so plain-text hooks
 * keep their old behaviour.
 */
export function parseHookDecision(stdout: string): ParsedHookDecision | null {
  const text = stdout.trim();
  if (!text.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const specific = obj.hookSpecificOutput;
  if (specific && typeof specific === "object" && !Array.isArray(specific)) {
    const s = specific as Record<string, unknown>;
    const d = s.permissionDecision;
    if (d === "allow" || d === "deny" || d === "ask") {
      const reason = typeof s.permissionDecisionReason === "string" ? s.permissionDecisionReason : undefined;
      return { decision: d, ...(reason ? { reason } : {}) };
    }
    // Claude Code's PermissionRequest form:
    //   { "hookSpecificOutput": { "decision": { "behavior": "allow"|"deny", "message": "..." } } }
    const nested = s.decision;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const n = nested as Record<string, unknown>;
      const reason = typeof n.message === "string" ? n.message : undefined;
      if (n.behavior === "allow" || n.behavior === "deny" || n.behavior === "ask") {
        return { decision: n.behavior, ...(reason ? { reason } : {}) };
      }
    }
  }
  const legacy = obj.decision;
  const reason = typeof obj.reason === "string" ? obj.reason : undefined;
  if (legacy === "block" || legacy === "deny") return { decision: "deny", ...(reason ? { reason } : {}) };
  if (legacy === "approve" || legacy === "allow") return { decision: "allow", ...(reason ? { reason } : {}) };
  if (legacy === "ask") return { decision: "ask", ...(reason ? { reason } : {}) };
  return null;
}

/**
 * Extract a few convenient fields from the payload to expose as
 * `AUTOPILOT_HOOK_*` env vars (each also as its legacy `KIMIFLARE_HOOK_*`
 * name). The full payload is always on stdin;
 * `KIMIFLARE_HOOK_PAYLOAD` carries a copy only when it is at most
 * HOOK_ENV_PAYLOAD_MAX_BYTES. Env vars are friendlier in shell
 * one-liners like:
 *   `case "$KIMIFLARE_HOOK_PATH" in *.env) echo no >&2; exit 2 ;; esac`
 */
export function buildHookEnv(payload: HookPayload, payloadJson?: string): Record<string, string> {
  const json = payloadJson ?? JSON.stringify(hookWirePayload(payload));
  const env: Record<string, string> = {
    KIMIFLARE_HOOK_EVENT: payload.event,
    KIMIFLARE_HOOK_CWD: payload.cwd,
  };
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= HOOK_ENV_PAYLOAD_MAX_BYTES) {
    env.KIMIFLARE_HOOK_PAYLOAD = json;
  } else {
    env.KIMIFLARE_HOOK_PAYLOAD_OMITTED = "1";
    env.KIMIFLARE_HOOK_PAYLOAD_BYTES = String(bytes);
  }
  if (payload.session_id) env.KIMIFLARE_HOOK_SESSION_ID = payload.session_id;
  if (isToolEventPayload(payload)) {
    const p = payload;
    env.KIMIFLARE_HOOK_TOOL = p.tool;
    // Common per-tool path arg — surfaced for ergonomic shell tests.
    const path = (p.args as Record<string, unknown>).path;
    if (typeof path === "string") env.KIMIFLARE_HOOK_PATH = path;
    if (p.tier) env.KIMIFLARE_HOOK_TIER = p.tier;
    if (p.event === "PostToolUse" || p.event === "PostToolUseFailure") {
      env.KIMIFLARE_HOOK_RESULT_OK = String(p.result.ok);
      const ec = p.result.errorCode;
      if (ec) env.KIMIFLARE_HOOK_RESULT_ERROR_CODE = ec;
    }
    if (p.event === "PermissionRequest") env.KIMIFLARE_HOOK_MODE = p.mode;
  }
  if (payload.event === "UserPromptSubmit") {
    const p = payload as { tier?: IntentTier };
    if (p.tier) env.KIMIFLARE_HOOK_TIER = p.tier;
  }
  // #887: every KIMIFLARE_HOOK_* var is also set as AUTOPILOT_HOOK_* (same
  // value); the old names stay for existing scripts.
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("KIMIFLARE_HOOK_")) env[`AUTOPILOT_HOOK_${k.slice("KIMIFLARE_HOOK_".length)}`] = v;
  }
  return env;
}

/**
 * The payload as hooks receive it: Autopilot's own fields, plus the names
 * Claude Code hooks use (hook_event_name, tool_name, tool_input,
 * tool_response, transcript_path). Existing hooks keep working, Claude Code
 * hook scripts work unchanged, and tools that speak that shape (e.g. Agent
 * Beacon's `beacon-hooks`) can read Autopilot events. No credentials are
 * ever part of a payload.
 */
export function hookWirePayload(payload: HookPayload): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    ...payload,
    hook_event_name: payload.event,
    client: HARNESS_NAME,
    [BEACON_HARNESS_ATTR]: HARNESS_NAME,
  };
  if (payload.session_id) wire.transcript_path = join(sessionsDir(), `${payload.session_id}.json`);
  // Claude Code's tool names and shapes (tool_name, tool_input, tool_response, error): see claude-compat.ts.
  if (isToolEventPayload(payload)) {
    Object.assign(wire, claudeToolFields(payload));
    if (payload.tool_call_id) wire.tool_use_id = payload.tool_call_id;
    if (payload.event === "PermissionRequest") wire.permission_mode = claudePermissionMode(payload.mode);
  }
  return wire;
}

/** Autopilot's mode under Claude Code's `permission_mode` names. */
function claudePermissionMode(mode: string): string {
  if (mode === "edit") return "default";
  if (mode === "auto") return "bypassPermissions";
  return mode;
}

function capStream(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= STREAM_CAP_BYTES) return s;
  // Slice by characters until we're under the byte cap. Simple and
  // good enough; we're not in a tight loop here.
  let cut = s;
  while (Buffer.byteLength(cut, "utf8") > STREAM_CAP_BYTES) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return `${cut}\n[…truncated]`;
}

/**
 * Spawn-and-run interface. Extracted so tests can inject a fake
 * spawner without bringing up real shells. The default
 * implementation uses `child_process.spawn` via the user's shell.
 */
export interface SpawnHookImpl {
  (
    command: string,
    payloadJson: string,
    env: NodeJS.ProcessEnv,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>;
}

const defaultSpawn: SpawnHookImpl = (command, payloadJson, env, cwd, timeoutMs, signal) =>
  new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (
      exitCode: number | null,
      timedOut = false,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(null, true);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(null, true);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (err) => {
      stderr += `${stderr ? "\n" : ""}spawn failed: ${err.message}`;
      finish(null);
    });
    child.on("exit", (code) => finish(code));
    // A hook that exits without reading stdin closes the pipe; writing a
    // large payload then raises EPIPE on the stream. Swallow it: the exit
    // code is what matters.
    child.stdin.on("error", () => {});
    try {
      child.stdin.end(payloadJson);
    } catch {
      // ignore — child may already have exited
    }
  });

let spawnImpl: SpawnHookImpl = defaultSpawn;

/** Test-only: swap the spawn implementation. Pass `null` to restore. */
export function setSpawnHookImplForTesting(impl: SpawnHookImpl | null): void {
  spawnImpl = impl ?? defaultSpawn;
}

/** Run a single hook. Best-effort: never throws. */
export async function runHook(
  hook: HookConfig,
  payload: HookPayload,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const start = Date.now();
  const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const json = JSON.stringify(hookWirePayload(payload));
  const env = { ...process.env, ...buildHookEnv(payload, json) };
  const id = hook.id ?? "anonymous";
  let result: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    result = await spawnImpl(hook.command, json, env, payload.cwd, timeoutMs, signal);
  } catch (e) {
    return {
      id,
      exitCode: null,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
      timedOut: false,
      durationMs: Date.now() - start,
    };
  }
  const rawStdout = result.stdout.trim();
  const decision =
    result.exitCode === 0 && Buffer.byteLength(rawStdout, "utf8") <= DECISION_STDOUT_CAP_BYTES
      ? parseHookDecision(rawStdout)
      : null;
  return {
    id,
    exitCode: result.exitCode,
    ...(decision ? { decision: decision.decision, ...(decision.reason ? { decisionReason: decision.reason } : {}) } : {}),
    stdout: capStream(rawStdout),
    stderr: capStream(result.stderr.trim()),
    timedOut: result.timedOut,
    durationMs: Date.now() - start,
  };
}

/** Filter hooks for an event by matcher (regex on tool name for the
 *  events that have one) and enabled state. `toolName` is a native name,
 *  whose Claude Code name is tried too, or the full list of names to test
 *  (see hookMatcherNames). */
export function filterHooks(
  hooks: HookConfig[] | undefined,
  toolName: string | readonly string[] | null,
): HookConfig[] {
  if (!hooks || hooks.length === 0) return [];
  const names = typeof toolName === "string" ? (toolName ? hookMatcherNames(toolName) : null) : toolName;
  return hooks.filter((h) => {
    if (h.enabled === false) return false;
    if (!names || names.length === 0) return true; // matcher is meaningless without a tool name
    return hookMatcherMatches(h.matcher, names);
  });
}

/**
 * Fire every matching hook for an event, in order. Sequential rather
 * than parallel so users can reason about ordering — and so the first
 * blocking hook short-circuits the rest for blocking events.
 *
 * Blocking semantics (PreToolUse, UserPromptSubmit, PermissionRequest), as
 * in Claude Code:
 *   - exit 2 blocks; stderr (else stdout) is the reason given to the model.
 *   - exit 0 with a JSON decision on stdout: `deny` (or legacy
 *     `decision: "block"`) blocks with `permissionDecisionReason`; `ask`
 *     forces the normal permission prompt; `allow` lets the call proceed.
 *     Precedence across hooks: deny > ask > allow.
 *   - exit 0 with anything else on stdout: allow.
 *   - any other exit code, a timeout, or a spawn failure (e.g. 127,
 *     command not found) logs a warning and ALLOWS — a broken hook must not
 *     wedge every tool call — unless the hook sets `failClosed: true`, in
 *     which case it blocks. Either way the failure is returned in
 *     `failures` so the host can tell the user (see HooksManager).
 *   - an aborted turn (signal) blocks, since the caller is giving up anyway.
 */
export async function runHooks(
  event: HookEvent,
  hooks: HookConfig[] | undefined,
  payload: HookPayload,
  toolName: string | readonly string[] | null = null,
  signal?: AbortSignal,
): Promise<HookEventOutcome> {
  const matched = filterHooks(hooks, toolName);
  const outcomes: HookOutcome[] = [];
  const failures: HookFailure[] = [];
  const veto = isVetoEvent(event);
  let vetoed = false;
  let vetoReason = "";
  let permissionDecision: HookPermissionDecision | undefined;
  let permissionDecisionReason: string | undefined;
  for (const hook of matched) {
    const outcome = await runHook(hook, payload, signal);
    outcomes.push(outcome);
    if (veto && signal?.aborted) {
      vetoed = true;
      vetoReason = `hook ${outcome.id} interrupted: the turn was aborted`;
      break;
    }
    // Killed because the turn was aborted: not the hook's fault.
    if (signal?.aborted) continue;
    // A hook that didn't run to an answer: timed out, couldn't start, or
    // exited non-zero other than 2 (exit 2 is a decision). Blocking events
    // fail open unless the hook is failClosed.
    const failure = classifyHookFailure(outcome, hook);
    if (failure) {
      const failClosed = veto && hook.failClosed === true;
      const record: HookFailure = {
        hookId: outcome.id,
        event,
        kind: failure.kind,
        reason: failure.reason,
        allowed: !failClosed,
        failClosed,
      };
      failures.push(record);
      (veto || failure.kind !== "nonzero_exit" ? logger.warn : logger.info)(`hook:${failure.kind}`, {
        event,
        id: outcome.id,
        reason: failure.reason,
        ...(outcome.exitCode !== null ? { exitCode: outcome.exitCode } : {}),
        ...(outcome.stderr ? { stderr: outcome.stderr.slice(0, 500) } : {}),
        ...(veto ? (failClosed ? { failClosed: true } : { failOpen: true }) : {}),
      });
      if (failClosed) {
        vetoed = true;
        vetoReason = `hook ${outcome.id} failed (${failure.reason}) and is set to failClosed, so this was blocked`;
        break;
      }
      continue;
    }
    if (outcome.exitCode !== 0) {
      // Exit 2 on a blocking event: the hook's decision to block.
      if (veto && outcome.exitCode === HOOK_BLOCK_EXIT_CODE) {
        vetoed = true;
        vetoReason = outcome.stderr || outcome.stdout || `hook ${outcome.id} exited ${HOOK_BLOCK_EXIT_CODE}`;
        // First block wins: don't run e.g. a slow type-check after a fast deny.
        break;
      }
      // Exit 2 on an informational event: nothing to block; noted only.
      logger.info("hook:nonzero_exit", { event, id: outcome.id, exitCode: outcome.exitCode });
      continue;
    }
    if (!veto || !outcome.decision) continue;
    if (outcome.decision === "deny") {
      vetoed = true;
      vetoReason = outcome.decisionReason || outcome.stderr || `hook ${outcome.id} denied the call`;
      permissionDecision = "deny";
      permissionDecisionReason = outcome.decisionReason;
      break;
    }
    if (outcome.decision === "ask") {
      if (permissionDecision !== "ask") {
        permissionDecision = "ask";
        permissionDecisionReason = outcome.decisionReason;
      }
    } else if (!permissionDecision) {
      permissionDecision = "allow";
      permissionDecisionReason = outcome.decisionReason;
    }
  }
  return {
    outcomes,
    vetoed,
    vetoReason,
    ...(permissionDecision ? { permissionDecision } : {}),
    ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
    failures,
  };
}

/** Shell exit code for "command not found". */
const COMMAND_NOT_FOUND_EXIT_CODE = 127;

function firstLine(s: string, max = 200): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Classify a hook outcome as a failure, or null when the hook answered:
 * exit 0, or exit 2 (a block on blocking events; a deliberate signal on
 * the others).
 */
export function classifyHookFailure(
  outcome: HookOutcome,
  hook: HookConfig,
): { kind: HookFailureKind; reason: string } | null {
  const detail = firstLine(outcome.stderr);
  if (outcome.timedOut) {
    return { kind: "timeout", reason: `timed out after ${hook.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` };
  }
  if (outcome.exitCode === null) {
    return { kind: "spawn_failed", reason: `could not be started${detail ? `: ${detail}` : ""}` };
  }
  if (outcome.exitCode === 0 || outcome.exitCode === HOOK_BLOCK_EXIT_CODE) return null;
  if (outcome.exitCode === COMMAND_NOT_FOUND_EXIT_CODE) {
    return { kind: "command_not_found", reason: `command not found (exit 127)${detail ? `: ${detail}` : ""}` };
  }
  return { kind: "nonzero_exit", reason: `exited ${outcome.exitCode}${detail ? `: ${detail}` : ""}` };
}
