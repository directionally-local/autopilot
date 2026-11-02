/**
 * OpenRouter reconciliation for `autopilot cost`.
 *
 * Every turn is confirmed individually as it happens (the stream's usage
 * accounting, or the /generation lookup — see usage-tracker.ts), so the
 * confirmed numbers are already in usage.json. Reconciling a date range means
 * comparing those confirmed costs with the local price-table estimates for
 * the same turns, and reporting any turns OpenRouter never confirmed.
 * Optionally, the key's all-time spend from GET /key is attached as an
 * independent cross-check.
 */

import type { SessionUsage } from "../usage-tracker.js";
import type { ReconciliationResult } from "./types.js";
import { checkOpenRouterKey } from "../models/openrouter.js";

export interface ReconcileOptions {
  localCost: number;
  sessions: SessionUsage[];
  /** When set, GET /key is queried for the key's all-time spend. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

/** Sum confirmed vs. estimated cost over the turns in `sessions`. Pure. */
export function summarizeConfirmation(sessions: SessionUsage[]): {
  turns: number;
  confirmedTurns: number;
  confirmedCost: number;
  estimateForConfirmed: number;
} {
  let turns = 0;
  let confirmedTurns = 0;
  let confirmedCost = 0;
  let estimateForConfirmed = 0;
  for (const s of sessions) {
    for (const t of s.turns ?? []) {
      turns++;
      if (typeof t.confirmedCost === "number") {
        confirmedTurns++;
        confirmedCost += t.confirmedCost;
        estimateForConfirmed += t.estimatedCost;
      }
    }
  }
  return { turns, confirmedTurns, confirmedCost, estimateForConfirmed };
}

export async function reconcileWithOpenRouter(opts: ReconcileOptions): Promise<ReconciliationResult> {
  const sum = summarizeConfirmation(opts.sessions);
  if (sum.turns === 0) {
    return { status: "local-only", localCost: opts.localCost, message: "No recorded turns in this range" };
  }
  if (sum.confirmedTurns === 0) {
    return {
      status: "local-only",
      localCost: opts.localCost,
      message: "No turns in this range were confirmed by OpenRouter",
    };
  }

  // Drift = how far the local price-table estimate was from what OpenRouter
  // actually billed, over the turns we can compare.
  const driftPct =
    sum.confirmedCost > 0 ? Math.abs(sum.estimateForConfirmed - sum.confirmedCost) / sum.confirmedCost : 0;
  const unconfirmed = sum.turns - sum.confirmedTurns;
  const result: ReconciliationResult = {
    status: unconfirmed === 0 && driftPct < 0.02 ? "verified" : "drift",
    localCost: opts.localCost,
    providerCost: sum.confirmedCost,
    driftPct: Math.round(driftPct * 1000) / 10,
    message:
      unconfirmed === 0
        ? `All ${sum.turns} turns confirmed by OpenRouter`
        : `${sum.confirmedTurns} of ${sum.turns} turns confirmed by OpenRouter`,
  };

  if (opts.apiKey) {
    const key = await checkOpenRouterKey(opts.apiKey, opts.fetchImpl).catch(() => null);
    if (key?.ok && typeof key.info.usage === "number") {
      result.keyAllTimeSpend = key.info.usage;
    }
  }
  return result;
}
