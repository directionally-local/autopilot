import type { ToolSpec, ToolContext, ToolOutput, ToolOutputMeta, RunWaitRequest } from "./registry.js";
import { wrapAsToolError, type ToolErrorCode } from "./tool-error.js";
import type { HooksManager } from "../hooks/manager.js";
import type { FileChangeForHook, PostToolUsePayload } from "../hooks/types.js";
import { claudeError, toolCallFailed } from "../hooks/claude-compat.js";
import type { TraceRecorder } from "../trace/recorder.js";
import { classifyVerification } from "../trace/verification.js";
import { detectGitRevert } from "../trace/git-delta.js";
import type { PermissionDecision as TracePermissionDecision, ToolCallPayload, ToolResultPayload } from "../trace/types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { webFetchTool } from "./web-fetch.js";
import { searchWebTool } from "./web-search.js";
import { githubReadPrTool, githubReadIssueTool, githubReadCodeTool, githubListMergedPrsTool, githubListReleasesTool, githubCreatePrTool } from "./github.js";
import { changelogImageTool } from "./changelog-image.js";
import { browserFetchTool } from "./browser.js";
import { htmlArtifactTool } from "./html-artifact.js";
import { tasksSetTool } from "./tasks.js";
import { memoryRememberTool, memoryRecallTool, memoryForgetTool } from "./memory.js";
import { subagentTool } from "./subagent.js";
import { presentPlanOptionsTool } from "./plan-options.js";
import { ToolArtifactStore } from "./artifact-store.js";
import { reduceToolOutput, DEFAULT_REDUCER_CONFIG } from "./reducer.js";
import { makeExpandArtifactTool } from "./expand-artifact.js";
import { jobStartTool, jobStatusTool, jobLogsTool, jobCancelTool } from "./jobs.js";
import { waitForTool } from "./wait-for.js";
import { workerResultTool, workerStatusTool } from "./workers.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolvePath } from "../util/paths.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { RunStore, RunToolBudgetExceededError } from "../runs/store.js";

export const ALL_TOOLS: ToolSpec[] = [
  { ...readTool, isReadOnly: true },
  writeTool,
  editTool,
  bashTool,
  { ...globTool, isReadOnly: true },
  { ...grepTool, isReadOnly: true },
  { ...webFetchTool, isReadOnly: true },
  { ...searchWebTool, isReadOnly: true },
  { ...githubReadPrTool, isReadOnly: true },
  { ...githubReadIssueTool, isReadOnly: true },
  { ...githubReadCodeTool, isReadOnly: true },
  { ...githubListMergedPrsTool, isReadOnly: true },
  { ...githubListReleasesTool, isReadOnly: true },
  githubCreatePrTool,
  { ...changelogImageTool, isReadOnly: true },
  { ...browserFetchTool, isReadOnly: true },
  htmlArtifactTool,
  tasksSetTool,
  memoryRememberTool,
  { ...memoryRecallTool, isReadOnly: true },
  memoryForgetTool,
  subagentTool,
  { ...presentPlanOptionsTool, isReadOnly: true },
  jobStartTool,
  jobStatusTool,
  jobLogsTool,
  jobCancelTool,
  waitForTool,
  workerStatusTool,
  workerResultTool,
];

export const RESEARCH_WORKER_TOOL_NAMES = new Set([
  "read", "glob", "grep", "github_read_pr", "github_read_issue", "github_read_code",
  "github_list_merged_prs", "github_list_releases",
]);

export function getWorkerTools(profile?: "research"): ToolSpec[] {
  return profile === "research"
    ? ALL_TOOLS
        .filter((tool) => RESEARCH_WORKER_TOOL_NAMES.has(tool.name) && tool.isReadOnly === true)
        .map(restrictResearchTool)
    : ALL_TOOLS;
}

function restrictResearchTool(tool: ToolSpec): ToolSpec {
  return {
    ...tool,
    run: async (args: Record<string, unknown>, ctx: ToolContext) => {
      if (tool.name === "read") {
        await assertResearchPath(args.path, ctx.cwd);
      } else if (tool.name === "glob" || tool.name === "grep") {
        await assertResearchPath(args.path ?? ".", ctx.cwd);
        if (tool.name === "glob") assertSafePattern(args.pattern);
        if (tool.name === "grep" && args.glob !== undefined) assertSafePattern(args.glob);
      }
      return tool.run(args, ctx);
    },
  };
}

const SENSITIVE_RESEARCH_PATHS = new Set([
  ".git", ".ssh", ".aws", ".config", ".hotcell", ".npmrc", ".netrc", ".git-credentials",
]);

