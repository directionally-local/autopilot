/**
 * Word-wrap plain text to a terminal width. Lines the renderer prints as-is
 * (Splash) are cut at the edge with "…", so text that must be read in full is
 * wrapped here first. Words longer than the width (paths, URLs) are kept
 * whole on their own line rather than split.
 */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(20, Math.floor(width));
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.length <= max) {
      out.push(line);
      continue;
    }
    let cur = "";
    for (const word of line.split(" ")) {
      if (!cur) cur = word;
      else if (cur.length + 1 + word.length <= max) cur += ` ${word}`;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
  }
  return out;
}

/** The width to wrap printed lines to: the terminal's, less a column of slack. */
export function terminalWrapWidth(stream: { columns?: number } = process.stdout): number {
  const cols = stream.columns && stream.columns > 0 ? stream.columns : 80;
  return cols - 1;
}
