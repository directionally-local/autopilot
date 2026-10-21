import type { ProviderId } from "../providers/presets.js";
import { useMemo, useState } from "react";
import type { CustomCommand } from "../commands/types.js";
import type { ModelEntry } from "../models/registry.js";

export interface CommandWizardState {
  mode: "create" | "edit";
  initial?: CustomCommand;
}

export interface CommandPickerState {
  mode: "edit" | "delete";
}

export interface ProviderSetupState {
  initial?: ProviderId;
}

export interface ModalHostController {
  // Fullscreen modals (replace the whole conversation view).
  commandWizard: CommandWizardState | null;
  setCommandWizard: (v: CommandWizardState | null) => void;
  commandPicker: CommandPickerState | null;
  setCommandPicker: (v: CommandPickerState | null) => void;
  commandToDelete: CustomCommand | null;
  setCommandToDelete: (v: CustomCommand | null) => void;
  showCommandList: boolean;
  setShowCommandList: (v: boolean) => void;
  showLspWizard: boolean;
  setShowLspWizard: (v: boolean) => void;
  showThemePicker: boolean;
  setShowThemePicker: (v: boolean) => void;
  showModelPicker: boolean;
  setShowModelPicker: (v: boolean) => void;
  /** `/provider`: the connect/switch flow, optionally starting at one provider. */
  providerSetup: ProviderSetupState | null;
  setProviderSetup: (v: ProviderSetupState | null) => void;
  showModePicker: boolean;
  setShowModePicker: (v: boolean) => void;
  showInboxModal: boolean;
  setShowInboxModal: (v: boolean) => void;
  /** M6.1: interactive `/hooks` dashboard (arrow-key picker). */
  showHooksDashboard: boolean;
  setShowHooksDashboard: (v: boolean) => void;
  /** Interactive `/help` menu (categorized command browser). */
  showHelpMenu: boolean;
  setShowHelpMenu: (v: boolean) => void;
  showMemoryPicker: boolean;
  setShowMemoryPicker: (v: boolean) => void;
  showSkillsPicker: boolean;
  setShowSkillsPicker: (v: boolean) => void;
  showShellPicker: boolean;
  setShowShellPicker: (v: boolean) => void;
  showPlanCompletePicker: boolean;
  setShowPlanCompletePicker: (v: boolean) => void;
  showChangelogImagePicker: boolean;
  setShowChangelogImagePicker: (v: boolean) => void;

  /** Any fullscreen modal is active (would trigger an early return). */
  hasFullscreenModal: boolean;
  /** An overlay (plan-complete picker) is active. */
  hasOverlayModal: boolean;
  /** Any modal of any kind is active (use to gate input / pickers). */
  hasAnyModal: boolean;
}

/**
 * Lifts the M4.3 modal state out of `app.tsx`. Owns the seven modal
 * families listed in the roadmap (command*, LSP, theme, inbox) plus the derived activity flags.
 *
 * Note on what is NOT here:
 *   - `perm` (permission modal) lives in `usePermissionController` (M4.1).
 *   - `resumeSessions` / `checkpointSession` are session-state and will
 *     move with `SessionManager` (M4.4).
 *
 * The hook returns everything destructured so call sites can keep their
 * original names (`setCommandWizard`, `commandWizard`, …) and no rename
 * sweep is required — only the JSX renderer changes.
 */
