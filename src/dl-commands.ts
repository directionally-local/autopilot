/**
 * `autopilot invite` and `autopilot upgrade`: the free tier's invite link and
 * the Pro / top-up choice outside a session (the headless "out of tokens"
 * line points here). Plain terminal output; the I/O is injected for tests.
 */

import {
  dlInviteReport,
  dlScreenChoices,
  dlTopupAmountLabel,
  dlTopupQuantities,
  dlUpgradeStep,
  parseTopupAmount,
  purchase,
  type PurchaseDeps,
} from "./providers/dl-growth.js";
import { formatUsd, isUsdTopup, type DlMe, type DlProduct } from "./providers/directionally-local.js";

export interface DlCommandDeps {
  providerId: string;
  providerName: string;
  print: (line: string) => void;
  fetchMe: () => Promise<DlMe>;
  copy: (text: string) => boolean;
  checkout: (product: DlProduct, quantity?: number) => Promise<string>;
  portal: () => Promise<string>;
  openBrowser: (url: string) => boolean;
  /** Ask a question on the terminal; null when there is no terminal to ask on. */
  ask: ((question: string) => Promise<string>) | null;
  sleep: PurchaseDeps["sleep"];
  now: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}

/** `autopilot invite`: the link (copied when the terminal takes it), who joined, the bonus. Exit code 0. */
export async function runInviteCommand(deps: DlCommandDeps): Promise<number> {
  deps.print(
    await dlInviteReport({
      providerId: deps.providerId,
      providerName: deps.providerName,
      fetchMe: deps.fetchMe,
      copy: deps.copy,
      where: "cli",
    }),
  );
  return 0;
}

/**
 * `autopilot upgrade [pro|topup]`: on Pro, the billing portal; otherwise buy
 * the named product, or ask which (numbered) when there is a terminal.
 * 0 once bought (or the portal opened), 1 when not.
 */
export async function runUpgradeCommand(product: string | undefined, deps: DlCommandDeps): Promise<number> {
  const step = await dlUpgradeStep({
    providerId: deps.providerId,
    providerName: deps.providerName,
    fetchMe: deps.fetchMe,
    portal: deps.portal,
    openBrowser: deps.openBrowser,
    where: "cli",
  });
  if (step.kind === "text") {
    deps.print(step.text);
    return step.text.startsWith("Manage or cancel your plan") ? 0 : 1;
  }
  const choices = dlScreenChoices("upgrade", step.screen);
  let chosen: DlProduct | undefined;
  const wanted = product?.trim().toLowerCase().replace(/[^a-z]/g, "");
  if (wanted) {
    chosen = wanted === "pro" ? "pro" : wanted === "topup" ? "topup" : undefined;
    if (!chosen || !choices.some((c) => c.value === chosen)) {
      deps.print(`Choose one of: ${choices.map((c) => (c.value === "pro" ? "pro" : "topup")).join(", ")}.`);
      return 1;
    }
  } else {
    deps.print("Upgrade Directionally Local");
    choices.forEach((c, i) => deps.print(`  ${i + 1}) ${c.label}${c.description ? ` (${c.description})` : ""}`));
    if (!deps.ask) {
      deps.print(`Run \`autopilot upgrade ${choices.map((c) => c.value).join("` or `autopilot upgrade ")}\`.`);
      return 1;
    }
    const answer = (await deps.ask(`Choose 1-${choices.length} (Enter to cancel): `)).trim();
    const picked = choices[Number(answer) - 1];
    if (!answer || !picked) {
      deps.print("Nothing bought.");
      return 1;
    }
    chosen = picked.value as DlProduct;
  }
  // A dollar top-up: how much ($2, $5, $10, $20 or another amount in range); the smallest without a terminal.
  let quantity: number | undefined;
  const topup = step.screen.offers.topup;
  if (chosen === "topup" && isUsdTopup(topup)) {
    quantity = topup.minQuantity;
    if (deps.ask) {
      const amounts = dlTopupQuantities(topup);
      deps.print("How much?");
      amounts.forEach((q, i) => deps.print(`  ${i + 1}) ${dlTopupAmountLabel(topup, q)}`));
      const range = `${formatUsd(topup.minQuantity * topup.unitPriceUsd)}–${formatUsd(topup.maxQuantity * topup.unitPriceUsd)}`;
      const answer = (await deps.ask(`Choose 1-${amounts.length}, or type a dollar amount (${range}): `)).trim();
      const listed = /^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= amounts.length ? amounts[Number(answer) - 1] : undefined;
      const typed = listed ?? (answer.startsWith("$") ? parseTopupAmount(topup, answer) : undefined);
      if (typed === undefined) {
        deps.print(answer ? `Choose a listed number, or a whole-dollar amount like $7 (${range}).` : "Nothing bought.");
        return 1;
      }
      quantity = typed;
    }
  }
  const bought = await purchase(
    chosen,
    {
      say: (message) => deps.print(message),
      checkout: deps.checkout,
      fetchMe: deps.fetchMe,
      openBrowser: deps.openBrowser,
      wait: async (text) => {
        deps.print(text);
        return null;
      },
      sleep: deps.sleep,
      now: deps.now,
      where: "cli",
      ...(deps.intervalMs !== undefined ? { intervalMs: deps.intervalMs } : {}),
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    },
    { continuing: false, ...(quantity !== undefined ? { quantity } : {}) },
  );
  return bought ? 0 : 1;
}
