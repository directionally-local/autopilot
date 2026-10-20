import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { ThemeProvider } from "./theme-context.js";
import { CommandWizard } from "./command-wizard.js";
import { CommandPicker } from "./command-picker.js";
import { CommandList } from "./command-list.js";
import { LspWizard } from "./lsp-wizard.js";
import { ThemePicker } from "./theme-picker.js";
import { UiPicker, type UiEngineChoice } from "./ui-picker.js";
import { ModelPicker } from "./model-picker.js";
import { ModePicker } from "./mode-picker.js";
import { ShellPicker } from "./shell-picker.js";
import { MemoryPicker } from "./memory-picker.js";
import { SkillsPicker } from "./skills-picker.js";
import type { ModelEntry } from "../models/registry.js";
import { InboxModal } from "./inbox-modal.js";
import { HooksDashboard } from "./hooks-dashboard.js";
import { HelpMenu } from "./help-menu.js";
import { ChangelogImagePicker } from "./changelog-image-picker.js";

import type { Theme } from "./theme.js";
import type { ModalHostController } from "./use-modal-host.js";
import type { CustomCommand } from "../commands/types.js";
import type { SaveCustomCommandOptions } from "../commands/save.js";
import type { HookConfig, HookEvent } from "../hooks/types.js";
import type { MemoryManager } from "../memory/manager.js";

interface LspServersConfig {
  [key: string]: {
    command: string[];
    env?: Record<string, string>;
    enabled?: boolean;
    rootPatterns?: string[];
  };
}

export interface ModalHostProps {
  modals: ModalHostController;
  theme: Theme;
  // Command modals
  customCommands: CustomCommand[];
  builtinNames: Set<string>;
  onCommandSave: (opts: SaveCustomCommandOptions) => Promise<void> | void;
  onCommandDelete: (cmd: CustomCommand) => Promise<void> | void;
  // LSP wizard
  lspServers: LspServersConfig;
  lspScope: "project" | "global";
  hasProjectDir: boolean;
  onLspSave: (
    servers: LspServersConfig,
    enabled: boolean,
    scope: "project" | "global",
  ) => void;
  // Theme picker
  themes: Theme[];
  onPickTheme: (theme: Theme | null) => void;
  // UI engine picker
  currentUiEngine: UiEngineChoice;
  onPickUi: (choice: UiEngineChoice | null) => void;
  // Model picker
  currentModel: string;
  modelSwitchBusy: boolean;
  onPickModel: (model: ModelEntry | null) => void;
  // Mode picker
  currentMode: import("../mode.js").Mode;
  onPickMode: (mode: import("../mode.js").Mode | null) => void;
  // Remote dashboard
  // Inbox
  onInboxOpen: (url: string) => void;
  // M6.1: hooks dashboard. Pass `getConfiguredHooks` rather than a
  // static array so the dashboard re-reads after every mutation
  // without needing a re-render in the parent.
  getConfiguredHooks: () => { event: HookEvent; hook: HookConfig }[];
  cwd: string;
  onHooksMutate: () => void;
  // Help menu
  costAttributionEnabled: boolean;
  onRunCommand: (cmd: string) => void;
  // Shell picker
  currentShell: string | undefined;
  onPickShell: (shell: string | null) => void;
  // Memory picker
  memoryEnabled: boolean;
  memoryManager: MemoryManager | null;
  onMemoryAction: (action: string) => void;
  onMemoryDone: () => void;
  // Skills picker
  onSkillsAction: (action: string) => void;
  onSkillsDone: () => void;
  // Changelog image picker
  changelogImageRepo: { owner: string; name: string } | null;
  onChangelogImageGenerate: (owner: string, repo: string, days: number) => void;
  onChangelogImageCancel: () => void;
}

/**
 * Renders whichever fullscreen modal is currently active, wrapped in the
 * shared `ThemeProvider`. Returns null when no fullscreen modal is open
 * — callers should check `modals.hasFullscreenModal` and skip the main
 * conversation render if true.
 */
