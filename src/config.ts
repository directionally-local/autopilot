import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderId, PROVIDER_PRESETS, type ProviderId } from "./providers/presets.js";
import { isProviderUsable, resolveActiveProvider, resolveProviderId, type ProviderSettings } from "./providers/resolve.js";
import { migrateLegacyModelId } from "./models/registry.js";
import type { OpenRouterProviderPrefs } from "./agent/client.js";
import type { SubagentPolicy } from "./intent/subagent-policy.js";

export type ReasoningEffort = "low" | "medium" | "high";
export const EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

export interface McpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
  /** Per-call timeout in milliseconds for tool invocations on this server. Default: 60000. */
  timeoutMs?: number;
}

export interface LspServerConfig {
  command: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  rootPatterns?: string[];
  /** Per-request timeout in milliseconds for LSP calls. Default: 10000. */
  timeoutMs?: number;
  /** Max auto-restart attempts after a crash. Default: 3. Set 0 to disable. */
  maxRestartAttempts?: number;
}

/** Permission rule: allow, deny, or ask (default). */
export type PermissionRule = "allow" | "deny" | "ask";

/** Per-tool permission rules keyed by glob pattern. */
export type PermissionRules = Record<string, PermissionRule>;

export interface TraceConfig {
  enabled: boolean;
  root?: string;
}

