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

import { lookup as dnsLookup } from "node:dns";
import { isIPv4, isIPv6 } from "node:net";
import type { Agent } from "undici";
import { getPreset, isProviderId, type ProviderId, type ProviderPreset } from "./presets.js";
import { vertexBase, vertexLocation, vertexProject } from "./vertex.js";
import { bedrockAuth, bedrockBase, bedrockRegion } from "./bedrock.js";
import { readEnv } from "../util/env.js";
import { logger } from "../util/logger.js";
import { dlApiBase, dlKeyMode } from "./dl-endpoint.js";

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
  /** Request-time refusal; display/config resolution must remain non-throwing. */
  baseUrlRefusal?: string;
  /** Resolved key; undefined when none is configured. */
  apiKey?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

// `0.0.0.0` and `::` are the wildcard addresses a local server binds to; a
// client reaching them reaches this machine (a common Ollama setting, and
// src/permissions/destructive.ts already treats them as local).
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]"]);

/** True for a loopback name or a literal IPv4 address in 127.0.0.0/8. Mirrors src/server/index.ts:141. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_NAMES.has(h) || (isIPv4(h) && h.startsWith("127."));
}

export type HttpHostClass = "loopback" | "private" | "public" | "unresolved";

/**
 * Classify a host by shape alone: literals by range, names as `unresolved`.
 * Loopback is silent; private literals (RFC 1918, CGNAT, IPv6 ULA/link-local)
 * are accepted with a key-travel warning; public literals are refused. A name
 * is **not** trusted by shape — `.local`, single-label and multi-label names
 * all return `unresolved` here and are resolved by {@link classifyHttpHost}
 * before they are classified, because a hostile resolver, a search domain or a
 * resolvable dotless TLD can point any of them at a public address. The CIDR
 * checks are `isIPv4`-gated so a DNS name that merely looks like an address
 * (`127.0.0.1.evil.com`) is never treated as one.
 */
export function classifyHttpHostShape(host: string): HttpHostClass {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return "loopback";
  if (isIPv4(h)) {
    const octets = h.split(".").map(Number);
    const a = octets[0];
    const b = octets[1];
    if (a === 10) return "private"; // 10.0.0.0/8
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
    if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 (tailscale)
    return "public";
  }
  if (isIPv6(h)) {
    const prefix = Number.parseInt(h.split(":")[0]!, 16);
    if ((prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80) return "private";
    return "public";
  }
  return "unresolved";
}

/** A DNS resolver: `dns.lookup(host, { all: true })` by default; injected in tests. */
export type HostResolver = (host: string, opts: { all: true }) => Promise<Array<{ address: string; family: number }>>;

const defaultHostResolver: HostResolver = (host, opts) =>
  new Promise((resolve, reject) => {
    dnsLookup(host, opts, (err, addresses) => (err ? reject(err) : resolve(addresses)));
  });

/** The addresses a host was classified from, and the class they produced. */
export interface HostClassification {
  kind: HttpHostClass;
  /** The literal itself, or the DNS answer the kind was decided from. */
  addresses: string[];
}

/**
 * Resolve `host`, then classify it. Literals classify by shape. A name is
 * resolved with `dns.lookup(host, { all: true })` and is private only when
 * **every** address is loopback, RFC 1918, CGNAT, IPv6 ULA or IPv6
 * link-local; any public address — including a mixed answer — makes it
 * public. Resolution failure (NXDOMAIN, a timeout, any error, or an empty
 * answer) is `unresolved`, which is fail-closed: the caller grants no
 * cleartext allowance.
 */
async function classifyHost(host: string, resolver: HostResolver): Promise<HostClassification> {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(h)) return { kind: "loopback", addresses: [h] };
  if (isIPv4(h) || isIPv6(h)) return { kind: classifyHttpHostShape(h), addresses: [h] };
  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolver(h, { all: true });
  } catch {
    return { kind: "unresolved", addresses: [] };
  }
  const addresses = answers.map((a) => a.address);
  if (addresses.length === 0) return { kind: "unresolved", addresses: [] };
  const classes = addresses.map((a) => classifyHttpHostShape(a));
  if (classes.some((c) => c === "public")) return { kind: "public", addresses };
  if (classes.some((c) => c === "unresolved")) return { kind: "unresolved", addresses };
  return { kind: "private", addresses };
}

