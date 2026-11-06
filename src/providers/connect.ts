/**
 * Connecting a provider, independent of the UI: the provider list with each
 * one's status, what connecting it needs (a sign-in, a key, a URL, nothing),
 * verifying the credentials and loading its models, and saving the switch.
 *
 * First-run onboarding and `/provider` in the Camouflage view both run on
 * this, so they offer the same steps.
 */

import { loadConfig, readPersistedConfig, type AutopilotConfig } from "../config.js";
import { checkOpenRouterKey, type OpenRouterKeyInfo } from "../models/openrouter.js";
import { ensureCatalogForProvider } from "../models/catalog.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { fuzzyFilter } from "../util/fuzzy.js";
import { getPreset, type ProviderId } from "./presets.js";
import { detectEnvProviders, resolveActiveProvider, resolveProviderKey } from "./resolve.js";
import { checkProviderKey, patchProviderSettings, saveProviderKey, switchProvider } from "./keys.js";
import { DL_DISCLOSURE, DL_FREE_MODEL, DL_FREE_WEEKLY_TOKENS, dlNotFreeLine, dlPickerHint, formatTokens, type DlDeviceCode } from "./directionally-local.js";
import { DL_STATUS_OPEN, dlPausedLine, dlWaitlistText, type DlFreeStatus } from "./dl-status.js";

