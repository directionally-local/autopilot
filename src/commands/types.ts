import type { Mode } from "../mode.js";
import type { ReasoningEffort } from "../config.js";

export type CommandSource = "project" | "global";

export type CustomCommand = {
  name: string;
  description?: string;
  template: string;
  source: CommandSource;
  filepath: string;
  mode?: Mode;
  model?: string;
  effort?: ReasoningEffort;
  shell?: boolean;
  files?: boolean;
  /** Set for a command read in place from another agent's setup (#1126). */
  importedFrom?: "claude";
};

export type RenderResult = {
  prompt: string;
  warnings: string[];
};

export type LoadResult = {
  commands: CustomCommand[];
  warnings: string[];
};

export type SlashItemSource = "builtin" | CommandSource;

export type SlashItem = {
  name: string;
  description: string;
  argHint?: string;
  source: SlashItemSource;
};
