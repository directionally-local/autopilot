/**
 * `autopilot invite` and `autopilot upgrade`: the free tier's invite link and
 * the Pro / top-up choice outside a session (the headless "out of tokens"
 * line points here). Plain terminal output; the I/O is injected for tests.
 */

import {
  dlInviteReport,
  dlScreenChoices,
  dlUpgradeStep,
  purchase,
  type PurchaseDeps,
} from "./providers/dl-growth.js";
import type { DlMe, DlProduct } from "./providers/directionally-local.js";

export interface DlCommandDeps {
  providerId: string;
  providerName: string;
  print: (line: string) => void;
  fetchMe: () => Promise<DlMe>;
  copy: (text: string) => boolean;
  checkout: (product: DlProduct) => Promise<string>;
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
    { continuing: false },
  );
  return bought ? 0 : 1;
}