export interface KimiConfig {
  /**
   * The active LLM provider (env: AUTOPILOT_PROVIDER). Unset on configs
   * written before multi-provider support: the provider is then inferred
   * from which credential is present (see src/providers/resolve.ts).
   */
  provider?: ProviderId;
  /** Per-provider keys, base URL overrides and last-used models, keyed by provider id. */
  providers?: Partial<Record<ProviderId, ProviderSettings>>;
  /**
   * The user's own OpenRouter API key (`sk-or-…`; env: OPENROUTER_API_KEY or
   * KIMIFLARE_OPENROUTER_KEY, which win over the file). Every model call —
   * chat, memory embeddings, plumbing side-calls — is billed to this key.
   * Bring-your-own only: kimiflare never pays for or proxies model calls.
   */
  openrouterApiKey?: string;
  /**
   * Optional Requesty API key (env: REQUESTY_API_KEY, which wins over the
   * file). Used only when no OpenRouter key and no custom endpoint are
   * configured: model calls then go to Requesty (https://requesty.ai). Set
   * REQUESTY_BASE_URL to pick a region, e.g. https://router.eu.requesty.ai/v1.
   */
  requestyApiKey?: string;
  /** OpenRouter model id, e.g. "moonshotai/kimi-k2.6". */
  model: string;
  /**
   * Optional OpenRouter provider-routing preferences, merged into every
   * request's `provider` object (kimiflare always sends
   * `require_parameters: true`). E.g. `{ "ignore": ["SomeProvider"] }` or
   * `{ "quantizations": ["fp8", "bf16"] }`. Avoid `order`/`sort` unless you
   * need them: they disable OpenRouter's sticky routing, which is what keeps
   * the prompt cache warm. See https://openrouter.ai/docs/guides/routing/provider-selection
   */
  openrouterProvider?: OpenRouterProviderPrefs;
  /**
   * Custom OpenAI-compatible endpoint base URL (env: KIMIFLARE_BASE_URL).
   * For a host application that embeds kimiflare and owns its own broker:
   * when set, ALL model calls go to `<baseUrl>/chat/completions` instead of
   * OpenRouter and no OpenRouter key is needed. See src/agent/custom-endpoint.ts.
   */
  baseUrl?: string;
  /**
   * Bearer sent as `Authorization` to `baseUrl` (env: KIMIFLARE_API_KEY).
   * Only used when `baseUrl` is set; omitted from the request entirely when
   * unset (for unauthenticated local gateways).
   */
  apiKey?: string;
  /**
   * Cloudflare account id + API token (env: CLOUDFLARE_ACCOUNT_ID /
   * CLOUDFLARE_API_TOKEN). Not used for model calls. Remote session
   * deployment uses these credentials to provision infrastructure.
   */
  accountId?: string;
  apiToken?: string;
  reasoningEffort?: ReasoningEffort;
  /** Harness subagent routing: off, auto (default; coordinator assesses substantial tasks), or suggest. Worker calls remain permission-gated and budget-limited. */
  subagentPolicy?: SubagentPolicy;
  /** Set only when the user explicitly chose a policy; used to migrate the former implicit suggest default. */
  subagentPolicyExplicit?: boolean;
  /**
   * Feature flag for the plan / edit / auto permission modes. Off by default:
   * every session runs in auto (tools run without per-call prompts) and the
   * mode UI (Shift+Tab, /mode, /plan, /edit, /auto, the mode badge) is hidden.
   * Turn on with `/settings modes on` to get the mode system back, starting
   * in edit.
   */
  modesEnabled?: boolean;
  coauthor?: boolean;
  coauthorName?: string;
  coauthorEmail?: string;
  mcpServers?: Record<string, McpServerConfig>;
  cacheStablePrompts?: boolean;
  /** Enable compiled context (token-optimized state packet + artifact store). */
  compiledContext?: boolean;
  /** Number of recent user turns to retain image content; older images are dropped. */
  imageHistoryTurns?: number;
  /** Hard safety ceiling on tool iterations per turn, across automatic
   *  200-call counter resets. Defaults to 1000. */
  maxTotalToolIterations?: number;
  /** Enable local structured memory (SQLite + embeddings). */
  memoryEnabled?: boolean;
  /** Path to memory database. Defaults to .kimiflare/memory.db in repo root, or ~/.local/share/kimiflare/memory.db. */
  memoryDbPath?: string;
  /** Max age of memories in days before cleanup. Default: 90. */
  memoryMaxAgeDays?: number;
  /** Max memories per repo. Default: 1000. */
  memoryMaxEntries?: number;
  /** Embedding model for memory vectors (OpenRouter id). Default: baai/bge-base-en-v1.5. */
  memoryEmbeddingModel?: string;
  /** Model for internal plumbing tasks (memory verification, hypothetical queries). Default: DEFAULT_PLUMBING_MODEL. */
  plumbingModel?: string;
  /** Model for auto-extracting high-signal edit events. Default: DEFAULT_PLUMBING_MODEL. */
  memoryExtractionModel?: string;
  /** Enable Code Mode: present tools as a TypeScript API and execute generated code in a sandbox. */
  codeMode?: boolean;
  /** End-of-turn "did the agent finish?" check via Jev (OpenRouter only). Default true. */
  completionCheck?: boolean;
  /** Enable LSP integration. Default: false. */
  lspEnabled?: boolean;
  /** LSP server configurations. */
  lspServers?: Record<string, LspServerConfig>;
  /** Enable cost attribution by task type. Default: false. Once stable for 2 releases, consider defaulting to true. */
  costAttribution?: boolean;
  /** Enable @ file mention picker in chat input. Default: false. */
  filePicker?: boolean;
  /** UI theme name. Default: everforest-dark. */
  theme?: string;
  /** URL of the remote orchestrator Worker. */
  remoteWorkerUrl?: string;
  /** Shared secret for authenticating with the remote Worker. */
  remoteAuthSecret?: string;
  /** Configurable TTL for remote sessions in minutes (default: 30). */
  remoteTtlMinutes?: number;
  /** Max input token budget per remote job (default: 5_000_000). */
  remoteMaxInputTokens?: number;
  /** GitHub OAuth token for remote PR creation. */
  githubOAuthToken?: string;
  /** GitHub refresh token (if available). */
  githubRefreshToken?: string;
  /** GitHub token expiry timestamp. */
  githubTokenExpiry?: number;
  /** Default GitHub repo for remote sessions (owner/repo). */
  githubRepo?: string;
  /** Shell override for the bash tool. "auto" (default) detects the platform, or specify "bash", "cmd", "powershell", or an absolute path. */
  shell?: string;
  /**
   * Deprecated/ignored: Camouflage is always used (the hidden `--ui ink`
   * picks Ink for one run). Kept so existing configs still load.
   */
  uiEngine?: "ink" | "camouflage";
  /** Max cost per Hotcell worker in USD (default: 1.0). */
  workerBudgetUsd?: number;
  /** Hard ceiling for workerBudgetUsd. Any configured or programmatic value above this is silently capped. Default: 5.0. */
  workerBudgetMaxUsd?: number;
  /** Max workers to spawn in parallel (default: 3). */
  workerMaxParallel?: number;
  /** Timeout per worker in milliseconds (default: 600000 = 10 min). */
  workerTimeoutMs?: number;
  /** Turn count at which KimiFlare suggests /fresh in auto/edit mode. 0 = disabled. Default: 30. */
  autoFreshSuggestionTurns?: number;
  /** If true, automatically execute /fresh when the threshold is hit instead of just suggesting it. Default: false. */
  autoFreshEnabled?: boolean;
  /** Estimated in-memory token threshold to trigger aggressive auto-compaction between turns. Default: 500_000. */
  autoCompactTokenThreshold?: number;
  /** Estimated in-memory token threshold to trigger auto-fresh when compaction cannot reduce below this. Default: 2_000_000. */
  autoFreshTokenThreshold?: number;
  /** Model used for LLM-based task decomposition in multi-agent mode.
   *  Default: DEFAULT_PLUMBING_MODEL (fast and cheap). */
  decompositionModel?: string;
  /** Strategy for decomposing heavy prompts into parallel research tasks.
   *  - "llm": use a lightweight LLM call (default)
   *  - "regex": pure regex heuristic (no LLM, fastest)
   *  - "hybrid": regex for explicit lists, LLM for prose */
  decompositionStrategy?: "llm" | "regex" | "hybrid";
  /** Model for synthesizing multi-agent findings.
   *  Default: DEFAULT_PLUMBING_MODEL (fast and cheap). */
  synthesisModel?: string;
  /** Strategy for synthesizing worker findings.
   *  - "llm": use a lightweight LLM call (default)
   *  - "heuristic": pure heuristic (no LLM, fastest)
   *  - "hybrid": try LLM, fall back to heuristic on failure */
  synthesisStrategy?: "llm" | "heuristic" | "hybrid";
  /** Explicit opt-out for LLM-based synthesis. When true, always uses heuristic. */
  disableLlmSynthesis?: boolean;
  /** Files to pre-read on the coordinator and inject into every worker's
   *  context. Saves redundant `read` tool calls across workers. Paths are
   *  relative to the repo root. */
  workerPreReadFiles?: string[];
  /** Max characters of pre-read content to inject per worker batch.
   *  Default: 50_000. */
  workerPreReadMaxChars?: number;
  /** Permission rules for headless/CI mode. Keys are tool names (e.g. "bash", "write").
   *  Values are glob-pattern → rule mappings. Patterns are matched against the
   *  target path (for file tools) or command string (for bash). */
  permissions?: Record<string, PermissionRules>;
  /** Prefer creating pull requests over pushing directly to the default branch.
   *  Injected into the system prompt. Default: true. */
  preferPullRequests?: boolean;
  /** Allow the bash tool to run `git push` directly to the repository's default
   *  branch. When false (default), such pushes are blocked and the model is
   *  directed to open a PR instead. */
  allowDirectPush?: boolean;
  /**
   * Local session tracing (docs/plans/trace-and-dataset-dev-plan.md). Off by
   * default; writes `trace.jsonl` + blobs per session under `root`
   * (default `${XDG_DATA_HOME:-~/.local/share}/kimiflare/traces`).
   * Env: KIMIFLARE_TRACE=1|0, KIMIFLARE_TRACE_DIR=<path>.
   */
  trace?: TraceConfig;
}

