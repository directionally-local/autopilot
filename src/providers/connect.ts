/**
 * Connecting a provider, independent of the UI: the provider list with each
 * one's status, what connecting it needs (a sign-in, a key, a URL, nothing),
 * verifying the credentials and loading its models, and saving the switch.
 *
 * First-run onboarding and `/provider` in the Camouflage view both run on
 * this, so they offer the same steps.
 */

import { loadConfig, readPersistedConfig, type KimiConfig } from "../config.js";
import { checkOpenRouterKey, type OpenRouterKeyInfo } from "../models/openrouter.js";
import { ensureCatalogForProvider } from "../models/catalog.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { fuzzyFilter } from "../util/fuzzy.js";
import { getPreset, type ProviderId } from "./presets.js";
import { detectEnvProviders, resolveActiveProvider, resolveProviderKey } from "./resolve.js";
import { checkProviderKey, patchProviderSettings, saveProviderKey, switchProvider } from "./keys.js";

/** Every provider we offer, in order, with a one-line hint. */
export const PROVIDER_CHOICES: ReadonlyArray<{ id: ProviderId; hint: string }> = [
  { id: "openrouter", hint: "recommended — hundreds of models with one account" },
  { id: "anthropic", hint: "Claude models with an Anthropic API key" },
  { id: "openai", hint: "GPT models with an OpenAI API key" },
  { id: "chatgpt", hint: "your ChatGPT plan — sign in with ChatGPT" },
  { id: "gemini", hint: "Gemini models with a Google AI Studio key" },
  { id: "vertex", hint: "Gemini and Claude on Google Cloud (gcloud credentials)" },
  { id: "bedrock", hint: "Claude and more on AWS (your AWS credentials)" },
  { id: "minimax", hint: "MiniMax models with a MiniMax API key" },
  { id: "copilot", hint: "your GitHub Copilot plan — sign in with GitHub" },
  { id: "xai", hint: "Grok models with an xAI API key" },
  { id: "mistral", hint: "Mistral models with a Mistral API key" },
  { id: "groq", hint: "fast open models with a Groq key" },
  { id: "cerebras", hint: "fast open models with a Cerebras key" },
  { id: "together", hint: "open models with a Together AI key" },
  { id: "fireworks", hint: "open models with a Fireworks key" },
  { id: "deepinfra", hint: "open models with a DeepInfra key" },
  { id: "vercel", hint: "many vendors with one Vercel AI Gateway key" },
  { id: "cloudflare", hint: "Workers AI with your Cloudflare account" },
  { id: "azure", hint: "your Azure OpenAI resource and deployments" },
  { id: "deepseek", hint: "DeepSeek API key" },
  { id: "moonshot", hint: "Kimi models with a Moonshot API key" },
  { id: "kimi-code", hint: "Kimi Code subscription" },
  { id: "zai", hint: "GLM models with a Z.ai API key" },
  { id: "zai-coding", hint: "GLM Coding Plan subscription" },
  { id: "ollama", hint: "local models, no key" },
  { id: "lmstudio", hint: "local models, no key" },
  { id: "requesty", hint: "Requesty gateway key" },
  { id: "custom", hint: "any OpenAI-compatible endpoint (LiteLLM, vLLM, a company gateway)" },
];

/** Where a provider's credentials currently come from. */
export type CredentialSource = "env" | "config" | "none-needed" | null;

export interface ProviderRow {
  id: ProviderId;
  name: string;
  hint: string;
  active: boolean;
  credentials: CredentialSource;
}

/** A row's credential status, e.g. "key saved", "key in environment", "needs a key". (Pickers mark the current one themselves.) */
export function credentialLabel(row: ProviderRow): string {
  const signIn = row.id === "copilot" || row.id === "chatgpt";
  switch (row.credentials) {
    case "env":
      return "key in environment";
    case "config":
      return signIn ? "signed in" : row.id === "custom" ? "endpoint saved" : "key saved";
    case "none-needed":
      return row.id === "bedrock" ? "AWS credentials" : "no key needed";
    default:
      if (signIn) return "sign-in needed";
      if (row.id === "custom") return "needs an endpoint";
      if (row.id === "vertex") return "gcloud credentials";
      if (row.id === "azure") return "needs a resource";
      return "needs a key";
  }
}

