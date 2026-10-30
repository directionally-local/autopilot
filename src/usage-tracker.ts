import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Usage } from "./agent/messages.js";
import type { ResponseMeta } from "./agent/client.js";
import type { ProviderPreset } from "./providers/presets.js";
import { calculateCost } from "./pricing.js";
import { fetchWithNetworkRetry, openRouterHeaders, openRouterUrl } from "./models/openrouter.js";
import { RETENTION } from "./storage-limits.js";
import { recoverJsonPrefix, withFileLock, writeFileAtomic } from "./util/atomic-file.js";
import { dataPath } from "./util/app-dirs.js";

const LOG_VERSION = 1;

/** Emits "update" with the sessionId whenever a session's cost/turn state changes
 *  out-of-band (e.g. after an OpenRouter generation-cost lookup lands). The UI
 *  subscribes to refresh its displayed numbers without polling. */
export const usageEvents = new EventEmitter();

/** Maximum number of per-turn records kept per session. */
const MAX_TURNS_PER_SESSION = 50;

/** Reconciliation poll schedule in ms — total budget ~15s. OpenRouter's
 *  /generation record is usually queryable within a second or two of the
 *  stream ending, occasionally longer under load (404 until then). */
const RECONCILE_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export interface DailyUsage {
  date: string; // YYYY-MM-DD
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  /**
   * Provider-confirmed accounting. The `gateway*` key names date from the
   * Cloudflare AI Gateway era and are kept so existing usage.json /
   * history.jsonl files keep aggregating; today they count OpenRouter
   * generations and the USD cost OpenRouter confirmed for them.
   */
  gatewayRequests?: number;
  /** Always 0 on OpenRouter (it has no response cache); kept for old records. */
  gatewayCachedRequests?: number;
  gatewayCost?: number;
  /** True iff this is a session-scoped DailyUsage with at least one turn whose
   *  cost OpenRouter has not yet confirmed. Always undefined for day/month/all-time. */
  reconcilePending?: boolean;
  /** Most recently confirmed turn duration in ms, from OpenRouter's generation
   *  record. Only set on the session-scoped DailyUsage. */
  lastTurnMs?: number;
}

/** A single agent turn's cost record. `estimatedCost` is the local-pricing
 *  number captured at recordUsage time; `confirmedCost` (if set) replaces it
 *  once OpenRouter reports the actual billed cost. */
export interface TurnCost {
  turnId: string;
  /** OpenRouter generation id ("gen-…"). */
  logId?: string;
  /** Model the request went to, and the token counts the stream reported —
   *  kept per turn so `kimiflare cost --verify` can check them against
   *  OpenRouter's own record of the generation. */
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  estimatedCost: number;
  confirmedCost?: number;
  durationMs?: number;
  cacheStatus?: string;
  reconciledAt?: number;
  reconcileFailed?: boolean;
}

export interface SessionUsage {
  id: string;
  date: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost: number;
  gatewayRequests?: number;
  gatewayCachedRequests?: number;
  gatewayCost?: number;
  /** Recent generation records (OpenRouter), for /cost. */
  gatewayLogs?: GenerationSnapshot[];
  turns?: TurnCost[];
  /** Carried-over cost from a previous session (e.g. after /fresh). Hidden
   *  bookkeeping — added to the session display but NOT to daily aggregates. */
  baselineCost?: number;
  // Cost attribution fields
  category?: string;
  confidence?: number;
  classifiedBy?: "heuristic" | "llm" | "user";
  classifiedAt?: string;
  summary?: string;
  tags?: string[];
}

/** One generation as OpenRouter reported it. Persisted in usage.json. */
export interface GenerationSnapshot {
  /** OpenRouter generation id ("gen-…"). */
  logId?: string;
  /** Legacy (AI Gateway) fields — present only on old records. */
  eventId?: string;
  cacheStatus?: string;
  cached?: boolean;
  /** Generation latency in ms. */
  duration?: number;
  statusCode?: number;
  model?: string;
  /** Upstream provider OpenRouter routed to, e.g. "Moonshot AI". */
  provider?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  cost?: number;
}

/** What `recordUsage` needs to confirm a turn's real cost with OpenRouter. */
export interface CostLookup {
  /** OpenRouter key the generation was billed to (the /generation lookup is per-key). */
  apiKey: string;
  meta: ResponseMeta;
}

export interface UsageLog {
  version: number;
  days: DailyUsage[];
  sessions: SessionUsage[];
}

function usagePath(): string {
  return dataPath("usage.json");
}

