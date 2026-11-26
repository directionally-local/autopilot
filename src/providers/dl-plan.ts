/**
 * dl's plan, for a dl key (dl_sk_…): what dl passes once the person signed in at dl.new. The
 * plan and this week's usage come from GET /v1/usage on api.dl.new (the plan's own meter), not
 * from /v1/me's free-tier budgets, which don't describe a dl.new plan.
 *
 *   Free:    DeepSeek V4.1 Flash, 10M tokens a week (95.5% caching applied)
 *   Starter, Plus, Max: each model's weekly tokens (95.5% caching applied), and the GPT-6.1 Sol
 *            bonus while it runs
 *
 * Token numbers are real tokens at the plan mix and always carry the mix's label. Plans and
 * upgrades are at dl.new/plans; nothing here names who serves a model.
 */

import { getUserAgent } from "../util/version.js";
import { dlOrigin } from "./dl-endpoint.js";

/** Where plans are picked and changed. */
export const DL_PLANS_URL = "https://dl.new/plans";
/** The plan mix's label when the service didn't send one. */
export const DL_PLAN_MIX_LABEL = "95.5% caching applied";
/** The Free plan, as dl.new states it. */
export const DL_FREE_PLAN_TOKENS = 10_000_000;
export const DL_FREE_PLAN_LINE = `Free: DeepSeek V4.1 Flash, 10M tokens a week (${DL_PLAN_MIX_LABEL})`;

const USAGE_TIMEOUT_MS = 5_000;

export interface DlPlanModel {
  model: string;
  name: string;
  /** The week's limit in real tokens at the plan mix; null without one. */
  realLimit: number | null;
  /** Used this week, as real tokens at the plan mix; null without a limit. */
  usedAtPlanMix: number | null;
  /** Used of the limit, 0 to 1; null without a limit. */
  usedShare: number | null;
}

