/**
 * Resolve the active provider from config and environment. This is the only
 * place that decides where model calls go; llm-auth.ts turns the result into
 * request credentials.
 *
 * Precedence:
 *   1. AUTOPILOT_PROVIDER env (an explicit override; with AUTOPILOT_BASE_URL also
 *      set, that URL replaces the preset's base URL, e.g. a gateway in front of it)
 *   2. AUTOPILOT_BASE_URL env (a host app embedding Autopilot owns routing)
 *   3. `provider` in config
 *   4. legacy inference for configs written before `provider` existed:
 *      `baseUrl` → custom, OpenRouter key → openrouter, Requesty key → requesty
 *   5. openrouter (onboarding will ask for a key)
 */

import { isIPv4 } from "node:net";
import { getPreset, isProviderId, type ProviderId, type ProviderPreset } from "./presets.js";
import { vertexBase, vertexLocation, vertexProject } from "./vertex.js";
import { bedrockAuth, bedrockBase, bedrockRegion } from "./bedrock.js";
import { readEnv } from "../util/env.js";
import { logger } from "../util/logger.js";
import { dlApiBase } from "./dl-endpoint.js";

/** Per-provider settings persisted under `providers.<id>` in config.json. */
export interface ProviderSettings {
  apiKey?: string;
  /** Override the preset's base URL (e.g. Ollama on another host, a regional endpoint). */
  baseUrl?: string;
  /** Last chat model used with this provider; restored when switching back. */
  model?: string;
  /** OAuth sign-ins (ChatGPT): refresh token, access-token expiry (epoch ms), issued client id, host id. */
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  hostId?: string;
  /** Google Vertex: project and location (also from GOOGLE_VERTEX_PROJECT / GOOGLE_VERTEX_LOCATION). */
  project?: string;
  location?: string;
  /** Amazon Bedrock region (also from AWS_REGION / AWS_DEFAULT_REGION). */
  region?: string;
  /** Directionally Local: an invite code to send with the next sign-in (cleared once signed in). */
  pendingReferral?: string;
}

/** The config fields provider resolution reads. */
export interface ProviderConfigFields {
  provider?: ProviderId;
  providers?: Partial<Record<ProviderId, ProviderSettings>>;
  openrouterApiKey?: string;
  requestyApiKey?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Cloudflare account id (Workers AI); also read from CLOUDFLARE_ACCOUNT_ID. */
  accountId?: string;
  /** Cloudflare API token from Cloudflare-era configs. */
  apiToken?: string;
}

export interface ActiveProvider {
  id: ProviderId;
  preset: ProviderPreset;
  /** Resolved base URL; undefined for OpenRouter and Requesty (their modules own the URL). */
  baseUrl?: string;
  /** Resolved key; undefined when none is configured. */
  apiKey?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True for a loopback name or a literal IPv4 address in 127.0.0.0/8. Mirrors src/server/index.ts:141. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_NAMES.has(h) || (isIPv4(h) && h.startsWith("127."));
}

export type HttpHostClass = "loopback" | "private" | "public";

/**
 * Classify an http base URL's host. Loopback is silent; private ranges and
 * `.local` names are accepted (with a key-travel warning); everything else is
 * refused. The CIDR checks are `isIPv4`-gated so a DNS name that merely looks
 * like an address (`127.0.0.1.evil.com`) is never treated as one.
 */
export function classifyHttpHost(host: string): HttpHostClass {
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return "loopback";
  if (isIPv4(h)) {
    const octets = h.split(".").map(Number);
    const a = octets[0];
    const b = octets[1];
    if (a === 10) return "private"; // 10.0.0.0/8
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
    if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 (tailscale)
  }
  if (h.endsWith(".local")) return "private";
  return "public";
}

const warnedPrivateHttpHosts = new Set<string>();

/** The host's user-visible warning channel (the same one the large-body warning uses). */
let privateHttpWarningHandler: ((message: string) => void) | undefined;