async function assertResearchPath(pathValue: unknown, cwd: string): Promise<void> {
  if (typeof pathValue !== "string" || !pathValue) throw new Error("Research worker paths must be non-empty strings.");
  const root = await realpath(cwd);
  const candidate = resolve(root, pathValue);
  assertInsideResearchRoot(candidate, root);
  assertNoSensitivePath(candidate, root);
  const actual = await realpath(candidate);
  assertInsideResearchRoot(actual, root);
  assertNoSensitivePath(actual, root);
}

function assertInsideResearchRoot(path: string, root: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Research workers may only inspect paths inside their cloned repository.");
  }
}

function assertNoSensitivePath(path: string, root: string): void {
  const parts = relative(root, path).split(sep).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".env" || part.startsWith(".env.") || SENSITIVE_RESEARCH_PATHS.has(part))) {
    throw new Error("Research worker access to environment, credential, and VCS metadata paths is blocked.");
  }
}

function assertSafePattern(value: unknown): void {
  if (typeof value !== "string" || !value || isAbsolute(value)) {
    throw new Error("Research worker glob patterns must be relative to the repository.");
  }
  const parts = value.replaceAll("\\\\", "/").split("/");
  if (parts.some((part) => part === ".." || part === ".env" || part.startsWith(".env.") || SENSITIVE_RESEARCH_PATHS.has(part.toLowerCase()))) {
    throw new Error("Research worker glob patterns cannot traverse outside the repository or target sensitive paths.");
  }
}

/**
 * Whether the user said yes or no.
 *
 * NOTE on naming: the legacy `PermissionDecision` string type
 * (`"allow" | "allow_session" | "deny"`) also lives below as a
 * deprecated back-compat alias. New callers should return the typed
 * `PermissionDecisionResult` shape; the executor normalizes either at
 * the boundary so existing SDK callers keep working unchanged.
 */
export type PermissionDecisionKind = "allow" | "deny";

/**
 * How broadly an allow applies. M2.1's enum overloaded this with the
 * decision — `"allow_session"` meant "allow + cache for the session" —
 * which made the new `"pattern"` scope from M6.2 impossible to express.
 *
 *   - `once`    — approved this single call. The executor will ask
 *                 again next time the same tool is requested.
 *   - `session` — approved for the rest of the session (existing
 *                 `"allow_session"` behavior).
 *   - `pattern` — approved because the call matched a pre-configured
 *                 glob in settings.json (M6.2). The executor does NOT
 *                 cache pattern-allow decisions — the pattern itself
 *                 is the durable record and lives in the config file.
 *
 * `scope` is meaningful only when `decision === "allow"`; for `deny`
 * it's ignored, but we keep it required so the shape stays uniform.
 */
export type PermissionScope = "once" | "session" | "pattern";

export interface PermissionDecisionResult {
  decision: PermissionDecisionKind;
  scope: PermissionScope;
  /** Free-text the user typed when denying ("do X instead"). Recorded on the
   *  trace's `permission_decision`; the text itself reaches the model as the
   *  next user message. */
  feedback?: string;
}

/**
 * Legacy single-string decision. Kept for SDK back-compat — callers can
 * still return `"allow" | "allow_session" | "deny"` and the executor
 * normalizes via `toPermissionResult`. Prefer
 * `PermissionDecisionResult` in new code.
 *
 * @deprecated since M2.2. Use `PermissionDecisionResult` instead.
 */
export type PermissionDecisionLegacy = "allow" | "allow_session" | "deny";

/**
 * Union of the new typed result and the legacy string. Both shapes are
 * accepted by `PermissionAsker`; the executor calls
 * `toPermissionResult` to normalize.
 */
export type PermissionDecision = PermissionDecisionLegacy | PermissionDecisionResult;

export interface PermissionRequest {
  tool: ToolSpec;
  args: Record<string, unknown>;
  sessionKey: string;
  /** Set when a PreToolUse hook answered `permissionDecision: "ask"`: the
   *  prompt is forced (even for tools that skip it) and this is the hook's
   *  `permissionDecisionReason`, if it gave one. */
  hookAskReason?: string;
  /** Set when a tool that normally skips the prompt needs it for this call
   *  (ToolSpec.permissionReason), e.g. reading a credentials file. Hosts
   *  must not auto-allow such a request on the strength of
   *  `tool.needsPermission` being false. */
  sensitiveReason?: string;
  /**
   * Fires the `PermissionRequest` hooks for this call. Hosts call it right
   * before they would prompt the user — after plan mode, `--dangerously-
   * allow-all` and config permission rules have had their say — passing
   * their current mode. A non-null result decides the request without a
   * prompt; null means show the prompt as usual. Absent when no
   * PermissionRequest hook is enabled. Never returns "allow" in plan mode.
   */
  firePermissionHook?: (mode: string) => Promise<PermissionHookResult | null>;
}