export interface DlPlanUsage {
  /** "starter", "plus", "max", or "none" (Free, or no plan). */
  plan: string;
  resetsAt?: string;
  /** "95.5% caching applied". */
  label: string;
  models: DlPlanModel[];
  /** The GPT-6.1 Sol bonus, while it runs and this plan has it. */
  bonus?: { leftUsd: number; weeklyUsd: number };
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** /v1/usage read defensively. Undefined when it isn't one. */
export function parseDlPlanUsage(raw: unknown): DlPlanUsage | undefined {
  if (!isRec(raw) || typeof raw.plan !== "string" || !Array.isArray(raw.models)) return undefined;
  const models: DlPlanModel[] = [];
  for (const m of raw.models) {
    if (!isRec(m) || typeof m.model !== "string" || !m.model) continue;
    models.push({
      model: m.model,
      name: typeof m.name === "string" && m.name ? m.name : m.model,
      realLimit: num(m.realLimit),
      usedAtPlanMix: num(m.usedAtPlanMix),
      usedShare: num(m.usedShare),
    });
  }
  const label = isRec(raw.mix) && typeof raw.mix.label === "string" && raw.mix.label ? raw.mix.label : DL_PLAN_MIX_LABEL;
  const b = isRec(raw.bonus) ? raw.bonus : undefined;
  const bonus = b && b.enabled === true && b.granted !== false && num(b.leftUsd) !== null && num(b.weeklyUsd) !== null ? { leftUsd: num(b.leftUsd)!, weeklyUsd: num(b.weeklyUsd)! } : undefined;
  return {
    plan: raw.plan,
    ...(typeof raw.resetsAt === "string" ? { resetsAt: raw.resetsAt } : {}),
    label,
    models,
    ...(bonus ? { bonus } : {}),
  };
}

/** GET /v1/usage with a dl key. Undefined when it can't be read (never throws). */
export async function fetchDlPlanUsage(key: string, o: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<DlPlanUsage | undefined> {
  try {
    const res = await (o.fetchImpl ?? fetch)(`${dlOrigin(o.env)}/v1/usage`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${key}`, "User-Agent": getUserAgent() },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    return parseDlPlanUsage(await res.json());
  } catch {
    return undefined;
  }
}

/** "Free", "Starter", "Plus", "Max". */
export function dlPlanTitle(plan: string): string {
  if (!plan || plan === "none" || plan === "free") return "Free";
  return plan.slice(0, 1).toUpperCase() + plan.slice(1);
}

/** The plan's models with a weekly limit (Free has none in /v1/usage: its limit is stated). */
function limited(u: DlPlanUsage): Array<DlPlanModel & { realLimit: number }> {
  return u.models.filter((m): m is DlPlanModel & { realLimit: number } => m.realLimit !== null && m.realLimit > 0);
}

/** "62M", "1.5M", "800k": the plan's tokens. */
function tokens(n: number): string {
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}k`;
  return String(Math.round(n));
}

function usd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** "Starter: DeepSeek V4.1 Flash 62M, Kimi K3.1 5M tokens a week (95.5% caching applied) · GPT-6.1 Sol bonus $4 left" */
export function dlPlanSummary(u: DlPlanUsage): string {
  const models = limited(u);
  if (models.length === 0) return dlPlanTitle(u.plan) === "Free" ? DL_FREE_PLAN_LINE : dlPlanTitle(u.plan);
  const each = models.map((m) => `${m.name} ${tokens(m.realLimit)}`).join(", ");
  const bonus = u.bonus ? ` · GPT-6.1 Sol bonus ${usd(u.bonus.leftUsd)} left` : "";
  return `${dlPlanTitle(u.plan)}: ${each} tokens a week (${u.label})${bonus}`;
}

/** The sign-in line for a dl key: "✓ Signed in with your dl key · <plan summary>". */
export function dlPlanSignedInLine(u: DlPlanUsage | undefined): string {
  return u ? `✓ Signed in with your dl key · ${dlPlanSummary(u)}` : "✓ Signed in with your dl key";
}

/** One model's week: "~8.1M of 10M tokens used (95.5% caching applied)", or "limit reached". */
function modelWeek(m: DlPlanModel & { realLimit: number }, label: string): string {
  if ((m.usedShare ?? 0) >= 1) return `limit reached: ${tokens(m.realLimit)} tokens (${label})`;
  return `~${tokens(m.usedAtPlanMix ?? 0)} of ${tokens(m.realLimit)} tokens used (${label})`;
}

/** The session header's line: "Starter · DeepSeek V4.1 Flash ~54M left this week (95.5% caching applied)". */
export function dlPlanHeaderLine(u: DlPlanUsage, modelId?: string): string {
  const models = limited(u);
  const m = models.find((x) => x.model === modelId) ?? models[0];
  if (!m) return dlPlanTitle(u.plan);
  if ((m.usedShare ?? 0) >= 1) return `${dlPlanTitle(u.plan)} · ${m.name} limit reached this week · more at ${DL_PLANS_URL.replace(/^https:\/\//, "")}`;
  return `${dlPlanTitle(u.plan)} · ${m.name} ~${tokens(Math.max(0, m.realLimit - (m.usedAtPlanMix ?? 0)))} left this week (${u.label})`;
}

/** /usage for a dl key: the plan, each model's week, the bonus, the reset and where plans are. */
export function renderDlPlanUsage(u: DlPlanUsage, o: { timeZone?: string } = {}): string {
  const lines = [`dl · ${dlPlanTitle(u.plan)} plan · signed in with your dl key`];
  const models = limited(u);
  if (models.length === 0 && dlPlanTitle(u.plan) === "Free") lines.push(`  ${DL_FREE_PLAN_LINE.replace(/^Free: /, "")}`);
  for (const m of models) lines.push(`  ${m.name.padEnd(22)}${modelWeek(m, u.label)}`);
  if (u.bonus) lines.push(`  ${"GPT-6.1 Sol bonus".padEnd(22)}${usd(u.bonus.leftUsd)} of ${usd(u.bonus.weeklyUsd)} left this week`);
  if (u.resetsAt && Number.isFinite(Date.parse(u.resetsAt))) {
    const at = new Date(u.resetsAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", ...(o.timeZone ? { timeZone: o.timeZone } : {}) });
    lines.push(`  ${"resets".padEnd(22)}${at}`);
  }
  lines.push(`  Plans and upgrades: ${DL_PLANS_URL}`);
  return lines.join("\n");
}
