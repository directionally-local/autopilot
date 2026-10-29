/**
 * One-line preview of a shell command for tool rows, permission titles and
 * the activity panel. A long multi-line script (a `for` loop with an inline
 * `python3 -c "…"`) otherwise fills the screen instead of its result. Shows
 * the first non-blank line with runs of whitespace collapsed, cut to
 * `maxWidth` characters, plus "… +N lines" when more lines follow. Short
 * single-line commands come back unchanged (apart from trimming).
 */
export function previewCommand(command: string, maxWidth = 120): string {
  const lines = command.replace(/\r\n?/g, "\n").trim().split("\n");
  const first = (lines[0] ?? "").replace(/\s+/g, " ").trim();
  const hidden = lines.length - 1;
  if (hidden === 0) return clipChars(first, maxWidth);
  const marker = ` … +${hidden} ${hidden === 1 ? "line" : "lines"}`;
  return `${clipChars(first, Math.max(1, maxWidth - marker.length))}${marker}`;
}

/** True when previewCommand drops or cuts part of the command. */
export function isCommandCollapsed(command: string, maxWidth = 120): boolean {
  const trimmed = command.trim();
  return trimmed.includes("\n") || Array.from(trimmed).length > maxWidth;
}

/** Cut to at most `max` code points, ending in "…"; never splits a surrogate pair. */
function clipChars(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}
