import { describe, it } from "node:test";
import assert from "node:assert";
import { terminalWrapWidth, wrapText } from "./wrap.js";

describe("wrapText", () => {
  it("wraps at word boundaries instead of cutting the line off", () => {
    const line =
      "API keys you enter are checked with the provider, then saved only in /home/dev/.config/autopilot/config.json (keys from your environment are never written to disk).";
    const lines = wrapText(line, 119);
    assert.ok(lines.length === 2 && lines.every((l) => l.length <= 119));
    assert.strictEqual(lines.join(" "), line, "no words lost");
    assert.ok(lines[1]!.endsWith("never written to disk)."));
  });

  it("keeps short lines and blank lines, and a word longer than the width whole", () => {
    assert.deepStrictEqual(wrapText("a\n\nb", 80), ["a", "", "b"]);
    const url = `https://example.com/${"x".repeat(60)}`;
    assert.deepStrictEqual(wrapText(`open ${url} now`, 30), ["open", url, "now"]);
  });

  it("uses the terminal's width less one, or 80 columns without one", () => {
    assert.strictEqual(terminalWrapWidth({ columns: 120 }), 119);
    assert.strictEqual(terminalWrapWidth({}), 79);
  });
});
