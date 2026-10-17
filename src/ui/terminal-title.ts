/** Build an OSC 0 title sequence, stripping terminal control characters. */
export function terminalTitleSequence(title: string): string | null {
  const safeTitle = title.replace(/[\u0000-\u001f\u007f\u009b\u009d]/g, " ").trim();
  return safeTitle ? `\u001b]0;${safeTitle}\u0007` : null;
}

/** Update the terminal/tab title using the widely supported OSC 0 sequence. */
export function setTerminalTitle(title: string): void {
  if (!process.stdout.isTTY) return;
  const sequence = terminalTitleSequence(title);
  if (sequence) process.stdout.write(sequence);
}