/** OpenRouter's default chat model (each provider's defaults live in src/providers/presets.ts). */
export const DEFAULT_MODEL = PROVIDER_PRESETS.openrouter.defaultModel!;
/** OpenRouter's cheap model for side calls; other providers use their preset's. */
export const DEFAULT_PLUMBING_MODEL = PROVIDER_PRESETS.openrouter.plumbingModel!;
/** Defaults when Requesty is the gateway (Requesty managed policy ids). */
export const REQUESTY_DEFAULT_MODEL = PROVIDER_PRESETS.requesty.defaultModel!;
export const REQUESTY_PLUMBING_MODEL = PROVIDER_PRESETS.requesty.plumbingModel!;

/**
 * Model for internal side calls (summaries, compaction, memory, decomposition):
 * the configured plumbing model — which loadConfig() defaults from the active
 * provider — else the session's chat model. Never another provider's id.
 */
export function plumbingModelOf(cfg: Pick<KimiConfig, "plumbingModel" | "model"> | null | undefined, sessionModel?: string): string {
  return cfg?.plumbingModel || sessionModel || cfg?.model || "";
}
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

export function configPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "kimiflare", "config.json");
}

function readReasoningEffortEnv(): ReasoningEffort | undefined {
  const raw = process.env.KIMI_REASONING_EFFORT?.toLowerCase();
  return (EFFORTS as readonly string[]).includes(raw ?? "")
    ? (raw as ReasoningEffort)
    : undefined;
}

