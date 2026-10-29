import { readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isProviderId, PROVIDER_PRESETS, type ProviderId } from "./providers/presets.js";
import { isProviderUsable, noteActiveProvider, resolveActiveProvider, resolveProviderId, type ProviderSettings } from "./providers/resolve.js";
import { migrateLegacyModelId } from "./models/registry.js";
import type { OpenRouterProviderPrefs } from "./agent/client.js";
import type { SubagentPolicy } from "./intent/subagent-policy.js";
import { readEnv } from "./util/env.js";

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
  /** Attached images are downscaled to this long edge (px) and re-encoded
   *  before upload. 0 sends images unchanged. Default 1568. */
  imageMaxEdge?: number;
  /** Email the operator about unattended runs (needs RESEND_API_KEY). Env:
   *  AUTOPILOT_NOTIFY_EMAIL_TO / AUTOPILOT_NOTIFY_EMAIL_FROM override. */
  runNotifications?: { email?: { to?: string | string[]; from?: string; events?: string[] } };
  /** Cap on unattended runs doing work at once (`autopilot serve`). Default 4; env AUTOPILOT_MAX_CONCURRENT_RUNS. */
  maxConcurrentRuns?: number;
  /** JPEG quality (1–100) for re-encoded images. Default 75. */
  imageQuality?: number;
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
  /** Embedding model for memory and skill vectors. Default: the embedding provider's preset model. */
  memoryEmbeddingModel?: string;
  /**
   * Provider for memory/skill embeddings when it should differ from the chat
   * provider (env: AUTOPILOT_EMBEDDING_PROVIDER) — e.g. keep an OpenAI key
   * for embeddings while chatting with Anthropic or DeepSeek, which have no
   * embeddings API. Unset: the active provider.
   */
  embeddingProvider?: ProviderId;
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
  /** Optional absolute cap for the budget-relative compaction thresholds (cost
   *  control). Off by default: thresholds scale with the model's context window. */
  autoCompactCapTokens?: number;
  /** Estimated in-memory token threshold to trigger auto-fresh when compaction cannot reduce below this. Default: 2_000_000. */
  autoFreshTokenThreshold?: number;
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
  /** Append a compact diagnostics block to successful edit/write results.
   *  Uses the language server when one is running, else a fast syntax check.
   *  Default: true. */
  postEditDiagnostics?: boolean;
  /** Include warnings (not just errors) in the post-edit diagnostics block.
   *  Default: false. */
  postEditDiagnosticsWarnings?: boolean;
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
  const raw = readEnv("SUBAGENT_POLICY")?.toLowerCase();
  return raw === "off" || raw === "suggest" || raw === "auto" ? raw : undefined;
}

function readCoauthorEnv(): { enabled: boolean; name: string; email: string } | undefined {
  const enabled = readEnv("COAUTHOR");
  if (enabled === "0" || enabled === "false") return undefined;
  const name = readEnv("COAUTHOR_NAME") || "autopilot";
  const email = readEnv("COAUTHOR_EMAIL") || "kimiflare@proton.me";
  return { enabled: true, name, email };
}

/** Boolean `AUTOPILOT_<suffix>` (or legacy `KIMIFLARE_<suffix>`) setting. */
function readBooleanEnv(suffix: string): boolean | undefined {
  return parseBooleanEnv(readEnv(suffix));
}

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  return undefined;
}

