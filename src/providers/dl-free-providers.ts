/**
 * The free tier's providers and their measured speeds, from the public
 * GET /v1/providers: who serves each free model, and how fast it was over the
 * last measurement (every 10 minutes on the service). Used by the first-run
 * "Pick a free model" screen and the /model picker on the free tier.
 *
 * Kept fast: a 2 s timeout and a 10 minute cache. When the endpoint can't be
 * read (not deployed yet, 404, offline, a malformed body) the built-in list
 * stands in: DeepSeek V4.1 Flash on Luminal, with no speeds.
 */

import { getUserAgent } from "../util/version.js";
import { DL_FREE_DEFAULT_MODEL, dlOrigin } from "./dl-endpoint.js";
import { DL_DEEPSEEK_MODEL, DL_FREE_MODELS, DL_PROVIDER_ID, dlFreeModelEntries, type DlMe } from "./directionally-local.js";
import { getModel, type ModelEntry } from "../models/registry.js";

export type DlModelAccess = "free" | "trusted" | "opt-in" | "pro";
export type DlModelStatus = "on" | "paused" | "out_of_credit";

export interface DlProviderModel {
  id: string;
  name: string;
  family: string;
  contextWindow: number;
  access: DlModelAccess;
  status: DlModelStatus;
  tokensPerSecond: number | null;
  ttftMs: number | null;
  successRate24h: number | null;
  measuredAt: string | null;
}

export interface DlProvider {
  id: string;
  name: string;
  website: string;
  url: string;
  logo: string;
  models: DlProviderModel[];
}

export interface DlProviders {
  updatedAt: string | null;
  providers: DlProvider[];
  /** False when this is the built-in list (the endpoint couldn't be read). */
  live: boolean;
}

/** How long /v1/providers may take before the built-in list is used. */
export const DL_PROVIDERS_TIMEOUT_MS = 2_000;
/** How long a read of /v1/providers is reused. */
export const DL_PROVIDERS_CACHE_MS = 10 * 60_000;
/** How long a failed read is reused before trying again (short: the endpoint may just be new). */
const FAILED_CACHE_MS = 60_000;

/** The built-in list: DeepSeek V4.1 Flash on Luminal, no speeds. */
export const DL_FALLBACK_PROVIDERS: DlProviders = {
  updatedAt: null,
  live: false,
  providers: [
    {
      id: "luminal",
      name: "Luminal",
      website: "https://www.luminal.com",
      url: "https://www.luminal.com/?utm_source=dl.new&utm_medium=referral&utm_campaign=providers",
      logo: "/logos/luminal.svg",
      models: [
        {
          id: DL_FREE_DEFAULT_MODEL,
          name: "DeepSeek V4.1 Flash",
          family: "deepseek",
          contextWindow: 1_048_576,
          access: "free",
          status: "on",
          tokensPerSecond: null,
          ttftMs: null,
          successRate24h: null,
          measuredAt: null,
        },
      ],
    },
  ],
};

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const ACCESS: readonly DlModelAccess[] = ["free", "trusted", "opt-in", "pro"];
const STATUS: readonly DlModelStatus[] = ["on", "paused", "out_of_credit"];

function parseModel(raw: unknown): DlProviderModel | null {
  if (!isRec(raw) || !str(raw.id)) return null;
  const access = ACCESS.find((a) => a === raw.access);
  const status = STATUS.find((s) => s === raw.status);
  // Unknown access or status: not offered (a newer server may mean something this client can't honour).
  if (!access || !status) return null;
  return {
    id: str(raw.id),
    name: str(raw.name) || str(raw.id),
    family: str(raw.family),
    contextWindow: numOrNull(raw.contextWindow) ?? 0,
    access,
    status,
    tokensPerSecond: numOrNull(raw.tokensPerSecond),
    ttftMs: numOrNull(raw.ttftMs),
    successRate24h: numOrNull(raw.successRate24h),
    measuredAt: typeof raw.measuredAt === "string" ? raw.measuredAt : null,
  };
}