export function ModalHost(props: ModalHostProps): React.ReactElement | null {
  const {
    modals,
    theme,
    customCommands,
    builtinNames,
    onCommandSave,
    onCommandDelete,
    lspServers,
    lspScope,
    hasProjectDir,
    onLspSave,
    themes,
    onPickTheme,
    currentUiEngine,
    onPickUi,
    currentModel,
    onPickModel,
    onInboxOpen,
  } = props;

  if (modals.showInboxModal) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <InboxModal
            onDone={() => modals.setShowInboxModal(false)}
            onOpen={onInboxOpen}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showHooksDashboard) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <HooksDashboard
            getConfigured={props.getConfiguredHooks}
            cwd={props.cwd}
            onMutate={props.onHooksMutate}
            onDone={() => modals.setShowHooksDashboard(false)}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showHelpMenu) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <HelpMenu
            customCommands={customCommands.map((c) => ({ name: c.name, description: c.description }))}
            costAttributionEnabled={props.costAttributionEnabled}
            onDone={() => modals.setShowHelpMenu(false)}
            onCommand={(cmd) => {
              modals.setShowHelpMenu(false);
              props.onRunCommand(cmd);
            }}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showShellPicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ShellPicker current={props.currentShell} onPick={props.onPickShell} />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showMemoryPicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <MemoryPicker
            enabled={props.memoryEnabled}
            memoryManager={props.memoryManager}
            onAction={props.onMemoryAction}
            onDone={props.onMemoryDone}
          />
        </Box>
      </ThemeProvider>
    );
  }


  if (modals.showSkillsPicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <SkillsPicker onAction={props.onSkillsAction} onDone={props.onSkillsDone} />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showLspWizard) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <LspWizard
            servers={lspServers}
            currentScope={lspScope}
            hasProjectDir={hasProjectDir}
            onDone={() => modals.setShowLspWizard(false)}
            onSave={onLspSave}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.commandWizard) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <CommandWizard
            mode={modals.commandWizard.mode}
            initial={modals.commandWizard.initial}
            existingNames={customCommands.map((c) => c.name)}
            builtinNames={builtinNames}
            onDone={() => modals.setCommandWizard(null)}
            onSave={onCommandSave}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.commandPicker) {
    const pickerMode = modals.commandPicker.mode;
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <CommandPicker
            commands={customCommands}
            title={pickerMode === "edit" ? "Edit custom command" : "Delete custom command"}
            onPick={(cmd) => {
              modals.setCommandPicker(null);
              if (!cmd) return;
              if (pickerMode === "edit") {
                modals.setCommandWizard({ mode: "edit", initial: cmd });
              } else {
                modals.setCommandToDelete(cmd);
              }
            }}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.commandToDelete) {
    const cmd = modals.commandToDelete;
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
          <Text color={theme.accent} bold>
            Delete /{cmd.name}?
          </Text>
          <Text color={theme.info.color}>
            {cmd.filepath}
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Yes, delete", value: "yes", key: "yes" },
                { label: "Cancel", value: "cancel", key: "cancel" },
              ]}
              onSelect={(item) => {
                if (item.value === "yes") {
                  void onCommandDelete(cmd);
                } else {
                  modals.setCommandToDelete(null);
                }
              }}
            />
          </Box>
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showCommandList) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <CommandList
            commands={customCommands}
            onDone={() => modals.setShowCommandList(false)}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showThemePicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ThemePicker themes={themes} onPick={onPickTheme} />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showUiPicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <UiPicker current={currentUiEngine} onPick={onPickUi} />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showModelPicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ModelPicker
            current={currentModel}
            turnInProgress={props.modelSwitchBusy}
            onPick={onPickModel}
          />
        </Box>
      </ThemeProvider>
    );
  }

  if (modals.showModePicker) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ModePicker current={props.currentMode} onPick={props.onPickMode} />
        </Box>
      </ThemeProvider>
    );
  }




  if (modals.showChangelogImagePicker && props.changelogImageRepo) {
    return (
      <ThemeProvider theme={theme}>
        <Box flexDirection="column">
          <ChangelogImagePicker
            owner={props.changelogImageRepo.owner}
            repo={props.changelogImageRepo.name}
            onGenerate={props.onChangelogImageGenerate}
            onCancel={props.onChangelogImageCancel}
          />
        </Box>
      </ThemeProvider>
    );
  }

  return null;
}
