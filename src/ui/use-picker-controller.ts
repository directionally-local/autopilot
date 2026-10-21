import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "../util/fuzzy.js";
import type { FilePickerItem } from "./view-types.js";
import type { SlashItem } from "../commands/types.js";

export type PickerKind = "file" | "slash";

export type ActivePicker =
  | { kind: "file"; anchor: number; selected: number }
  | { kind: "slash"; anchor: number; selected: number };

// ── Pure helpers (kept here so unit tests don't have to load app.tsx) ─────

export function filterPickerItems(
  items: FilePickerItem[],
  query: string,
): FilePickerItem[] {
  return fuzzyFilter(items, query, (item) => item.name).slice(0, 50);
}

export function shouldOpenMentionPicker(
  input: string,
  cursorOffset: number,
  pickerCancelOffset: number | null,
): boolean {
  if (pickerCancelOffset === cursorOffset) return false;
  if (cursorOffset > 0 && input[cursorOffset - 1] === "@") {
    const beforeAt = cursorOffset - 2;
    return beforeAt < 0 || /\s/.test(input[beforeAt]!);
  }
  return false;
}

/**
 * Slash picker triggers when:
 *   - the char immediately before the cursor is "/"
 *   - everything before that "/" is whitespace-only
 * This matches handleSlash() dispatch (it only runs on inputs where the
 * trimmed text starts with "/"), so the picker can't surface commands
 * that won't actually fire.
 */
export function shouldOpenSlashPicker(
  input: string,
  cursorOffset: number,
  cancelOffset: number | null,
): boolean {
  if (cancelOffset === cursorOffset) return false;
  if (cursorOffset === 0 || input[cursorOffset - 1] !== "/") return false;
  return /^\s*$/.test(input.slice(0, cursorOffset - 1));
}

/**
 * Insert a picked slash-command name into the input, replacing the entire
 * command token (from `/` through the next whitespace or EOL). Preserves
 * any args the user already typed past the cursor and ensures exactly one
 * separating space.
 */
export function insertSlashCommand(
  input: string,
  anchor: number,
  name: string,
): { value: string; cursor: number } {
  let tokenEnd = anchor + 1;
  while (tokenEnd < input.length && !/\s/.test(input[tokenEnd]!)) tokenEnd++;
  const head = input.slice(0, anchor + 1) + name;
  const tail = " " + input.slice(tokenEnd).replace(/^\s+/, "");
  return { value: head + tail, cursor: head.length + 1 };
}

// ── Pure transition function (the core decision) ─────────────────────────

export type PickerTransition =
  | { kind: "none" }
  | { kind: "close" }
  | { kind: "open"; picker: ActivePicker; loadFiles: boolean }
  | { kind: "dropCancel" };

export function decidePickerTransition(
  active: ActivePicker | null,
  input: string,
  cursorOffset: number,
  pickerCancelOffset: number | null,
  filePickerEnabled: boolean,
): PickerTransition {
  if (active !== null) {
    const trigger = active.kind === "file" ? "@" : "/";
    if (cursorOffset < active.anchor) return { kind: "close" };
    if (input[active.anchor] !== trigger) return { kind: "close" };
    const query = input.slice(active.anchor + 1, cursorOffset);
    if (/\s/.test(query)) return { kind: "close" };
    return { kind: "none" };
  }

  if (pickerCancelOffset === cursorOffset) {
    return { kind: "dropCancel" };
  }

  if (filePickerEnabled && shouldOpenMentionPicker(input, cursorOffset, pickerCancelOffset)) {
    return {
      kind: "open",
      picker: { kind: "file", anchor: cursorOffset - 1, selected: 0 },
      loadFiles: true,
    };
  }

  if (shouldOpenSlashPicker(input, cursorOffset, pickerCancelOffset)) {
    return {
      kind: "open",
      picker: { kind: "slash", anchor: cursorOffset - 1, selected: 0 },
      loadFiles: false,
    };
  }

  return { kind: "none" };
}

// ── React hook ───────────────────────────────────────────────────────────

export interface UsePickerControllerOptions {
  input: string;
  cursorOffset: number;
  setInput: (v: string) => void;
  setCursorOffset: (n: number) => void;
  filePickerEnabled: boolean;
  allSlashCommands: SlashItem[];
  modalActive: boolean;
  /** Lazy-load file list on first `@` trigger. Called at most once. */
  loadFilePickerItems: (query?: string) => Promise<FilePickerItem[]>;
  /** Called when a file is picked so the caller can update its recents store. */
  onFileSelected?: (name: string) => void;
  /** Called with the new input value when a slash command is picked. */
  onSlashSelected: (value: string) => void;
  /** Snapshot of the recents map for the file-picker sort. */
  getRecentFiles: () => Map<string, number>;
}

export interface PickerController {
  active: ActivePicker | null;
  isActive: boolean;
  query: string;
  fileItems: FilePickerItem[];
  slashItems: SlashItem[];
  onUp: () => void;
  onDown: () => void;
  onSelect: () => void;
  onCancel: () => void;
}