/** /v1/providers read defensively: malformed providers and models are dropped. Null when nothing usable is left. */
export function parseDlProviders(raw: unknown): DlProviders | null {
  if (!isRec(raw) || !Array.isArray(raw.providers)) return null;
  const providers: DlProvider[] = [];
  for (const p of raw.providers) {
    if (!isRec(p) || !str(p.id) || !Array.isArray(p.models)) continue;
    const models = p.models.map(parseModel).filter((m): m is DlProviderModel => m !== null);
    if (models.length === 0) continue;
    providers.push({ id: str(p.id), name: str(p.name) || str(p.id), website: str(p.website), url: str(p.url), logo: str(p.logo), models });
  }
  if (providers.length === 0) return null;
  return { updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null, providers, live: true };
}

let cache: { at: number; value: DlProviders; ttl: number } | null = null;
let inflight: Promise<DlProviders> | null = null;

/** The last list read in this process (or the built-in one), without waiting. */
export function cachedDlProviders(): DlProviders | null {
  return cache?.value ?? null;
}

/** Test hook: forget the cache, or pretend /v1/providers said this. */
export function setDlProvidersCache(value: DlProviders | null, at = Date.now()): void {
  cache = value ? { at, value, ttl: value.live ? DL_PROVIDERS_CACHE_MS : FAILED_CACHE_MS } : null;
  inflight = null;
}

/**
 * GET /v1/providers (public, no sign-in), cached for 10 minutes. Never throws:
 * a 404, a timeout or a malformed body gives the built-in list.
 */