/** A PermissionRequest hook's answer: approve or deny without a prompt. */
export interface PermissionHookResult {
  decision: "allow" | "deny";
  reason?: string;
}

/**
 * Ask the request's PermissionRequest hooks (if any) before prompting.
 * Returns the decision to hand back to the executor, or null to prompt.
 */
export async function permissionFromHook(
  req: PermissionRequest,
  mode: string,
): Promise<PermissionDecisionResult | null> {
  const hook = await req.firePermissionHook?.(mode);
  if (!hook) return null;
  return { decision: hook.decision, scope: "once" };
}

export type PermissionAsker = (req: PermissionRequest) => Promise<PermissionDecision>;

/**
 * Normalize either decision shape into `PermissionDecisionResult`.
 * Mapping:
 *   `"allow"`         → `{ decision: "allow", scope: "once" }`
 *   `"allow_session"` → `{ decision: "allow", scope: "session" }`
 *   `"deny"`          → `{ decision: "deny", scope: "once" }`
 *   typed shape       → returned as-is
 */
export function toPermissionResult(d: PermissionDecision): PermissionDecisionResult {
  if (typeof d === "string") {
    switch (d) {
      case "allow":
        return { decision: "allow", scope: "once" };
      case "allow_session":
        return { decision: "allow", scope: "session" };
      case "deny":
        return { decision: "deny", scope: "once" };
    }
  }
  return d;
}

export interface ToolInvocation {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
  ok: boolean;
  /** Raw output bytes before any truncation/capping. */
  rawBytes?: number;
  /** Final output bytes after truncation/capping. */
  reducedBytes?: number;
  /** Artifact ID if the raw output was stored for later expansion. */
  artifactId?: string;
  /** Stable code classifying the failure mode. Populated only when
   *  `ok` is false. Sites that have not yet been migrated to
   *  `ToolError` fall back to `"unknown"`. (M2.1) */
  errorCode?: ToolErrorCode;
  /** True when the failure is reasonable to retry. Populated only when
   *  `ok` is false. The loop reads this for retry-vs-fail-fast
   *  decisions — currently informational; retry policy lands later. */
  recoverable?: boolean;
  /** Optional one-line UI hint describing how to recover. */
  suggestion?: string;
  /** True when this result is an internal safety block rather than a tool failure. */
  guardrail?: boolean;
  /** Durable wait signal that ends the current agent turn after persisting state. */
  waitRequest?: RunWaitRequest;
}

/** Cap on `result.content` bytes carried in the PostToolUse hook
 *  payload (G7 from the M6.1 audit). Large tool outputs are reduced
 *  to fit OS env-var limits (`KIMIFLARE_HOOK_PAYLOAD` ~128 KB on
 *  Linux, less on macOS) and to keep hooks fast. The full output is
 *  still available via the tool's artifact id if the user needs it. */
const HOOK_RESULT_CONTENT_CAP_BYTES = 4 * 1024;

/** write / edit hook payloads carry the file's before/after content (for
 *  `structuredPatch` / `originalFile`) only for files up to this size. */
export const HOOK_FILE_SNAPSHOT_MAX_BYTES = 1024 * 1024;

/** The file as it is before a write / edit: whether it exists, and its
 *  content when it is small enough to diff. */
async function snapshotForHook(abs: string): Promise<{ existed: boolean; content: string | null }> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { existed: true, content: null };
    if (st.size > HOOK_FILE_SNAPSHOT_MAX_BYTES) return { existed: true, content: null };
    return { existed: true, content: await readFile(abs, "utf8") };
  } catch {
    return { existed: false, content: null };
  }
}

/** bash's exit code and separate streams, for the PostToolUse payload. */
function shellResultForHook(meta: ToolOutputMeta | undefined): Partial<PostToolUsePayload["result"]> {
  if (!meta || meta.exitCode === undefined) return {};
  return {
    exitCode: meta.exitCode,
    stdout: capContentForHook(meta.stdout ?? ""),
    stderr: capContentForHook(meta.stderr ?? ""),
    interrupted: meta.timedOut === true || meta.aborted === true,
  };
}

function capContentForHook(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= HOOK_RESULT_CONTENT_CAP_BYTES) return s;
  let cut = s;
  while (Buffer.byteLength(cut, "utf8") > HOOK_RESULT_CONTENT_CAP_BYTES) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return `${cut}\n[…truncated for hook payload]`;
}

