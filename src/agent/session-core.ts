/**
 * SessionCore: the one place that assembles an agent turn. Every host — the
 * TUI, print mode, /init, the SDK, the HTTP server and emit mode — used to
 * build `AgentTurnOpts` on its own, and the turn-level features drifted
 * apart (the SDK, server and emit hosts offered the subagent tool with no
 * delegation policy and no completion check, and only the TUI/print hosts
 * classified the request).
 *
 * The core owns the policy:
 *  - intent classification of the user's request
 *  - subagent guidance (policy, explicit requests, Jev in auto mode) and the
 *    tool set it allows — `subagent` is only offered when guidance permits
 *  - the end-of-turn completion check (OpenRouter's Jev)
 *  - provider credentials, model, reasoning effort, co-author, PR policy,
 *    image retention and the tool-iteration ceiling from config
 *  - persistence in `finally`, so a failed or aborted turn still saves
 *
 * Hosts supply only IO: callbacks (rendering, permission prompts), where
 * history is stored, steering input, compaction state, tracing, and any
 * host-specific limit (`toolLimitBehavior`, iteration caps) as explicit
 * overrides.
 */

import { runAgentTurn, type AgentTurnOpts } from "./loop.js";
import { ContextBudgetError } from "./context-budget.js";
import { llmAuthFromConfig, activeOpenRouterKey } from "./llm-auth.js";
import { completionCheckFromConfig } from "./completion-check.js";
import { classifyIntent, type IntentResult } from "../intent/classify.js";
import { allowsSubagentDispatch, resolveSubagentGuidance, type SubagentGuidance, type SubagentPolicy } from "../intent/subagent-policy.js";
import type { KimiConfig } from "../config.js";
import type { ToolSpec } from "../tools/registry.js";
import type { ChatMessage } from "./messages.js";

/** Text of the latest user message — what a turn's policy is decided on. */
export function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join(" ");
  }
  return "";
}

/** The config fields turn assembly reads. */
export type CoreConfig = Partial<KimiConfig> & { model?: string };

export interface TurnPolicyInput {
  cfg: CoreConfig;
  /** The user's request for this turn (classification and delegation read it). */
  prompt: string;
  /** Tools the host would offer before policy (base tools + MCP + LSP). */
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** A research subagent answers one mission: no delegation, no completion check. */
  workerProfile?: "research";
  /** Subagent policy override for this turn (default: config, else "auto"). */
  subagentPolicy?: SubagentPolicy;
}

export interface TurnPolicy {
  classification: IntentResult;
  guidance: SubagentGuidance;
  /** The tools to offer this turn: `subagent` only when guidance allows dispatch. */
  tools: ToolSpec[];
  delegationDirective?: AgentTurnOpts["delegationDirective"];
  completionCheck?: AgentTurnOpts["completionCheck"];
}

/** Classification, delegation guidance, the tool set, and the completion check for one turn. */
export async function resolveTurnPolicy(input: TurnPolicyInput): Promise<TurnPolicy> {
  const classification = classifyIntent(input.prompt);
  const guidance: SubagentGuidance =
    input.workerProfile === "research"
      ? { kind: "explicit-sequential", reason: "research subagent" }
      : await resolveSubagentGuidance({
          prompt: input.prompt,
          tier: classification.tier,
          policy: input.subagentPolicy ?? input.cfg.subagentPolicy ?? "auto",
          apiKey: activeOpenRouterKey(input.cfg),
          signal: input.signal,
        });
  const tools = input.tools.filter((tool) => tool.name !== "subagent" || allowsSubagentDispatch(guidance.kind));
  const directive = input.workerProfile === "research" ? undefined : guidance.refinedDirective ?? guidance.directive;
  const completionCheck = input.workerProfile === "research" ? undefined : completionCheckFromConfig(input.cfg);
  return {
    classification,
    guidance,
    tools,
    ...(directive ? { delegationDirective: directive } : {}),
    ...(completionCheck ? { completionCheck } : {}),
  };
}

/** The user-facing line a host shows for non-trivial subagent guidance (null when there's nothing to say). */
export function describeSubagentGuidance(guidance: SubagentGuidance): string | null {
  if (guidance.kind === "none") return null;
  if (guidance.kind === "explicit-delegate") return "Subagent policy: respecting your explicit request to delegate. Worker calls still require permission.";
  if (guidance.kind === "explicit-sequential") return "Subagent policy: respecting your instruction to work without delegation.";
  // "auto" is the default and every worker call still asks permission:
  // restating it each turn is noise.
  if (guidance.kind === "auto-delegate") return null;
  const probability = guidance.probability === undefined ? "" : ` (Jev estimate: ${Math.round(guidance.probability * 100)}%)`;
  return `Subagent suggestion: independent work may help${probability}. No worker will launch without your confirmation.`;
}