export async function fetchDlProviders(opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: number; timeoutMs?: number } = {}): Promise<DlProviders> {
  const now = opts.now ?? Date.now();
  if (cache && now - cache.at < cache.ttl) return cache.value;
  if (inflight) return inflight;
  const fetchImpl = opts.fetchImpl ?? fetch;
  inflight = (async () => {
    let value: DlProviders = DL_FALLBACK_PROVIDERS;
    try {
      const res = await fetchImpl(`${dlOrigin(opts.env)}/v1/providers`, {
        headers: { Accept: "application/json", "User-Agent": getUserAgent() },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DL_PROVIDERS_TIMEOUT_MS),
      });
      if (res.ok) value = parseDlProviders(await res.json().catch(() => null)) ?? DL_FALLBACK_PROVIDERS;
    } catch {
      // Offline or slow: the built-in list.
    }
    cache = { at: now, value, ttl: value.live ? DL_PROVIDERS_CACHE_MS : FAILED_CACHE_MS };
    return value;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** One model of GET /v1/models: what the free tier serves this person. */
export interface DlServedModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

const posInt = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

/**
 * GET /v1/models with the person's token: the models the free tier serves this
 * person, with name and limits when it says. Undefined when it can't be read in
 * time (the caller then goes by /v1/providers and /v1/me alone).
 */
export async function fetchDlServedModels(token: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<DlServedModel[] | undefined> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${dlOrigin(opts.env)}/v1/models`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": getUserAgent() },
      signal: AbortSignal.timeout(opts.timeoutMs ?? DL_PROVIDERS_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const body = (await res.json().catch(() => null)) as unknown;
    if (!isRec(body) || !Array.isArray(body.data)) return undefined;
    const out: DlServedModel[] = [];
    for (const m of body.data) {
      if (!isRec(m) || !str(m.id)) continue;
      const name = str(m.name);
      const contextWindow = posInt(m.context_window ?? m.contextWindow);
      const maxOutputTokens = posInt(m.max_output_tokens ?? m.maxOutputTokens);
      out.push({ id: str(m.id), ...(name ? { name } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}) });
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** GET /v1/models as a set of ids (see fetchDlServedModels). */
export async function fetchDlModelIds(token: string, opts: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<Set<string> | undefined> {
  const served = await fetchDlServedModels(token, opts);
  return served ? new Set(served.map((m) => m.id)) : undefined;
}

/** Context for a served model the service gave no limits for, and its output cap. */
export const DL_UNKNOWN_CONTEXT = 128_000;
export const DL_UNKNOWN_MAX_OUTPUT = 32_768;

/**
 * A catalog entry for a free model this Autopilot has no built-in entry for (a model
 * added on the server, e.g. a new one on a new provider): name and context from
 * /v1/models, else /v1/providers, else conservative defaults. Free, with tools.
 */
export function dlServedModelEntry(m: DlServedModel, list: DlProviders | null = cachedDlProviders()): ModelEntry {
  const listed = list?.providers.flatMap((p) => p.models).find((x) => x.id === m.id);
  const contextWindow = m.contextWindow ?? (listed && listed.contextWindow > 0 ? listed.contextWindow : DL_UNKNOWN_CONTEXT);
  const maxOutputTokens = Math.min(m.maxOutputTokens ?? DL_UNKNOWN_MAX_OUTPUT, contextWindow);
  return {
    id: m.id,
    name: `${m.name ?? listed?.name ?? m.id} (free)`,
    contextWindow,
    maxOutputTokens,
    pricing: { inputPerMtok: 0, outputPerMtok: 0 },
    supports: { tools: true, reasoning: false, streaming: true, vision: false },
  };
}

/**
 * The free tier's catalog for /model and the session: the built-in models, plus every
 * model /v1/models serves this person that this Autopilot doesn't know yet, so models
 * added on the server show up without a release. Never throws; without a token or an
 * answer it is the built-in list.
 */
export async function loadDlCatalog(token: string | undefined, o: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<ModelEntry[]> {
  const builtIn = dlFreeModelEntries();
  if (!token) return builtIn;
  const call = { ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.env ? { env: o.env } : {}) };
  const [served, list] = await Promise.all([fetchDlServedModels(token, call), fetchDlProviders(call)]);
  const known = new Set(builtIn.map((m) => m.id));
  const extra = (served ?? []).filter((m) => !known.has(m.id)).map((m) => dlServedModelEntry(m, list));
  // dl Pro perks /v1/models doesn't serve this person (a free account): listed so /model can show
  // them as "Pro" rows that are off (camouflage-view modelOptions, dlProModelRow).
  const listedIds = new Set([...known, ...extra.map((m) => m.id)]);
  const pro = lockedDlProModels(list, null)
    .filter((m) => !listedIds.has(m.id))
    .map((m) => ({ ...dlServedModelEntry({ id: m.id, name: m.name }, list), name: `${m.name} (Pro)` }));
  return [...builtIn, ...extra, ...pro];
}

/** A free model this person can pick, with who serves it and how fast it measured. */
export interface DlUsableModel {
  id: string;
  name: string;
  provider: string;
  tokensPerSecond: number | null;
}

/**
 * Whether /v1/me lets this person use a model of this access level: "free" always;
 * "pro" on Pro only; "trusted" and "opt-in" not on Starter, else when its family's
 * weekly budget is above $0 (or uncapped). Undefined when /v1/me doesn't say (no
 * account read, or no budget for that family): /v1/models then decides.
 */
export function dlAccessAllowed(model: Pick<DlProviderModel, "access" | "family">, me: Pick<DlMe, "plan" | "level" | "budgets"> | null | undefined): boolean | undefined {
  if (model.access === "free") return true;
  if (!me) return undefined;
  if (model.access === "pro") return me.plan === "pro";
  if (me.level === "starter") return false;
  const budget = (me.budgets as Record<string, { usdPerWeek: number | null } | undefined> | undefined)?.[model.family];
  if (!budget) return undefined;
  return budget.usdPerWeek === null || budget.usdPerWeek > 0;
}

/**
 * The free models this person can use now: status "on"; served to them by /v1/models
 * when that was read (it filters per person), and allowed by /v1/me. A model this
 * Autopilot has no built-in entry for is offered only when /v1/models serves it (the
 * catalog then has an entry from /v1/models, see loadDlCatalog). DeepSeek V4.1
 * Flash first, then by measured speed. The same model from two providers is listed once,
 * the faster one.
 */
export function usableDlModels(list: DlProviders, o: { modelIds?: Set<string>; me?: Pick<DlMe, "plan" | "level" | "budgets"> | null } = {}): DlUsableModel[] {
  const known = new Set(DL_FREE_MODELS.map((m) => m.id));
  const byId = new Map<string, DlUsableModel>();
  for (const p of list.providers) {
    for (const m of p.models) {
      if (m.status !== "on") continue;
      if (!known.has(m.id) && !o.modelIds?.has(m.id)) continue;
      // /v1/models is the per-person answer when it was read; /v1/me rules out what it shows as closed,
      // and without /v1/models a model /v1/me doesn't speak for is left out.
      if (o.modelIds && !o.modelIds.has(m.id)) continue;
      if (!(dlAccessAllowed(m, o.me) ?? !!o.modelIds)) continue;
      const prev = byId.get(m.id);
      if (!prev || (m.tokensPerSecond ?? -1) > (prev.tokensPerSecond ?? -1)) {
        byId.set(m.id, { id: m.id, name: m.name, provider: p.name, tokensPerSecond: m.tokensPerSecond });
      }
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (a.id === DL_FREE_DEFAULT_MODEL) return -1;
    if (b.id === DL_FREE_DEFAULT_MODEL) return 1;
    return (b.tokensPerSecond ?? -1) - (a.tokensPerSecond ?? -1);
  });
}

/** "~85 tok/s", or "" when not measured. */
export function formatTokPerSec(tps: number | null | undefined): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return "";
  return `~${Math.round(tps)} tok/s`;
}

/**
 * For the /model picker: "Luminal · ~85 tok/s" for a free model, from the cached
 * list (fastest provider serving it). Undefined when nothing is cached or no provider lists it.
 */
export function dlModelProviderLine(modelId: string, list: DlProviders | null = cachedDlProviders()): string | undefined {
  if (!list) return undefined;
  let best: { provider: string; tps: number | null } | undefined;
  for (const p of list.providers) {
    for (const m of p.models) {
      if (m.id !== modelId) continue;
      if (!best || (m.tokensPerSecond ?? -1) > (best.tps ?? -1)) best = { provider: p.name, tps: m.tokensPerSecond };
    }
  }
  if (!best) return undefined;
  const speed = formatTokPerSec(best.tps);
  return speed ? `${best.provider} · ${speed}` : best.provider;
}

/**
 * The first-run list: /v1/providers and /v1/models read together (2 s each, so
 * at most ~2 s), filtered by the last /v1/me. Never empty: DeepSeek V4.1 Flash
 * on its own when nothing else can be offered.
 */
export async function loadUsableDlModels(
  token: string | undefined,
  o: { me?: Pick<DlMe, "plan" | "level" | "budgets"> | null; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<DlUsableModel[]> {
  const call = { ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}), ...(o.env ? { env: o.env } : {}) };
  const [list, modelIds] = await Promise.all([fetchDlProviders(call), token ? fetchDlModelIds(token, call) : Promise.resolve(undefined)]);
  const usable = usableDlModels(list, { ...(modelIds ? { modelIds } : {}), me: o.me ?? null });
  return usable.length > 0 ? usable : usableDlModels(DL_FALLBACK_PROVIDERS);
}

/** One row of the "Pick a free model" screen: "DeepSeek V4.1 Flash · Luminal", then "~85 tok/s" (blank when not measured). */
export function dlFreeModelOption(m: DlUsableModel): { value: string; label: string; columns: string[] } {
  return { value: m.id, label: `${m.name} · ${m.provider}`, columns: [formatTokPerSec(m.tokensPerSecond)] };
}

/** A free model's display name: built in, else /v1/providers, else the catalog (without " (free)" or " (Pro)"), else its id. */
export function dlModelName(id: string, list: DlProviders | null = cachedDlProviders()): string {
  const builtIn = DL_FREE_MODELS.find((m) => m.id === id)?.name;
  if (builtIn) return builtIn;
  const listed = list?.providers.flatMap((p) => p.models).find((m) => m.id === id)?.name;
  if (listed) return listed;
  const name = getModel(id)?.name?.replace(/ \((free|Pro)\)$/, "");
  return name || id;
}

/** The provider's name for a provider_limit: the error's provider (an id or a name), else whoever /v1/providers says serves the model. */
function dlProviderName(provider: string | undefined, modelId: string, list: DlProviders | null): string | undefined {
  if (provider) return list?.providers.find((p) => p.id === provider)?.name ?? provider;
  return list?.providers.find((p) => p.models.some((m) => m.id === modelId))?.name;
}

/** 140000 → "140K", 1200000 → "1.2M": the "about N tokens" of a Pro ration. */
export function formatApproxTokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

/** "Monday 30 Nov": when a weekly ration resets, in this machine's time zone. */
export function dlResetDay(iso: string | undefined, timeZone?: string): string | undefined {
  if (!iso || !Number.isFinite(Date.parse(iso))) return undefined;
  const date = new Date(iso);
  const tz = timeZone ? { timeZone } : {};
  return `${date.toLocaleDateString("en-GB", { weekday: "long", ...tz })} ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...tz })}`;
}

/**
 * A free model's provider can't serve it right now (402 provider_limit: paused, out of
 * credit, its weekly budget, or this person's cap): switch the session to the service's
 * alternative (DeepSeek V4.1 Flash when it names none this Autopilot knows) and send the
 * blocked turn again, once, with one line saying so. A dl Pro perk (the error's `plans`
 * "pro") gets its own line: the perk and where to upgrade for a free account (pro_only), the
 * reset day for Pro's used-up ration (person_cap). Null when the turn should get the usual
 * error: not the free tier, another error, already on the alternative, or this turn was itself
 * the retry (no loop). Any model, not only GPT-6.
 */
export function dlProviderLimitAutoSwitch(o: {
  provider: string | undefined;
  model: string | undefined;
  code: string | undefined;
  alternative: string | undefined;
  /** The error's `provider`: who couldn't serve the model. */
  servedBy?: string | undefined;
  /** The error's `reason`, `plans`, `upgradeUrl`, `approxTokensPerWeek` and `resetsAt`. */
  reason?: string | undefined;
  plans?: string | undefined;
  upgradeUrl?: string | undefined;
  approxTokensPerWeek?: number | undefined;
  resetsAt?: string | undefined;
  /** For tests: the time zone the reset day is shown in. */
  timeZone?: string;
  retried: boolean;
  list?: DlProviders | null;
}): { model: string; notice: string } | null {
  if (o.provider !== DL_PROVIDER_ID || o.code !== "provider_limit" || o.retried || !o.model) return null;
  const alternative = o.alternative && DL_FREE_MODELS.some((m) => m.id === o.alternative) ? o.alternative : DL_DEEPSEEK_MODEL;
  if (o.model === alternative) return null;
  const list = o.list === undefined ? cachedDlProviders() : o.list;
  const name = dlModelName(o.model, list);
  const switched = `switched to ${dlModelName(alternative, list)}`;
  const ration = o.approxTokensPerWeek ? `about ${formatApproxTokens(o.approxTokensPerWeek)} tokens a week` : undefined;
  if (o.plans === "pro" && o.reason === "pro_only") {
    const perk = ration ? `${name} is a dl Pro perk (${ration})` : `${name} is a dl Pro perk`;
    return { model: alternative, notice: `${perk}; ${switched}.${o.upgradeUrl ? ` Upgrade: ${o.upgradeUrl}` : ""}` };
  }
  if (o.plans === "pro" && o.reason === "person_cap") {
    const day = dlResetDay(o.resetsAt, o.timeZone);
    return { model: alternative, notice: `This week's ${name} with dl Pro is used up${day ? ` (it resets ${day})` : ""}; ${switched}.` };
  }
  const servedBy = dlProviderName(o.servedBy, o.model, list);
  const what = servedBy ? `${name} on ${servedBy}` : name;
  return { model: alternative, notice: `${what} is at its limit for now; ${switched}.` };
}

