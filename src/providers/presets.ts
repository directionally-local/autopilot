/**
 * Provider presets: everything Autopilot needs to know about an LLM provider
 * in one row — where to send requests, which key to use, which models to
 * default to, which request-shape quirks apply, and which OpenRouter-only
 * features it can support.
 *
 * Every model call (chat, side calls, embeddings), the catalog, cost
 * tracking, onboarding and feature gating read the *active* provider
 * (see resolve.ts). Nothing outside src/providers/ and the key-management
 * surfaces should branch on OpenRouter directly; that rule is enforced by
 * src/providers/openrouter-guard.test.ts.
 *
 * Model ids, base URLs and env names were checked against models.dev
 * (https://models.dev/api.json) on 2026-10-20.
 */

export const PROVIDER_IDS = [
  "openrouter",
  "requesty",
  "custom",
  "openai",
  "deepseek",
  "moonshot",
  "kimi-code",
  "anthropic",
  "zai",
  "zai-coding",
  "ollama",
  "lmstudio",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

/** Request-shape differences between OpenAI-compatible APIs (see client.ts). */
export interface ProviderCompat {
  /** Which output-limit field the API accepts. */
  maxTokensField: "max_completion_tokens" | "max_tokens";
  /** Send `parallel_tool_calls: true` with tools. */
  parallelToolCalls: boolean;
  /** Send `stream_options: { include_usage: true }` (OpenAI omits usage otherwise). */
  streamUsage: boolean;
  /** Send `reasoning_effort` for reasoning-capable models. */
  reasoningEffort: boolean;
  /**
   * Reasoning fields to echo back on assistant history. DeepSeek and Kimi
   * thinking models require `reasoning_content` during tool loops; strict
   * APIs reject OpenRouter's `reasoning_details`.
   */
  reasoningEcho: { content: boolean; details: boolean };
}

/** OpenRouter-specific features, by whether a provider can support them. */
export interface ProviderCapabilities {
  /** Per-request cost is confirmed by the provider (OpenRouter `usage.cost` / `/generation`). */
  costConfirmation: boolean;
  /** OpenRouter Decisions API (Jev): completion check, inbox triage, subagent policy. */
  decisionsApi: boolean;
  /** Hotcell subagents (their egress gateway only speaks OpenRouter today). */
  hotcellGateway: boolean;
}

export interface EmbeddingPreset {
  model: string;
  /** Vector length the model returns (memory rows record it). */
  dim: number;
}

/**
 * Wire protocol: OpenAI Chat Completions (most providers), the Anthropic
 * Messages API, or the OpenAI Responses API. The agent loop always speaks
 * Chat Completions shapes; src/agent/protocols/ converts.
 */
export type WireProtocol = "openai-chat" | "anthropic-messages" | "openai-responses";

/** Where the model list for the picker comes from. */
export type CatalogSource = "openrouter" | "requesty" | "models.dev" | "ollama" | "openai-models" | "none";

export interface ProviderPreset {
  id: ProviderId;
  /** Display name: "served through <name>", "/cost — <name>", error messages. */
  name: string;
  /** Wire protocol; default "openai-chat". */
  protocol?: WireProtocol;
  /** OpenAI-compatible base URL (without /chat/completions). Unset for custom/OpenRouter/Requesty. */
  baseUrl?: string;
  /** Env vars that hold the key, in priority order. */
  apiKeyEnv: readonly string[];
  /** False for local runtimes that accept unauthenticated requests. */
  keyRequired: boolean;
  /** Where users create a key. */
  keysUrl?: string;
  /** Status page linked from API error messages. */
  statusUrl?: string;
  /** Default chat model when none is configured. */
  defaultModel?: string;
  /** Cheap model for side calls (summaries, memory, decomposition). Falls back to the chat model. */
  plumbingModel?: string;
  /** Embedding model for memory/skills, or null when the provider has no embeddings API. */
  embedding: EmbeddingPreset | null;
  catalog: CatalogSource;
  /** models.dev provider key, when `catalog` is "models.dev". */
  modelsDevId?: string;
  compat: ProviderCompat;
  capabilities: ProviderCapabilities;
}

/** Plain OpenAI Chat Completions behaviour; presets override what differs. */
const OPENAI_COMPAT: ProviderCompat = {
  maxTokensField: "max_completion_tokens",
  parallelToolCalls: true,
  streamUsage: true,
  reasoningEffort: true,
  reasoningEcho: { content: false, details: false },
};

const NO_OPENROUTER_FEATURES: ProviderCapabilities = {
  costConfirmation: false,
  decisionsApi: false,
  hotcellGateway: false,
};

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    apiKeyEnv: ["OPENROUTER_API_KEY", "KIMIFLARE_OPENROUTER_KEY"],
    keyRequired: true,
    keysUrl: "https://openrouter.ai/settings/keys",
    statusUrl: "https://status.openrouter.ai",
    defaultModel: "moonshotai/kimi-k2.6",
    plumbingModel: "moonshotai/kimi-k2.5",
    // Same model Workers AI served, so existing memory vectors stay comparable.
    embedding: { model: "baai/bge-base-en-v1.5", dim: 768 },
    catalog: "openrouter",
    // The OpenRouter branch of the client gates each parameter on the
    // catalog's supported_parameters instead; these flags are unused there.
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: true, details: true } },
    capabilities: { costConfirmation: true, decisionsApi: true, hotcellGateway: true },
  },
  requesty: {
    id: "requesty",
    name: "Requesty",
    apiKeyEnv: ["REQUESTY_API_KEY"],
    keyRequired: true,
    keysUrl: "https://app.requesty.ai/api-keys",
    defaultModel: "kimi-k2.6",
    plumbingModel: "deepseek-v4-flash",
    embedding: { model: "openai/text-embedding-3-small", dim: 1536 },
    catalog: "requesty",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  custom: {
    id: "custom",
    name: "custom endpoint",
    apiKeyEnv: ["KIMIFLARE_API_KEY"],
    keyRequired: false,
    // No defaults: the host's gateway decides which models exist, and side
    // calls fall back to the session's chat model.
    embedding: null,
    catalog: "none",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    // Responses keeps GPT-5.x reasoning across a tool loop (encrypted items)
    // and serves the Responses-only codex/pro models.
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://platform.openai.com/api-keys",
    statusUrl: "https://status.openai.com",
    defaultModel: "gpt-6.1-sol",
    plumbingModel: "gpt-6-luna",
    embedding: { model: "text-embedding-3-small", dim: 1536 },
    catalog: "models.dev",
    modelsDevId: "openai",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    keyRequired: true,
    keysUrl: "https://platform.deepseek.com/api_keys",
    statusUrl: "https://status.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    plumbingModel: "deepseek-flash",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "deepseek",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot AI",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: ["MOONSHOT_API_KEY"],
    keyRequired: true,
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    defaultModel: "kimi-k2.6",
    plumbingModel: "kimi-k2.6",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "moonshotai",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: ["ANTHROPIC_API_KEY"],
    keyRequired: true,
    keysUrl: "https://console.anthropic.com/settings/keys",
    statusUrl: "https://status.anthropic.com",
    defaultModel: "claude-sonnet-5-5",
    plumbingModel: "claude-haiku-5-5",
    // No embeddings API: memory uses text recall unless embeddingProvider is set.
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "anthropic",
    // Thinking blocks (reasoning_details) must be replayed with their signatures.
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  "kimi-code": {
    id: "kimi-code",
    name: "Kimi Code",
    baseUrl: "https://api.kimi.ai/coding/v1",
    apiKeyEnv: ["KIMI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://www.kimi.com/code",
    defaultModel: "k3",
    plumbingModel: "kimi-for-coding-highspeed",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "kimi-code-plan-global",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  zai: {
    id: "zai",
    name: "Z.ai",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultModel: "glm-5.3",
    plumbingModel: "glm-5.3-flash",
    embedding: { model: "embedding-3", dim: 2048 },
    catalog: "models.dev",
    modelsDevId: "zai",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  "zai-coding": {
    id: "zai-coding",
    name: "Z.ai GLM Coding Plan",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: ["ZHIPU_API_KEY", "ZAI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://z.ai/manage-apikey/apikey-list",
    defaultModel: "glm-5.3",
    plumbingModel: "glm-5.3-flash",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "zai-coding-plan",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  ollama: {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: ["OLLAMA_API_KEY"],
    keyRequired: false,
    // Installed models are discovered; nothing to default to.
    embedding: { model: "nomic-embed-text", dim: 768 },
    catalog: "ollama",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEffort: false },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  lmstudio: {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: ["LMSTUDIO_API_KEY"],
    keyRequired: false,
    embedding: null,
    catalog: "openai-models",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEffort: false },
    capabilities: NO_OPENROUTER_FEATURES,
  },
};

export function getPreset(id: ProviderId): ProviderPreset {
  return PROVIDER_PRESETS[id];
}