/** The file after a successful write / edit, next to how it was before. */
async function fileChangeAfter(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  before: { existed: boolean; content: string | null },
): Promise<FileChangeForHook> {
  let updated: string | null = null;
  if (tool === "write" && typeof args.content === "string") {
    updated = Buffer.byteLength(args.content, "utf8") <= HOOK_FILE_SNAPSHOT_MAX_BYTES ? args.content : null;
  } else {
    updated = (await snapshotForHook(resolvePath(cwd, args.path as string))).content;
  }
  return { existed: before.existed, original: before.content, updated };
}

export class ToolExecutor {
  private sessionAllowed = new Set<string>();
  private tools: Map<string, ToolSpec>;
  private artifactStore: ToolArtifactStore;
  /** M6.1: when set, executor fires PreToolUse/PostToolUse around
   *  every `run` call regardless of caller (standard agent loop,
   *  code-mode sandbox, init turn, SDK, CLI print mode). */
  private hooks: HooksManager | null;
  /** Default session trace recorder; `ctx.trace` (set by the agent loop)
   *  takes precedence per call. */
  private trace: TraceRecorder | null;

  constructor(tools: ToolSpec[] = ALL_TOOLS, opts?: { hooks?: HooksManager; trace?: TraceRecorder }) {
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.artifactStore = new ToolArtifactStore();
    this.tools.set("expand_artifact", makeExpandArtifactTool(this.artifactStore));
    this.hooks = opts?.hooks ?? null;
    this.trace = opts?.trace ?? null;
  }

  /** Swap or detach the hooks manager. Used by app startup so the
   *  executor created before the manager exists can pick it up later. */
  setHooks(hooks: HooksManager | null): void {
    this.hooks = hooks;
  }