// ─── dl Pro only models (Kimi K3.1 Pro) ─────────────────────────────────────

/** One entry of /v1/me `proModels`: a model only dl Pro gets, and this person's weekly ration of it. */
export interface DlProModel {
  id: string;
  name: string;
  /** Whether this account may use it (Pro, or an admin). */
  available: boolean;
  approxTokensPerWeek: number | null;
  /** Pro's ration this week; null for a free account (or an admin, who has none). */
  ration: { approxTokensLeft: number; approxTokensPerWeek: number; remainingUsd: number; resetsAt: string } | null;
  /** The service's one line about it, to show as it is. */
  text: string;
}

/** /v1/me `proModels`, read defensively; [] when the service doesn't send it (older servers). */
export function dlProModels(me: unknown): DlProModel[] {
  const raw = isRec(me) ? me.proModels : undefined;
  if (!Array.isArray(raw)) return [];
  const out: DlProModel[] = [];
  for (const m of raw) {
    if (!isRec(m) || !str(m.id)) continue;
    const r = isRec(m.ration) ? m.ration : null;
    const left = r ? numOrNull(r.approxTokensLeft) : null;
    const perWeek = r ? numOrNull(r.approxTokensPerWeek) : null;
    out.push({
      id: str(m.id),
      name: str(m.name) || str(m.id),
      available: m.available === true,
      approxTokensPerWeek: numOrNull(m.approxTokensPerWeek),
      ration: r && left !== null && perWeek !== null ? { approxTokensLeft: left, approxTokensPerWeek: perWeek, remainingUsd: numOrNull(r.remainingUsd) ?? 0, resetsAt: str(r.resetsAt) } : null,
      text: str(m.text),
    });
  }
  return out;
}