function readSubagentPolicyEnv(): SubagentPolicy | undefined {
  const raw = process.env.KIMIFLARE_SUBAGENT_POLICY?.toLowerCase();
  return raw === "off" || raw === "suggest" || raw === "auto" ? raw : undefined;
}

function readCoauthorEnv(): { enabled: boolean; name: string; email: string } | undefined {
  const enabled = process.env.KIMIFLARE_COAUTHOR;
  if (enabled === "0" || enabled === "false") return undefined;
  const name = process.env.KIMIFLARE_COAUTHOR_NAME || "autopilot";
  const email = process.env.KIMIFLARE_COAUTHOR_EMAIL || "kimiflare@proton.me";
  return { enabled: true, name, email };
}

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return undefined;
}

function readNumberEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Env (KIMIFLARE_TRACE, KIMIFLARE_TRACE_DIR) wins over the file; default off. */
function resolveTraceConfig(persisted: Partial<TraceConfig> | undefined): TraceConfig | undefined {
  const envEnabled = readBooleanEnv("KIMIFLARE_TRACE");
  const envRoot = process.env.KIMIFLARE_TRACE_DIR?.trim() || undefined;
  if (envEnabled === undefined && envRoot === undefined && persisted === undefined) return undefined;
  const trace: TraceConfig = { enabled: envEnabled ?? persisted?.enabled ?? false };
  const root = envRoot ?? persisted?.root;
  if (root) trace.root = root;
  return trace;
}