/** Route the key-travel warning to the host's user-visible warning channel. */
export function setPrivateHttpWarningHandler(handler: ((message: string) => void) | undefined): void {
  privateHttpWarningHandler = handler;
}

/** The one-time warning for a key travelling over cleartext to a private host, or undefined. */
function privateHttpKeyTravelWarning(host: string): string | undefined {
  const key = host.toLowerCase();
  if (warnedPrivateHttpHosts.has(key)) return undefined;
  warnedPrivateHttpHosts.add(key);
  const message = `Sending your API key over cleartext http to ${host}. Use https if the host supports it.`;
  logger.warn("provider:http_key_travel", { host });
  return message;
}

/** Test seam: forget which hosts have been warned. */
export function resetPrivateHttpWarnings(): void {
  warnedPrivateHttpHosts.clear();
}

export function resolveProviderId(cfg: ProviderConfigFields | null | undefined, env: NodeJS.ProcessEnv = process.env): ProviderId {
  const envProvider = nonEmpty(env.AUTOPILOT_PROVIDER)?.toLowerCase();
  if (isProviderId(envProvider)) return envProvider;
  if (nonEmpty(readEnv("BASE_URL", env))) return "custom";
  if (cfg?.provider && isProviderId(cfg.provider)) return cfg.provider;
  if (nonEmpty(cfg?.baseUrl)) return "custom";
  if (nonEmpty(cfg?.openrouterApiKey)) return "openrouter";
  if (nonEmpty(cfg?.requestyApiKey)) return "requesty";
  return "openrouter";
}

/** The key for `id`, from its env vars first, then config. */
export function resolveProviderKey(
  id: ProviderId,
  cfg: ProviderConfigFields | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const name of getPreset(id).apiKeyEnv) {
    const v = nonEmpty(env[name]);
    if (v) return v;
  }
  if (id === "openrouter") return nonEmpty(cfg?.openrouterApiKey);
  if (id === "requesty") return nonEmpty(cfg?.requestyApiKey);
  if (id === "custom") return nonEmpty(cfg?.apiKey);
  return nonEmpty(cfg?.providers?.[id]?.apiKey) ?? (id === "cloudflare" ? nonEmpty(cfg?.apiToken) : undefined);
}

export function resolveActiveProvider(
  cfg: ProviderConfigFields | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  /** Use this provider instead of resolving one (e.g. a separate embedding provider). */
  forced?: ProviderId,
): ActiveProvider {
  const id = forced ?? resolveProviderId(cfg, env);
  const preset = getPreset(id);
  const apiKey = resolveProviderKey(id, cfg, env);
  let baseUrl: string | undefined;
  if (id === "custom") baseUrl = nonEmpty(readEnv("BASE_URL", env)) ?? nonEmpty(cfg?.baseUrl);
  else if (id === "vertex") {
    const settings = cfg?.providers?.vertex;
    const project = vertexProject(settings, env);
    baseUrl = nonEmpty(settings?.baseUrl) ?? (project ? vertexBase(project, vertexLocation(settings, env)) : undefined);
  } else if (id === "bedrock") {
    const settings = cfg?.providers?.bedrock;
    baseUrl = nonEmpty(settings?.baseUrl) ?? bedrockBase(bedrockRegion(settings, env));
  } else if (id === "directionally-local") {
    // AUTOPILOT_PROVIDER + AUTOPILOT_BASE_URL: a sandbox's Hotcell route; else AUTOPILOT_DL_FREE_URL.
    const envBaseUrl = isProviderId(nonEmpty(env.AUTOPILOT_PROVIDER)?.toLowerCase()) ? nonEmpty(readEnv("BASE_URL", env)) : undefined;
    baseUrl = envBaseUrl ?? nonEmpty(cfg?.providers?.[id]?.baseUrl) ?? dlApiBase(env);
  } else if (id !== "openrouter" && id !== "requesty") {
    // AUTOPILOT_PROVIDER + AUTOPILOT_BASE_URL route a preset through another endpoint (a
    // gateway such as Hotcell's). Without AUTOPILOT_PROVIDER the URL alone means "custom".
    const envBaseUrl = isProviderId(nonEmpty(env.AUTOPILOT_PROVIDER)?.toLowerCase()) ? nonEmpty(readEnv("BASE_URL", env)) : undefined;
    baseUrl = fillPlaceholders(envBaseUrl ?? nonEmpty(cfg?.providers?.[id]?.baseUrl) ?? preset.baseUrl, cfg, env);
  }
  if (baseUrl) assertHttpsBaseUrl(baseUrl, { hasKey: !!apiKey });
  return { id, preset, ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) };
}

