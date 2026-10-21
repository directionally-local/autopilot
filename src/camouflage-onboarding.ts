/**
 * First-run onboarding for the Camouflage UI: nothing is configured yet, so
 * before the App mounts the user picks a provider, connects it and picks a
 * model (the same steps as `/provider`). Only then does the session start.
 *
 * The flow is kept free of renderer details so it can be tested: the
 * Camouflage view supplies `show` (print lines) and `setup` (run the provider
 * picker) and this module decides what to say and when the session can start.
 */

import type { KimiConfig } from "./config.js";

/** Copy for an upgrading kimiflare user whose config still points at Cloudflare. */
export const UPGRADE_NOTICE = [
  "autopilot (formerly kimiflare) no longer runs on Cloudflare.",
  "Cloudflare Workers AI and AI Gateway are no longer used. Connect a provider once and your other settings carry over — Kimi models, memory and sessions all keep working.",
];

/** What the user sees before the provider picker opens. */
export function firstRunIntro(o: { upgrading: boolean; configPath: string }): string[] {
  return [
    ...(o.upgrading ? [...UPGRADE_NOTICE, ""] : ["Welcome to autopilot. Let's connect a model provider — it takes a minute."]),
    "Model calls are billed to your own account with that provider.",
    `Keys you enter are checked with the provider, then saved only in ${o.configPath} (keys from your environment are never written to disk).`,
    "Tip: set a provider's API key (e.g. OPENROUTER_API_KEY) to skip this setup.",
  ];
}

/** Printed after the renderer closes when the user backs out of setup. */
export function onboardingCancelledMessage(): string {
  return [
    "Setup cancelled — nothing was saved.",
    "Run `autopilot` again to connect a provider, or set a provider's API key (e.g. OPENROUTER_API_KEY) to skip setup.",
    "`autopilot auth status` lists the providers and the variables each one reads.",
  ].join("\n");
}

export type FirstRunOutcome =
  | { kind: "ready"; cfg: KimiConfig & { model: string } }
  | { kind: "cancelled" }
  | { kind: "failed"; message: string };

export interface FirstRunDeps {
  /** True when the config file is a Cloudflare-era kimiflare config. */
  upgrading(): Promise<boolean>;
  configPath(): string;
  /** Show lines above the picker. */
  show(lines: string[]): void;
  /** Run provider → credentials → model; true once a provider and model were saved, false if the user backed out. */
  setup(o: { upgrading: boolean }): Promise<boolean>;
  loadConfig(): Promise<KimiConfig | null>;
}

/**
 * Intro, provider setup, then reload the config. The session starts only with
 * a config that has a model: setup always ends with the model step, so a
 * missing model means the save went wrong, not that the user skipped it.
 */
export async function runFirstRun(deps: FirstRunDeps): Promise<FirstRunOutcome> {
  const upgrading = await deps.upgrading().catch(() => false);
  deps.show(firstRunIntro({ upgrading, configPath: deps.configPath() }));
  if (!(await deps.setup({ upgrading }))) return { kind: "cancelled" };
  let cfg: KimiConfig | null;
  try {
    cfg = await deps.loadConfig();
  } catch (e) {
    return { kind: "failed", message: `The provider was saved, but the config didn't load: ${(e as Error).message}` };
  }
  if (!cfg) return { kind: "failed", message: `The provider was saved, but no credentials were found in ${deps.configPath()}.` };
  if (!cfg.model) return { kind: "failed", message: "No model selected for this provider — pass -m <model-id>, set KIMI_MODEL, or run setup again." };
  return { kind: "ready", cfg: { ...cfg, model: cfg.model } };
}