export async function loadConfig(): Promise<KimiConfig | null> {
  // Always read the file up front, even when env vars provide credentials:
  // settings-only fields (theme, mcpServers, …) live only in the file and
  // must survive an env-driven launch.
  let persisted: Partial<KimiConfig> & LegacyConfigFields = {};
  let hasFile = false;
  try {
    const raw = await readFile(configPath(), "utf8");
    persisted = JSON.parse(raw) as Partial<KimiConfig> & LegacyConfigFields;
    hasFile = true;
  } catch {
    /* no config file yet — env-only is still valid */
  }

  // OpenRouter and Requesty keys keep their own top-level fields (and env
  // vars); every other provider's key lives under providers.<id>. Configs
  // written by the pre-release OpenRouter branch kept the key under
  // providerKeys.openrouter — honoured as a fallback.
  const openrouterApiKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.KIMIFLARE_OPENROUTER_KEY ||
    persisted.openrouterApiKey ||
    persisted.providerKeys?.openrouter ||
    undefined;

  // Custom OpenAI-compatible endpoint (see src/agent/custom-endpoint.ts): a
  // complete setup on its own, no OpenRouter key needed.
  const baseUrl = process.env.KIMIFLARE_BASE_URL ?? persisted.baseUrl;
  const apiKey = process.env.KIMIFLARE_API_KEY ?? persisted.apiKey;
  const requestyApiKey = process.env.REQUESTY_API_KEY || persisted.requestyApiKey || undefined;
  const providerFields = {
    provider: isProviderId(persisted.provider) ? persisted.provider : undefined,
    providers: persisted.providers,
    openrouterApiKey,
    requestyApiKey,
    baseUrl,
    apiKey,
  };

  // Every LLM default below follows the active provider.
  const active = resolveActiveProvider(providerFields);
  if (!isProviderUsable(active)) return null;
  const preset = active.preset;

  // KIMI_MODEL is an override, not a default: leave it undefined when unset so
  // the persisted `model` (set via /model) is honoured on the next launch.
  const envModel = process.env.KIMI_MODEL || undefined;
  const envEffort = readReasoningEffortEnv();
  const envSubagentPolicy = readSubagentPolicyEnv();
  const envCoauthor = readCoauthorEnv();

  const envCacheStable = process.env.KIMIFLARE_CACHE_STABLE_PROMPTS;
  const cacheStablePrompts = envCacheStable === "0" || envCacheStable === "false" ? false : true;
  const envCompiled = process.env.KIMIFLARE_COMPILED_CONTEXT;
  const compiledContext = envCompiled === "0" || envCompiled === "false" ? false : true;
  const envImageTurns = process.env.KIMIFLARE_IMAGE_HISTORY_TURNS;
  const imageHistoryTurns = envImageTurns ? parseInt(envImageTurns, 10) : undefined;

  const envWorkerPreReadFiles = process.env.KIMIFLARE_WORKER_PRE_READ_FILES
    ? process.env.KIMIFLARE_WORKER_PRE_READ_FILES.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  // Cloudflare-era ids only exist on OpenRouter; other providers' ids pass through.
  const m = active.id === "openrouter" ? migrateLegacyModelId : (id: string | undefined) => id;
  // Top-level model fields belong to the provider the file was written for
  // (its `provider`, or the one its credentials imply). When another
  // provider is active — AUTOPILOT_PROVIDER, or a switch — they are ignored,
  // so an OpenRouter id is never sent to OpenAI and vice versa.
  const savedFor = isProviderId(persisted.provider)
    ? persisted.provider
    : resolveProviderId({ ...providerFields, provider: undefined, baseUrl: persisted.baseUrl }, {});
  const own = <T,>(v: T | undefined): T | undefined => (savedFor === active.id ? v : undefined);
  const model =
    m(envModel ?? persisted.providers?.[active.id]?.model ?? own(persisted.model)) ?? preset.defaultModel;
  // Side calls use the provider's cheap model; with none (custom gateways,
  // local runtimes) they fall back to the chat model, never to another
  // provider's id.
  const plumbingDefault = preset.plumbingModel;
  const cfg: KimiConfig = {
    provider: providerFields.provider,
    providers: persisted.providers,
    openrouterApiKey,
    requestyApiKey,
    baseUrl,
    apiKey,
    // Cloudflare credentials survive only for /multi-agent Commute, which
    // deploys a Worker into the user's own Cloudflare account.
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? persisted.accountId,
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? persisted.apiToken,
    // Empty only for providers without a default (custom gateways, local
    // runtimes) until the user picks one; onboarding/`/model` handle that.
    model: model ?? "",
    openrouterProvider: persisted.openrouterProvider,
    reasoningEffort: envEffort ?? persisted.reasoningEffort,
    subagentPolicy: envSubagentPolicy ?? (
      persisted.subagentPolicy === "suggest" && persisted.subagentPolicyExplicit !== true
        ? "auto"
        : persisted.subagentPolicy === "off" || persisted.subagentPolicy === "suggest" || persisted.subagentPolicy === "auto"
          ? persisted.subagentPolicy
          : "auto"
    ),
    modesEnabled: persisted.modesEnabled,
    coauthor: envCoauthor?.enabled ?? persisted.coauthor ?? true,
    coauthorName: envCoauthor?.name ?? persisted.coauthorName,
    coauthorEmail: envCoauthor?.email ?? persisted.coauthorEmail,
    mcpServers: persisted.mcpServers,
    cacheStablePrompts: persisted.cacheStablePrompts ?? cacheStablePrompts,
    compiledContext: persisted.compiledContext ?? compiledContext,
    imageHistoryTurns:
      imageHistoryTurns === undefined || Number.isNaN(imageHistoryTurns)
        ? persisted.imageHistoryTurns
        : imageHistoryTurns,
    maxTotalToolIterations:
      readNumberEnv("KIMIFLARE_MAX_TOTAL_TOOL_ITERATIONS") ?? persisted.maxTotalToolIterations,
    memoryEnabled: readBooleanEnv("KIMIFLARE_MEMORY_ENABLED") ?? persisted.memoryEnabled ?? false,
    memoryDbPath: process.env.KIMIFLARE_MEMORY_DB_PATH ?? persisted.memoryDbPath,
    memoryMaxAgeDays: readNumberEnv("KIMIFLARE_MEMORY_MAX_AGE_DAYS") ?? persisted.memoryMaxAgeDays,
    memoryMaxEntries: readNumberEnv("KIMIFLARE_MEMORY_MAX_ENTRIES") ?? persisted.memoryMaxEntries,
    memoryEmbeddingModel: m(process.env.KIMIFLARE_MEMORY_EMBEDDING_MODEL ?? own(persisted.memoryEmbeddingModel)),
    plumbingModel: m(process.env.KIMIFLARE_PLUMBING_MODEL ?? own(persisted.plumbingModel)) ?? plumbingDefault,
    memoryExtractionModel:
      m(process.env.KIMIFLARE_MEMORY_EXTRACTION_MODEL ?? own(persisted.memoryExtractionModel)) ?? plumbingDefault,
    codeMode: readBooleanEnv("KIMIFLARE_CODE_MODE") ?? persisted.codeMode ?? true,
    completionCheck: readBooleanEnv("KIMIFLARE_COMPLETION_CHECK") ?? persisted.completionCheck ?? true,
    lspEnabled: persisted.lspEnabled,
    lspServers: persisted.lspServers,
    costAttribution: readBooleanEnv("KIMI_COST_ATTRIBUTION") ?? persisted.costAttribution ?? true,
    filePicker: readBooleanEnv("KIMIFLARE_FILE_PICKER") ?? persisted.filePicker ?? true,
    theme: persisted.theme,
    shell: process.env.KIMIFLARE_SHELL ?? persisted.shell,
    uiEngine: persisted.uiEngine,
    remoteWorkerUrl: persisted.remoteWorkerUrl,
    remoteAuthSecret: persisted.remoteAuthSecret,
    remoteTtlMinutes: persisted.remoteTtlMinutes,
    remoteMaxInputTokens: persisted.remoteMaxInputTokens,
    githubOAuthToken: persisted.githubOAuthToken,
    githubRefreshToken: persisted.githubRefreshToken,
    githubTokenExpiry: persisted.githubTokenExpiry,
    githubRepo: persisted.githubRepo,
    workerBudgetUsd: readNumberEnv("KIMIFLARE_WORKER_BUDGET_USD") ?? persisted.workerBudgetUsd,
    workerBudgetMaxUsd: readNumberEnv("KIMIFLARE_WORKER_BUDGET_MAX_USD") ?? persisted.workerBudgetMaxUsd,
    workerMaxParallel: readNumberEnv("KIMIFLARE_WORKER_MAX_PARALLEL") ?? persisted.workerMaxParallel,
    workerTimeoutMs: readNumberEnv("KIMIFLARE_WORKER_TIMEOUT_MS") ?? persisted.workerTimeoutMs,
    autoFreshSuggestionTurns: persisted.autoFreshSuggestionTurns,
    autoFreshEnabled: persisted.autoFreshEnabled,
    autoCompactTokenThreshold: persisted.autoCompactTokenThreshold,
    autoFreshTokenThreshold: persisted.autoFreshTokenThreshold,
    decompositionModel: m(own(persisted.decompositionModel)) ?? plumbingDefault,
    decompositionStrategy: persisted.decompositionStrategy,
    synthesisModel: m(own(persisted.synthesisModel)),
    synthesisStrategy: persisted.synthesisStrategy,
    disableLlmSynthesis: persisted.disableLlmSynthesis,
    workerPreReadFiles: envWorkerPreReadFiles ?? persisted.workerPreReadFiles,
    workerPreReadMaxChars: readNumberEnv("KIMIFLARE_WORKER_PRE_READ_MAX_CHARS") ?? persisted.workerPreReadMaxChars,
    permissions: persisted.permissions,
    preferPullRequests: readBooleanEnv("KIMIFLARE_PREFER_PULL_REQUESTS") ?? persisted.preferPullRequests ?? true,
    allowDirectPush: readBooleanEnv("KIMIFLARE_ALLOW_DIRECT_PUSH") ?? persisted.allowDirectPush ?? false,
    trace: resolveTraceConfig(persisted.trace),
  };

  // One-time cleanup of a Cloudflare-era config file: rewrite it without the
  // retired fields (OAuth session, gateway, unified billing, BYOK keys for
  // other providers, cloud mode) and with migrated model ids, so the file on
  // disk matches what is actually used. Env-derived values are not persisted.
  if (hasFile && hasLegacyFields(persisted)) {
    await rewriteLegacyConfig(persisted, openrouterApiKey).catch(() => undefined);
  }

  return stripUndefined(cfg);
}

