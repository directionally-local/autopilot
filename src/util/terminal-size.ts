/**
 * Some ptys report a window of 0 rows × 0 cols: `expect` without `set stty_init`, some CI
 * runners, `script`, and a few IDE task terminals. The renderer falls back to 80×24, but a
 * blank screen with no explanation is its own bug, so say so once.
 */

/** Whether a terminal stream is a TTY that reports no usable width. */
export function noTerminalSize(stream: { isTTY?: boolean; columns?: number }): boolean {
  return stream.isTTY === true && !(typeof stream.columns === "number" && stream.columns > 0);
}

let warned = false;

/** Say it once per process, on stderr (stdout may be the host's event stream). */
export function warnIfNoTerminalSize(
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
  write: (text: string) => void = (text) => process.stderr.write(text),
): boolean {
  if (warned || !noTerminalSize(stream)) return false;
  warned = true;
  write("autopilot: terminal reported no size; assuming 80×24\n");
  return true;
}

/** Tests: forget that the warning was shown. */
export function resetNoTerminalSizeWarning(): void {
  warned = false;
}