  /** Swap or detach the default trace recorder (e.g. when the TUI starts a new session). */
  setTrace(trace: TraceRecorder | null): void {
    this.trace = trace;
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  register(tool: ToolSpec): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  clearSessionPermissions(): void {
    this.sessionAllowed.clear();
  }

  clearArtifacts(): void {
    this.artifactStore.clear();
  }

  async run(
    call: ToolInvocation,
    askPermission: PermissionAsker,
    ctx: ToolContext,
    onFileChange?: (path: string, content: string) => void,
  ): Promise<ToolResult> {
    const trace = ctx.trace ?? this.trace;
    if (!trace?.enabled) return this.runInner(call, askPermission, ctx, onFileChange, null);
    const tr = new ToolTrace(trace, ctx, call);
    const result = await this.runInner(call, askPermission, ctx, onFileChange, tr);
    tr.finish(result);
    return result;
  }

  private async runInner(
    call: ToolInvocation,
    askPermission: PermissionAsker,
    ctx: ToolContext,
    onFileChange: ((path: string, content: string) => void) | undefined,
    tr: ToolTrace | null,
  ): Promise<ToolResult> {
    // `spawn_worker` was renamed to `subagent`; resumed sessions and models
    // primed by old history may still emit the old name.
    const tool = this.tools.get(call.name) ?? (call.name === "spawn_worker" ? this.tools.get("subagent") : undefined);
    if (!tool) {
      tr?.call(null, false);
      return {
        tool_call_id: call.id,
        name: call.name,
        content: `Error: unknown tool "${call.name}". Valid tools: ${[...this.tools.keys()].join(", ")}.`,
        ok: false,
        errorCode: "not_found",
        recoverable: false,
      };
    }

    let args: Record<string, unknown>;
    try {
      if (!call.arguments.trim()) throw new SyntaxError("tool arguments were empty");
      const parsed: unknown = JSON.parse(call.arguments);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("tool arguments must be a JSON object");
      }
      args = parsed as Record<string, unknown>;
    } catch (e) {
      tr?.call(null, tool.needsPermission);
      const artifactSuggestion =
        call.name === "create_artifact"
          ? "Use write to save the complete HTML document as a workspace .html file, then call create_artifact with its title and sourcePath."
          : "Retry with valid JSON object arguments for this tool.";
      return {
        tool_call_id: call.id,
        name: call.name,
        content: `Error: invalid JSON arguments for ${call.name}: ${(e as Error).message}. No tool action was performed (${Buffer.byteLength(call.arguments, "utf8")} argument bytes).`,
        ok: false,
        errorCode: "invalid_args",
        recoverable: true,
        suggestion: artifactSuggestion,
      };
    }
    tr?.call(args, tool.needsPermission);

    // M6.1: PreToolUse hook (blocking). Fires here — after JSON-args
    // parsing, BEFORE the permission check — so a hook can block a
    // call without the user being asked. Hooks live on the executor
    // so every caller (standard loop, code-mode sandbox, init, SDK,
    // print mode) gets the same behavior automatically. Exit 2 or a
    // `deny` JSON decision blocks; a broken hook fails open (see runHooks).
    let hookForcesAsk = false;
    let hookAskReason: string | undefined;
    if (this.hooks?.hasEnabledHooks("PreToolUse")) {
      const preOutcome = await this.hooks.fire(
        "PreToolUse",
        {
          event: "PreToolUse",
          session_id: ctx.sessionId ?? null,
          cwd: ctx.cwd,
          tool: call.name,
          tool_call_id: call.id,
          args,
          tier: ctx.intentTier,
        },
        call.name,
        ctx.signal,
      );
      if (preOutcome.vetoed) {
        const reason = preOutcome.vetoReason || "PreToolUse hook blocked the call";
        const synthetic: ToolResult = {
          tool_call_id: call.id,
          name: call.name,
          content: `Hook blocked this call: ${reason}`,
          ok: false,
          errorCode: "policy_rejection",
          recoverable: false,
          suggestion: "the user has a hook that blocks this call — try a different approach",
        };
        // PostToolUse does NOT fire on a vetoed call. The action never
        // ran, so "post" is meaningless. Documented behavior.
        return synthetic;
      }
      // `ask`: route through the host's normal permission prompt even if
      // the tool or the session cache would skip it. Non-interactive hosts
      // answer as they do for any prompt (print mode denies unless
      // --dangerously-allow-all). `allow` does NOT bypass the user's own
      // permission rules or mode — it only means the hook raised no objection.
      if (preOutcome.permissionDecision === "ask") {
        hookForcesAsk = true;
        hookAskReason = preOutcome.permissionDecisionReason;
      }
    }

    const sensitiveReason = tool.permissionReason?.(args, ctx) ?? null;
    if (tool.needsPermission || hookForcesAsk || sensitiveReason) {
      // A sensitive call is approved per target, never for the whole tool.
      const sessionKey = sensitiveReason
        ? `${tool.name}:sensitive:${typeof args.path === "string" ? resolvePath(ctx.cwd, args.path) : JSON.stringify(args)}`
        : this.permissionKey(tool, args);
      if (hookForcesAsk || !this.sessionAllowed.has(sessionKey)) {
        const askedAt = performance.now();
        // PermissionRequest hooks (#891): the host calls this right before
        // it would prompt; we remember a deny so the model hears who denied.
        let hookDenial: PermissionHookResult | null = null;
        const firePermissionHook = this.hooks?.hasEnabledHooks("PermissionRequest")
          ? async (mode: string): Promise<PermissionHookResult | null> => {
              const decided = await this.firePermissionRequest(call, args, ctx, mode, hookAskReason);
              if (decided?.decision === "deny") hookDenial = decided;
              return decided;
            }
          : undefined;
        const raw = await askPermission({
          tool,
          args,
          sessionKey,
          ...(hookForcesAsk && hookAskReason ? { hookAskReason } : {}),
          ...(sensitiveReason ? { sensitiveReason } : {}),
          ...(firePermissionHook ? { firePermissionHook } : {}),
        });
        const result = toPermissionResult(raw);
        tr?.permission(tracePermissionDecision(result), Math.round(performance.now() - askedAt), result.feedback);
        if (result.decision === "deny") {
          const byHook = hookDenial as PermissionHookResult | null;
          const denied: ToolResult = byHook
            ? {
                tool_call_id: call.id,
                name: call.name,
                content: `Permission denied by a PermissionRequest hook: ${byHook.reason || "no reason given"}`,
                ok: false,
                errorCode: "policy_rejection",
                recoverable: false,
                suggestion: "the user has a hook that denies this call — try a different approach",
              }
            : {
                tool_call_id: call.id,
                name: call.name,
                content: `Permission denied by user. Do not retry this exact call; ask the user what they want to do differently.`,
                ok: false,
                errorCode: "permission_denied",
                recoverable: false,
                suggestion: "ask the user what they want to do differently",
              };
          this.firePostToolUse(call, args, denied, ctx);
          return denied;
        }
        // Only cache when the user said "for this session." `once` is
        // intentionally not cached (we re-ask), and `pattern` allows
        // come from settings.json so the pattern itself is the durable
        // record — no in-memory cache needed.
        if (result.scope === "session") this.sessionAllowed.add(sessionKey);
      } else {
        tr?.permission("auto", 0);
      }
    } else {
      tr?.permission("auto", 0);
    }

    let runStore: RunStore | null = null;
    let intentRecorded = false;
    let toolCompleted = false;
    try {
      if (ctx.runId) {
        runStore = new RunStore(ctx.runsDbPath);
        runStore.recordToolIntent(ctx.runId, call.id, call.name, args);
        intentRecorded = true;
      }
      // PostToolUse hooks get a write / edit call's diff (Claude Code's
      // `structuredPatch`, `originalFile`): keep the file as it was.
      const before = this.wantsFileChange(call.name, args)
        ? await snapshotForHook(resolvePath(ctx.cwd, args.path as string))
        : undefined;
      const result = await tool.run(args as never, ctx);
      toolCompleted = true;
      const fileChange = before ? await fileChangeAfter(call.name, args, ctx.cwd, before) : undefined;
      const normalized = normalizeToolOutput(result);
      tr?.raw(normalized);
      if (runStore && ctx.runId) {
        runStore.recordToolResult(ctx.runId, call.id, call.name, { ok: true, content: normalized.content });
      }
      if (normalized.waitRequest) {
        if (!ctx.runId || normalized.waitRequest.runId !== ctx.runId || !runStore) {
          throw new Error("wait_for yield signal does not match an active durable run");
        }
        runStore.transition(ctx.runId, "waiting", `timer:${normalized.waitRequest.timerId}`);
      }

      // Notify LSP document sync bridge on write/edit
      if (onFileChange) {
        if (call.name === "write" && typeof args.path === "string" && typeof args.content === "string") {
          onFileChange(args.path, args.content);
        } else if (call.name === "edit" && typeof args.path === "string") {
          // For edit, we don't have the new content readily available;
          // the LSP manager will need to read the file. Pass empty to signal change.
          onFileChange(args.path, "");
        }
      }

      // Diff-style git commands carry meaning per line; the bash reducer's
      // dedupeConsecutiveLines rule mangles them and traps the model in retry
      // loops on merge-conflict resolution. Archive the artifact so
      // expand_artifact still works, but hand the model the unreduced content.
      const cmd = call.name === "bash" && typeof args.command === "string" ? args.command : "";
      if (isDiffCommand(cmd)) {
        const artifactId = this.artifactStore.store(normalized.content);
        const bytes = Buffer.byteLength(normalized.content, "utf8");
        const diffResult: ToolResult = {
          tool_call_id: call.id,
          name: call.name,
          content: normalized.content,
          ok: true,
          rawBytes: bytes,
          reducedBytes: bytes,
          artifactId,
        };
        this.firePostToolUse(call, args, diffResult, ctx, normalized.meta);
        return diffResult;
      }

      const reduced = reduceToolOutput(
        call.name,
        normalized.content,
        args,
        this.artifactStore,
        DEFAULT_REDUCER_CONFIG,
      );
      const success: ToolResult = {
        tool_call_id: call.id,
        name: call.name,
        content: reduced.content,
        ok: true,
        rawBytes: reduced.rawBytes,
        reducedBytes: reduced.reducedBytes,
        artifactId: reduced.artifactId,
        ...(normalized.waitRequest ? { waitRequest: normalized.waitRequest } : {}),
      };
      this.firePostToolUse(call, args, success, ctx, normalized.meta, fileChange);
      return success;
    } catch (e) {
      if (e instanceof RunToolBudgetExceededError) ctx.onRunBudgetExceeded?.(e.reason);
      const err = wrapAsToolError(e);
      const msg = `Error running ${call.name}: ${err.message}`;
      tr?.raw({ content: msg, rawBytes: Buffer.byteLength(msg, "utf8"), reducedBytes: Buffer.byteLength(msg, "utf8") });
      const failure: ToolResult = {
        tool_call_id: call.id,
        name: call.name,
        content: msg,
        ok: false,
        rawBytes: msg.length,
        reducedBytes: msg.length,
        errorCode: err.code,
        recoverable: err.recoverable,
        suggestion: err.suggestion,
      };
      if (runStore && ctx.runId && intentRecorded && !toolCompleted) {
        try {
          runStore.recordToolResult(ctx.runId, call.id, call.name, { ok: false, content: msg, errorCode: err.code });
        } catch {
          // Preserve the tool error; an unmatched intent is recovered as unknown.
        }
      }
      this.firePostToolUse(call, args, failure, ctx);
      return failure;
    } finally {
      runStore?.close();
    }
  }