/**
 * True when the config file on disk was written by the Cloudflare-era
 * kimiflare (it has Cloudflare credentials but no OpenRouter key). Onboarding
 * uses this to explain the switch to upgrading users instead of greeting
 * them like a first run.
 */
export async function hasLegacyCloudflareConfig(): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(configPath(), "utf8")) as Partial<KimiConfig> & LegacyConfigFields;
    return !raw.openrouterApiKey && !!(raw.cloudflareOAuth || raw.apiToken || raw.aiGatewayId || raw.cloudMode);
  } catch {
    return false;
  }
}

/** Fields written by kimiflare ≤0.99 (Cloudflare era) that are no longer read. */
interface LegacyConfigFields {
  cloudflareOAuth?: unknown;
  aiGatewayId?: string;
  aiGatewayCacheTtl?: number;
  aiGatewaySkipCache?: boolean;
  aiGatewayCollectLogPayload?: boolean;
  aiGatewayMetadata?: unknown;
  providerKeys?: Record<string, string | undefined>;
  providerKeyAliases?: unknown;
  secretsStoreId?: string;
  unifiedBilling?: boolean;
  cloudMode?: boolean;
}

const LEGACY_KEYS: readonly (keyof LegacyConfigFields)[] = [
  "cloudflareOAuth",
  "aiGatewayId",
  "aiGatewayCacheTtl",
  "aiGatewaySkipCache",
  "aiGatewayCollectLogPayload",
  "aiGatewayMetadata",
  "providerKeys",
  "providerKeyAliases",
  "secretsStoreId",
  "unifiedBilling",
  "cloudMode",
];

