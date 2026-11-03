/** Conversation titles: how they are cut, and how saved ones are shown. */

/** Words a cut title shouldn't end on ("explain what this project does and…"). */
const TRAILING_FILLER = new Set(["and", "or", "but", "the", "a", "an", "to", "of", "for", "with", "in", "on", "at", "how", "that", "is"]);

/**
 * Cut `text` to at most `max` characters at a word boundary, with an
 * ellipsis when anything was left out. A single word longer than `max` is
 * cut inside it.
 */
export function cutAtWord(text: string, max: number, maxWords = Infinity): string {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length <= maxWords && words.join(" ").length <= max) return words.join(" ");
  const kept: string[] = [];
  for (const w of words) {
    if (kept.length >= maxWords || [...kept, w].join(" ").length > max - 1) break;
    kept.push(w);
  }
  if (kept.length === 0) return `${words[0]!.slice(0, max - 1)}…`;
  return withEllipsis(kept);
}

/** `words` ending in "…", without a dangling "and" or punctuation before it. */
function withEllipsis(words: string[]): string {
  const kept = [...words];
  while (kept.length > 1 && TRAILING_FILLER.has(kept[kept.length - 1]!.toLowerCase())) kept.pop();
  return `${kept.join(" ").replace(/[\s,;:.!?-]+$/, "")}…`;
}

/**
 * A saved title as shown. Titles saved by earlier versions lose their
 * "Q&A:" label, and the ones those versions cut after six words (or at 37
 * characters with "...") end in "…" without a dangling "and".
 */
export function displaySessionTitle(title: string): string {
  const t = title.trim();
  const qa = /^Q&A:\s*/.exec(t);
  if (!qa) return t.endsWith("...") ? `${t.slice(0, -3).trimEnd()}…` : t;
  const rest = t.slice(qa[0].length);
  if (rest.endsWith("...")) return `${rest.slice(0, -3).trimEnd()}…`;
  const words = rest.split(" ");
  // Six words was the old cut: when the last is a filler word, more followed.
  return words.length >= 6 && TRAILING_FILLER.has(words[words.length - 1]!.toLowerCase()) ? withEllipsis(words) : rest;
}
