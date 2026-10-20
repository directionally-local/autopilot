import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderTerminalQr } from "./terminal-qr.js";

// Captured from the `qrcode` package (toString type "terminal", small: true,
// ANSI colours stripped) that /hello used before; the output must not change.
const HELLO_WORLD = [
  " ▄▄▄▄▄▄▄   ▄ ▄ ▄▄▄▄▄▄▄ ",
  " █ ▄▄▄ █ ▀▀█ ▄ █ ▄▄▄ █ ",
  " █ ███ █ ▄ █▄█ █ ███ █ ",
  " █▄▄▄▄▄█ ▄▀█▀▄ █▄▄▄▄▄█ ",
  " ▄ ▄ ▄ ▄  ▄  ▄   ▄  ▄  ",
  "  ▀▀██▄▄▄█▄ █  ▄ █▄  ▀ ",
  " ▀█▀▀▄█▄█▀▄ █▀▀▄█▄▀█▀▄ ",
  " ▄▄▄▄▄▄▄ ▀ ▀ ▄ ▀▄ ▄█ ▀ ",
  " █ ▄▄▄ █ ▄█▀ ▄ ██▄█▄▄▄ ",
  " █ ███ █ ▄▄██ █▄█ ▄ ▀▄ ",
  " █▄▄▄▄▄█ ▄▄ █▀█▄▄ ▀ ▀█ ",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "",
];

const EXAMPLE_URL = [
  " ▄▄▄▄▄▄▄    ▄   ▄▄▄ ▄  ▄▄▄▄▄▄▄ ",
  " █ ▄▄▄ █ ▄▄▀██ ▄ ▄  ▄▀ █ ▄▄▄ █ ",
  " █ ███ █ █▀▀▀█▄▄▄▀▀▀▄█ █ ███ █ ",
  " █▄▄▄▄▄█ █ ▄▀▄▀█▀█ █ █ █▄▄▄▄▄█ ",
  " ▄ ▄▄▄▄▄ ▀ ▄▄█▀▄█ ▄▄██ ▄▄▄▄▄   ",
  " █▄█  ▀▄▄ ▀▄█   ▀▀▄▄▀▄▄▀██   ▀ ",
  " ▄ ▄▀ ▀▄█  ▄▄▀ ▀ ▀▄██▀▀ ▀ █▄▀  ",
  " █ ▄ ▀ ▄  █ ▀ ███ ▄▄▀▄▀███▄▄ ▀ ",
  " █▄ █ ▀▄▄▀▄█▄▀▀▄█▄▄▄▄▀▀  ▀▄▄▀  ",
  " █▀█▀▀▄▄ ▄ █▀▀  ▄   ▀█▀▀▀█ █ ▀ ",
  " █ ▄█▄▄▄▄ █ ▀▀ ▀ ▀▄███▄▄▄▄ ▄█▄ ",
  " ▄▄▄▄▄▄▄ ▀  ▀▄██▄▄▄▀▄█ ▄ ███▀▀ ",
  " █ ▄▄▄ █ █▀  ▀▀▄█▄▄▀▀█▄▄▄█ ▄▄  ",
  " █ ███ █ ██▄ █▀▄▄▄▄ ▀▀█▄█▄███▀ ",
  " █▄▄▄▄▄█ ▄▀  ▄  ▀█▄█▄▀▄███▀▄▀  ",
  "▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
  "",
];

/** Rebuild the module grid (true = dark) from the half-block lines. */
function modules(lines: string[]): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of lines.slice(0, -2)) {
    const chars = [...line].slice(1, -1);
    rows.push(chars.map((c) => c === "█" || c === "▀"));
    rows.push(chars.map((c) => c === "█" || c === "▄"));
  }
  return rows.slice(1); // first half-row is the quiet zone
}

describe("renderTerminalQr", () => {
  it("matches the output of the qrcode package it replaced", () => {
    assert.deepEqual(renderTerminalQr("HELLO WORLD"), HELLO_WORLD);
    assert.deepEqual(renderTerminalQr("https://example.com/?s=1234&v=1.0"), EXAMPLE_URL);
  });

  it("draws a square symbol with finder patterns in three corners", () => {
    const url = "https://hello.kimiflare.com/?s=3f2b8c1e-0000-4000-8000-123456789abc&v=1.28.0";
    const lines = renderTerminalQr(url);
    const grid = modules(lines);
    const size = grid[0]!.length;
    assert.equal(size, 37); // version 5 at error correction level M
    assert.equal(grid.length, size);
    for (const line of lines.slice(0, -1)) assert.equal([...line].length, size + 2);
    assert.equal(lines.at(-1), "");
    const finder = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          assert.equal(grid[y0 + y]![x0 + x], ring !== 2, `finder at ${x0},${y0} cell ${x},${y}`);
        }
      }
    };
    finder(0, 0);
    finder(size - 7, 0);
    finder(0, size - 7);
  });

  it("grows the symbol for longer input", () => {
    assert.ok(renderTerminalQr("x".repeat(200)).length > renderTerminalQr("x").length);
  });
});