function historyPath(): string {
  return dataPath("history.jsonl");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function cutoffDate(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function loadLog(): Promise<UsageLog> {
  let raw: string;
  try {
    raw = await readFile(usagePath(), "utf8");
  } catch {
    return { version: LOG_VERSION, days: [], sessions: [] };
  }
  let parsed: UsageLog | undefined;
  try {
    parsed = JSON.parse(raw) as UsageLog;
  } catch {
    // Unparseable file (e.g. left by an older build's non-atomic write). Keep
    // a copy and salvage what we can instead of starting from an empty log,
    // which the next save would write over the user's whole cost history.
    await rename(usagePath(), `${usagePath()}.corrupt-${Date.now()}`).catch(() => undefined);
    parsed = recoverJsonPrefix(raw) as UsageLog | undefined;
  }
  if (parsed && parsed.version === LOG_VERSION) return parsed;
  return { version: LOG_VERSION, days: [], sessions: [] };
}

async function saveLog(log: UsageLog): Promise<void> {
  await writeFileAtomic(usagePath(), JSON.stringify(log, null, 2));
}

/** Serialize all read-modify-write operations on usage.json and history.jsonl.
 *  The promise chain orders calls within this process; the file lock orders
 *  them across processes, since several autopilot sessions share these files. */
let writeChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const locked = () => withFileLock(`${usagePath()}.lock`, fn);
  const next = writeChain.then(locked, locked);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Load the append-only history JSONL file. Never pruned. */
async function loadHistory(): Promise<DailyUsage[]> {
  try {
    const raw = await readFile(historyPath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const entries: DailyUsage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as DailyUsage;
        if (parsed.date) entries.push(parsed);
      } catch {
        /* skip malformed line */
      }
    }
    return entries;
  } catch {
    /* no file or unreadable */
  }
  return [];
}

/** Append or update a day's entry in the history JSONL file.
 *  Reads the whole file (it's tiny), updates the matching day or appends,
 *  then writes back. This keeps the file compact and deduplicated by date.
 */
async function upsertHistoryDay(day: DailyUsage): Promise<void> {
  const entries = await loadHistory();
  const idx = entries.findIndex((e) => e.date === day.date);
  if (idx >= 0) {
    entries[idx] = day;
  } else {
    entries.push(day);
  }
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFileAtomic(historyPath(), lines);
}

function getOrCreateDay(log: UsageLog, date: string): DailyUsage {
  let day = log.days.find((d) => d.date === date);
  if (!day) {
    day = { date, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    log.days.push(day);
  }
  return day;
}

function getOrCreateSession(log: UsageLog, sessionId: string, date: string): SessionUsage {
  let session = log.sessions.find((s) => s.id === sessionId);
  if (!session) {
    session = { id: sessionId, date, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };
    log.sessions.push(session);
  }
  return session;
}

/**
 * Look up one generation's authoritative cost/latency: GET /generation?id=….
 * Returns undefined until OpenRouter has the record (it 404s for a moment
 * after the stream ends) or on any failure — callers poll.
 */
export async function fetchGenerationSnapshot(
  lookup: CostLookup,
  fetchImpl: typeof fetch = fetch,
): Promise<GenerationSnapshot | undefined> {
  const id = lookup.meta.generationId;
  if (!id) return undefined;
  const res = await fetchWithNetworkRetry(fetchImpl, openRouterUrl(`generation?id=${encodeURIComponent(id)}`), {
    headers: openRouterHeaders(lookup.apiKey),
  }, 2);
  if (!res.ok) return undefined;
  const parsed = (await res.json()) as { data?: Record<string, unknown> };
  const d = parsed.data;
  if (!d || typeof d.total_cost !== "number") return undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    logId: id,
    cost: d.total_cost,
    duration: num(d.latency) ?? num(d.generation_time),
    model: typeof d.model === "string" ? d.model : lookup.meta.model,
    provider: typeof d.provider_name === "string" ? d.provider_name : lookup.meta.provider,
    tokensIn: num(d.native_tokens_prompt) ?? num(d.tokens_prompt),
    tokensOut: num(d.native_tokens_completion) ?? num(d.tokens_completion),
    tokensCached: num(d.native_tokens_cached),
  };
}

/** Prune old day and session entries to enforce retention policy. */
export function pruneUsageLog(log: UsageLog): UsageLog {
  const dayCutoff = cutoffDate(RETENTION.usageDayMaxAgeDays);
  const sessionCutoff = cutoffDate(RETENTION.usageSessionMaxAgeDays);
  const days = log.days.filter((d) => d.date >= dayCutoff);
  let sessions = log.sessions.filter((s) => s.date >= sessionCutoff);
  if (sessions.length > RETENTION.usageSessionMaxCount) {
    // Keep most recent sessions by date, then by array order as tie-breaker
    sessions = sessions
      .sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0))
      .slice(0, RETENTION.usageSessionMaxCount);
  }
  return { ...log, days, sessions };
}