const MODEL_ID_KEYS = [
  "model",
  "plumbingModel",
  "memoryExtractionModel",
  "memoryEmbeddingModel",
  "decompositionModel",
  "synthesisModel",
] as const;

function hasLegacyFields(persisted: Partial<KimiConfig> & LegacyConfigFields): boolean {
  if (LEGACY_KEYS.some((k) => persisted[k] !== undefined)) return true;
  return MODEL_ID_KEYS.some((k) => {
    const v = persisted[k];
    return typeof v === "string" && migrateLegacyModelId(v) !== v;
  });
}

async function rewriteLegacyConfig(
  persisted: Partial<KimiConfig> & LegacyConfigFields,
  openrouterApiKey: string | undefined,
): Promise<void> {
  const next: Record<string, unknown> = { ...persisted };
  for (const k of LEGACY_KEYS) delete next[k];
  for (const k of MODEL_ID_KEYS) {
    const v = persisted[k];
    if (typeof v === "string") next[k] = migrateLegacyModelId(v);
  }
  // Keep a key that only lived under providerKeys.openrouter — but never copy
  // an env-provided key into the file.
  const fileKey = persisted.openrouterApiKey ?? persisted.providerKeys?.openrouter;
  if (fileKey && fileKey === openrouterApiKey) next.openrouterApiKey = fileKey;
  const p = configPath();
  await writeFile(p, JSON.stringify(next, null, 2), "utf8");
  await chmod(p, 0o600);
}

