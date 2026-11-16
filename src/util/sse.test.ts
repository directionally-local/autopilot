import { describe, it } from "node:test";
import { getEventListeners } from "node:events";
import assert from "node:assert";
import { readSSE } from "./sse.js";

describe("readSSE", () => {
  it("exits gracefully when signal aborts during pending read", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Abort before enqueueing any data so reader.read() is pending.
        setTimeout(() => controller.abort(), 10);
      },
    });
    const gen = readSSE(stream, controller.signal);
    const result = await gen.next();
    assert.strictEqual(result.done, true);
  });

  it("yields events when stream completes normally", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: hello\n\n"));
        c.close();
      },
    });
    const gen = readSSE(stream);
    const results: string[] = [];
    for await (const ev of gen) {
      results.push(ev);
    }
    assert.deepStrictEqual(results, ["hello"]);
  });

  it("leaves no abort listener behind per chunk read on a long-lived signal", async () => {
    // One signal spans a whole turn; every streamed chunk used to add an
    // abort listener that was never removed (MaxListenersExceededWarning).
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, "abort").length;
    for (let request = 0; request < 20; request++) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 200; i++) c.enqueue(new TextEncoder().encode(`data: ${i}\n\n`));
          c.close();
        },
      });
      let events = 0;
      for await (const _ of readSSE(stream, controller.signal)) events++;
      assert.strictEqual(events, 200);
      assert.strictEqual(getEventListeners(controller.signal, "abort").length, baseline);
    }
  });

  it("removes its listeners when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    const gen = readSSE(stream, controller.signal);
    assert.deepStrictEqual(await gen.next(), { value: "first", done: false });
    setTimeout(() => controller.abort(), 10);
    await gen.next().catch(() => undefined);
    assert.strictEqual(getEventListeners(controller.signal, "abort").length, 0);
  });
});