export function usePickerController(opts: UsePickerControllerOptions): PickerController {
  const {
    input,
    cursorOffset,
    setInput,
    setCursorOffset,
    filePickerEnabled,
    allSlashCommands,
    modalActive,
    loadFilePickerItems,
    onFileSelected,
    onSlashSelected,
    getRecentFiles,
  } = opts;

  const [active, setActive] = useState<ActivePicker | null>(null);
  const [fileItemsRaw, setFileItemsRaw] = useState<FilePickerItem[]>([]);
  const filesLoadedRef = useRef(false);
  const cancelOffsetRef = useRef<number | null>(null);

  // Stash callbacks/getters in refs so the public handlers keep stable
  // identities and we never close over a stale closure.
  const onFileSelectedRef = useRef(onFileSelected);
  onFileSelectedRef.current = onFileSelected;
  const onSlashSelectedRef = useRef(onSlashSelected);
  onSlashSelectedRef.current = onSlashSelected;
  const getRecentFilesRef = useRef(getRecentFiles);
  getRecentFilesRef.current = getRecentFiles;
  const loadFilePickerItemsRef = useRef(loadFilePickerItems);
  loadFilePickerItemsRef.current = loadFilePickerItems;

  // Depend on stable fields (kind, anchor) — not the active reference,
  // which churns on every arrow-key press.
  const activeAnchor = active?.anchor ?? null;
  const activeKind = active?.kind ?? null;

  const query = useMemo(() => {
    if (activeAnchor === null) return "";
    return input.slice(activeAnchor + 1, cursorOffset);
  }, [input, cursorOffset, activeAnchor]);

  const requestedPathRef = useRef("");
  useEffect(() => {
    if (activeKind !== "file" || !(query.startsWith(".") || query.startsWith("~") || query.startsWith("/"))) return;
    const directoryQuery = query.endsWith("/") || query === "~" || query === "." || query === ".." || query.endsWith("/..")
      ? query
      : query.slice(0, query.lastIndexOf("/") + 1);
    if (requestedPathRef.current === directoryQuery) return;
    requestedPathRef.current = directoryQuery;
    void loadFilePickerItemsRef.current(query).then(setFileItemsRaw).catch(() => setFileItemsRaw([]));
  }, [activeKind, query]);

  const fileItems = useMemo(() => {
    if (activeKind !== "file") return [];
    const items = filterPickerItems(fileItemsRaw, query).slice();
    const recents = getRecentFilesRef.current();
    return items.sort((a, b) => {
      const aRecent = recents.get(a.name) ?? 0;
      const bRecent = recents.get(b.name) ?? 0;
      if (aRecent && !bRecent) return -1;
      if (!aRecent && bRecent) return 1;
      if (aRecent && bRecent) return bRecent - aRecent;
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [activeKind, fileItemsRaw, query]);

  const slashItems = useMemo(() => {
    if (activeKind !== "slash") return [];
    return fuzzyFilter(allSlashCommands, query, (c) => c.name).slice(0, 50);
  }, [activeKind, allSlashCommands, query]);

  // Transition on input/cursor changes.
  useEffect(() => {
    const t = decidePickerTransition(
      active,
      input,
      cursorOffset,
      cancelOffsetRef.current,
      filePickerEnabled,
    );
    if (t.kind === "close") {
      setActive(null);
      return;
    }
    if (t.kind === "dropCancel") {
      cancelOffsetRef.current = null;
      return;
    }
    if (t.kind === "open") {
      setActive(t.picker);
      if (t.loadFiles) {
        filesLoadedRef.current = true;
        void loadFilePickerItemsRef
          .current(input.slice(t.picker.anchor + 1, cursorOffset))
          .then((items) => setFileItemsRaw(items))
          .catch(() => setFileItemsRaw([]));
      }
    }
  }, [input, cursorOffset, active, filePickerEnabled]);

  // Clamp selected index when filtered list shrinks below current selection.
  useEffect(() => {
    if (active?.kind !== "file") return;
    const max = Math.max(0, fileItems.length - 1);
    if (active.selected > max) {
      setActive({ ...active, selected: max });
    }
  }, [fileItems.length, active]);

  useEffect(() => {
    if (active?.kind !== "slash") return;
    const max = Math.max(0, slashItems.length - 1);
    if (active.selected > max) {
      setActive({ ...active, selected: max });
    }
  }, [slashItems.length, active]);

  // Close the picker whenever a modal takes over the input. Without this,
  // picker state survives the modal and re-renders on close.
  useEffect(() => {
    if (modalActive && active !== null) {
      setActive(null);
    }
  }, [modalActive, active]);

  const onUp = useCallback(() => {
    setActive((p) => {
      if (!p) return null;
      const next = Math.max(0, p.selected - 1);
      return next === p.selected ? p : { ...p, selected: next };
    });
  }, []);

  const onDown = useCallback(() => {
    setActive((p) => {
      if (!p) return null;
      const max = p.kind === "file"
        ? Math.max(0, fileItems.length - 1)
        : Math.max(0, slashItems.length - 1);
      const next = Math.min(max, p.selected + 1);
      return next === p.selected ? p : { ...p, selected: next };
    });
  }, [fileItems.length, slashItems.length]);

  const onSelect = useCallback(() => {
    if (!active) return;
    if (active.kind === "file") {
      const item = fileItems[active.selected];
      if (!item) return;
      onFileSelectedRef.current?.(item.name);
      const insert = item.name + (item.isDirectory ? "/" : " ");
      const newInput = input.slice(0, active.anchor) + insert + input.slice(cursorOffset);
      setInput(newInput);
      setCursorOffset(active.anchor + insert.length);
      setActive(null);
      return;
    }
    const item = slashItems[active.selected];
    if (!item) return;
    const { value } = insertSlashCommand(input, active.anchor, item.name);
    setActive(null);
    onSlashSelectedRef.current(value);
  }, [active, fileItems, slashItems, input, cursorOffset, setInput, setCursorOffset]);

  const onCancel = useCallback(() => {
    cancelOffsetRef.current = cursorOffset;
    setActive(null);
  }, [cursorOffset]);

  return {
    active,
    isActive: active !== null,
    query,
    fileItems,
    slashItems,
    onUp,
    onDown,
    onSelect,
    onCancel,
  };
}
