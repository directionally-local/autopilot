import type { ProviderId } from "../providers/presets.js";
import { useState } from "react";
import type { CustomCommand } from "../commands/types.js";

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
  commandWizard: CommandWizardState | null;
  setCommandWizard: (v: CommandWizardState | null) => void;
  commandPicker: CommandPickerState | null;
  setCommandPicker: (v: CommandPickerState | null) => void;
  showCommandList: boolean;
  setShowCommandList: (v: boolean) => void;
  showLspWizard: boolean;
  setShowLspWizard: (v: boolean) => void;
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
}

/**
 * Which modal App has open. App reports the open ones to the Camouflage
 * view in the bridge snapshot; the view draws them and closes them through
 * bridge actions.
 *
 * Note on what is NOT here:
 *   - `perm` (permission modal) lives in `usePermissionController`.
 *   - `resumeSessions` / `checkpointSession` live in `useSessionManager`.
 */
export function useModalHost(): ModalHostController {
  const [commandWizard, setCommandWizard] = useState<CommandWizardState | null>(null);
  const [commandPicker, setCommandPicker] = useState<CommandPickerState | null>(null);
  const [showCommandList, setShowCommandList] = useState(false);
  const [showLspWizard, setShowLspWizard] = useState(false);
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

  return {
    commandWizard, setCommandWizard,
    commandPicker, setCommandPicker,
    showCommandList, setShowCommandList,
    showLspWizard, setShowLspWizard,
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
  };
}
