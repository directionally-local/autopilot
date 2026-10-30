import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { configPath } from "./app-dirs.js";

export interface StateFile {
  creatorMessageSeenVersion?: string;
  /** Legacy kimiflare hook settings files the "hooks found only in the
   *  legacy path" notice was already shown for (#887). */
  legacyHooksNoticePaths?: string[];
  /** The 1.29.0 "only exit 2 blocks" hooks notice was shown (#888). */
  hooksExitCodeNoticeShown?: boolean;
}

function statePath(): string {
  return configPath("state.json");
}

export async function readState(): Promise<StateFile> {
  try {
    const raw = await readFile(statePath(), "utf8");
    return JSON.parse(raw) as StateFile;
  } catch {
    return {};
  }
}

export async function writeState(state: StateFile): Promise<void> {
  const path = statePath();
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export async function markCreatorMessageSeen(version: string): Promise<void> {
  const state = await readState();
  state.creatorMessageSeenVersion = version;
  await writeState(state);
}

export async function shouldShowCreatorMessage(version: string): Promise<boolean> {
  const state = await readState();
  return state.creatorMessageSeenVersion !== version;
}