  /**
   * Run the PermissionRequest hooks for one call. Returns allow/deny when a
   * hook decided (exit 2 or a failing failClosed hook count as deny), or
   * null to show the normal prompt (`ask`, no decision, or a hook that
   * failed open). `allow` is ignored in plan mode: a hook can't switch
   * plan mode off.
   */
  private async firePermissionRequest(
    call: ToolInvocation,
    args: Record<string, unknown>,
    ctx: ToolContext,
    mode: string,
    hookAskReason: string | undefined,
  ): Promise<PermissionHookResult | null> {
    if (!this.hooks) return null;
    const outcome = await this.hooks.fire(
      "PermissionRequest",
      {
        event: "PermissionRequest",
        session_id: ctx.sessionId ?? null,
        cwd: ctx.cwd,
        tool: call.name,
        tool_call_id: call.id,
        args,
        tier: ctx.intentTier,
        mode,
        ...(hookAskReason ? { hook_ask_reason: hookAskReason } : {}),
      },
      call.name,
      ctx.signal,
    );
    if (outcome.vetoed) {
      return { decision: "deny", reason: outcome.permissionDecisionReason || outcome.vetoReason || undefined };
    }
    if (outcome.permissionDecision === "allow" && mode !== "plan") {
      return { decision: "allow", ...(outcome.permissionDecisionReason ? { reason: outcome.permissionDecisionReason } : {}) };
    }
    return null;
  }