/**
 * Classify an http base URL's host, resolving a name before deciding. A
 * single-label name — and any other non-literal host — is resolved with
 * `dns.lookup(host, { all: true })`; it is private only when every address is
 * loopback/private, public when any address is public, and `unresolved` when
 * resolution fails. `unresolved` is fail-closed: an unresolvable name is never
 * granted the local-http allowance.
 */
export async function classifyHttpHost(host: string, resolver: HostResolver = defaultHostResolver): Promise<HttpHostClass> {
  return (await classifyHost(host, resolver)).kind;
}

/** What the resolution gate decided for one request target. */
export interface HttpHostGate {
  /** Set when the host is (or resolves to) a public address: the request must be refused. */
  refusal?: string;
  /**
   * Set when the host does not resolve. This is not our refusal: the request
   * must fail as a transient network error (`could not resolve \`<host>\``)
   * inside the retry loop, and must never fall through to an unpinned fetch.
   */
  unresolved?: { host: string; message: string };
  /**
   * The addresses the check validated; the connection must use one of them
   * (http, non-literal hosts). All of them are kept so the client's v4/v6
   * fallback still works.
   */
  pin?: { hostname: string; addresses: string[]; port: string };
}

function publicHttpRefusal(url: URL): string {
  return `base URL must use https (got http://${url.host}) — use https or an ssh tunnel to 127.0.0.1`;
}

/**
 * The resolution gate, run at request time. Literal hosts classify by shape;
 * a non-literal host is resolved with `dns.lookup(host, { all: true })` and is
 * accepted-private only when **every** returned address is loopback or
 * private. Any public address refuses exactly like a public http host, and so
 * does a name that does not resolve — fail-closed, so an unknown host never
 * gets the cleartext allowance. The returned `pin` is the address the
 * connection must use.
 */
export async function resolveHttpHostGate(
  baseUrl: string,
  opts: { hasKey?: boolean; warnings?: PrivateHttpWarningTracker; resolver?: HostResolver } = {},
): Promise<HttpHostGate> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return {}; // a malformed URL fails later, at request time
  }
  if (url.protocol !== "http:") return {};
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const { kind, addresses } = await classifyHost(hostname, opts.resolver ?? defaultHostResolver);
  if (kind === "public") {
    // The ruling is about keys: a keyless public http endpoint (a no-auth
    // Ollama on a VPS) is allowed, with a warning; a key would travel → refuse.
    if (opts.hasKey) return { refusal: publicHttpRefusal(url) };
    opts.warnings?.warn(
      hostname,
      `Sending requests over cleartext http to ${hostname}. Use https if the host supports it.`,
      "provider:http_cleartext",
    );
    return {};
  }
  // A failed lookup is the request's own transient failure, not our refusal —
  // but it must never fall through to an unpinned fetch.
  if (kind === "unresolved") return { unresolved: { host: hostname, message: `could not resolve \`${hostname}\`` } };
  if (kind === "loopback") return {};
  if (opts.hasKey) {
    opts.warnings?.warn(hostname, `Sending your API key over cleartext http to ${hostname}. Use https if the host supports it.`);
  }
  // A literal already addresses the checked IP; a name is pinned to the checked addresses.
  if (isIPv4(hostname) || isIPv6(hostname)) return {};
  return { pin: { hostname, addresses, port: url.port } };
}

/**
 * Per-session once-per-host accounting for the cleartext key-travel warning.
 * The handler is the session's user-visible warning channel (the same one the
 * large-body warning uses); the set lives on the session, so a second session
 * warns again for the same host. Only visible delivery consumes the once-guard:
 * a resolution without a channel stays pending and is delivered on the next one.
 */
export class PrivateHttpWarningTracker {
  private readonly warned = new Set<string>();
  private handler?: (message: string) => void;

  constructor(handler?: (message: string) => void) {
    this.handler = handler;
  }

  /** Point the tracker at the session's current visible channel. */
  setHandler(handler?: (message: string) => void): void {
    this.handler = handler;
  }

  /** Deliver `message` for `host` once per session; no-op without a channel. */
  warn(host: string, message: string, event = "provider:http_key_travel"): void {
    const key = `${event}\u0000${host.toLowerCase()}`;
    if (this.warned.has(key)) return;
    if (!this.handler) return; // pending until a visible channel exists
    this.handler(message);
    this.warned.add(key);
    logger.warn(event, { host });
  }
}

