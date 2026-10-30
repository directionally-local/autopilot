/**
 * Bare-word exit: typing exactly `exit` (nothing before or after it) quits
 * autopilot, the same way `/exit` does.
 *
 * The match is deliberately strict — the whole trimmed input must be the
 * single word `exit` (case-insensitive). A sentence that merely contains the
 * word ("how do I exit vim?", "exit code 1 means…") is a normal prompt and
 * must reach the model untouched.
 */
export function isExitCommand(text: string): boolean {
  return text.trim().toLowerCase() === "exit";
}