/** Every provider we offer, in order, with a one-line hint. */
export const PROVIDER_CHOICES: ReadonlyArray<{ id: ProviderId; hint: string }> = [
  { id: "directionally-local", hint: dlPickerHint() },
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
  const signIn = row.id === "copilot" || row.id === "chatgpt" || row.id === "directionally-local";
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
  cfg: Partial<AutopilotConfig> | null,
  opts: { upgrading?: boolean; env?: NodeJS.ProcessEnv; markActive?: boolean } = {},
): ProviderRow[] {
  const env = opts.env ?? process.env;
  // First run has no "current" provider, only the default.
  const active = cfg && opts.markActive !== false ? resolveActiveProvider(cfg as AutopilotConfig, env).id : null;
  const envProviders = detectEnvProviders(env);
  const rows = PROVIDER_CHOICES.map(({ id, hint }): ProviderRow => {
    const preset = getPreset(id);
    const credentials: CredentialSource = envProviders.includes(id)
      ? "env"
      : resolveProviderKey(id, cfg as AutopilotConfig | null, env)
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
  /** The free tier's GitHub device sign-in (no key to paste). */
  | { kind: "directionally-local" }
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

export function planConnect(id: ProviderId, cfg: Partial<AutopilotConfig> | null, env: NodeJS.ProcessEnv = process.env): ConnectPlan {
  if (id === "openrouter") return { kind: "openrouter" };
  if (id === "copilot") return { kind: "copilot" };
  if (id === "directionally-local") return { kind: "directionally-local" };
  if (id === "chatgpt") return { kind: "chatgpt" };
  if (id === "custom") return { kind: "baseUrl", purpose: "custom" };
  if (id === "azure" && !resolveActiveProvider({ ...(cfg ?? {}), provider: "azure" } as AutopilotConfig, env).baseUrl) return { kind: "baseUrl", purpose: "azure" };
  if (id === "vertex" && !resolveActiveProvider({ ...(cfg ?? {}), provider: "vertex" } as AutopilotConfig, env).baseUrl) return { kind: "project" };
  const key = resolveProviderKey(id, cfg as AutopilotConfig | null, env);
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
export async function commitProvider(connection: Connection, modelId: string): Promise<AutopilotConfig> {
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

/**
 * The line said before leaving the free tier for `to`: undefined unless the
 * free tier is active and `to` bills the person's own key.
 */
export function leavingFreeTierLine(active: ProviderId | undefined, to: ProviderId): string | undefined {
  if (active !== "directionally-local" || to === "directionally-local" || !getPreset(to).keyRequired) return undefined;
  return dlNotFreeLine(getPreset(to).name);
}

/**
 * What the free tier's sign-in screen says: the offer and the disclosure
 * first, then (once the code is known) the code and where to approve it. The
 * disclosure is said once, before the code. "Opened your browser" only when
 * a browser really opened (`opened`); otherwise the link is for any device.
 */
export function dlSignInLines(code?: DlDeviceCode, opened = false): string {
  if (!code) return `Free: GPT-6 Luna + DeepSeek, ${formatTokens(DL_FREE_WEEKLY_TOKENS)} tokens a week, no credit card. Sign in with GitHub to start.\n${DL_DISCLOSURE}`;
  const where = opened
    ? `Opened your browser at ${code.verificationUriComplete} — sign in with GitHub and approve it`
    : `Open ${code.verificationUriComplete} in a browser on any device, sign in with GitHub and approve it`;
  return `Your code is ${code.userCode}. ${where} (enter an invite code there if asked).`;
}

/** The last line shown while the free tier's sign-in waits for the browser. */
export const DL_WAITING_LINE = "Waiting for you to approve in the browser… Esc to cancel";

/**
 * Shown while the free tier's sign-in waits for the browser, in place of the
 * chat input: the whole sign-in paragraph (`dlSignInLines` with the code),
 * then the waiting line. The paragraph is part of this text, not only a line
 * said before it, so every attempt shows all of it for the whole wait,
 * however late (or whether) the renderer draws a line said just before it
 * lends the terminal.
 */
export function dlWaitingText(code: DlDeviceCode, opened = false): string {
  return `${dlSignInLines(code, opened)}\n${DL_WAITING_LINE}`;
}

/** Said when someone backs out of the free tier's sign-in: nothing was saved, and the question is asked again. */
export const DL_SIGN_IN_NEEDED = "Free-tier sign-in cancelled; nothing was saved.";

/** The free tier's model and who serves it, under the first-run question (a plain fact, and their site). */
export const DL_FREE_MODEL_LINE = "Free: GPT-6 Luna on OpenAI, with DeepSeek on Luminal as the backup";

/** The first-run question's answers. */
export type FirstRunChoice = "free" | "own-key";

/** The one question first run asks when no provider is usable. */
export const FIRST_RUN_QUESTION = "How should it think?";

/** The label of Free while the service has it paused (it can't be chosen). */
export const DL_FREE_PAUSED_LABEL = "Free — paused";

/**
 * Its two answers: the free tier, or the provider picker (without the free
 * tier). With the free tier on a waitlist, Free says when it opens; paused,
 * Free goes last (choosing it only says why: see `freeChoosable`), so own
 * key is the one selected.
 */
export function firstRunChoices(status: DlFreeStatus = DL_STATUS_OPEN, timeZone?: string, starter = false): Array<{ value: FirstRunChoice; label: string; description: string }> {
  const ownKey = { value: "own-key" as const, label: "Use my own API key", description: "OpenRouter, Anthropic, OpenAI and more" };
  if (status.free === "paused") return [ownKey, { value: "free", label: DL_FREE_PAUSED_LABEL, description: "not taking new sign-ins right now" }];
  const description = starter
    ? "Starter: DeepSeek only, 5M tokens a week"
    : status.free === "waitlist" ? dlWaitlistText(status, timeZone) : `GPT-6 Luna + DeepSeek, ${formatTokens(DL_FREE_WEEKLY_TOKENS)} tokens a week, no credit card`;
  return [{ value: "free", label: "Free — sign in with GitHub", description }, ownKey];
}

/** The first-run question's subtitle: the free model's line, or the service's word on a waitlist or pause. */
export function firstRunSubtitle(status: DlFreeStatus, escape: string, starter = false): string {
  return `${statusMessage(status) ?? (starter ? "Free: Starter — DeepSeek only, 5M tokens a week" : DL_FREE_MODEL_LINE)} · ${escape}`;
}

/** The service's message while Free is on a waitlist or paused; undefined when open. */
export function statusMessage(status: DlFreeStatus): string | undefined {
  if (status.free === "open") return undefined;
  return status.free === "paused" ? dlPausedLine(status) : status.message || undefined;
}

/** Whether choosing Free goes on to the sign-in (a waitlist still does: the service queues them). */
export function freeChoosable(status: DlFreeStatus): boolean {
  return status.free !== "paused";
}

/**
 * The `/provider` rows under the free tier's status: on a waitlist its hint
 * says when it opens; paused, it moves last and says so in its name. The
 * free row is left alone once signed in.
 */
export function rowsWithFreeStatus(rows: ProviderRow[], status: DlFreeStatus, timeZone?: string): ProviderRow[] {
  const free = rows.find((r) => r.id === "directionally-local");
  if (!free || free.credentials || status.free === "open") return rows;
  if (status.free === "waitlist") return rows.map((r) => (r === free ? { ...r, hint: `free — ${dlWaitlistText(status, timeZone)}, sign in with GitHub` } : r));
  return [...rows.filter((r) => r !== free), { ...free, name: `${free.name} — paused`, hint: "paused — not taking new sign-ins right now" }];
}

/** Said on the own-key picker, and only there: the free tier is never on that screen. */
export const OWN_KEY_BILLING_LINE = "Model calls are billed to your own account with that provider.";

/** Providers left out of the own-key picker: the free tier has its own answer. */
export const OWN_KEY_EXCLUDE: ReadonlySet<ProviderId> = new Set<ProviderId>(["directionally-local"]);

/**
 * A provider whose key is already in the environment, for first run to use
 * without asking: the first one detected (OpenRouter before the others).
 */
export function envKeyProvider(env: NodeJS.ProcessEnv = process.env): { id: ProviderId; envVar: string } | undefined {
  const id = detectEnvProviders(env)[0];
  if (!id) return undefined;
  const envVar = getPreset(id).apiKeyEnv.find((n) => env[n]?.trim());
  return envVar ? { id, envVar } : undefined;
}

/** The one line first run shows instead of the question when a key is in the environment. */
export function envKeyLine(p: { id: ProviderId; envVar: string }): string {
  return `Using ${getPreset(p.id).name} with ${p.envVar} from your environment.`;
}

/** The free tier's device sign-in: `onCode` shows the code; tokens are saved once approved. */
export async function directionallyLocalSignIn(onCode: (code: DlDeviceCode) => void, signal?: AbortSignal): Promise<{ key: string }> {
  const { dlSignIn } = await import("./directionally-local.js");
  return { key: await dlSignIn(onCode, signal ? { signal } : {}) };
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
      const code = await untilAborted(listener.code, io.signal);
      // The browser handed the code back: bring the terminal forward again (macOS; silent otherwise).
      void import("../util/refocus-terminal.js").then((m) => m.refocusTerminal()).catch(() => {});
      return await exchangeCode(code, pkce.verifier);
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
export function switchedMessage(cfg: AutopilotConfig, to: ProviderId, env: NodeJS.ProcessEnv = process.env): string {
  const preset = getPreset(to);
  const effective = resolveActiveProvider(cfg, env);
  if (effective.id !== to) {
    return `saved ${preset.name} as your provider, but ${env.AUTOPILOT_PROVIDER ? "AUTOPILOT_PROVIDER" : "KIMIFLARE_BASE_URL"} in the environment keeps ${effective.preset.name} active for this run`;
  }
  return `provider: ${preset.name} · model ${cfg.model || "(none yet — pick one with /model)"}. Conversation history is kept; memory and skills re-index for this provider's embedding model.`;
}
