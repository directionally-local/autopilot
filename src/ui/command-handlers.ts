/**
 * Modal-form save/delete handlers extracted from app.tsx.
 *
 * These are the callbacks the various wizards/dashboards fire when the
 * user clicks save/delete/cancel — small async helpers that touch the
 * config, surface info events, and close the modal. Identical behavior
 * to the prior in-component callbacks.
 */
import React from "react";

import type { Cfg } from "../app.js";
import type { ChatEvent } from "./view-types.js";
import { saveConfig } from "../config.js";
import { saveProjectLspConfig } from "../util/lsp-config.js";
import {
  deleteCustomCommand,
  saveCustomCommand,
  type SaveCustomCommandOptions,
} from "../commands/save.js";
import type { CustomCommand } from "../commands/types.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

export interface CommandSaveDeps {
  setEvents: SetEvents;
  mkKey: () => string;
  commandWizard: { mode: "create" | "edit"; initial?: CustomCommand } | null;
  setCommandWizard: (v: null) => void;
  reloadCustomCommands: () => Promise<void>;
}

export async function handleCommandSave(
  deps: CommandSaveDeps,
  opts: SaveCustomCommandOptions,
): Promise<void> {
  const { setEvents, mkKey, commandWizard, setCommandWizard, reloadCustomCommands } = deps;
  setCommandWizard(null);
  try {
    // If editing and name changed, delete the old file first
    if (
      commandWizard?.mode === "edit" &&
      commandWizard.initial &&
      commandWizard.initial.name !== opts.name
    ) {
      await deleteCustomCommand(commandWizard.initial);
    }
    const result = await saveCustomCommand(opts);
    await reloadCustomCommands();
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `saved /${opts.name} → ${result.filepath}` },
    ]);
  } catch (err) {
    setEvents((e) => [
      ...e,
      { kind: "error", key: mkKey(), text: `failed to save /${opts.name}: ${(err as Error).message}` },
    ]);
  }
}

export interface CommandDeleteDeps {
  setEvents: SetEvents;
  mkKey: () => string;
  setCommandToDelete: (v: null) => void;
  reloadCustomCommands: () => Promise<void>;
}

export async function handleCommandDelete(
  deps: CommandDeleteDeps,
  cmd: CustomCommand,
): Promise<void> {
  const { setEvents, mkKey, setCommandToDelete, reloadCustomCommands } = deps;
  setCommandToDelete(null);
  try {
    await deleteCustomCommand(cmd);
    await reloadCustomCommands();
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `deleted /${cmd.name} (${cmd.filepath})` },
    ]);
  } catch (err) {
    setEvents((e) => [
      ...e,
      { kind: "error", key: mkKey(), text: `failed to delete /${cmd.name}: ${(err as Error).message}` },
    ]);
  }
}

export interface LspSaveDeps {
  cfg: Cfg | null;
  setCfg: React.Dispatch<React.SetStateAction<Cfg | null>>;
  setEvents: SetEvents;
  mkKey: () => string;
  setLspScope: (v: "project" | "global") => void;
  setLspProjectPath: (v: string | null) => void;
  setShowLspWizard: (v: boolean) => void;
}

export function handleLspSave(
  deps: LspSaveDeps,
  servers: NonNullable<Cfg["lspServers"]>,
  enabled: boolean,
  scope: "project" | "global",
): void {
  const { cfg, setCfg, setEvents, mkKey, setLspScope, setLspProjectPath, setShowLspWizard } = deps;
  setCfg((c) => (c ? { ...c, lspEnabled: enabled, lspServers: servers } : c));
  setLspScope(scope);
  if (scope === "project") {
    void saveProjectLspConfig(process.cwd(), { lspEnabled: enabled, lspServers: servers })
      .then((path) => {
        setLspProjectPath(path);
        setEvents((e) => [
          ...e,
          {
            kind: "info",
            key: mkKey(),
            text: `LSP config saved to project (${path}). Run /lsp reload to apply.`,
          },
        ]);
      })
      .catch(() => {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: "Failed to save project LSP config." },
        ]);
      });
  } else if (cfg) {
    void saveConfig({ ...cfg, lspEnabled: enabled, lspServers: servers }).catch(() => {});
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `LSP config saved to global config. Run /lsp reload to apply.` },
    ]);
  }
  setShowLspWizard(false);
}