function stripUndefined<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}

/**
 * Side-call models that loadConfig() filled in from the active provider's
 * preset are not user choices: persisting them would pin one provider's ids
 * into the file and leak them into the next provider after a switch.
 */
function withoutDerivedDefaults(cfg: KimiConfig): KimiConfig {
  const plumbing = resolveActiveProvider(cfg).preset.plumbingModel;
  if (!plumbing) return cfg;
  const out: KimiConfig = { ...cfg };
  for (const k of ["plumbingModel", "memoryExtractionModel", "decompositionModel"] as const) {
    if (out[k] === plumbing) delete out[k];
  }
  return out;
}

/**
 * Merge `patch` into the on-disk config without disturbing unrelated fields
 * (unlike saveConfig(), which rewrites the whole file from an in-memory cfg
 * that may carry env-derived defaults).
 */
export async function patchPersistedConfig(patch: Partial<KimiConfig>): Promise<string> {
  const p = configPath();
  let existing: Partial<KimiConfig> = {};
  try {
    existing = JSON.parse(await readFile(p, "utf8")) as Partial<KimiConfig>;
  } catch {
    /* no file yet */
  }
  const merged = { ...existing, ...patch };
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(merged, null, 2), "utf8");
  await chmod(p, 0o600);
  return p;
}

/** Resolve and validate a worker budget, applying the hard ceiling.
 *
 *  - If no budget is configured, returns the default (1.0).
 *  - If the configured budget is ≤ 0, throws.
 *  - If the configured budget exceeds the hard ceiling (default 5.0), it is
 *    silently capped and a warning is logged.
 */
export function resolveWorkerBudgetUsd(cfg: KimiConfig | null): number {
  const DEFAULT_WORKER_BUDGET_USD = 1.0;
  const HARD_CEILING = cfg?.workerBudgetMaxUsd ?? 5.0;

  const raw = cfg?.workerBudgetUsd ?? DEFAULT_WORKER_BUDGET_USD;
  if (raw <= 0) {
    throw new Error(
      `Invalid workerBudgetUsd (${raw}). Must be > 0. Set via KIMIFLARE_WORKER_BUDGET_USD.`,
    );
  }
  if (raw > HARD_CEILING) {
    // eslint-disable-next-line no-console
    console.warn(
      `kimiflare: workerBudgetUsd ${raw} exceeds hard ceiling ${HARD_CEILING}; capping to ${HARD_CEILING}. ` +
        `Raise the ceiling with KIMIFLARE_WORKER_BUDGET_MAX_USD if you really need more.`,
    );
    return HARD_CEILING;
  }
  return raw;
}

export async function saveConfig(cfg: KimiConfig): Promise<string> {
  const p = configPath();
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(withoutDerivedDefaults(cfg), null, 2), "utf8");
  await chmod(p, 0o600);
  return p;
}
