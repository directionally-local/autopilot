/**
 * Waiting on something outside the terminal (a browser sign-in) with the
 * chat input out of the way. The Camouflage renderer has no event that
 * hides its input box, but it can lend the terminal out (as for `!`
 * commands): its live area, input included, is cleared and it stops reading
 * keys. While it is lent, the waiting text (one or more lines) is drawn
 * here and Esc (or Ctrl+C) cancels. When the terminal can't be lent, the
 * caller shows the text itself and ignores typed input until the wait ends.
 */

import { terminalWrapWidth, wrapText } from "../util/wrap.js";

/** Esc or Ctrl+C, as a raw byte or in the kitty keyboard protocol's CSI-u form. */
export function isCancelKey(chunk: string): boolean {
  return chunk === "\x1b" || chunk === "\x03" || /^\x1b\[27(?:;1)?u$/.test(chunk) || /^\x1b\[99;5u$/.test(chunk);
}

export interface TerminalLender {
  /** Clear the renderer's live area and stop it reading keys; false when it can't. */
  suspend(): Promise<boolean>;
  resume(): void;
}

export interface WaitIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/** Rows `text` takes on a terminal `columns` wide, each line soft-wrapping. */
export function textRows(text: string, columns: number): number {
  const cols = Math.max(1, columns);
  return text.split("\n").reduce((rows, l) => rows + Math.max(1, Math.ceil([...l].length / cols)), 0);
}

/**
 * Lend the terminal, draw `line` (newlines allowed), and call `cancel` on Esc
 * or Ctrl+C. Resolves with the function that erases it and gives the terminal back, or null
 * when the terminal couldn't be lent (no TTY, or a renderer that can't).
 */
export async function waitWithoutInput(
  line: string,
  cancel: () => void,
  lender: TerminalLender,
  io: WaitIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<(() => void) | null> {
  return lendTerminal(line, (chunk) => {
    if (isCancelKey(chunk)) cancel();
  }, lender, io);
}

/**
 * Lend the terminal, draw `line`, and resolve with the first key pressed
 * (the raw chunk), erasing the line and giving the terminal back. Null when
 * the terminal couldn't be lent.
 */
export async function readKeyWithoutInput(
  line: string,
  lender: TerminalLender,
  io: WaitIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<string | null> {
  let resolveKey!: (key: string) => void;
  const key = new Promise<string>((resolve) => (resolveKey = resolve));
  const end = await lendTerminal(line, (chunk) => resolveKey(chunk), lender, io);
  if (!end) return null;
  const pressed = await key;
  end();
  return pressed;
}

/** Lend the terminal, draw `line`, and pass each key chunk to `onKey` until the returned function ends it. */
async function lendTerminal(
  line: string,
  onKey: (chunk: string) => void,
  lender: TerminalLender,
  io: WaitIo,
): Promise<(() => void) | null> {
  const { stdin, stdout } = io;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return null;
  if (!(await lender.suspend().catch(() => false))) return null;
  // Wrapped at word boundaries, like the renderer's own lines, not mid-word by the terminal.
  const text = wrapText(line, terminalWrapWidth(stdout)).join("\n");
  const wasRaw = stdin.isRaw;
  const onData = (chunk: Buffer | string) => onKey(typeof chunk === "string" ? chunk : chunk.toString("latin1"));
  try {
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write(`\r\x1b[2K${text.split("\n").join("\r\n")}`);
  } catch {
    stdin.off("data", onData);
    lender.resume();
    return null;
  }
  // Erased by going back up over every row it took (long lines wrap).
  const up = textRows(text, stdout.columns || 80) - 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    stdin.off("data", onData);
    try {
      stdin.setRawMode(wasRaw);
    } catch {
      /* the terminal went away */
    }
    stdin.pause();
    stdout.write(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`);
    lender.resume();
  };
}
