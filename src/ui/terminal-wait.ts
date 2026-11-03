/**
 * Waiting on something outside the terminal (a browser sign-in) with the
 * chat input out of the way. The Camouflage renderer has no event that
 * hides its input box, but it can lend the terminal out (as for `!`
 * commands): its live area, input included, is cleared and it stops reading
 * keys. While it is lent, one waiting line is drawn here and Esc (or Ctrl+C)
 * cancels. When the terminal can't be lent, the caller shows the line itself
 * and ignores typed input until the wait ends.
 */

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

/**
 * Lend the terminal, draw `line`, and call `cancel` on Esc or Ctrl+C. Resolves
 * with the function that erases the line and gives the terminal back, or null
 * when the terminal couldn't be lent (no TTY, or a renderer that can't).
 */
export async function waitWithoutInput(
  line: string,
  cancel: () => void,
  lender: TerminalLender,
  io: WaitIo = { stdin: process.stdin, stdout: process.stdout },
): Promise<(() => void) | null> {
  const { stdin, stdout } = io;
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") return null;
  if (!(await lender.suspend().catch(() => false))) return null;
  const wasRaw = stdin.isRaw;
  const onData = (chunk: Buffer | string) => {
    if (isCancelKey(typeof chunk === "string" ? chunk : chunk.toString("latin1"))) cancel();
  };
  try {
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stdout.write(`\r\x1b[2K${line}`);
  } catch {
    stdin.off("data", onData);
    lender.resume();
    return null;
  }
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
    stdout.write("\r\x1b[2K");
    lender.resume();
  };
}
