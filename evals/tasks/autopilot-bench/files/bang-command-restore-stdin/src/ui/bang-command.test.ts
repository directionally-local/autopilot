import { describe, it } from "node:test";
import assert from "node:assert";
import {
  cleanTerminalOutput,
  formatBangContext,
  parseBangCommand,
  scriptInvocation,
  stopReading,
  truncateMiddle,
} from "./bang-command.js";

describe("parseBangCommand", () => {
  it("extracts the command after a leading !", () => {
    assert.strictEqual(parseBangCommand("! gh auth login"), "gh auth login");
    assert.strictEqual(parseBangCommand("!ls -la"), "ls -la");
    assert.strictEqual(parseBangCommand("  !  pwd  "), "pwd");
  });

  it("returns an empty string for a bare !", () => {
    assert.strictEqual(parseBangCommand("!"), "");
  });

  it("ignores input that doesn't start with !", () => {
    assert.strictEqual(parseBangCommand("fix the bug!"), null);
    assert.strictEqual(parseBangCommand("/help"), null);
  });
});

describe("scriptInvocation", () => {
  it("uses BSD argument order on macOS", () => {
    const inv = scriptInvocation("echo hi", "/bin/zsh", "/tmp/x.log", "darwin");
    assert.deepStrictEqual(inv?.args, ["-q", "/tmp/x.log", "/bin/zsh", "-c", "echo hi"]);
  });

  it("uses util-linux flags on Linux and passes the shell via SHELL", () => {
    const inv = scriptInvocation("echo hi", "/bin/bash", "/tmp/x.log", "linux");
    assert.deepStrictEqual(inv?.args, ["-q", "-e", "-c", "echo hi", "/tmp/x.log"]);
    assert.strictEqual(inv?.env?.SHELL, "/bin/bash");
  });

  it("returns null where script(1) isn't available", () => {
    assert.strictEqual(scriptInvocation("dir", "cmd.exe", "x.log", "win32"), null);
  });
});

describe("stopReading", () => {
  it("clears Node's readable-state latch when stopping the TTY handle", () => {
    let readStopped = false;
    const stdin = {
      pause() {},
      _handle: {
        reading: true,
        readStop() {
          readStopped = true;
          return 0;
        },
      },
      _readableState: { reading: true },
    } as unknown as NodeJS.ReadStream;

    stopReading(stdin);

    assert.strictEqual(readStopped, true);
    assert.strictEqual((stdin as unknown as { _handle: { reading: boolean } })._handle.reading, false);
    assert.strictEqual(
      (stdin as unknown as { _readableState: { reading: boolean } })._readableState.reading,
      false,
    );
  });
});

describe("cleanTerminalOutput", () => {
  it("strips colors, OSC titles, and CRLF", () => {
    const raw = "\x1b]0;title\x07\x1b[32m✓ Logged in\x1b[0m as octocat\r\n^D\x08\x08";
    assert.strictEqual(cleanTerminalOutput(raw), "✓ Logged in as octocat");
  });

  it("keeps the last overwrite of a carriage-return progress line", () => {
    assert.strictEqual(cleanTerminalOutput("10%\r50%\r100%\r\ndone"), "100%\ndone");
  });
});

describe("formatBangContext", () => {
  it("frames the output as user-run context with the exit status", () => {
    const text = formatBangContext({ command: "gh auth login", exitCode: 0, signal: null, output: "Logged in" });
    assert.ok(text.includes("ran this shell command themselves"));
    assert.ok(text.includes("$ gh auth login\n(exit code 0)\nLogged in"));
  });

  it("says when output couldn't be captured", () => {
    const text = formatBangContext({ command: "x", exitCode: 1, signal: null, output: null });
    assert.ok(text.includes("could not be captured"));
  });

  it("keeps head and tail of very long output", () => {
    const long = "a".repeat(10_000) + "b".repeat(10_000);
    const t = truncateMiddle(long, 1000);
    assert.ok(t.startsWith("a".repeat(500)));
    assert.ok(t.endsWith("b".repeat(500)));
    assert.ok(t.includes("chars omitted"));
  });
});
