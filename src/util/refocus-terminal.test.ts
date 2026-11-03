import { describe, it } from "node:test";
import assert from "node:assert";
import { refocusPlan, refocusTerminal, terminalApp } from "./refocus-terminal.js";

const mac = (env: NodeJS.ProcessEnv) => refocusPlan({ env, platform: "darwin" });

describe("terminalApp", () => {
  it("maps TERM_PROGRAM to the macOS app", () => {
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "Apple_Terminal" }), "Terminal");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "iTerm.app" }), "iTerm");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "WarpTerminal" }), "Warp");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "ghostty" }), "Ghostty");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "WezTerm" }), "WezTerm");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "vscode" }), "Visual Studio Code");
  });

  it("tells VS Code forks apart by bundle id", () => {
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.todesktop.230313mzl4w4u92" }), "Cursor");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.exafunction.windsurf" }), "Windsurf");
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "vscode", __CFBundleIdentifier: "com.example.other" }), "Visual Studio Code");
  });

  it("knows kitty and Alacritty by their own variables", () => {
    assert.strictEqual(terminalApp({ TERM: "xterm-kitty" }), "kitty");
    assert.strictEqual(terminalApp({ ALACRITTY_WINDOW_ID: "1" }), "Alacritty");
  });

  it("is unknown inside tmux or for terminals it can't name", () => {
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "tmux", TERM: "xterm-kitty" }), undefined);
    assert.strictEqual(terminalApp({ TERM_PROGRAM: "constructor" }), undefined);
    assert.strictEqual(terminalApp({}), undefined);
  });
});

describe("refocusPlan", () => {
  it("activates the terminal on macOS", () => {
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "iTerm.app" }), { app: "iTerm" });
  });

  it("does nothing on Linux or Windows", () => {
    assert.deepStrictEqual(refocusPlan({ env: { TERM_PROGRAM: "iTerm.app" }, platform: "linux" }), { skip: "not-macos" });
    assert.deepStrictEqual(refocusPlan({ env: { TERM_PROGRAM: "vscode" }, platform: "win32" }), { skip: "not-macos" });
  });

  it("does nothing over SSH", () => {
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "iTerm.app", SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }), { skip: "ssh" });
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "iTerm.app", SSH_TTY: "/dev/ttys001" }), { skip: "ssh" });
  });

  it("does nothing for an unknown terminal", () => {
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "tmux" }), { skip: "unknown-terminal" });
  });

  it("does nothing when turned off by setting or environment", () => {
    assert.deepStrictEqual(refocusPlan({ env: { TERM_PROGRAM: "iTerm.app" }, platform: "darwin", enabled: false }), { skip: "off" });
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "iTerm.app", AUTOPILOT_REFOCUS_TERMINAL: "0" }), { skip: "off" });
  });

  it("never steals focus from a test run", () => {
    assert.deepStrictEqual(mac({ TERM_PROGRAM: "iTerm.app", NODE_TEST_CONTEXT: "child" }), { skip: "test" });
  });
});

describe("refocusTerminal", () => {
  it("runs the activation only when the plan says so, and never throws", async () => {
    const opened: string[] = [];
    const activate = (app: string) => void opened.push(app);
    assert.deepStrictEqual(await refocusTerminal({ env: { TERM_PROGRAM: "ghostty" }, platform: "darwin", enabled: true, activate }), { app: "Ghostty" });
    assert.deepStrictEqual(await refocusTerminal({ env: { TERM_PROGRAM: "ghostty" }, platform: "linux", activate }), { skip: "not-macos" });
    const throwing = () => {
      throw new Error("no open");
    };
    assert.deepStrictEqual(await refocusTerminal({ env: { TERM_PROGRAM: "ghostty" }, platform: "darwin", enabled: true, activate: throwing }), { skip: "off" });
    assert.deepStrictEqual(opened, ["Ghostty"]);
  });
});
