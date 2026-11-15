import { describe, it } from "node:test";
import assert from "node:assert";
import { EventEmitter } from "node:events";
import { isCancelKey, readKeyWithoutInput, screenWithoutInput, waitWithoutInput } from "./terminal-wait.js";

function fakeIo(tty = true) {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: tty,
    isRaw: false,
    setRawMode(v: boolean) {
      this.isRaw = v;
      return this;
    },
    resume() {
      return this;
    },
    pause() {
      return this;
    },
  });
  const written: string[] = [];
  const stdout = { isTTY: tty, write: (s: string) => (written.push(s), true) };
  return { io: { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream }, stdin, written };
}

describe("waitWithoutInput", () => {
  it("recognises Esc and Ctrl+C, raw or kitty-encoded, and nothing else", () => {
    for (const k of ["\x1b", "\x03", "\x1b[27u", "\x1b[27;1u", "\x1b[99;5u"]) assert.ok(isCancelKey(k), JSON.stringify(k));
    for (const k of ["a", "\r", "\x1b[A", "\x1b[13u"]) assert.ok(!isCancelKey(k), JSON.stringify(k));
  });

  it("lends the terminal, draws the line, cancels on Esc, and gives it back", async () => {
    const { io, stdin, written } = fakeIo();
    const calls: string[] = [];
    let cancelled = 0;
    const end = await waitWithoutInput("Waiting… Esc to cancel", () => cancelled++, {
      suspend: async () => (calls.push("suspend"), true),
      resume: () => calls.push("resume"),
    }, io);
    assert.ok(end);
    assert.ok(stdin.isRaw);
    assert.ok(written.join("").includes("Waiting… Esc to cancel"));
    stdin.emit("data", Buffer.from("x"));
    assert.strictEqual(cancelled, 0);
    stdin.emit("data", Buffer.from("\x1b"));
    assert.strictEqual(cancelled, 1);
    end!();
    end!();
    assert.deepStrictEqual(calls, ["suspend", "resume"]);
    assert.strictEqual(stdin.isRaw, false);
    assert.strictEqual(stdin.listenerCount("data"), 0);
  });

  it("returns null without a terminal or when the renderer can't lend it", async () => {
    const lender = { suspend: async () => true, resume: () => undefined };
    assert.strictEqual(await waitWithoutInput("w", () => undefined, lender, fakeIo(false).io), null);
    assert.strictEqual(await waitWithoutInput("w", () => undefined, { suspend: async () => false, resume: () => undefined }, fakeIo().io), null);
  });
});

describe("readKeyWithoutInput", () => {
  it("draws the line, resolves with the first key, then erases it and gives the terminal back", async () => {
    const { io, stdin, written } = fakeIo();
    const calls: string[] = [];
    const pending = readKeyWithoutInput("Star it? (press s to star · any other key to dismiss)", {
      suspend: async () => (calls.push("suspend"), true),
      resume: () => calls.push("resume"),
    }, io);
    await new Promise((r) => setImmediate(r));
    assert.ok(written.join("").includes("press s to star"));
    assert.ok(stdin.isRaw);
    stdin.emit("data", Buffer.from("s"));
    assert.strictEqual(await pending, "s");
    assert.deepStrictEqual(calls, ["suspend", "resume"]);
    assert.strictEqual(stdin.isRaw, false);
    assert.strictEqual(stdin.listenerCount("data"), 0);
  });

  it("returns null without a terminal or when the renderer can't lend it", async () => {
    assert.strictEqual(await readKeyWithoutInput("l", { suspend: async () => true, resume: () => undefined }, fakeIo(false).io), null);
    assert.strictEqual(await readKeyWithoutInput("l", { suspend: async () => false, resume: () => undefined }, fakeIo().io), null);
  });
});

describe("textRows", () => {
  it("counts the rows wrapped lines take", async () => {
    const { textRows } = await import("./terminal-wait.js");
    assert.strictEqual(textRows("abc", 80), 1);
    assert.strictEqual(textRows("x".repeat(80), 80), 1);
    assert.strictEqual(textRows(`${"x".repeat(81)}\nwaiting`, 80), 3);
    assert.strictEqual(textRows("\n", 80), 2);
  });
});

describe("screenWithoutInput", () => {
  it("redraws over the last screen on each key, then erases it and gives the terminal back", async () => {
    const { io, stdin, written } = fakeIo();
    (io.stdout as unknown as { columns: number }).columns = 80;
    const calls: string[] = [];
    let page = 0;
    const done = screenWithoutInput(
      () => `\x1b[1mpage ${page}\x1b[22m\nbody\n\nfooter`,
      (k) => {
        if (k === "q") return true;
        page++;
        return false;
      },
      { suspend: async () => (calls.push("suspend"), true), resume: () => calls.push("resume") },
      io,
    );
    await new Promise((r) => setImmediate(r));
    assert.ok(written.join("").includes("page 0"));
    stdin.emit("data", Buffer.from("l"));
    // Four rows drawn (styling takes no columns): up three, clear, draw the next page.
    assert.ok(written.at(-1)!.startsWith("\r\x1b[3A\x1b[J"), JSON.stringify(written.at(-1)));
    assert.ok(written.at(-1)!.includes("page 1"));
    stdin.emit("data", Buffer.from("q"));
    assert.strictEqual(await done, true);
    assert.strictEqual(written.at(-1), "\r\x1b[3A\x1b[J", "erased: nothing is left printed");
    assert.deepStrictEqual(calls, ["suspend", "resume"]);
    assert.strictEqual(stdin.listenerCount("data"), 0);
  });

  it("is false when the terminal can't be lent", async () => {
    assert.strictEqual(await screenWithoutInput(() => "x", () => true, { suspend: async () => true, resume: () => undefined }, fakeIo(false).io), false);
  });
});