  /**
   * Fire-and-forget PostToolUse, plus PostToolUseFailure when the call
   * failed. Wraps every code path that returns a `ToolResult` so success /
   * failure / permission-denied all surface to PostToolUse hooks uniformly
   * (PostToolUse keeps firing for failures, for compatibility). The
   * `content` field is capped via `capContentForHook` to keep large tool
   * outputs from blowing the OS env-var limits on `KIMIFLARE_HOOK_PAYLOAD`.
   */
  private firePostToolUse(
    call: ToolInvocation,
    args: Record<string, unknown>,
    result: ToolResult,
    ctx: ToolContext,
    meta?: ToolOutputMeta,
    fileChange?: FileChangeForHook,
  ): void {
    const hooks = this.hooks;
    if (!hooks) return;
    const post = hooks.hasEnabledHooks("PostToolUse");
    const failure = hooks.hasEnabledHooks("PostToolUseFailure");
    if (!post && !failure) return;
    const resultFields: PostToolUsePayload["result"] = {
      ok: result.ok,
      content: capContentForHook(result.content),
      errorCode: result.errorCode,
      ...shellResultForHook(meta),
      ...(fileChange ? { fileChange } : {}),
    };
    const base = {
      session_id: ctx.sessionId ?? null,
      cwd: ctx.cwd,
      tool: call.name,
      tool_call_id: call.id,
      args,
      tier: ctx.intentTier,
      result: resultFields,
    };
    const swallow = () => {
      // hooks are best-effort; never crash the tool path
    };
    if (post) void hooks.fire("PostToolUse", { event: "PostToolUse", ...base }, call.name, ctx.signal).catch(swallow);
    if (failure && toolCallFailed(resultFields)) {
      void hooks
        .fire("PostToolUseFailure", { event: "PostToolUseFailure", ...base, error: claudeError(resultFields) }, call.name, ctx.signal)
        .catch(swallow);
    }
  }

  /** True when a PostToolUse hook would get this write / edit call's diff. */
  private wantsFileChange(tool: string, args: Record<string, unknown>): boolean {
    if ((tool !== "write" && tool !== "edit") || typeof args.path !== "string" || !args.path) return false;
    return !!this.hooks && (this.hooks.hasEnabledHooks("PostToolUse") || this.hooks.hasEnabledHooks("PostToolUseFailure"));
  }

  private permissionKey(tool: ToolSpec, args: Record<string, unknown>): string {
    if (tool.name === "bash" && typeof args.command === "string") {
      const firstToken = args.command.trim().split(/\s+/)[0] ?? "";
      return `bash:${firstToken}`;
    }
    return tool.name;
  }
}

/** Map the asker's typed result onto the trace enum. `pattern` allows come
 *  from settings.json rules, so they count as automatic. */
function tracePermissionDecision(result: PermissionDecisionResult): TracePermissionDecision {
  if (result.decision === "deny") return "deny";
  if (result.scope === "session") return "allow_session";
  if (result.scope === "pattern") return "auto";
  return "allow";
}

/** Inline args in the trace when their JSON is at most this long. */
const TRACE_ARGS_INLINE_MAX = 2 * 1024;

/**
 * Collects the trace facts of one `run()` and emits `tool_call`,
 * `permission_decision`, and `tool_result` (or a single `code_mode_call`
 * when the call came from inside an `execute_code` sandbox).
 */
class ToolTrace {
  private readonly startedAt = performance.now();
  private readonly turnId: string | null;
  private readonly parentId: string | undefined;
  private readonly sessionId: string | undefined;
  private rawOutput: ToolOutput | null = null;
  private argsBlob = "";
  private args: Record<string, unknown> | null = null;

  constructor(
    private readonly trace: TraceRecorder,
    ctx: ToolContext,
    private readonly invocation: ToolInvocation,
  ) {
    this.turnId = ctx.turnId ?? null;
    this.parentId = ctx.codeModeParentToolCallId;
    this.sessionId = ctx.sessionId;
  }