export async function recordUsage(
  sessionId: string,
  usage: Usage,
  lookup?: CostLookup,
  model?: string,
): Promise<void> {
  const cost = calculateCost(
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.prompt_tokens_details?.cached_tokens ?? 0,
    model,
    usage.prompt_tokens_details?.cache_write_tokens ?? 0,
  );
  const estimatedCost = cost.total;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const turnId = randomUUID();
  const generationId = lookup?.meta.generationId;
  // OpenRouter's usage accounting puts the billed cost right in the stream's
  // final usage chunk — when present, the turn is confirmed on the spot.
  const inlineCost = typeof usage.cost === "number" && Number.isFinite(usage.cost) ? usage.cost : undefined;

  await withLock(async () => {
    const log = pruneUsageLog(await loadLog());
    const date = today();

    const day = getOrCreateDay(log, date);
    day.promptTokens += usage.prompt_tokens;
    day.completionTokens += usage.completion_tokens;
    day.cachedTokens += cachedTokens;
    day.cost += estimatedCost;

    const session = getOrCreateSession(log, sessionId, date);
    session.promptTokens += usage.prompt_tokens;
    session.completionTokens += usage.completion_tokens;
    session.cachedTokens += cachedTokens;
    session.cost += estimatedCost;

    const turn: TurnCost = {
      turnId,
      logId: generationId,
      ...(model ? { model } : {}),
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      cachedTokens,
      estimatedCost,
    };
    session.turns = [...(session.turns ?? []), turn].slice(-MAX_TURNS_PER_SESSION);

    if (generationId || inlineCost !== undefined) {
      session.gatewayRequests = (session.gatewayRequests ?? 0) + 1;
      day.gatewayRequests = (day.gatewayRequests ?? 0) + 1;
    }

    if (inlineCost !== undefined) {
      applyConfirmedCost(log, session, turn, {
        logId: generationId,
        cost: inlineCost,
        model: lookup?.meta.model ?? model,
        provider: lookup?.meta.provider,
        tokensIn: usage.prompt_tokens,
        tokensOut: usage.completion_tokens,
      });
    }

    await saveLog(log);
    await upsertHistoryDay(getOrCreateDay(log, date));
  });

  usageEvents.emit("update", sessionId);

  // No inline cost (older OpenRouter responses, or a provider that omits it):
  // fall back to polling the /generation record in the background.
  if (inlineCost === undefined && lookup?.apiKey && generationId) {
    void reconcileTurnCost(sessionId, turnId, lookup).catch(() => undefined);
  }
}

/** Patch `turn` with a confirmed cost and move the session/day totals by the
 *  delta from the estimate. Caller holds the lock and saves. */
function applyConfirmedCost(
  log: UsageLog,
  session: SessionUsage,
  turn: TurnCost,
  snapshot: GenerationSnapshot & { cost: number },
): void {
  const delta = snapshot.cost - turn.estimatedCost;
  turn.confirmedCost = snapshot.cost;
  turn.durationMs = snapshot.duration ?? turn.durationMs;
  turn.reconciledAt = Date.now();

  session.cost += delta;
  session.gatewayCost = (session.gatewayCost ?? 0) + snapshot.cost;

  const day = getOrCreateDay(log, session.date);
  day.cost += delta;
  day.gatewayCost = (day.gatewayCost ?? 0) + snapshot.cost;

  const logs = session.gatewayLogs ?? [];
  const idx = snapshot.logId ? logs.findIndex((l) => l.logId === snapshot.logId) : -1;
  if (idx >= 0) logs[idx] = snapshot;
  else logs.push(snapshot);
  session.gatewayLogs = logs.slice(-100);
}

/** Poll OpenRouter's /generation record until this turn's cost surfaces (or
 *  we exhaust the retry budget), then patch the turn and adjust the
 *  session/day totals. Emits "update" so the UI re-renders. */
