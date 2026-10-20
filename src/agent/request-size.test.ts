import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { formatBytes, largeBodyWarning, largestBodyParts, LARGE_BODY_BYTES, shouldWarnLargeBody } from "./request-size.js";
import { runKimi } from "./client.js";
import { createMemoryRecorder } from "../trace/recorder.js";
import type { ChatMessage } from "./messages.js";

const bigImage = `data:image/png;base64,${"A".repeat(900_000)}`;
const history: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: bigImage } }, { type: "image_url", image_url: { url: bigImage } }] },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "x".repeat(300_000) },
];

describe("request size", () => {
  it("names the biggest parts: images together, tool results by tool", () => {
    const parts = largestBodyParts(history);
    assert.deepStrictEqual(parts.map((p) => p.label), ["2 images", "read result", "user message"]);
    assert.ok(parts[0]!.bytes > 1_800_000);
  });

  it("formats sizes and the warning", () => {
    assert.strictEqual(formatBytes(1536), "2 KB");
    assert.strictEqual(formatBytes(1_900_000), "1.8 MB");
    const w = largeBodyWarning(2_200_000, largestBodyParts(history, 2));
    assert.match(w, /this request is 2\.1 MB \(largest parts: 2 images 1\.7 MB, read result 293 KB\)/);
    assert.match(w, /\/compact or \/fresh/);
  });

  it("warns once per session, only above the threshold", () => {
    assert.strictEqual(shouldWarnLargeBody("s1", LARGE_BODY_BYTES - 1), false);
    assert.strictEqual(shouldWarnLargeBody("s1", LARGE_BODY_BYTES + 1), true);
    assert.strictEqual(shouldWarnLargeBody("s1", LARGE_BODY_BYTES * 3), false);
    assert.strictEqual(shouldWarnLargeBody("s2", LARGE_BODY_BYTES * 3), true);
  });
});

describe("runKimi: body size and timing", () => {
  let originalFetch: typeof globalThis.fetch;
  let sentBytes = 0;
  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBytes = Buffer.byteLength(String(init?.body ?? ""), "utf8");
      await new Promise((r) => setTimeout(r, 15));
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  });
  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("records body_bytes, headers_ms and first_token_ms, and warns once about a large body", async () => {
    const trace = createMemoryRecorder();
    const warnings: string[] = [];
    for (let i = 0; i < 2; i++) {
      for await (const _ of runKimi({
        openrouterApiKey: "sk-or-test",
        model: "moonshotai/kimi-k2.6",
        messages: history,
        trace,
        sessionId: "size-test",
        onLargeBody: (w) => warnings.push(w),
      })) {
        /* drain */
      }
    }
    const req = trace.ofType("llm_request")[0]!.payload;
    assert.strictEqual(req.body_bytes, sentBytes);
    assert.ok(sentBytes > LARGE_BODY_BYTES);
    const res = trace.ofType("llm_response")[0]!.payload;
    assert.ok((res.headers_ms ?? -1) >= 10, `headers_ms ${res.headers_ms}`);
    assert.ok((res.first_token_ms ?? -1) >= (res.headers_ms ?? 0));
    assert.strictEqual(warnings.length, 1, "warned once for the session");
    assert.match(warnings[0]!, /2 images/);
  });
});
