/**
 * Ground-truth check for the numbers kimiflare shows (`autopilot cost --verify`,
 * `/cost verify`).
 *
 * For every recorded turn that has an OpenRouter generation id, fetch
 * OpenRouter's own record of that generation (GET /generation?id=…, the same
 * data behind openrouter.ai/activity and your bill) and compare it field by
 * field with what kimiflare recorded: input tokens, output tokens, cached
 * tokens and USD cost. Tokens must match exactly; cost within a
 * hundred-millionth of a dollar (float rounding).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchGenerationSnapshot, type SessionUsage, type TurnCost, type UsageLog } from "./usage-tracker.js";
import { dataPath } from "./util/app-dirs.js";

export interface VerifyField {
  name: "input" | "output" | "cached" | "cost";
  ours?: number;
  openrouter?: number;
  ok: boolean;
}

export interface VerifyRow {
  generationId: string;
  model?: string;
  provider?: string;
  fields: VerifyField[];
  /** OpenRouter had no record (or the lookup failed). */
  missing?: boolean;
}

export interface VerifyResult {
  sessionId: string;
  rows: VerifyRow[];
  /** Recorded turns without a generation id (custom endpoint, pre-OpenRouter). */
  skipped: number;
}

const COST_EPSILON = 1e-8;

function usagePath(): string {
  return dataPath("usage.json");
}

async function loadSessions(): Promise<SessionUsage[]> {
  try {
    return (JSON.parse(await readFile(usagePath(), "utf8")) as UsageLog).sessions ?? [];
  } catch {
    return [];
  }
}

/** The requested session, or the most recent one with OpenRouter generations. */
export async function pickSession(sessionId?: string): Promise<SessionUsage | undefined> {
  const sessions = await loadSessions();
  if (sessionId) return sessions.find((s) => s.id === sessionId);
  return [...sessions].reverse().find((s) => s.turns?.some((t) => t.logId?.startsWith("gen-")));
}

function compare(name: VerifyField["name"], ours: number | undefined, theirs: number | undefined): VerifyField {
  if (ours === undefined || theirs === undefined) return { name, ours, openrouter: theirs, ok: true };
  const ok = name === "cost" ? Math.abs(ours - theirs) < COST_EPSILON : ours === theirs;
  return { name, ours, openrouter: theirs, ok };
}

export async function verifyTurn(turn: TurnCost, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<VerifyRow> {
  const id = turn.logId!;
  const snap = await fetchGenerationSnapshot({ apiKey, meta: { generationId: id } }, fetchImpl).catch(() => undefined);
  if (!snap) return { generationId: id, model: turn.model, fields: [], missing: true };
  return {
    generationId: id,
    model: snap.model ?? turn.model,
    provider: snap.provider,
    fields: [
      compare("input", turn.promptTokens, snap.tokensIn),
      compare("output", turn.completionTokens, snap.tokensOut),
      compare("cached", turn.cachedTokens, snap.tokensCached),
      compare("cost", turn.confirmedCost ?? turn.estimatedCost, snap.cost),
    ],
  };
}

export async function verifySession(
  session: SessionUsage,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const turns = session.turns ?? [];
  const withIds = turns.filter((t) => t.logId?.startsWith("gen-"));
  const rows: VerifyRow[] = [];
  // Sequential on purpose: a handful of GETs, and it keeps us well inside rate limits.
  for (const t of withIds) rows.push(await verifyTurn(t, apiKey, fetchImpl));
  return { sessionId: session.id, rows, skipped: turns.length - withIds.length };
}

function fmt(name: VerifyField["name"], v: number | undefined): string {
  if (v === undefined) return "—";
  return name === "cost" ? `$${v.toFixed(6)}` : String(v);
}

export function formatVerifyReport(r: VerifyResult): string {
  const lines = [`Verifying session ${r.sessionId} against OpenRouter's generation records`, ""];
  let mismatches = 0;
  let missing = 0;
  const totals = { ours: { input: 0, output: 0, cached: 0, cost: 0 }, theirs: { input: 0, output: 0, cached: 0, cost: 0 } };
  for (const row of r.rows) {
    if (row.missing) {
      missing++;
      lines.push(`  ? ${row.generationId}  OpenRouter has no record (yet) — retry in a minute`);
      continue;
    }
    const bad = row.fields.filter((f) => !f.ok);
    mismatches += bad.length > 0 ? 1 : 0;
    for (const f of row.fields) {
      if (f.ours !== undefined) totals.ours[f.name] += f.ours;
      if (f.openrouter !== undefined) totals.theirs[f.name] += f.openrouter;
    }
    const summary = row.fields.map((f) => `${f.name} ${fmt(f.name, f.ours)}${f.ok ? "" : ` ≠ ${fmt(f.name, f.openrouter)}`}`).join("  ");
    lines.push(`  ${bad.length ? "✗" : "✓"} ${row.generationId}  ${row.model ?? ""}${row.provider ? ` via ${row.provider}` : ""}`);
    lines.push(`      ${summary}`);
  }
  lines.push("");
  const checked = r.rows.length - missing;
  lines.push(
    `Totals — autopilot:  in ${totals.ours.input}, out ${totals.ours.output}, cached ${totals.ours.cached}, $${totals.ours.cost.toFixed(6)}`,
  );
  lines.push(
    `         OpenRouter: in ${totals.theirs.input}, out ${totals.theirs.output}, cached ${totals.theirs.cached}, $${totals.theirs.cost.toFixed(6)}`,
  );
  lines.push(
    mismatches === 0 && checked > 0
      ? `✓ All ${checked} generation${checked === 1 ? "" : "s"} match OpenRouter exactly.`
      : checked === 0
        ? "Nothing to verify yet."
        : `✗ ${mismatches} of ${checked} generation${checked === 1 ? "" : "s"} differ from OpenRouter (details above).`,
  );
  if (r.skipped > 0) lines.push(`(${r.skipped} turn${r.skipped === 1 ? "" : "s"} without an OpenRouter generation id skipped.)`);
  lines.push("Cross-check any generation by id at https://openrouter.ai/activity");
  return lines.join("\n");
}
