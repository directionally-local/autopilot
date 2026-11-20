import { describe, it } from "node:test";
import assert from "node:assert";
import { createReasoningStripGate, stripHistoricalReasoning } from "./strip-reasoning.js";
import { PROVIDER_PRESETS } from "../providers/presets.js";
import type { ChatMessage } from "./messages.js";

describe("STRIP_REASONING env gate", () => {
  it("warns once and ignores STRIP_REASONING=1 on echoing presets without refusing", () => {
    const gate = createReasoningStripGate();
    const warnings: string[] = [];
    const messages: ChatMessage[] = [{
      role: "assistant", content: "narration", reasoning_content: "required echo",
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
    }];
    for (const preset of [PROVIDER_PRESETS["directionally-local"], PROVIDER_PRESETS.deepseek]) {
      for (let request = 0; request < 2; request++) {
        const strip = gate(preset.compat, (w) => warnings.push(w), { STRIP_REASONING: "1" });
        assert.strictEqual(strip, false, "ignore the opt-in, do not refuse or strip");
        const sent = strip ? stripHistoricalReasoning(messages, { keepLast: 0 }) : messages;
        assert.strictEqual(sent, messages, "ignoring the env var leaves history untouched");
        assert.strictEqual(sent[0]!.reasoning_content, "required echo");
        assert.strictEqual(sent[0]!.content, "narration");
      }
    }
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /STRIP_REASONING=1.*ignored.*requires reasoning_content/);
  });

  it("honors the opt-in on non-echoing presets and supports both prefixed spellings", () => {
    const gate = createReasoningStripGate();
    const warnings: string[] = [];
    const warn = (w: string) => warnings.push(w);
    for (const env of [{ STRIP_REASONING: "1" }, { AUTOPILOT_STRIP_REASONING: "1" }, { KIMIFLARE_STRIP_REASONING: "1" }]) {
      assert.strictEqual(gate(PROVIDER_PRESETS.openai.compat, warn, env), true);
      assert.strictEqual(gate(PROVIDER_PRESETS.deepseek.compat, warn, env), false);
    }
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(gate(PROVIDER_PRESETS.openai.compat, warn, {}), false);
    assert.strictEqual(gate(PROVIDER_PRESETS.deepseek.compat, warn, { STRIP_REASONING: "0" }), false);
    assert.strictEqual(gate(PROVIDER_PRESETS.openai.compat, warn, {
      AUTOPILOT_STRIP_REASONING: "0", KIMIFLARE_STRIP_REASONING: "1", STRIP_REASONING: "1",
    }), false, "current prefix retains precedence");
  });
});

describe("stripHistoricalReasoning", () => {
  it("leaves system and user messages untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    const out = stripHistoricalReasoning(messages);
    assert.deepStrictEqual(out, messages);
  });

  it("preserves reasoning on the most recent assistant message by default", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "old",
        reasoning_content: "old reasoning",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "result", tool_call_id: "tc1" },
      {
        role: "assistant",
        content: "new",
        reasoning_content: "new reasoning",
      },
    ];
    const out = stripHistoricalReasoning(messages);
    assert.strictEqual(out[0]!.reasoning_content, "old reasoning");
    assert.strictEqual(out[0]!.content, "");
    assert.strictEqual(out[2]!.reasoning_content, "new reasoning");
    assert.strictEqual(out[2]!.content, "new");
  });

  it("strips reasoning from all assistant messages when keepLast=0", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "a",
        reasoning_content: "r1",
      },
      {
        role: "assistant",
        content: "b",
        reasoning_content: "r2",
      },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    assert.strictEqual(out[0]!.reasoning_content, undefined);
    assert.strictEqual(out[1]!.reasoning_content, undefined);
  });

  it("preserves text-only messages when text is substantive (>200 chars)", () => {
    const longText = "x".repeat(201);
    const messages: ChatMessage[] = [
      { role: "assistant", content: longText, reasoning_content: "reason" },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    assert.strictEqual(out[0]!.content, longText);
    assert.strictEqual(out[0]!.reasoning_content, undefined);
  });

  it("strips text-only messages when text is short (≤200 chars)", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "short", reasoning_content: "reason" },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    assert.strictEqual(out[0]!.content, "");
    assert.strictEqual(out[0]!.reasoning_content, undefined);
  });

  it("strips text but preserves multiple tool_calls", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Let me check",
        reasoning_content: "plan",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
          { id: "tc2", type: "function", function: { name: "grep", arguments: "{}" } },
        ],
      },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    assert.strictEqual(out[0]!.content, "");
    assert.strictEqual(out[0]!.reasoning_content, "plan");
    assert.strictEqual(out[0]!.tool_calls!.length, 2);
  });

  it("keeps reasoning_content on tool-call turns with keepLast=0, strips narration text", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "Let me check",
        reasoning_content: "plan",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    assert.strictEqual(out[0]!.reasoning_content, "plan");
    assert.strictEqual(out[0]!.content, "");
  });

  it("handles array content correctly", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "narration" },
          { type: "image_url", image_url: { url: "http://example.com/img.png" } },
        ],
        reasoning_content: "plan",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 0 });
    const content = out[0]!.content as Array<{ type: string; text?: string }>;
    assert.strictEqual(content[0]!.text, "");
    assert.strictEqual(content[1]!.type, "image_url");
    assert.strictEqual(out[0]!.reasoning_content, "plan");
  });

  it("does not modify tool messages", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "result", tool_call_id: "tc1" },
    ];
    const out = stripHistoricalReasoning(messages);
    assert.deepStrictEqual(out, messages);
  });

  it("preserves the last N assistant messages based on keepLast", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "first", reasoning_content: "r1" },
      { role: "assistant", content: "second", reasoning_content: "r2" },
      { role: "assistant", content: "third", reasoning_content: "r3" },
    ];
    const out = stripHistoricalReasoning(messages, { keepLast: 2 });
    assert.strictEqual(out[0]!.reasoning_content, undefined);
    assert.strictEqual(out[1]!.reasoning_content, "r2");
    assert.strictEqual(out[2]!.reasoning_content, "r3");
  });
});