/** Thrown by {@link gatedFetch} when the resolution gate refuses the target. */
export class HttpGateRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpGateRefusalError";
  }
}

/**
 * Thrown by {@link gatedFetch} when the host does not resolve: a transient
 * network error (the request's own failure), never an unpinned fetch.
 */
export class HttpResolutionError extends Error {
  readonly code = "ENOTFOUND";

  constructor(host: string) {
    super(`could not resolve \`${host}\``);
    this.name = "HttpResolutionError";
  }
}

/**
 * One dispatcher per host + checked-address set. A long session reuses the
 * connection pool instead of opening (and leaking) a new Agent per request;
 * the cache is bounded, and an evicted Agent is closed.
 */
const dispatcherCache = new Map<string, Agent>();
const MAX_CACHED_DISPATCHERS = 32;

function dispatcherKey(host: string, addresses: string[]): string {
  return `${host}\n${[...addresses].sort().join(",")}`;
}

/**
 * An undici dispatcher whose `lookup` answers with the addresses the gate
 * already checked — all of them, so the client's v4/v6 fallback still works.
 * The URL and Host header stay the name, so name-routed LAN reverse proxies
 * (`llm.home.lan`), `.local` hosts whose first answer is `fe80::` and NO_PROXY
 * name matching under NODE_USE_ENV_PROXY keep working.
 */
function pinnedDispatcher(AgentCtor: typeof Agent, host: string, addresses: string[]): Agent {
  const key = dispatcherKey(host, addresses);
  const cached = dispatcherCache.get(key);
  if (cached) return cached;
  const agent = new AgentCtor({
    connect: {
      lookup: (hostname, options, callback) => {
        const opts = (typeof options === "object" && options !== null ? options : {}) as { all?: boolean; family?: number };
        const family = opts.family === 4 || opts.family === 6 ? opts.family : undefined;
        const matching = family ? addresses.filter((a) => (family === 4 ? isIPv4(a) : isIPv6(a))) : addresses;
        const chosen = matching.length > 0 ? matching : addresses;
        if (opts.all) {
          callback(null, chosen.map((address) => ({ address, family: isIPv4(address) ? 4 : 6 })));
          return;
        }
        const first = chosen[0]!;
        callback(null, first, isIPv4(first) ? 4 : 6);
      },
    },
  });
  if (dispatcherCache.size >= MAX_CACHED_DISPATCHERS) {
    const oldest = dispatcherCache.entries().next();
    if (!oldest.done) {
      dispatcherCache.delete(oldest.value[0]);
      void oldest.value[1].close().catch(() => {});
    }
  }
  dispatcherCache.set(key, agent);
  return agent;
}

/** Test hook: the number of cached dispatchers. */
export function dispatcherCacheSize(): number {
  return dispatcherCache.size;
}

/** Test hook: close and clear every cached dispatcher. */
export function clearDispatcherCache(): void {
  for (const agent of dispatcherCache.values()) void agent.close().catch(() => {});
  dispatcherCache.clear();
}

export interface GatedFetchOpts {
  /** An api key will travel: a private http host gets the one-time warning. */
  hasKey?: boolean;
  /** The session's warning tracker (per session, never a module global). */
  warnings?: PrivateHttpWarningTracker;
  /** DNS resolver for the gate; defaults to `dns.lookup`. Tests inject it. */
  resolver?: HostResolver;
  /** Test seam; defaults to undici's fetch, which accepts the pin dispatcher. */
  fetchImpl?: typeof fetch;
}

/**
 * The one gated fetch: every key-carrying request goes through here. It runs
 * the resolution gate, refuses a public http target before the request is
 * issued, fails a non-resolving host as a transient network error (never an
 * unpinned fetch), pins the connection to the checked addresses with an undici
 * dispatcher, and refuses redirects on http so a private host cannot forward
 * the key and body to a public origin.
 */