/** Integer `AUTOPILOT_<suffix>` (or legacy `KIMIFLARE_<suffix>`) setting. */
function readNumberEnv(suffix: string): number | undefined {
  const raw = readEnv(suffix);
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Env (KIMIFLARE_TRACE, KIMIFLARE_TRACE_DIR) wins over the file; default off. */
function resolveTraceConfig(persisted: Partial<TraceConfig> | undefined): TraceConfig | undefined {
  const envEnabled = readBooleanEnv("TRACE");
  const envRoot = readEnv("TRACE_DIR")?.trim() || undefined;
  if (envEnabled === undefined && envRoot === undefined && persisted === undefined) return undefined;
  const trace: TraceConfig = { enabled: envEnabled ?? persisted?.enabled ?? false };
  const root = envRoot ?? persisted?.root;
  if (root) trace.root = root;
  return trace;
}

export async function loadConfig(): Promise<KimiConfig | null> {
  // Always read the file up front, even when env vars provide credentials:
  // settings-only fields (mcpServers, lspServers, …) live only in the file and
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
    readEnv("OPENROUTER_KEY") ||
    persisted.openrouterApiKey ||
    persisted.providerKeys?.openrouter ||
    undefined;

  // Custom OpenAI-compatible endpoint (see src/agent/custom-endpoint.ts): a
  // complete setup on its own, no OpenRouter key needed.
  const baseUrl = readEnv("BASE_URL") ?? persisted.baseUrl;
  const apiKey = readEnv("API_KEY") ?? persisted.apiKey;
  const requestyApiKey = process.env.REQUESTY_API_KEY || persisted.requestyApiKey || undefined;
  const providerFields = {
    provider: isProviderId(persisted.provider) ? persisted.provider : undefined,
    providers: persisted.providers,
    openrouterApiKey,
    requestyApiKey,
    baseUrl,
    apiKey,
    accountId: persisted.accountId,
    apiToken: persisted.apiToken,
  };

  // Every LLM default below follows the active provider.
  const active = resolveActiveProvider(providerFields);
  if (!isProviderUsable(active)) return null;
  noteActiveProvider(active.id);
  const preset = active.preset;

  // KIMI_MODEL is an override, not a default: leave it undefined when unset so
  // the persisted `model` (set via /model) is honoured on the next launch.
  const envModel = process.env.KIMI_MODEL || undefined;
  const envEffort = readReasoningEffortEnv();
  const envSubagentPolicy = readSubagentPolicyEnv();
  const envCoauthor = readCoauthorEnv();

  const envCacheStable = readEnv("CACHE_STABLE_PROMPTS");
  const cacheStablePrompts = envCacheStable === "0" || envCacheStable === "false" ? false : true;
  const envCompiled = readEnv("COMPILED_CONTEXT");
  const compiledContext = envCompiled === "0" || envCompiled === "false" ? false : true;
  const envImageTurns = readEnv("IMAGE_HISTORY_TURNS");
  const imageHistoryTurns = envImageTurns ? parseInt(envImageTurns, 10) : undefined;


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
    // Cloudflare account id and token: the Workers AI provider uses them
    // (and Cloudflare-era configs still carry them).
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
    runNotifications: persisted.runNotifications,
    maxConcurrentRuns: persisted.maxConcurrentRuns,
    cacheStablePrompts: persisted.cacheStablePrompts ?? cacheStablePrompts,
    compiledContext: persisted.compiledContext ?? compiledContext,
    imageHistoryTurns:
      imageHistoryTurns === undefined || Number.isNaN(imageHistoryTurns)
        ? persisted.imageHistoryTurns
        : imageHistoryTurns,
    imageMaxEdge: readNumberEnv("IMAGE_MAX_EDGE") ?? persisted.imageMaxEdge,
    imageQuality: readNumberEnv("IMAGE_QUALITY") ?? persisted.imageQuality,
    maxTotalToolIterations:
      readNumberEnv("MAX_TOTAL_TOOL_ITERATIONS") ?? persisted.maxTotalToolIterations,
    memoryEnabled: readBooleanEnv("MEMORY_ENABLED") ?? persisted.memoryEnabled ?? false,
    memoryDbPath: readEnv("MEMORY_DB_PATH") ?? persisted.memoryDbPath,
    memoryMaxAgeDays: readNumberEnv("MEMORY_MAX_AGE_DAYS") ?? persisted.memoryMaxAgeDays,
    memoryMaxEntries: readNumberEnv("MEMORY_MAX_ENTRIES") ?? persisted.memoryMaxEntries,
    memoryEmbeddingModel: m(readEnv("MEMORY_EMBEDDING_MODEL") ?? own(persisted.memoryEmbeddingModel)),
    embeddingProvider: isProviderId(persisted.embeddingProvider) ? persisted.embeddingProvider : undefined,
    plumbingModel: m(readEnv("PLUMBING_MODEL") ?? own(persisted.plumbingModel)) ?? plumbingDefault,
    memoryExtractionModel:
      m(readEnv("MEMORY_EXTRACTION_MODEL") ?? own(persisted.memoryExtractionModel)) ?? plumbingDefault,
    codeMode: readBooleanEnv("CODE_MODE") ?? persisted.codeMode ?? true,
    completionCheck: readBooleanEnv("COMPLETION_CHECK") ?? persisted.completionCheck ?? true,
    lspEnabled: persisted.lspEnabled,
    lspServers: persisted.lspServers,
    costAttribution: parseBooleanEnv(process.env.KIMI_COST_ATTRIBUTION) ?? persisted.costAttribution ?? true,
    filePicker: readBooleanEnv("FILE_PICKER") ?? persisted.filePicker ?? true,
    shell: readEnv("SHELL") ?? persisted.shell,
    remoteWorkerUrl: persisted.remoteWorkerUrl,
    remoteAuthSecret: persisted.remoteAuthSecret,
    remoteTtlMinutes: persisted.remoteTtlMinutes,
    remoteMaxInputTokens: persisted.remoteMaxInputTokens,
    githubOAuthToken: persisted.githubOAuthToken,
    githubRefreshToken: persisted.githubRefreshToken,
    githubTokenExpiry: persisted.githubTokenExpiry,
    githubRepo: persisted.githubRepo,
    workerMaxParallel: readNumberEnv("WORKER_MAX_PARALLEL") ?? persisted.workerMaxParallel,
    workerTimeoutMs: readNumberEnv("WORKER_TIMEOUT_MS") ?? persisted.workerTimeoutMs,
    autoFreshSuggestionTurns: persisted.autoFreshSuggestionTurns,
    autoFreshEnabled: persisted.autoFreshEnabled,
    autoCompactTokenThreshold: persisted.autoCompactTokenThreshold,
    autoCompactCapTokens: readNumberEnv("AUTO_COMPACT_CAP_TOKENS") ?? persisted.autoCompactCapTokens,
    autoFreshTokenThreshold: persisted.autoFreshTokenThreshold,
    permissions: persisted.permissions,
    preferPullRequests: readBooleanEnv("PREFER_PULL_REQUESTS") ?? persisted.preferPullRequests ?? true,
    allowDirectPush: readBooleanEnv("ALLOW_DIRECT_PUSH") ?? persisted.allowDirectPush ?? false,
    postEditDiagnostics: readBooleanEnv("POST_EDIT_DIAGNOSTICS") ?? persisted.postEditDiagnostics ?? true,
    postEditDiagnosticsWarnings: readBooleanEnv("POST_EDIT_DIAGNOSTICS_WARNINGS") ?? persisted.postEditDiagnosticsWarnings ?? false,
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

/** The config file as stored (no env, no defaults), or null when there is none. */
export async function readPersistedConfig(): Promise<Partial<KimiConfig> | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Partial<KimiConfig>;
  } catch {
    return null;
  }
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

/** Fields persisted by older config versions that are no longer read. */
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
  /** Remote-era multi-agent decomposition/synthesis settings (no longer used). */
  decompositionModel?: string;
  decompositionStrategy?: string;
  synthesisModel?: string;
  synthesisStrategy?: string;
  disableLlmSynthesis?: boolean;
  workerPreReadFiles?: string[];
  workerPreReadMaxChars?: number;
  /** Retired worker spend-cap settings; accepted so old config files can be cleaned up safely. */
  workerBudgetUsd?: unknown;
  workerBudgetMaxUsd?: unknown;
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
  "decompositionModel",
  "decompositionStrategy",
  "synthesisModel",
  "synthesisStrategy",
  "disableLlmSynthesis",
  "workerPreReadFiles",
  "workerPreReadMaxChars",
  "workerBudgetUsd",
  "workerBudgetMaxUsd",
];

