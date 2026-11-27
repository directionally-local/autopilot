/** Build an OSC 0 title sequence, stripping terminal control characters. */
export function terminalTitleSequence(title: string): string | null {
  const safeTitle = title.replace(/[\u0000-\u001f\u007f\u009b\u009d]/g, " ").trim();
  return safeTitle ? `\u001b]0;${safeTitle}\u0007` : null;
}

/** The session title set by the app; restored after a pending-prompt title. */
let activeTitle: string | null = null;

/** Update the terminal/tab title using the widely supported OSC 0 sequence. */
export function setTerminalTitle(title: string, io: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout): void {
  const sequence = terminalTitleSequence(title);
  if (!sequence) return;
  activeTitle = title.trim();
  if (!io.isTTY) return;
  io.write(sequence);
}

/** The title the app last asked for (null before any session title exists). */
export function currentTerminalTitle(): string | null {
  return activeTitle;
}

/** The title shown while an answer is pending, so a background tab says so. */
export const PENDING_CONFIRMATION_TITLE = "autopilot: confirmation needed";

/** A BEL plus an OSC 0 title: a prompt is waiting even when nobody is watching. */
export function pendingAttentionSequence(title = PENDING_CONFIRMATION_TITLE): string {
  return `\u0007${terminalTitleSequence(title) ?? ""}`;
}

/**
 * Ring and title the terminal for a pending prompt (does nothing without a
 * TTY). Returns the function that restores the session title once the prompt
 * is answered or cancelled.
 */
export function alertPendingConfirmation(
  title = PENDING_CONFIRMATION_TITLE,
  io: Pick<NodeJS.WriteStream, "isTTY" | "write"> = process.stdout,
): () => void {
  if (!io.isTTY) return () => {};
  io.write(pendingAttentionSequence(title));
  // Read the title when the prompt closes: the first turn can generate the
  // session title while the permission prompt is still open.
  return () => {
    const sequence = terminalTitleSequence(activeTitle ?? "autopilot");
    if (sequence) io.write(sequence);
  };
}
