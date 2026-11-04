/**
 * Copy text to the clipboard of the terminal in front of the person with
 * OSC 52, which works over SSH too. There is no way to ask a terminal whether
 * it took the text, so callers always show the text as well and only say
 * "copied" when the sequence was sent to a terminal likely to honour it.
 */

/** The OSC 52 sequence that sets the clipboard to `text`. */
export function osc52Sequence(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/**
 * Whether OSC 52 is worth sending: a terminal on stdout, not turned off
 * (AUTOPILOT_NO_CLIPBOARD=1), and not one known to drop it: a dumb terminal,
 * macOS Terminal, or a tmux/screen session (which pass it on only when set up
 * to).
 */
export function osc52Supported(env: NodeJS.ProcessEnv = process.env, isTTY = !!process.stdout.isTTY): boolean {
  if (!isTTY) return false;
  if (env.AUTOPILOT_NO_CLIPBOARD === "1") return false;
  if (!env.TERM || env.TERM === "dumb") return false;
  if (env.TERM_PROGRAM === "Apple_Terminal") return false;
  if (env.TMUX || env.STY) return false;
  return true;
}

/** Send `text` to the terminal's clipboard when supported. True when it was sent. */
export function copyWithOsc52(
  text: string,
  o: { env?: NodeJS.ProcessEnv; isTTY?: boolean; write?: (data: string) => void } = {},
): boolean {
  const env = o.env ?? process.env;
  const isTTY = o.isTTY ?? !!process.stdout.isTTY;
  if (!osc52Supported(env, isTTY)) return false;
  try {
    (o.write ?? ((d: string) => process.stdout.write(d)))(osc52Sequence(text));
    return true;
  } catch {
    return false;
  }
}