/**
 * The provider list for a picker. Providers that are ready (current, key in
 * the environment, key saved) come first; `upgrading` puts Workers AI first
 * for a Cloudflare-era kimiflare config.
 */
export function providerRows(
  cfg: Partial<KimiConfig> | null,
  opts: { upgrading?: boolean; env?: NodeJS.ProcessEnv; markActive?: boolean } = {},
): ProviderRow[] {
  const env = opts.env ?? process.env;
  // First run has no "current" provider, only the default.
  const active = cfg && opts.markActive !== false ? resolveActiveProvider(cfg as KimiConfig, env).id : null;
  const envProviders = detectEnvProviders(env);
  const rows = PROVIDER_CHOICES.map(({ id, hint }): ProviderRow => {
    const preset = getPreset(id);
    const credentials: CredentialSource = envProviders.includes(id)
      ? "env"
      : resolveProviderKey(id, cfg as KimiConfig | null, env)
        ? "config"
        : !preset.keyRequired && id !== "custom" && id !== "azure" && id !== "vertex"
          ? "none-needed"
          : null;
    return { id, name: preset.name, hint, active: id === active, credentials };
  });
  const rank = (r: ProviderRow) =>
    r.active ? 4 : opts.upgrading && r.id === "cloudflare" ? 3 : r.credentials === "env" ? 2 : r.credentials === "config" ? 1 : 0;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => rank(b.r) - rank(a.r) || a.i - b.i).map((x) => x.r);
}

/**
 * Type-to-search, best first: name or id contains the query, then the hint
 * does ("claude" → Anthropic, then Vertex and Bedrock; "local" → Ollama, LM
 * Studio), then fuzzy matches on name/id, then on the hint.
 */
export function filterProviderRows(rows: ProviderRow[], query: string): ProviderRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  const tiers = [
    rows.filter((r) => `${r.name} ${r.id}`.toLowerCase().includes(q)),
    rows.filter((r) => r.hint.toLowerCase().includes(q)),
    fuzzyFilter(rows, q, (r) => `${r.name} ${r.id}`),
    fuzzyFilter(rows, q, (r) => r.hint),
  ];
  const seen = new Set<ProviderId>();
  return tiers.flat().filter((r) => !seen.has(r.id) && seen.add(r.id));
}

/** What connecting a provider takes, before any check. */
export type ConnectPlan =
  /** OpenRouter: sign in in the browser, or paste a key. */
  | { kind: "openrouter" }
  /** GitHub device login. */
  | { kind: "copilot" }
  /** Browser sign-in with token sharing. */
  | { kind: "chatgpt" }
  /** An endpoint first (custom: any URL; azure: resource name or URL), then a key. */
  | { kind: "baseUrl"; purpose: "custom" | "azure" }
  /** A Google Cloud project id; credentials come from gcloud. */
  | { kind: "project" }
  /** An API key to paste. */
  | { kind: "key" }
  /** Nothing to type: use these credentials (or none, for local runtimes). */
  | { kind: "ready"; key?: string; source: "env" | "config" | "none" };

export function planConnect(id: ProviderId, cfg: Partial<KimiConfig> | null, env: NodeJS.ProcessEnv = process.env): ConnectPlan {
  if (id === "openrouter") return { kind: "openrouter" };
  if (id === "copilot") return { kind: "copilot" };
  if (id === "chatgpt") return { kind: "chatgpt" };
  if (id === "custom") return { kind: "baseUrl", purpose: "custom" };
  if (id === "azure" && !resolveActiveProvider({ ...(cfg ?? {}), provider: "azure" } as KimiConfig, env).baseUrl) return { kind: "baseUrl", purpose: "azure" };
  if (id === "vertex" && !resolveActiveProvider({ ...(cfg ?? {}), provider: "vertex" } as KimiConfig, env).baseUrl) return { kind: "project" };
  const key = resolveProviderKey(id, cfg as KimiConfig | null, env);
  if (key) return { kind: "ready", key, source: getPreset(id).apiKeyEnv.some((n) => env[n]?.trim()) ? "env" : "config" };
  if (!getPreset(id).keyRequired) return { kind: "ready", source: "none" };
  return { kind: "key" };
}

