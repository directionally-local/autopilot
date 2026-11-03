import { describe, it } from "node:test";
import assert from "node:assert";
import type { ChatMessage } from "../agent/messages.js";
import { buildResumeReplay, formatWhen, trimStart } from "./resume-replay.js";
import { resumeReplayEvents } from "./use-session-manager.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string | null, toolCall = false): ChatMessage =>
  ({ role: "assistant", content, ...(toolCall ? { tool_calls: [{ id: "t", type: "function", function: { name: "bash", arguments: "{}" } }] } : {}) }) as ChatMessage;
const tool = (): ChatMessage => ({ role: "tool", tool_call_id: "t", content: "ok" }) as ChatMessage;

const NOW = Date.parse("2026-11-03T10:00:00.000Z");

describe("resume replay", () => {
  it("shows each request with the start of its final answer, then where it continues", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "you are autopilot" },
      user("explain what this project does and how it's tested"),
      assistant("Let me look around.", true),
      tool(),
      assistant("slugify turns a string into a URL-safe slug.\nIt is tested with node:test."),
      { role: "system", content: "[session resume summary]\nGoal: …" },
      user("In one sentence, what did I ask you before?"),
      assistant("You asked me to explain what this project does and how it's tested."),
    ];
    const r = buildResumeReplay({ messages, title: "Explain slugify", updatedAt: "2026-11-03T09:20:00.000Z" }, { now: NOW, timeZone: "UTC" });
    assert.deepStrictEqual(r.exchanges, [
      { user: "explain what this project does and how it's tested", answer: "slugify turns a string into a URL-safe slug.\nIt is tested with node:test." },
      { user: "In one sentence, what did I ask you before?", answer: "You asked me to explain what this project does and how it's tested." },
    ]);
    assert.strictEqual(r.line, "Continuing “Explain slugify” from today at 09:20");
  });

  it("keeps only the last three requests and says how many there were", () => {
    const messages = [1, 2, 3, 4, 5].flatMap((n) => [user(`q${n}`), assistant(`a${n}`)]);
    const events = resumeReplayEvents({ messages, updatedAt: "2026-11-02T09:00:00.000Z" }, (() => {
      let k = 0;
      return () => `k${k++}`;
    })(), undefined, { now: NOW, timeZone: "UTC" });
    assert.deepStrictEqual(
      events.map((e) => [e.kind, "text" in e ? e.text : ""]),
      [
        ["info", "Last 3 of 5 requests in this conversation:"],
        ["user", "q3"],
        ["assistant", "a3"],
        ["user", "q4"],
        ["assistant", "a4"],
        ["user", "q5"],
        ["assistant", "a5"],
        ["info", "Continuing “q1” from yesterday at 09:00"],
      ],
    );
    assert.ok(events.every((e) => e.kind !== "assistant" || e.streaming === false));
  });

  it("trims long requests and answers at the start, and handles a request with no reply", () => {
    const long = `${"word ".repeat(200)}end`;
    const r = buildResumeReplay({ messages: [user(long), assistant(null, true), tool()], updatedAt: "2026-10-01T09:00:00.000Z" }, { now: NOW, timeZone: "UTC" });
    assert.ok(r.exchanges[0]!.user.endsWith(" …") && r.exchanges[0]!.user.length <= 302);
    assert.strictEqual(r.exchanges[0]!.answer, "");
    assert.strictEqual(trimStart("a\nb\nc", 100, 2), "a\nb …");
    assert.strictEqual(formatWhen("2026-10-01T09:00:00.000Z", NOW, "UTC"), "Oct 1 at 09:00");
  });

  it("makes no model call: it is built from the saved messages alone", () => {
    // buildResumeReplay is synchronous and takes no credentials.
    const r = buildResumeReplay({ messages: [], updatedAt: "bad" }, { now: NOW });
    assert.deepStrictEqual(r.exchanges, []);
    assert.strictEqual(r.line, "Continuing “this conversation” from earlier");
  });
});
