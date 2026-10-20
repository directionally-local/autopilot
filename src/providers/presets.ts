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
  "gemini",
  "minimax",
  "copilot",
  "xai",
  "mistral",
  "groq",
  "cerebras",
  "together",
  "fireworks",
  "deepinfra",
  "vercel",
  "cloudflare",
  "azure",
  "chatgpt",
  "vertex",
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
   * Keep provider-specific `extra_content` on assistant tool calls (Gemini's
   * thought signatures, which must be sent back with the call they belong
   * to). Stripped for every other provider.
   */
  toolCallExtras?: boolean;
  /** Extra request fields the provider needs (e.g. MiniMax's `reasoning_split`). */
  extraBody?: Record<string, unknown>;
  /** The model may stream its reasoning inline as `<think>…</think>` in the content; split it out. */
  thinkTags?: boolean;
  /** Tool-call id format the API enforces: Mistral requires exactly 9 alphanumerics. */
  toolIdFormat?: "mistral";
  /** Extra headers on every request (e.g. Cerebras' integration header). */
  headers?: Record<string, string>;
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
export type CatalogSource = "openrouter" | "requesty" | "models.dev" | "ollama" | "openai-models" | "copilot" | "azure" | "chatgpt" | "none";

export interface ProviderPreset {
  id: ProviderId;
  /** Display name: "served through <name>", "/cost — <name>", error messages. */
  name: string;
  /** Wire protocol; default "openai-chat". A model's catalog entry can override it (Copilot). */
  protocol?: WireProtocol;
  /** Billed by a subscription plan rather than per token (cost shows $0 with a note). */
  subscription?: boolean;
  /** How the key is sent: `Authorization: Bearer` (default) or Azure's `api-key` header. */
  authHeader?: "bearer" | "api-key";
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
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    // Gemini's OpenAI-compatible endpoint; thought signatures ride on tool calls as extra_content.
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://aistudio.google.com/apikey",
    statusUrl: "https://aistudio.google.com/status",
    defaultModel: "gemini-3.8-flash",
    plumbingModel: "gemini-flash-lite-latest",
    embedding: { model: "gemini-embedding-001", dim: 3072 },
    catalog: "models.dev",
    modelsDevId: "google",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, toolCallExtras: true },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  minimax: {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.io/v1",
    apiKeyEnv: ["MINIMAX_API_KEY"],
    keyRequired: true,
    keysUrl: "https://platform.minimax.io/user-center/basic-information/interface-key",
    defaultModel: "MiniMax-M3",
    plumbingModel: "MiniMax-M3.1-Flash",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "minimax",
    compat: {
      ...OPENAI_COMPAT,
      maxTokensField: "max_tokens",
      parallelToolCalls: false,
      reasoningEffort: false,
      // reasoning_split returns thinking as reasoning_details (which MiniMax
      // needs back during tool loops) instead of <think> tags in the content.
      reasoningEcho: { content: false, details: true },
      extraBody: { reasoning_split: true },
      thinkTags: true,
    },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot",
    // Overridden per account by the API base /copilot_internal/user reports (providers.copilot.baseUrl).
    baseUrl: "https://api.githubcopilot.com",
    // A Copilot OAuth token from `autopilot auth copilot`. Deliberately not GITHUB_TOKEN:
    // ordinary PATs aren't Copilot tokens, and that variable is set in many CI environments.
    apiKeyEnv: ["GITHUB_COPILOT_TOKEN"],
    keyRequired: true,
    statusUrl: "https://www.githubstatus.com",
    subscription: true,
    embedding: null,
    catalog: "copilot",
    // Per-model protocol from the live list: Claude → Messages, GPT-5+ → Responses, others → chat.
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, streamUsage: true, reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  xai: {
    id: "xai",
    name: "xAI",
    protocol: "openai-responses",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: ["XAI_API_KEY"],
    keyRequired: true,
    keysUrl: "https://console.x.ai",
    statusUrl: "https://status.x.ai",
    defaultModel: "grok-4.7",
    plumbingModel: "grok-4.3",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "xai",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: ["MISTRAL_API_KEY"],
    keyRequired: true,
    keysUrl: "https://console.mistral.ai/api-keys",
    statusUrl: "https://status.mistral.ai",
    defaultModel: "mistral-large-4",
    plumbingModel: "mistral-small-latest",
    embedding: { model: "mistral-embed", dim: 1024 },
    catalog: "models.dev",
    modelsDevId: "mistral",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEffort: false, toolIdFormat: "mistral" },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  groq: {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
    keyRequired: true,
    keysUrl: "https://console.groq.com/keys",
    statusUrl: "https://groqstatus.com",
    defaultModel: "openai/gpt-oss-120b",
    plumbingModel: "openai/gpt-oss-20b",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "groq",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", streamUsage: false },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: ["CEREBRAS_API_KEY"],
    keyRequired: true,
    keysUrl: "https://cloud.cerebras.ai",
    defaultModel: "gpt-oss-120b",
    plumbingModel: "gpt-oss-120b",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "cerebras",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_completion_tokens", headers: { "X-Cerebras-3rd-Party-Integration": "autopilot" } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  together: {
    id: "together",
    name: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: ["TOGETHER_API_KEY"],
    keyRequired: true,
    keysUrl: "https://api.together.ai/settings/api-keys",
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
    plumbingModel: "zai-org/GLM-5.3-Flash",
    // Same model as OpenRouter's default, so memory vectors stay comparable.
    embedding: { model: "BAAI/bge-base-en-v1.5", dim: 768 },
    catalog: "models.dev",
    modelsDevId: "togetherai",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  fireworks: {
    id: "fireworks",
    name: "Fireworks AI",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: ["FIREWORKS_API_KEY"],
    keyRequired: true,
    keysUrl: "https://app.fireworks.ai/settings/users/api-keys",
    defaultModel: "accounts/fireworks/models/deepseek-v4p1-flash",
    plumbingModel: "accounts/fireworks/models/deepseek-v4p1-flash",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "fireworks-ai",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  deepinfra: {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: ["DEEPINFRA_API_KEY"],
    keyRequired: true,
    keysUrl: "https://deepinfra.com/dash/api_keys",
    defaultModel: "deepseek-ai/DeepSeek-V4.1-Flash",
    plumbingModel: "XiaomiMiMo/MiMo-V2.6-Flash",
    embedding: { model: "BAAI/bge-base-en-v1.5", dim: 768 },
    catalog: "models.dev",
    modelsDevId: "deepinfra",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  vercel: {
    id: "vercel",
    name: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
    apiKeyEnv: ["AI_GATEWAY_API_KEY"],
    keyRequired: true,
    keysUrl: "https://vercel.com/dashboard/ai-gateway",
    defaultModel: "anthropic/claude-sonnet-5.5",
    plumbingModel: "deepseek/deepseek-v4.1-flash-1017",
    embedding: { model: "openai/text-embedding-3-small", dim: 1536 },
    catalog: "models.dev",
    modelsDevId: "vercel",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  cloudflare: {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    // The account id is filled in from CLOUDFLARE_ACCOUNT_ID or `accountId` in config
    // (configs from the Cloudflare-era kimiflare still have it).
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    apiKeyEnv: ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"],
    keyRequired: true,
    keysUrl: "https://dash.cloudflare.com/profile/api-tokens",
    statusUrl: "https://www.cloudflarestatus.com",
    defaultModel: "@cf/zai-org/glm-5.3",
    plumbingModel: "@cf/zai-org/glm-5.3-flash",
    // The model kimiflare's Cloudflare-era memory used: old memory databases stay comparable.
    embedding: { model: "@cf/baai/bge-base-en-v1.5", dim: 768 },
    catalog: "models.dev",
    modelsDevId: "cloudflare-workers-ai",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, reasoningEcho: { content: true, details: false } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  azure: {
    id: "azure",
    name: "Azure OpenAI",
    protocol: "openai-responses",
    // Azure OpenAI's v1 API (no api-version needed). The resource comes from
    // AZURE_RESOURCE_NAME, or set providers.azure.baseUrl
    // (`autopilot auth azure --resource <name>` does).
    baseUrl: "https://${AZURE_RESOURCE_NAME}.openai.azure.com/openai/v1",
    apiKeyEnv: ["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"],
    authHeader: "api-key",
    keyRequired: true,
    keysUrl: "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    statusUrl: "https://azure.status.microsoft",
    // Model ids are your deployment names: discovered from the resource.
    embedding: null,
    catalog: "azure",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    // Token sharing: your ChatGPT plan's GPT models through the normal Responses API.
    protocol: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    // Set by `autopilot auth chatgpt` (refreshed automatically); the env var is for short headless runs.
    apiKeyEnv: ["CHATGPT_ACCESS_TOKEN"],
    keyRequired: true,
    statusUrl: "https://status.openai.com",
    subscription: true,
    defaultModel: "gpt-6.1-sol",
    plumbingModel: "gpt-6-luna",
    embedding: null,
    catalog: "chatgpt",
    modelsDevId: "openai",
    compat: { ...OPENAI_COMPAT, reasoningEcho: { content: false, details: true } },
    capabilities: NO_OPENROUTER_FEATURES,
  },
  vertex: {
    id: "vertex",
    name: "Google Vertex AI",
    // Built from the project and location (src/providers/vertex.ts); Claude goes to
    // Anthropic's Messages API on Vertex, everything else to the OpenAI-compatible endpoint.
    apiKeyEnv: ["GOOGLE_VERTEX_ACCESS_TOKEN"],
    keyRequired: false,
    keysUrl: "https://cloud.google.com/docs/authentication/provide-credentials-adc",
    statusUrl: "https://status.cloud.google.com",
    defaultModel: "gemini-3.8-flash",
    plumbingModel: "gemini-3.5-flash-lite",
    embedding: null,
    catalog: "models.dev",
    modelsDevId: "google-vertex",
    compat: { ...OPENAI_COMPAT, maxTokensField: "max_tokens", parallelToolCalls: false, toolCallExtras: true, reasoningEcho: { content: false, details: true } },
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

/** The auth header(s) a provider expects for `key` (Bearer for all but Azure's api-key). */
export function keyHeaders(id: ProviderId | undefined, key: string | undefined): Record<string, string> {
  if (!key) return {};
  return id && PROVIDER_PRESETS[id].authHeader === "api-key" ? { "api-key": key } : { Authorization: `Bearer ${key}` };
}
