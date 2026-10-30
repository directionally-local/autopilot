import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noTerminalSize, resetNoTerminalSizeWarning, warnIfNoTerminalSize } from "./terminal-size.js";

describe("a terminal that reports no size", () => {
  it("is a TTY with no usable width", () => {
    assert.equal(noTerminalSize({ isTTY: true, columns: 0 }), true);
    assert.equal(noTerminalSize({ isTTY: true }), true);
    assert.equal(noTerminalSize({ isTTY: true, columns: 120 }), false);
    assert.equal(noTerminalSize({ isTTY: false, columns: 0 }), false, "a pipe isn't a terminal");
  });

  it("says so once, on stderr", () => {
    resetNoTerminalSizeWarning();
    const lines: string[] = [];
    assert.equal(warnIfNoTerminalSize({ isTTY: true, columns: 0 }, (text) => { lines.push(text); }), true);
    assert.equal(warnIfNoTerminalSize({ isTTY: true, columns: 0 }, (text) => { lines.push(text); }), false, "once");
    assert.deepEqual(lines, ["autopilot: terminal reported no size; assuming 80×24\n"]);
    assert.equal(warnIfNoTerminalSize({ isTTY: true, columns: 120 }, (text) => { lines.push(text); }), false, "a sized terminal says nothing");
    resetNoTerminalSizeWarning();
  });
});