export async function reconcileTurnCost(
  sessionId: string,
  turnId: string,
  lookup: CostLookup,
  fetchImpl: typeof fetch = fetch,
  delaysMs: readonly number[] = RECONCILE_DELAYS_MS,
): Promise<void> {
  for (const delay of delaysMs) {
    await new Promise((r) => setTimeout(r, delay));
    let snapshot: GenerationSnapshot | undefined;
    try {
      snapshot = await fetchGenerationSnapshot(lookup, fetchImpl);
    } catch {
      continue;
    }
    if (!snapshot || typeof snapshot.cost !== "number") continue;
    const confirmed = snapshot as GenerationSnapshot & { cost: number };

    const patched = await withLock(async () => {
      const log = pruneUsageLog(await loadLog());
      const session = log.sessions.find((s) => s.id === sessionId);
      const turn = session?.turns?.find((t) => t.turnId === turnId);
      if (!session || !turn || turn.confirmedCost !== undefined) return false;
      applyConfirmedCost(log, session, turn, confirmed);
      await saveLog(log);
      await upsertHistoryDay(getOrCreateDay(log, session.date));
      return true;
    });

    if (patched) {
      usageEvents.emit("update", sessionId);
    }
    return;
  }

  // Retries exhausted — mark the turn so the UI can drop its spinner.
  await withLock(async () => {
    const log = await loadLog();
    const turn = log.sessions.find((s) => s.id === sessionId)?.turns?.find((t) => t.turnId === turnId);
    if (!turn || turn.confirmedCost !== undefined) return;
    turn.reconcileFailed = true;
    await saveLog(log);
  });
  usageEvents.emit("update", sessionId);
}

export interface CostReport {
  session: DailyUsage;
  today: DailyUsage;
  month: DailyUsage;
  allTime: DailyUsage;
}

