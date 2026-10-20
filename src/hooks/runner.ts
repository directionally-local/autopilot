import { spawn } from "node:child_process";
import type {
  HookConfig,
  HookEvent,
  HookEventOutcome,
  HookOutcome,
  HookPayload,
  IntentTier,
  PostToolUsePayload,
  PreToolUsePayload,
} from "./types.js";
import { logger } from "../util/logger.js";
import { join } from "node:path";
import { sessionsDir } from "../sessions.js";
import { claudeToolFields } from "./claude-compat.js";
import { BEACON_HARNESS_ATTR, HARNESS_NAME } from "../util/harness.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const STREAM_CAP_BYTES = 4 * 1024;

/** Events whose non-zero exit cancels the underlying action. */
function isVetoEvent(event: HookEvent): boolean {
  return event === "PreToolUse" || event === "UserPromptSubmit";
}

/**
 * Extract a few convenient fields from the payload to expose as
 * `KIMIFLARE_HOOK_*` env vars. The full payload is also on stdin
 * (and in `KIMIFLARE_HOOK_PAYLOAD`), but env vars are friendlier in
 * shell one-liners like:
 *   `case "$KIMIFLARE_HOOK_PATH" in *.env) exit 1 ;; esac`
 */
function buildHookEnv(payload: HookPayload): Record<string, string> {
  const env: Record<string, string> = {
    KIMIFLARE_HOOK_EVENT: payload.event,
    KIMIFLARE_HOOK_CWD: payload.cwd,
    KIMIFLARE_HOOK_PAYLOAD: JSON.stringify(hookWirePayload(payload)),
  };
  if (payload.session_id) env.KIMIFLARE_HOOK_SESSION_ID = payload.session_id;
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") {
    const p = payload as PreToolUsePayload | PostToolUsePayload;
    env.KIMIFLARE_HOOK_TOOL = p.tool;
    // Common per-tool path arg — surfaced for ergonomic shell tests.
    const path = (p.args as Record<string, unknown>).path;
    if (typeof path === "string") env.KIMIFLARE_HOOK_PATH = path;
    if (p.tier) env.KIMIFLARE_HOOK_TIER = p.tier;
    if (p.event === "PostToolUse") {
      env.KIMIFLARE_HOOK_RESULT_OK = String((p as PostToolUsePayload).result.ok);
      const ec = (p as PostToolUsePayload).result.errorCode;
      if (ec) env.KIMIFLARE_HOOK_RESULT_ERROR_CODE = ec;
    }
  }
  if (payload.event === "UserPromptSubmit") {
    const p = payload as { tier?: IntentTier };
    if (p.tier) env.KIMIFLARE_HOOK_TIER = p.tier;
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
  if (payload.event === "PreToolUse" || payload.event === "PostToolUse") Object.assign(wire, claudeToolFields(payload));
  return wire;
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
    child.on("error", () => finish(null));
    child.on("exit", (code) => finish(code));
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
  const env = { ...process.env, ...buildHookEnv(payload) };
  const json = JSON.stringify(hookWirePayload(payload));
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
  return {
    id,
    exitCode: result.exitCode,
    stdout: capStream(result.stdout.trim()),
    stderr: capStream(result.stderr.trim()),
    timedOut: result.timedOut,
    durationMs: Date.now() - start,
  };
}

/** Filter hooks for an event by matcher (regex on tool name for the
 *  events that have one) and enabled state. */
export function filterHooks(
  hooks: HookConfig[] | undefined,
  toolName: string | null,
): HookConfig[] {
  if (!hooks || hooks.length === 0) return [];
  return hooks.filter((h) => {
    if (h.enabled === false) return false;
    if (!h.matcher) return true;
    if (!toolName) return true; // matcher is meaningless without a tool name
    try {
      return new RegExp(h.matcher).test(toolName);
    } catch {
      // Malformed regex matches nothing rather than crashing the loop.
      return false;
    }
  });
}

/**
 * Fire every matching hook for an event, in order. Sequential rather
 * than parallel so users can reason about ordering — and so the first
 * vetoing hook short-circuits the rest for veto-able events.
 */
export async function runHooks(
  event: HookEvent,
  hooks: HookConfig[] | undefined,
  payload: HookPayload,
  toolName: string | null = null,
  signal?: AbortSignal,
): Promise<HookEventOutcome> {
  const matched = filterHooks(hooks, toolName);
  const outcomes: HookOutcome[] = [];
  const veto = isVetoEvent(event);
  const vetoReasons: string[] = [];
  let vetoed = false;
  for (const hook of matched) {
    const outcome = await runHook(hook, payload, signal);
    outcomes.push(outcome);
    if (outcome.timedOut) {
      logger.warn("hook:timeout", {
        event,
        id: outcome.id,
        timeoutMs: hook.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } else if (outcome.exitCode !== 0 && outcome.exitCode !== null) {
      logger.info("hook:nonzero_exit", {
        event,
        id: outcome.id,
        exitCode: outcome.exitCode,
      });
    }
    if (veto && (outcome.exitCode !== 0 || outcome.timedOut)) {
      vetoed = true;
      const reason = outcome.stdout || outcome.stderr || `hook ${outcome.id} exited ${outcome.exitCode}`;
      vetoReasons.push(reason);
      // Stop firing further hooks once vetoed — preserves the "first
      // veto wins" semantic and avoids running e.g. a slow type-check
      // after a fast permission deny.
      break;
    }
  }
  return { outcomes, vetoed, vetoReason: vetoReasons.join("\n") };
}
