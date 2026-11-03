import { describe, it } from "node:test";
import assert from "node:assert";
import { canOpenBrowser } from "./open-browser.js";

describe("canOpenBrowser", () => {
  it("is false on Linux without a graphical session", () => {
    assert.strictEqual(canOpenBrowser({}, "linux"), false);
    assert.strictEqual(canOpenBrowser({ DISPLAY: "" }, "linux"), false);
  });

  it("is true on Linux with X11 or Wayland, and in WSL", () => {
    assert.strictEqual(canOpenBrowser({ DISPLAY: ":0" }, "linux"), true);
    assert.strictEqual(canOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
    assert.strictEqual(canOpenBrowser({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true);
  });

  it("is false over SSH, even with a forwarded display or on a Mac", () => {
    assert.strictEqual(canOpenBrowser({ SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22", DISPLAY: "localhost:10.0" }, "linux"), false);
    assert.strictEqual(canOpenBrowser({ SSH_TTY: "/dev/pts/1" }, "darwin"), false);
  });

  it("is true on macOS and Windows desktops, false when turned off", () => {
    assert.strictEqual(canOpenBrowser({}, "darwin"), true);
    assert.strictEqual(canOpenBrowser({}, "win32"), true);
    assert.strictEqual(canOpenBrowser({ AUTOPILOT_NO_BROWSER: "1" }, "darwin"), false);
    assert.strictEqual(canOpenBrowser({ BROWSER: "none", DISPLAY: ":0" }, "linux"), false);
  });
});