/** Normalize what the user typed as an endpoint; null with a reason when it isn't usable. */
export function normalizeEndpoint(purpose: "custom" | "azure", input: string): { url: string } | { error: string } {
  let url = input.trim();
  // Azure: a bare resource name is enough.
  if (purpose === "azure" && /^[a-z0-9-]+$/i.test(url)) url = `https://${url}.openai.azure.com/openai/v1`;
  if (!/^https?:\/\//.test(url)) return { error: "Enter a URL starting with http:// or https://" };
  return { url };
}

export function isVertexProjectId(input: string): boolean {
  return /^[a-z][a-z0-9-]{4,}$/.test(input.trim());
}

export async function saveVertexProject(project: string): Promise<void> {
  await patchProviderSettings("vertex", { project: project.trim() });
}

/** How the credentials were obtained: typed and signed-in keys get saved; env and saved keys don't. */
export type KeySource = "key" | "signin" | "env" | "config" | "none";

export interface Connection {
  id: ProviderId;
  key?: string;
  source: KeySource;
  baseUrl?: string;
  /** OpenRouter only: the key's label and credit. */
  openRouter?: OpenRouterKeyInfo;
  /** Extra detail from the provider check (e.g. "· 12 models"). */
  detail?: string;
}

export type VerifyResult = { ok: true; connection: Connection } | { ok: false; message: string };

/**
 * Check the credentials (or reach the local runtime) and load the provider's
 * model catalog, so the model picker that follows lists the right models.
 */
export async function verifyProvider(
  id: ProviderId,
  key: string | undefined,
  source: KeySource,
  baseUrl?: string,
): Promise<VerifyResult> {
  const preset = getPreset(id);
  const connection: Connection = { id, source, ...(key ? { key } : {}), ...(baseUrl ? { baseUrl } : {}) };
  if (id === "copilot" && key) {
    // Access was checked during the device login.
  } else if (id === "openrouter" && key) {
    const res = await checkOpenRouterKey(key);
    if (!res.ok) {
      return {
        ok: false,
        message: res.reason === "invalid" ? "OpenRouter rejected this key. Check it was copied in full, or create a new one." : `Couldn't reach OpenRouter (${res.message}).`,
      };
    }
    connection.openRouter = res.info;
  } else {
    const res = await checkProviderKey(id, key, baseUrl ?? preset.baseUrl);
    if (!res.ok) return { ok: false, message: res.message };
    if (res.detail) connection.detail = res.detail;
  }
  const persisted = await readPersistedConfig();
  const auth =
    id === "vertex"
      ? llmAuthFromConfig({ ...persisted, provider: "vertex" }, "vertex")
      : llmAuthFromConfig(
          {
            ...(id === "cloudflare" ? { accountId: persisted?.accountId, apiToken: persisted?.apiToken } : {}),
            provider: id,
            ...(id === "openrouter" ? { openrouterApiKey: key } : {}),
            ...(id === "requesty" ? { requestyApiKey: key } : {}),
            ...(id === "custom" ? { baseUrl, apiKey: key } : {}),
            providers: { [id]: { ...(key ? { apiKey: key } : {}), ...(baseUrl ? { baseUrl } : {}) } },
          },
          id,
        );
  await ensureCatalogForProvider(auth);
  return { ok: true, connection };
}

/** Save the credentials we were given (never env or already-saved keys), switch, and reload the config. */
export async function commitProvider(connection: Connection, modelId: string): Promise<KimiConfig> {
  const { id, key, source, baseUrl } = connection;
  const toSave = source === "key" || source === "signin" ? key : undefined;
  if (toSave || (id === "custom" && baseUrl)) {
    await saveProviderKey(id, toSave, id === "custom" || id === "copilot" || id === "azure" ? baseUrl || undefined : undefined);
  }
  await switchProvider(null, id, modelId);
  const cfg = await loadConfig();
  if (!cfg) throw new Error("config did not load after saving");
  return cfg;
}

/** GitHub device login for Copilot. `onCode` shows the code; resolves once approved and access is confirmed. */
export async function copilotSignIn(
  onCode: (code: { uri: string; code: string }) => void,
  signal?: AbortSignal,
): Promise<{ key: string; baseUrl: string }> {
  const { startDeviceFlow, pollDeviceFlow, checkCopilotAccess } = await import("./copilot.js");
  const code = await startDeviceFlow();
  onCode({ uri: code.verificationUri, code: code.userCode });
  const token = await pollDeviceFlow(code, undefined, signal ? { signal } : {});
  const access = await checkCopilotAccess(token);
  return { key: token, baseUrl: access.apiBase };
}

/** "Sign in with ChatGPT": browser sign-in with token sharing. Tokens are saved as soon as it succeeds. */
export async function chatgptSignIn(onUrl: (url: string) => void, signal?: AbortSignal): Promise<{ key: string }> {
  const persisted = await readPersistedConfig();
  const { hostId, startChatGPTSignIn, saveChatGPTSettings } = await import("./chatgpt.js");
  const signIn = await startChatGPTSignIn({ savedClientId: persisted?.providers?.chatgpt?.clientId, hostId: await hostId() });
  onUrl(signIn.url);
  let settings;
  try {
    settings = await untilAborted(signIn.done, signal);
  } finally {
    signIn.close();
  }
  await saveChatGPTSettings(settings);
  if (!settings.apiKey) throw new Error("ChatGPT sign-in finished without a token; try again");
  return { key: settings.apiKey };
}

/** Reject with an AbortError when `signal` aborts first. */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("sign-in cancelled", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * "Sign in with OpenRouter" without a UI (the Ink panel is OpenRouterSignIn):
 * the OAuth PKCE flow with a local callback, or — on SSH / display-less
 * machines — a link to open anywhere plus the code OpenRouter shows.
 */
export async function openRouterSignIn(io: {
  /** Show the sign-in link; `opened` says whether a browser was launched. */
  show(url: string, opened: boolean): void;
  open(url: string): boolean;
  /** Code mode: ask for the code OpenRouter displays (null = cancelled). */
  askCode(): Promise<string | null>;
  signal?: AbortSignal;
}): Promise<string> {
  const { buildAuthUrl, createPkce, exchangeCode, isHeadlessEnvironment, startLoopbackListener } = await import("../models/openrouter-oauth.js");
  const pkce = createPkce();
  if (!isHeadlessEnvironment()) {
    const listener = await startLoopbackListener(io.signal ? { signal: io.signal } : {});
    try {
      const url = buildAuthUrl({ challenge: pkce.challenge, callbackUrl: listener.callbackUrl });
      io.show(url, io.open(url));
      return await exchangeCode(await untilAborted(listener.code, io.signal), pkce.verifier);
    } finally {
      listener.close();
    }
  }
  const url = buildAuthUrl({ challenge: pkce.challenge });
  io.show(url, false);
  const code = await io.askCode();
  if (!code?.trim()) throw new DOMException("sign-in cancelled", "AbortError");
  return exchangeCode(code.trim(), pkce.verifier);
}

/** The "connected" line after verifying, e.g. "OpenRouter connected (my-key) · $4.20 credit left on this key". */
export function describeConnection(c: Connection): string {
  const preset = getPreset(c.id);
  const parts = [`${preset.name} connected`];
  if (c.source === "env") parts.push("(key from your environment)");
  if (c.openRouter?.label) parts.push(`(${c.openRouter.label})`);
  let line = parts.join(" ");
  if (c.id === "openrouter" && typeof c.openRouter?.limitRemaining === "number") {
    line += ` · $${c.openRouter.limitRemaining.toFixed(2)} credit left on this key`;
  } else if (c.detail) {
    line += ` ${c.detail}`;
  }
  return line;
}

/** Masked display of a saved key, e.g. "sk-or-…a1b2". */
export function maskKey(key: string): string {
  if (key.length <= 10) return "•".repeat(key.length);
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/** The line shown after a switch (or why the environment overrides it). */
export function switchedMessage(cfg: KimiConfig, to: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const preset = getPreset(to);
  const effective = resolveActiveProvider(cfg, env);
  if (effective.id !== to) {
    return `saved ${preset.name} as your provider, but ${env.AUTOPILOT_PROVIDER ? "AUTOPILOT_PROVIDER" : "KIMIFLARE_BASE_URL"} in the environment keeps ${effective.preset.name} active for this run`;
  }
  return `provider: ${preset.name} · model ${cfg.model || "(none yet — pick one with /model)"}. Conversation history is kept; memory and skills re-index for this provider's embedding model.`;
}