/** Whether /v1/providers lists this model as a dl Pro perk (access "pro"). */
export function isDlProModel(modelId: string, list: DlProviders | null = cachedDlProviders()): boolean {
  return !!list?.providers.some((p) => p.models.some((m) => m.id === modelId && m.access === "pro"));
}

/**
 * How a dl Pro only model shows in a picker for this person: for a free account (or when the
 * plan isn't known) the row is off, labelled "Pro" and says how to get it; for Pro, a column
 * with this week's ration left ("~86K of 140K left"). Undefined for every other model.
 */
export function dlProModelRow(
  modelId: string,
  me: Pick<DlMe, "plan"> | null | undefined,
  list: DlProviders | null = cachedDlProviders(),
): { locked: boolean; description: string; column?: string } | undefined {
  const fromMe = dlProModels(me).find((m) => m.id === modelId);
  if (!fromMe && !isDlProModel(modelId, list)) return undefined;
  const available = fromMe ? fromMe.available : me?.plan === "pro";
  if (!available) {
    const perWeek = fromMe?.approxTokensPerWeek ? `, about ${formatApproxTokens(fromMe.approxTokensPerWeek)} tokens a week` : "";
    return { locked: true, description: `Pro — dl Pro only${perWeek}: /upgrade` };
  }
  const ration = fromMe?.ration;
  if (!ration) return { locked: false, description: "Pro" };
  const column = ration.remainingUsd <= 0 ? "used up this week" : `~${formatApproxTokens(ration.approxTokensLeft)} of ${formatApproxTokens(ration.approxTokensPerWeek)} left`;
  return { locked: false, description: "Pro", column };
}

