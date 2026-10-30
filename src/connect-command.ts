/**
 * `autopilot connect [--state-file PATH] [--model-only]`: run the first-run
 * provider and model screens on their own, save the choice to Autopilot's
 * config, and — for an installer that spawned us — write what it needs to
 * proxy the provider to a 0600 JSON file. Exit codes are CONNECT_EXIT.
 *
 * The renderer is injected (`mount`) so the decisions here are testable
 * without a terminal.
 */

import { configPath } from "./config.js";
import type { ConnectOutcome, View } from "./camouflage-view.js";
import { getPreset } from "./providers/presets.js";
import {
  buildConnectState,
  CONNECT_EXIT,
  HIDDEN_WITHOUT_GATEWAY,
  writeConnectState,
  type ConnectState,
} from "./providers/connect-state.js";

export interface ConnectFlags {
  stateFile?: string;
  modelOnly?: boolean;
}

/** The setup screens `connect` drives; the View implements them. */
export type ConnectScreens = Pick<View, "connectSetup" | "pickModelOnly">;

export interface ConnectDeps {
  /** Open the renderer and run `run` inside it; resolves once the renderer closed (also when the user quit it). */
  mount: (run: (view: ConnectScreens) => Promise<void>) => Promise<void>;
  writeState?: (path: string, state: ConnectState) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

/** Runs the screens and returns the exit code. Never prints the key. */
export async function runConnectCommand(flags: ConnectFlags, deps: ConnectDeps): Promise<number> {
  const stdout = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const stateFile = flags.stateFile?.trim();
  if (flags.stateFile !== undefined && !stateFile) {
    stderr("autopilot connect: --state-file needs a path");
    return CONNECT_EXIT.usage;
  }

  // Null until the screens save something: a quit renderer leaves it null.
  let outcome: ConnectOutcome | null = null;
  await deps.mount(async (view) => {
    outcome = flags.modelOnly
      ? await view.pickModelOnly()
      : await view.connectSetup(stateFile ? { exclude: HIDDEN_WITHOUT_GATEWAY } : {});
  });
  const saved = outcome as ConnectOutcome | null;
  if (!saved) {
    stderr(flags.modelOnly ? "autopilot connect: no model chosen — the config is unchanged." : "autopilot connect: cancelled — nothing was saved.");
    return CONNECT_EXIT.cancelled;
  }

  if (stateFile) {
    let state: ConnectState;
    try {
      const { connection } = saved;
      state = buildConnectState(
        { id: saved.id, model: saved.model, ...(connection.key ? { key: connection.key } : {}), ...(connection.baseUrl ? { baseUrl: connection.baseUrl } : {}) },
        saved.cfg,
        deps.env,
      );
    } catch (e) {
      stderr(`autopilot connect: ${(e as Error).message}; the provider was saved to ${configPath()} but no state file was written.`);
      return CONNECT_EXIT.cancelled;
    }
    try {
      await (deps.writeState ?? writeConnectState)(stateFile, state);
    } catch (e) {
      stderr(`autopilot connect: couldn't write ${stateFile}: ${(e as Error).message}`);
      return CONNECT_EXIT.usage;
    }
  }
  stdout(`✓ ${getPreset(saved.id).name} · ${saved.model} — saved to ${configPath()}.`);
  return CONNECT_EXIT.success;
}