export function useModalHost(): ModalHostController {
  const [commandWizard, setCommandWizard] = useState<CommandWizardState | null>(null);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [commandToDelete, setCommandToDelete] = useState<CustomCommand | null>(null);
  const [showCommandList, setShowCommandList] = useState(false);
  const [showLspWizard, setShowLspWizard] = useState(false);
  const [showThemePicker, setShowThemePicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [providerSetup, setProviderSetup] = useState<ProviderSetupState | null>(null);
  const [showModePicker, setShowModePicker] = useState(false);
  const [showInboxModal, setShowInboxModal] = useState(false);
  const [showHooksDashboard, setShowHooksDashboard] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [showMemoryPicker, setShowMemoryPicker] = useState(false);
  const [showSkillsPicker, setShowSkillsPicker] = useState(false);
  const [showShellPicker, setShowShellPicker] = useState(false);
  const [showPlanCompletePicker, setShowPlanCompletePicker] = useState(false);
  const [showChangelogImagePicker, setShowChangelogImagePicker] = useState(false);

  const flags = useMemo(() => {
    const hasFullscreenModal =
      commandWizard !== null ||
      commandPicker !== null ||
      commandToDelete !== null ||
      showCommandList ||
      showLspWizard ||
      showThemePicker ||
      showModelPicker ||
      providerSetup !== null ||
      showModePicker ||
      showInboxModal ||
      showHooksDashboard ||
      showHelpMenu ||
      showMemoryPicker ||
      showSkillsPicker ||
      showShellPicker ||
      showChangelogImagePicker;
    const hasOverlayModal = showPlanCompletePicker;
    return {
      hasFullscreenModal,
      hasOverlayModal,
      hasAnyModal: hasFullscreenModal || hasOverlayModal,
    };
  }, [
    commandWizard,
    commandPicker,
    commandToDelete,
    showCommandList,
    showLspWizard,
    showThemePicker,
    showModelPicker,
    providerSetup,
    showModePicker,
    showInboxModal,
    showHooksDashboard,
    showHelpMenu,
    showMemoryPicker,
    showSkillsPicker,
    showShellPicker,
    showPlanCompletePicker,
    showChangelogImagePicker,
  ]);

  return {
    commandWizard, setCommandWizard,
    commandPicker, setCommandPicker,
    commandToDelete, setCommandToDelete,
    showCommandList, setShowCommandList,
    showLspWizard, setShowLspWizard,
    showThemePicker, setShowThemePicker,
    showModelPicker, setShowModelPicker,
    providerSetup, setProviderSetup,
    showModePicker, setShowModePicker,
    showInboxModal, setShowInboxModal,
    showHooksDashboard, setShowHooksDashboard,
    showHelpMenu, setShowHelpMenu,
    showMemoryPicker, setShowMemoryPicker,
    showSkillsPicker, setShowSkillsPicker,
    showShellPicker, setShowShellPicker,
    showPlanCompletePicker, setShowPlanCompletePicker,
    showChangelogImagePicker, setShowChangelogImagePicker,
    ...flags,
  };
}

// ── Pure helpers (handy for tests + downstream consumers) ────────────────

export interface ModalFlagsInput {
  commandWizard: CommandWizardState | null;
  commandPicker: CommandPickerState | null;
  commandToDelete: CustomCommand | null;
  showCommandList: boolean;
  showLspWizard: boolean;
  showThemePicker: boolean;
  showModelPicker: boolean;
  showInboxModal: boolean;
  showHelpMenu: boolean;
  showMemoryPicker: boolean;
  showSkillsPicker: boolean;
  showShellPicker: boolean;
  showPlanCompletePicker: boolean;
  showChangelogImagePicker: boolean;
}

export interface ModalFlags {
  hasFullscreenModal: boolean;
  hasOverlayModal: boolean;
  hasAnyModal: boolean;
}

export function computeModalFlags(s: ModalFlagsInput): ModalFlags {
  const hasFullscreenModal =
    s.commandWizard !== null ||
    s.commandPicker !== null ||
    s.commandToDelete !== null ||
    s.showCommandList ||
    s.showLspWizard ||
    s.showThemePicker ||
    s.showModelPicker ||
    s.showInboxModal ||
    s.showHelpMenu ||
    s.showMemoryPicker ||
    s.showSkillsPicker ||
    s.showShellPicker ||
    s.showChangelogImagePicker;
  const hasOverlayModal = s.showPlanCompletePicker;
  return {
    hasFullscreenModal,
    hasOverlayModal,
    hasAnyModal: hasFullscreenModal || hasOverlayModal,
  };
}

export const EMPTY_MODAL_STATE: ModalFlagsInput = {
  commandWizard: null,
  commandPicker: null,
  commandToDelete: null,
  showCommandList: false,
  showLspWizard: false,
  showThemePicker: false,
  showModelPicker: false,
  showInboxModal: false,
  showHelpMenu: false,
  showMemoryPicker: false,
  showSkillsPicker: false,
  showShellPicker: false,
  showPlanCompletePicker: false,
  showChangelogImagePicker: false,
};