const MODEL_ID_KEYS = [
  "model",
  "plumbingModel",
  "memoryExtractionModel",
  "memoryEmbeddingModel",
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
async function forSaving(cfg: KimiConfig, path: string): Promise<KimiConfig> {
  const active = resolveActiveProvider(cfg);
  const out: KimiConfig = { ...cfg };
  const plumbing = active.preset.plumbingModel;
  if (plumbing) {
    for (const k of ["plumbingModel", "memoryExtractionModel"] as const) {
      if (out[k] === plumbing) delete out[k];
    }
  }
  // The top-level `model` belongs to the provider the file is written for.
  // When another provider is active only for this run (AUTOPILOT_PROVIDER),
  // its model goes under providers.<id>.model and the file's own model stays.
  const owner = isProviderId(cfg.provider) ? cfg.provider : resolveProviderId({ ...cfg, provider: undefined }, {});
  if (owner !== active.id) {
    let onDisk: Partial<KimiConfig> = {};
    try {
      onDisk = JSON.parse(await readFile(path, "utf8")) as Partial<KimiConfig>;
    } catch {
      /* no file yet */
    }
    out.providers = { ...out.providers, [active.id]: { ...out.providers?.[active.id], model: cfg.model } };
    if (onDisk.model) out.model = onDisk.model;
    else delete (out as Partial<KimiConfig>).model;
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

export async function saveConfig(cfg: KimiConfig): Promise<string> {
  const p = configPath();
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, JSON.stringify(await forSaving(cfg, p), null, 2), "utf8");
  await chmod(p, 0o600);
  return p;
}
