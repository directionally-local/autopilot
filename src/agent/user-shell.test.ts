import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { enableUserShellCommands, interactiveCommandHint, userShellCommandsEnabled } from "./user-shell.js";
import { buildSessionPrefix, buildSystemPrompt } from "./system-prompt.js";
import { bashTool } from "../tools/bash.js";

describe("user shell prompt gating", () => {
  afterEach(() => enableUserShellCommands(false));

  it("is off by default (headless, SDK, server)", () => {
    assert.strictEqual(userShellCommandsEnabled(), false);
    const p = buildSystemPrompt({ cwd: "/tmp", tools: [], model: "m" });
    assert.ok(!p.includes("Commands the user runs with `!`"));
  });

  it("adds the `!` section to the session prefix when the TUI enables it", () => {
    enableUserShellCommands();
    const p = buildSessionPrefix({ cwd: "/tmp", tools: [], model: "m" });
    assert.ok(p.includes("Commands the user runs with `!`"));
    assert.ok(p.includes("! gh auth login"));
    assert.ok(p.includes("the turn continues automatically"));
  });
});

describe("interactiveCommandHint", () => {
  const base = { exitCode: 1, timedOut: false, output: "" };

  it("never hints on success", () => {
    assert.strictEqual(
      interactiveCommandHint({ ...base, command: "gh auth status", exitCode: 0, output: "You are not logged in" }),
      null,
    );
  });

  it("hints on auth failures and suggests the exact command", () => {
    const hint = interactiveCommandHint({
      ...base,
      command: "gh pr list",
      output: "To get started with GitHub CLI, please run:  gh auth login",
    });
    assert.ok(hint);
    assert.ok(hint.includes("`! gh pr list`"));
  });

  it("hints on TTY errors", () => {
    for (const output of [
      "sudo: a terminal is required to read the password",
      "Error: stdin is not a tty",
      "stty: 'standard input': Inappropriate ioctl for device",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    ]) {
      assert.ok(interactiveCommandHint({ ...base, command: "some-cmd", output }), output);
    }
  });

  it("hints on failed known-interactive commands, stripping a leading cd", () => {
    const hint = interactiveCommandHint({ ...base, command: "cd app && npm login", output: "npm error canceled" });
    assert.ok(hint?.includes("`! npm login`"));
  });

  it("hints on a timeout that is waiting at a prompt", () => {
    const hint = interactiveCommandHint({
      command: "./deploy.sh",
      exitCode: null,
      timedOut: true,
      output: "Deploying...\nContinue? [y/N] ",
    });
    assert.ok(hint);
  });

  it("stays quiet for ordinary failures and timeouts", () => {
    assert.strictEqual(
      interactiveCommandHint({ ...base, command: "npm test", output: "1 failing\nAssertionError: expected 2" }),
      null,
    );
    assert.strictEqual(
      interactiveCommandHint({ command: "sleep 999", exitCode: null, timedOut: true, output: "" }),
      null,
    );
  });
});

describe("bash tool", () => {
  afterEach(() => enableUserShellCommands(false));

  it("closes stdin so commands waiting for input finish immediately", async () => {
    const start = Date.now();
    const out = await bashTool.run({ command: "read -r line; echo \"got:[$line]\"", timeout_ms: 5000 }, { cwd: "/tmp" });
    const content = typeof out === "string" ? out : out.content;
    assert.ok(Date.now() - start < 4000, "should not wait for the timeout");
    assert.ok(!content.includes("timed out"), content);
  });

  it("appends the `!` hint only when the TUI has enabled user shell commands", async () => {
    const cmd = { command: "echo 'sudo: a terminal is required to read the password' >&2; exit 1" };
    const off = await bashTool.run(cmd, { cwd: "/tmp" });
    assert.ok(!(typeof off === "string" ? off : off.content).includes("[autopilot]"));

    enableUserShellCommands();
    const on = await bashTool.run(cmd, { cwd: "/tmp" });
    assert.ok((typeof on === "string" ? on : on.content).includes("ask the user to run `! echo"));
  });
});
