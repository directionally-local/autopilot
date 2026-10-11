import { describe, it } from "node:test";
import assert from "node:assert";
import { Writable } from "node:stream";
import { render } from "ink";
import { ChatView, firstUnsettledIndex, isSettled, type ChatEvent } from "./chat.js";
import { activeSpinnerCount } from "./spinner.js";
import { ThemeProvider } from "./theme-context.js";
import { resolveTheme } from "./theme.js";

const theme = resolveTheme();

/** A TTY-like stream that records every write Ink makes. */
function fakeTerminal() {
  const writes: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      writes.push(chunk.toString());
      cb();
    },
  }) as Writable & { columns: number; rows: number; isTTY: boolean };
  stream.columns = 100;
  stream.rows = 40;
  stream.isTTY = true;
  return { stream, writes };
}

/** A long finished transcript: user prompt, assistant reply, finished tool call. */
function history(turns: number): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (let t = 0; t < turns; t++) {
    out.push({ kind: "user", key: `u${t}`, text: `question ${t}: why does the build fail on CI but not locally?` });
    out.push({ kind: "assistant", key: `a${t}`, id: t, reasoning: "", streaming: false,
      text: `Answer ${t}. The CI image pins an older Node, so \`fetch\` is missing.\n\n- upgrade the image\n- or polyfill it` });
    out.push({ kind: "tool", key: `t${t}`, id: `tool${t}`, name: "bash", args: '{"command":"npm test"}', status: "done", result: "ok" } as ChatEvent);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mount(events: ChatEvent[]) {
  const term = fakeTerminal();
  const app = render(
    <ThemeProvider theme={theme}>
      <ChatView events={events} showReasoning={false} />
    </ThemeProvider>,
    { stdout: term.stream as unknown as NodeJS.WriteStream, interactive: true, patchConsole: false, exitOnCtrlC: false },
  );
  return { ...term, app };
}

describe("ChatView settling", () => {
  it("treats streaming assistants and running or queued tools as unsettled", () => {
    const done = history(1);
    assert.ok(done.every(isSettled));
    assert.equal(firstUnsettledIndex(done), done.length);
    const live: ChatEvent[] = [...done, { kind: "assistant", key: "s", id: 99, text: "…", reasoning: "", streaming: true }];
    assert.equal(firstUnsettledIndex(live), done.length);
  });

  it("keeps pending info events live until they can be replaced with a result", () => {
    const done = history(1);
    const pending: ChatEvent = { kind: "info", key: "jev", text: "Jev is evaluating…", pending: true };
    assert.equal(isSettled(pending), false);
    assert.equal(firstUnsettledIndex([...done, pending]), done.length);

    const result: ChatEvent = { kind: "jev", key: "jev", result: "Yes", tone: "yes", receipt: "question only" };
    assert.equal(isSettled(result), true);
    assert.equal(firstUnsettledIndex([...done, result]), done.length + 1);
  });
});

describe("ChatView idle cost", () => {
  it("writes nothing while idle, however long the transcript", async () => {
    const { writes, app } = mount(history(2000));
    await sleep(400);
    const before = writes.length;
    await sleep(1200);
    assert.equal(writes.length - before, 0, "idle UI must not write to the terminal");
    assert.equal(activeSpinnerCount(), 0, "idle UI must not run an animation clock");
    app.unmount();
  });

  it("animates a streaming reply without re-printing the history", async () => {
    const events: ChatEvent[] = [
      ...history(2000),
      { kind: "assistant", key: "live", id: 9999, text: "Working on it", reasoning: "", streaming: true },
    ];
    const { writes, app } = mount(events);
    await sleep(400);
    const before = writes.length;
    await sleep(1000);
    const frames = writes.slice(before);
    app.unmount();
    assert.ok(frames.length > 0, "the spinner should animate");
    const biggest = Math.max(...frames.map((f) => f.length));
    assert.ok(biggest < 2_000, `each frame should only redraw the live tail, got ${biggest} bytes`);
    assert.equal(activeSpinnerCount(), 0, "unmounting must stop the animation clock");
  });
});
