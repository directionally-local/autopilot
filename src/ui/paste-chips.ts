/**
 * The renderer collapses a long paste into a `[Pasted text #1 +22 lines]`
 * chip and expands it back on submit. The chat prompt has always done that;
 * multi-line form fields did not until camouflage-tui expanded them too, so
 * with an older renderer a form value can still hold the chip instead of the
 * pasted text. These helpers let the forms that take free text catch that
 * rather than send or save the placeholder.
 */

const CHIP = /\[Pasted text #\d+ \+\d+ lines?\]/g;

/** Whether `text` still holds a collapsed-paste chip. */
export function hasPasteChip(text: string): boolean {
  CHIP.lastIndex = 0;
  return CHIP.test(text);
}

/** `text` without its chips (what's left to prefill when asking again). */
export function withoutPasteChips(text: string): string {
  return text.replace(CHIP, "").replace(/[ \t]+\n/g, "\n").trim();
}

/** Shown when a form value came back with a chip in it. */
export const PASTE_CHIP_PROBLEM = "a long paste didn't come through; paste it again or type it";