/**
 * Refuse a cleartext base URL to a public host; accept loopback silently and
 * private/.local hosts with a one-time key-travel warning when a key is present.
 */
export function assertHttpsBaseUrl(baseUrl: string, opts: { hasKey?: boolean } = {}): string | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined; // a malformed URL fails later, at request time
  }
  if (url.protocol !== "http:") return undefined;
  const kind = classifyHttpHost(url.hostname);
  if (kind === "public") {
    throw new Error(`base URL must use https (got ${url.protocol}//${url.host})`);
  }
  if (kind === "private" && opts.hasKey) {
    const warning = privateHttpKeyTravelWarning(url.hostname);
    if (warning) privateHttpWarningHandler?.(warning);
    return warning;
  }
  return undefined;
}

/** The host the API key will be sent to, for the banner and status line. */
export function providerDestinationLabel(p: ActiveProvider): string {
  if (!p.baseUrl) return "<preset>";
  try {
    return new URL(p.baseUrl).hostname;
  } catch {
    return p.baseUrl;
  }
}

let lastLoaded: ProviderId | null = null;

/** Record the provider loadConfig() resolved, for text that names it (system prompt, banner). */
export function noteActiveProvider(id: ProviderId): void {
  lastLoaded = id;
}

/** Display name of the provider the last loaded config uses, or null before any config was loaded. */
export function lastActiveProviderName(): string | null {
  return lastLoaded ? getPreset(lastLoaded).name : null;
}

/** Fill `${CLOUDFLARE_ACCOUNT_ID}`-style placeholders in a base URL; undefined if one can't be filled. */
function fillPlaceholders(url: string | undefined, cfg: ProviderConfigFields | null | undefined, env: NodeJS.ProcessEnv): string | undefined {
  if (!url) return url;
  let missing = false;
  const filled = url.replace(/\$\{([A-Z_]+)\}/g, (_m, name: string) => {
    const v =
      nonEmpty(env[name]) ??
      (name === "CLOUDFLARE_ACCOUNT_ID" ? nonEmpty(env.CF_ACCOUNT_ID) ?? nonEmpty(cfg?.accountId) : undefined);
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? undefined : filled;
}

/** True when the provider can take requests: it has a key, or needs none (local runtimes, a custom gateway). */
export function isProviderUsable(p: ActiveProvider): boolean {
  // Providers whose URL comes from account details (Cloudflare account id, Azure resource) need it resolved.
  if (p.id === "custom" || p.id === "cloudflare" || p.id === "azure") return !!p.baseUrl && (p.id === "custom" || !!p.apiKey);
  // Vertex authenticates with Google credentials at request time; it needs a project.
  if (p.id === "vertex") return !!p.baseUrl;
  // Bedrock: an API key or AWS credentials (env or ~/.aws/credentials).
  if (p.id === "bedrock") return !!bedrockAuth();
  return !!p.apiKey || !p.preset.keyRequired;
}

/** Providers with a key available in the environment, for onboarding to offer first. */
export function detectEnvProviders(env: NodeJS.ProcessEnv = process.env): ProviderId[] {
  const out: ProviderId[] = [];
  for (const id of ["openrouter", "anthropic", "openai", "gemini", "minimax", "xai", "mistral", "groq", "cerebras", "together", "fireworks", "deepinfra", "vercel", "deepseek", "moonshot", "kimi-code", "zai", "requesty"] as const) {
    if (getPreset(id).apiKeyEnv.some((n) => nonEmpty(env[n]))) out.push(id);
  }
  return out;
}