  /** The call was parsed (args null when the arguments were not valid JSON). */
  call(args: Record<string, unknown> | null, needsPermission: boolean): void {
    this.args = args;
    this.argsBlob = this.trace.blob(this.invocation.arguments) ?? "";
    if (this.parentId) return;
    const payload: ToolCallPayload = {
      tool_call_id: this.invocation.id,
      name: this.invocation.name,
      args_blob: this.argsBlob,
      ...(args && this.invocation.arguments.length <= TRACE_ARGS_INLINE_MAX ? { args_inline: args } : {}),
      needs_permission: needsPermission,
      code_mode_redirected: false,
    };
    this.trace.emit("tool_call", payload, this.turnId);
  }

  permission(decision: TracePermissionDecision, latencyMs: number, feedback?: string): void {
    this.trace.emit(
      "permission_decision",
      {
        tool_call_id: this.invocation.id,
        decision,
        ...(feedback ? { feedback_text: feedback } : {}),
        latency_ms: latencyMs,
      },
      this.turnId,
    );
  }

  /** The tool's output before reduction. */
  raw(output: ToolOutput): void {
    this.rawOutput = output;
  }

  finish(result: ToolResult): void {
    const durationMs = Math.round(performance.now() - this.startedAt);
    const rawContent = this.rawOutput?.content ?? result.content;
    const rawBlob = this.trace.blob(rawContent) ?? "";
    this.outcomes(result);
    if (this.parentId) {
      this.trace.emit(
        "code_mode_call",
        {
          parent_tool_call_id: this.parentId,
          name: this.invocation.name,
          args_blob: this.argsBlob,
          raw_blob: rawBlob,
          ok: result.ok,
          duration_ms: durationMs,
        },
        this.turnId,
      );
      return;
    }
    const meta = this.rawOutput?.meta;
    const payload: ToolResultPayload = {
      tool_call_id: this.invocation.id,
      name: this.invocation.name,
      ok: result.ok,
      ...(result.errorCode ? { error_code: result.errorCode } : {}),
      raw_blob: rawBlob,
      raw_bytes: Buffer.byteLength(rawContent, "utf8"),
      reduced_blob: rawContent === result.content ? rawBlob : this.trace.blob(result.content) ?? "",
      reduced_bytes: Buffer.byteLength(result.content, "utf8"),
      ...(result.artifactId ? { artifact_id: result.artifactId } : {}),
      ...(meta && meta.exitCode !== undefined && meta.exitCode !== null ? { exit_code: meta.exitCode } : {}),
      ...(meta?.timedOut !== undefined ? { timed_out: meta.timedOut } : {}),
      duration_ms: durationMs,
    };
    this.trace.emit("tool_result", payload, this.turnId);
  }

  /** Outcome signals a bash call carries: a verification exit code, or a git revert of the last delta. */
  private outcomes(result: ToolResult): void {
    if (this.invocation.name !== "bash") return;
    const command = this.args?.command;
    if (typeof command !== "string" || !command.trim()) return;
    const exitCode = this.rawOutput?.meta?.exitCode;
    const category = classifyVerification(command);
    if (category && typeof exitCode === "number") {
      this.trace.emit(
        "outcome",
        {
          kind: "verification",
          turn_id: this.turnId ?? "",
          tool_call_id: this.invocation.id,
          command,
          category,
          exit_code: exitCode,
        },
        this.turnId,
      );
    }
    if (result.ok && this.sessionId) {
      const reverted = detectGitRevert(this.sessionId, command);
      if (reverted) {
        this.trace.emit("outcome", { kind: "reverted", turn_id: reverted.turnId, how: "git_checkout" }, this.turnId);
      }
    }
  }
}

/** True if the command is a diff-style git invocation whose output the bash
 *  reducer would mangle (dedupe of similar adjacent lines collapses real diff
 *  context). Conservative match: anchored at the start, requires `-p` /
 *  `--patch` for the cases where it's optional. */
export function isDiffCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (/^git\s+show(?:\s|$)/.test(trimmed)) return true;
  if (/^git\s+diff(?:\s|$)/.test(trimmed)) return true;
  if (/^git\s+format-patch(?:\s|$)/.test(trimmed)) return true;
  const hasPatchFlag = /(?:^|\s)(?:-p|--patch)(?:\s|$)/.test(trimmed);
  if (/^git\s+log(?:\s|$)/.test(trimmed) && hasPatchFlag) return true;
  if (/^git\s+stash\s+show(?:\s|$)/.test(trimmed) && hasPatchFlag) return true;
  return false;
}

function normalizeToolOutput(result: string | ToolOutput): ToolOutput {
  if (typeof result === "string") {
    const bytes = Buffer.byteLength(result, "utf8");
    return { content: result, rawBytes: bytes, reducedBytes: bytes };
  }
  return result;
}