/** Turn options that come straight from config, identical for every host. */
export function configTurnOpts(cfg: CoreConfig): Pick<
  AgentTurnOpts,
  "coauthor" | "githubToken" | "keepLastImageTurns" | "maxTotalToolIterations" | "allowDirectPush" | "preferPullRequests" | "reasoningEffort" | "shell"
> & ReturnType<typeof llmAuthFromConfig> {
  return {
    ...llmAuthFromConfig(cfg),
    coauthor:
      cfg.coauthor !== false
        ? { name: cfg.coauthorName || "autopilot", email: cfg.coauthorEmail || "kimiflare@proton.me" }
        : undefined,
    ...(cfg.githubOAuthToken ? { githubToken: cfg.githubOAuthToken } : {}),
    keepLastImageTurns: cfg.imageHistoryTurns ?? 2,
    ...(cfg.maxTotalToolIterations !== undefined ? { maxTotalToolIterations: cfg.maxTotalToolIterations } : {}),
    allowDirectPush: cfg.allowDirectPush,
    preferPullRequests: cfg.preferPullRequests,
    ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
    ...(cfg.shell ? { shell: cfg.shell } : {}),
  };
}

export interface CoreTurn {
  cfg: CoreConfig;
  policy: TurnPolicy;
  /** Everything host-specific: messages, executor, cwd, signal, callbacks, model, persistence hooks, limits. */
  host: Omit<AgentTurnOpts, "tools" | "intentClassification" | "delegationDirective" | "completionCheck"> &
    Partial<Pick<AgentTurnOpts, "completionCheck">>;
}

/** Assemble the turn: config defaults, then the policy, then the host's own options (host wins). */
export function assembleTurn({ cfg, policy, host }: CoreTurn): AgentTurnOpts {
  return {
    ...configTurnOpts(cfg),
    intentClassification: policy.classification,
    ...(policy.delegationDirective ? { delegationDirective: policy.delegationDirective } : {}),
    ...(policy.completionCheck ? { completionCheck: policy.completionCheck } : {}),
    ...host,
    tools: policy.tools,
  } as AgentTurnOpts;
}

/**
 * Run an assembled turn and always persist afterwards — on success, error
 * or abort — so a failed turn never loses the history it produced. The
 * turn's own error still propagates after the save.
 */
export async function runCoreTurn(opts: AgentTurnOpts, persist?: () => Promise<void> | void): Promise<void> {
  try {
    await runAgentTurn(opts);
  } finally {
    if (persist) await persist();
  }
}

/** What a durable run becomes after its turn throws. */
export interface RunStop {
  status: "needs_input" | "failed";
  /** Stored as the run's stop reason and shown to whoever resumes it. */
  reason: string;
}

/**
 * Map a failed turn to the run's next state, the same way for every host
 * (#840). Hitting a budget is a decision for the user, not a failure:
 *  - the runtime budget ran out → needs_input (raise the budget to continue)
 *  - the active turn alone no longer fits the model's context → needs_input
 *    with the estimate, the budget and the choices (a larger-context model,
 *    or stop). An unattended run grows one turn without bound, so this would
 *    otherwise end a long run hours in, with nobody watching.
 * Anything else fails the run.
 */
export function runStopForError(error: unknown, opts: { runtimeBudgetExceeded?: boolean; model?: string } = {}): RunStop {
  if (opts.runtimeBudgetExceeded) return { status: "needs_input", reason: "max_runtime_exceeded" };
  if (error instanceof ContextBudgetError) {
    const n = (v: number) => v.toLocaleString("en-US");
    return {
      status: "needs_input",
      reason:
        `context_budget_exceeded: the current turn needs ~${n(error.estimatedTokens)} tokens but ${opts.model ? `${opts.model} has` : "the model has"} ` +
        `${n(error.budgetTokens)} available (context window ${n(error.contextWindow)}); older turns are already compacted. ` +
        `Resume with a larger-context model ({"model": "<id>"}) or cancel the run.`,
    };
  }
  return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
}