/** Merge usage.json days with history.jsonl days. usage.json takes precedence for overlapping dates. */
function mergeDays(usageDays: DailyUsage[], historyDays: DailyUsage[]): DailyUsage[] {
  const map = new Map<string, DailyUsage>();
  for (const d of historyDays) map.set(d.date, d);
  for (const d of usageDays) map.set(d.date, d); // overwrite with fresher usage.json data
  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export async function getCostReport(sessionId?: string): Promise<CostReport> {
  const log = pruneUsageLog(await loadLog());
  const history = await loadHistory();
  const allDays = mergeDays(log.days, history);
  const date = today();
  const currentMonth = date.slice(0, 7); // YYYY-MM

  const rawSession = sessionId ? log.sessions.find((s) => s.id === sessionId) : undefined;
  const session: DailyUsage = rawSession
    ? {
        date: rawSession.date,
        promptTokens: rawSession.promptTokens,
        completionTokens: rawSession.completionTokens,
        cachedTokens: rawSession.cachedTokens,
        cost: rawSession.cost + (rawSession.baselineCost ?? 0),
        gatewayRequests: rawSession.gatewayRequests,
        gatewayCachedRequests: rawSession.gatewayCachedRequests,
        gatewayCost: rawSession.gatewayCost,
        reconcilePending: hasPendingReconcile(rawSession),
        lastTurnMs: latestConfirmedDurationMs(rawSession),
      }
    : { date, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };

  const todayUsage =
    log.days.find((d) => d.date === date) ??
    { date, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 };

  const monthUsage: DailyUsage = {
    date: currentMonth,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
  };
  for (const d of allDays) {
    if (d.date.startsWith(currentMonth)) {
      monthUsage.promptTokens += d.promptTokens;
      monthUsage.completionTokens += d.completionTokens;
      monthUsage.cachedTokens += d.cachedTokens;
      monthUsage.cost += d.cost;
      monthUsage.gatewayRequests = (monthUsage.gatewayRequests ?? 0) + (d.gatewayRequests ?? 0);
      monthUsage.gatewayCachedRequests =
        (monthUsage.gatewayCachedRequests ?? 0) + (d.gatewayCachedRequests ?? 0);
      monthUsage.gatewayCost = (monthUsage.gatewayCost ?? 0) + (d.gatewayCost ?? 0);
    }
  }

  const allTime: DailyUsage = {
    date: "all",
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cost: 0,
  };
  for (const d of allDays) {
    allTime.promptTokens += d.promptTokens;
    allTime.completionTokens += d.completionTokens;
    allTime.cachedTokens += d.cachedTokens;
    allTime.cost += d.cost;
    allTime.gatewayRequests = (allTime.gatewayRequests ?? 0) + (d.gatewayRequests ?? 0);
    allTime.gatewayCachedRequests =
      (allTime.gatewayCachedRequests ?? 0) + (d.gatewayCachedRequests ?? 0);
    allTime.gatewayCost = (allTime.gatewayCost ?? 0) + (d.gatewayCost ?? 0);
  }

  return { session, today: todayUsage, month: monthUsage, allTime };
}

/** Copy the displayed cost from an old session into a new session as a hidden
 *  baseline. Used by `/fresh` so the status-bar dollar amount stays continuous
 *  across session resets. The baseline is added to the session display only —
 *  it does NOT affect today/month/allTime aggregates. */
export async function carryOverSessionBaseline(
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  await withLock(async () => {
    const log = pruneUsageLog(await loadLog());
    const fromSession = log.sessions.find((s) => s.id === fromSessionId);
    const baseline = fromSession
      ? Math.max(0, fromSession.cost + (fromSession.baselineCost ?? 0))
      : 0;

    const toSession = getOrCreateSession(log, toSessionId, today());
    toSession.baselineCost = baseline;

    await saveLog(log);
  });
}

function hasPendingReconcile(session: SessionUsage): boolean {
  if (!session.turns) return false;
  return session.turns.some(
    (t) => t.logId && t.confirmedCost === undefined && !t.reconcileFailed,
  );
}

function latestConfirmedDurationMs(session: SessionUsage): number | undefined {
  if (!session.turns) return undefined;
  for (let i = session.turns.length - 1; i >= 0; i--) {
    const ms = session.turns[i]?.durationMs;
    if (typeof ms === "number") return ms;
  }
  return undefined;
}

/** Fetch the generation records kept for a session, for /cost rendering. */
export async function getSessionGenerations(sessionId: string): Promise<GenerationSnapshot[]> {
  const log = await loadLog();
  const session = log.sessions.find((s) => s.id === sessionId);
  return session?.gatewayLogs ?? [];
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtConfirmed(u: DailyUsage): string {
  if (!u.gatewayRequests) return "";
  const cost = u.gatewayCost ? `, OpenRouter-confirmed $${u.gatewayCost.toFixed(4)}` : "";
  return `  ${u.gatewayRequests} req${cost}`;
}

/** Render the OpenRouter section of /cost: the session's most recent
 *  generations with the upstream provider each one was routed to. Returns
 *  empty string when the session has no generation records. */
export function formatGenerationsSection(recent: GenerationSnapshot[] = []): string {
  const logs = recent.filter((l) => l.logId?.startsWith("gen-") || l.provider).slice(-5).reverse();
  if (logs.length === 0) return "";
  const lines: string[] = ["─── OpenRouter ───", "  recent generations:"];
  for (const log of logs) {
    const provider = log.provider ? `  via ${log.provider}` : "";
    const cost = typeof log.cost === "number" ? `  $${log.cost.toFixed(5)}` : "";
    const ms = typeof log.duration === "number" ? `  ${(log.duration / 1000).toFixed(1)}s` : "";
    lines.push(`    ${log.logId ?? "?"}${cost}${ms}${provider}`);
  }
  lines.push("  activity:  https://openrouter.ai/activity");
  return lines.join("\n");
}

/**
 * How /cost figures were produced for a provider: confirmed by OpenRouter,
 * estimated from a hosted provider's published prices (final — it doesn't
 * report per-request cost), free for local runtimes, or unknown for a custom
 * gateway whose models aren't in any catalog.
 */
export function costNote(preset: Pick<ProviderPreset, "id" | "name" | "keyRequired" | "capabilities" | "subscription">): string | undefined {
  if (preset.capabilities.costConfirmation) return undefined;
  if (preset.subscription) return `${preset.name} is billed by your plan (premium requests), not per token, so costs show as $0.`;
  if (preset.id === "custom") return "Custom endpoint: costs are estimated only for models found in a catalog; your gateway's own metering is authoritative.";
  if (!preset.keyRequired) return `${preset.name} runs locally: no per-token cost.`;
  return `Costs are estimates from ${preset.name}'s published prices (models.dev); ${preset.name} doesn't report per-request cost, so these are final.`;
}

export function formatCostReport(
  report: CostReport,
  /** A line about how the figures were produced (see costNote). */
  note?: string,
): string {
  const lines: string[] = [];
  const add = (label: string, u: DailyUsage) => {
    const cached = u.cachedTokens > 0 ? ` (${fmtTokens(u.cachedTokens)} cached)` : "";
    lines.push(
      `${label.padEnd(9)} $${u.cost.toFixed(4)}  (in: ${fmtTokens(u.promptTokens)}${cached}  out: ${fmtTokens(u.completionTokens)})${fmtConfirmed(u)}`,
    );
  };
  add("Session", report.session);
  add("Today", report.today);
  add("Month", report.month);
  add("All time", report.allTime);
  if (note) lines.push(note);
  return lines.join("\n");
}