export async function gatedFetch(url: string, init: RequestInit = {}, opts: GatedFetchOpts = {}): Promise<Response> {
  const gate = await resolveHttpHostGate(url, opts);
  if (gate.refusal) throw new HttpGateRefusalError(gate.refusal);
  if (gate.unresolved) throw new HttpResolutionError(gate.unresolved.host);
  const gated: RequestInit & { dispatcher?: Agent } = { ...init };
  let protocol: string | undefined;
  try {
    protocol = new URL(url).protocol;
  } catch {
    // A malformed URL fails at fetch time, as before.
  }
  if (protocol === "http:") gated.redirect = "error";
  let impl: typeof fetch = opts.fetchImpl ?? globalThis.fetch;
  if (gate.pin) {
    // Imported lazily: a pin is only needed for a cleartext private host, and
    // the eager import cost ~100 ms on every startup.
    const { Agent: UndiciAgent, fetch: undiciFetch } = await import("undici");
    gated.dispatcher = pinnedDispatcher(UndiciAgent, gate.pin.hostname, gate.pin.addresses);
    // A pinned connection needs undici's fetch (Node's global fetch rejects a
    // dispatcher from another undici copy); everything else keeps the global
    // fetch, so a host app's fetch mock still sees the request.
    impl = opts.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
  }
  return impl(url, gated);
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
    // A dl key (dl_sk_) goes to api.dl.new, never to a base URL a GitHub sign-in saved.
    const envBaseUrl = isProviderId(nonEmpty(env.AUTOPILOT_PROVIDER)?.toLowerCase()) ? nonEmpty(readEnv("BASE_URL", env)) : undefined;
    baseUrl = envBaseUrl ?? (dlKeyMode(env) ? undefined : nonEmpty(cfg?.providers?.[id]?.baseUrl)) ?? dlApiBase(env);
  } else if (id !== "openrouter" && id !== "requesty") {
    // AUTOPILOT_PROVIDER + AUTOPILOT_BASE_URL route a preset through another endpoint (a
    // gateway such as Hotcell's). Without AUTOPILOT_PROVIDER the URL alone means "custom".
    const envBaseUrl = isProviderId(nonEmpty(env.AUTOPILOT_PROVIDER)?.toLowerCase()) ? nonEmpty(readEnv("BASE_URL", env)) : undefined;
    baseUrl = fillPlaceholders(envBaseUrl ?? nonEmpty(cfg?.providers?.[id]?.baseUrl) ?? preset.baseUrl, cfg, env);
  }
  const baseUrlRefusal = baseUrl && apiKey ? publicHttpBaseUrlRefusal(baseUrl) : undefined;
  if (baseUrl && !baseUrlRefusal) assertHttpsBaseUrl(baseUrl, { hasKey: !!apiKey });
  return { id, preset, ...(baseUrl ? { baseUrl } : {}), ...(baseUrlRefusal ? { baseUrlRefusal } : {}), ...(apiKey ? { apiKey } : {}) };
}

/** The shared refusal predicate, without throwing from display/config paths. */
function publicHttpBaseUrlRefusal(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    if (url.protocol === "http:" && classifyHttpHostShape(url.hostname) === "public") return publicHttpRefusal(url);
  } catch {
    // A malformed URL fails later, at request time.
  }
  return undefined;
}

/**
 * Refuse a cleartext base URL to a public host; accept loopback silently and
 * private/.local hosts with a one-time key-travel warning when a key is present.
 */
export function assertHttpsBaseUrl(baseUrl: string, opts: { hasKey?: boolean; warnings?: PrivateHttpWarningTracker } = {}): string | undefined {
  // Keyless public http is allowed: the refusal is about a key traveling
  // cleartext.
  const refusal = opts.hasKey ? publicHttpBaseUrlRefusal(baseUrl) : undefined;
  if (refusal) throw new Error(refusal);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined; // a malformed URL fails later, at request time
  }
  if (url.protocol !== "http:") return undefined;
  const kind = classifyHttpHostShape(url.hostname);
  if (kind === "private" && opts.hasKey) {
    const message = `Sending your API key over cleartext http to ${url.hostname}. Use https if the host supports it.`;
    opts.warnings?.warn(url.hostname, message);
    return message;
  }
  return undefined;
}

/** The host the API key will be sent to, for the banner and status line. */
export function providerDestinationLabel(p: ActiveProvider): string {
  if (!p.baseUrl) {
    // A preset-owned URL: name its real host, or nothing — never the "<preset>" placeholder.
    try {
      return p.preset.baseUrl ? new URL(p.preset.baseUrl).hostname : "";
    } catch {
      return "";
    }
  }
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
