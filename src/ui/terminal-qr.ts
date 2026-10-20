import { encode } from "uqr";

// Half-block glyph for a vertical pair of cells. Cell codes: "0" outside the
// code, "1" light (quiet zone or light module), "2" dark module. This is the
// colour-stripped form of the `qrcode` package's small terminal renderer, which
// /hello used before, so the printed QR code is unchanged.
const GLYPHS: Record<string, string> = {
  "00": " ",
  "01": "▄",
  "02": "▄",
  "10": "▀",
  "11": " ",
  "12": "▄",
  "20": "▀",
  "21": "▀",
  "22": "█",
};

/**
 * Render `text` as a QR code drawn with half-block characters, two module rows
 * per terminal line, with a one-module quiet zone. Error correction level M.
 * Returns the lines (the last one is empty, as with the old renderer).
 */
export function renderTerminalQr(text: string, opts: { maskPattern?: number } = {}): string[] {
  const { data, size } = encode(text, { ecc: "M", border: 0, maskPattern: opts.maskPattern ?? -1 });
  const cell = (x: number, y: number): string => {
    if (x > size || y > size || x < -1 || y < -1) return "0";
    if (x >= size || y >= size || x < 0 || y < 0) return "1";
    return data[y]?.[x] ? "2" : "1";
  };
  const lines: string[] = [];
  for (let y = -1; y < size + 1; y += 2) {
    let line = "";
    for (let x = -1; x <= size; x++) line += GLYPHS[cell(x, y) + cell(x, y + 1)] ?? " ";
    lines.push(line);
  }
  lines.push("");
  return lines;
}