/**
 * The dl Pro only models a free account sees but can't pick (status on in /v1/providers),
 * shown on the first run's "Pick a free model" as "Pro" rows. [] for Pro (theirs are usable).
 */
export function lockedDlProModels(list: DlProviders, me: Pick<DlMe, "plan"> | null | undefined): DlUsableModel[] {
  if (me?.plan === "pro") return [];
  const byId = new Map<string, DlUsableModel>();
  for (const p of list.providers) {
    for (const m of p.models) {
      if (m.access !== "pro" || m.status !== "on") continue;
      const prev = byId.get(m.id);
      if (!prev || (m.tokensPerSecond ?? -1) > (prev.tokensPerSecond ?? -1)) byId.set(m.id, { id: m.id, name: m.name, provider: p.name, tokensPerSecond: m.tokensPerSecond });
    }
  }
  return [...byId.values()];
}

/** A locked "Pro" row of "Pick a free model": shown, off, saying how to get it. */
export function dlLockedProOption(m: DlUsableModel): { value: string; label: string; description: string; state: "off"; columns: string[] } {
  return { value: m.id, label: `${m.name} · ${m.provider}`, description: "Pro — dl Pro only: /upgrade", state: "off", columns: [formatTokPerSec(m.tokensPerSecond)] };
}
