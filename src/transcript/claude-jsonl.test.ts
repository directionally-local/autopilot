import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ClaudeTranscript,
  claudeTranscriptPath,
  claudeUsage,
  hookTranscriptFields,
  resetTranscripts,
  sessionTranscript,
} from "./claude-jsonl.js";
import { runAgentTurn } from "../agent/loop.js";
import type { ChatMessage } from "../agent/messages.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { hookWirePayload } from "../hooks/runner.js";

type Line = Record<string, any>;

function readLines(path: string): Line[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Line);
}

describe("Claude JSONL transcript", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcript-"));
    resetTranscripts();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetTranscripts();
  });

  it("appends one complete line per entry, readable after every write", () => {
    const t = new ClaudeTranscript("s1", "/repo", { dir });
    assert.equal(t.path, join(dir, "s1.jsonl"));
    assert.equal(existsSync(t.path), false, "nothing on disk before the first entry");

    t.appendUser({ role: "user", content: "fix the bug" });
    let lines = readLines(t.path);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.type, "user");
    assert.deepEqual(lines[0]!.message, { role: "user", content: "fix the bug" });
    assert.equal(lines[0]!.parentUuid, null);
    assert.equal(lines[0]!.sessionId, "s1");
    assert.equal(lines[0]!.cwd, "/repo");
    assert.equal(typeof lines[0]!.uuid, "string");
    assert.ok(!Number.isNaN(Date.parse(lines[0]!.timestamp)));
    assert.equal(typeof lines[0]!.promptId, "string");

    t.appendAssistant(
      { role: "assistant", content: "done" },
      { model: "test/model", usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, prompt_tokens_details: { cached_tokens: 100 } }, responseId: "gen-1" },
    );
    lines = readLines(t.path);
    assert.equal(lines.length, 2);
    const a = lines[1]!;
    assert.equal(a.type, "assistant");
    assert.equal(a.parentUuid, lines[0]!.uuid);
    assert.equal(a.requestId, "gen-1");
    assert.equal(a.message.id, "gen-1");
    assert.equal(a.message.role, "assistant");
    assert.equal(a.message.model, "test/model");
    assert.deepEqual(a.message.content, [{ type: "text", text: "done" }]);
    assert.equal(a.message.stop_reason, "end_turn");
    assert.deepEqual(a.message.usage, { input_tokens: 20, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 });
  });

  it("pairs tool_use blocks with tool_result entries, under Claude Code's tool names", () => {
    const t = new ClaudeTranscript("s2", "/repo", { dir });
    t.appendUser({ role: "user", content: "list files" });
    const assistantUuid = t.appendAssistant({
      role: "assistant",
      content: null,
      reasoning_content: "I should list them",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } },
        { id: "call_2", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "src/a.ts" }) } },
      ],
    });
    t.appendToolResult({ tool_call_id: "call_1", content: "a.ts\nb.ts", ok: true });
    t.appendToolResult({ tool_call_id: "call_2", content: "ENOENT", ok: false });

    const [user, assistant, r1, r2] = readLines(t.path);
    assert.deepEqual(assistant!.message.content, [
      { type: "thinking", thinking: "I should list them" },
      { type: "tool_use", id: "call_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "call_2", name: "Read", input: { file_path: "/repo/src/a.ts" } },
    ]);
    assert.equal(assistant!.message.stop_reason, "tool_use");
    for (const [r, id, text, isError] of [[r1, "call_1", "a.ts\nb.ts", false], [r2, "call_2", "ENOENT", true]] as const) {
      assert.equal(r!.type, "user");
      assert.equal(r!.message.role, "user");
      assert.deepEqual(r!.message.content, [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }]);
      assert.equal(r!.sourceToolAssistantUUID, assistantUuid);
      assert.equal(r!.promptId, user!.promptId, "tool results carry the prompt's id, as Claude Code's do");
    }
    assert.equal(r1!.parentUuid, assistant!.uuid);
    assert.equal(r2!.parentUuid, r1!.uuid);
  });

  it("redacts what the session trace redacts", () => {
    const t = new ClaudeTranscript("s3", "/repo", { dir });
    t.appendUser({ role: "user", content: "use api_key=abc123 and sk-or-v1-deadbeef" });
    t.appendAssistant({
      role: "assistant",
      content: "Authorization: Bearer tok.en-1",
      tool_calls: [{ id: "c", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "curl -H 'token: ghp_secret1'" }) } }],
    });
    t.appendToolResult({ tool_call_id: "c", content: "-----BEGIN RSA PRIVATE KEY-----\nxyz\n-----END RSA PRIVATE KEY-----", ok: true });
    const raw = readFileSync(t.path, "utf8");
    for (const secret of ["abc123", "deadbeef", "tok.en-1", "ghp_secret1", "xyz"]) assert.ok(!raw.includes(secret), `${secret} leaked`);
    assert.ok(raw.includes("<redacted>"));
    assert.ok(raw.includes("<redacted-key>"));
    readLines(t.path); // still valid JSON per line
  });

  it("cuts giant blocks like the trace blob store and stops at the session cap", () => {
    const t = new ClaudeTranscript("s4", "/repo", { dir, maxBlockBytes: 100, maxSessionBytes: 4000 });
    t.appendUser({ role: "user", content: "x" });
    t.appendToolResult({ tool_call_id: "c", content: "y".repeat(5000), ok: true });
    const result = readLines(t.path)[1]!;
    const content = result.message.content[0].content as string;
    assert.equal(content, `${"y".repeat(100)}\n[truncated: 5000 bytes total]`);
    for (let i = 0; i < 50; i++) t.appendUser({ role: "user", content: `prompt ${i}` });
    assert.equal(t.active, false);
    assert.ok(readFileSync(t.path, "utf8").length <= 4000);
    readLines(t.path);
  });

  it("continues the parentUuid chain when a session is reopened (resume, new process)", () => {
    const first = new ClaudeTranscript("s5", "/repo", { dir });
    first.appendUser({ role: "user", content: "one" });
    const lastUuid = first.appendAssistant({ role: "assistant", content: "ok" });
    const second = new ClaudeTranscript("s5", "/repo", { dir });
    second.appendUser({ role: "user", content: "two" });
    const lines = readLines(second.path);
    assert.equal(lines.length, 3);
    assert.equal(lines[2]!.parentUuid, lastUuid);
  });

  it("writes image parts as a placeholder, never base64, and marks automatic notices isMeta", () => {
    const t = new ClaudeTranscript("s6", "/repo", { dir });
    t.appendUser({ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] });
    t.appendUser({ role: "user", content: "[Automatic notice — not typed by the user] done" }, { meta: true });
    const [img, notice] = readLines(t.path);
    assert.deepEqual(img!.message.content, [{ type: "text", text: "what is this" }, { type: "text", text: "[Image]" }]);
    assert.equal(notice!.isMeta, true);
    assert.equal(notice!.promptId, undefined);
  });

  it("is keyed by session, and off with KIMIFLARE_TRANSCRIPT=0", () => {
    const a = sessionTranscript("s7", "/repo", { dir });
    assert.ok(a);
    assert.equal(sessionTranscript("s7", "/repo", { dir }), a);
    assert.equal(sessionTranscript(undefined, "/repo", { dir }), null);
    const prev = process.env.KIMIFLARE_TRANSCRIPT;
    process.env.KIMIFLARE_TRANSCRIPT = "0";
    try {
      assert.equal(sessionTranscript("s8", "/repo", { dir }), null);
      assert.deepEqual(hookTranscriptFields("s8").transcript_format, "autopilot-json");
      assert.match(hookTranscriptFields("s8").transcript_path, /s8\.json$/);
    } finally {
      if (prev === undefined) delete process.env.KIMIFLARE_TRANSCRIPT;
      else process.env.KIMIFLARE_TRANSCRIPT = prev;
    }
  });

  it("maps OpenAI-style usage to Anthropic's field names", () => {
    assert.deepEqual(
      claudeUsage({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } }),
      { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 600, cache_creation_input_tokens: 300 },
    );
  });
});

describe("agent loop writes the transcript that hook payloads point at", () => {
  let dir: string;
  let originalFetch: typeof globalThis.fetch;
  let prevXdg: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "transcript-loop-"));
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dir;
    originalFetch = globalThis.fetch;
    resetTranscripts();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    // The temp dir is left in place: the loop's fire-and-forget debug log
    // may still write under it after the turn resolves.
    resetTranscripts();
  });

  function sse(events: unknown[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("prompt, tool_use, tool_result and the final reply, each on disk before the next step runs", async () => {
    const sessionId = "loop-session";
    const path = hookWirePayload({ event: "Stop", session_id: sessionId, cwd: "/repo" } as never).transcript_path as string;
    assert.equal(path, claudeTranscriptPath(sessionId));

    let requests = 0;
    const seenAtRequest: number[] = [];
    globalThis.fetch = async () => {
      seenAtRequest.push(existsSync(path) ? readLines(path).length : 0);
      requests++;
      if (requests === 1) {
        return sse([
          { choices: [{ delta: { content: "Listing." } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) } }] } }] },
          { choices: [{ finish_reason: "tool_calls" }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
        ]);
      }
      return sse([
        { choices: [{ delta: { content: "There are two files." } }] },
        { choices: [{ finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 150, completion_tokens: 6, total_tokens: 156 } },
      ]);
    };
    const tool: ToolSpec = {
      name: "bash",
      description: "Run a command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      needsPermission: false,
      run: async () => "unused",
    };
    let linesWhenToolRan = -1;
    const executor = {
      list: () => [tool],
      run: async (call: { id: string; name: string }) => {
        linesWhenToolRan = readLines(path).length;
        return { tool_call_id: call.id, name: call.name, ok: true, content: "a.ts\nb.ts" };
      },
    } as unknown as ToolExecutor;
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "what files are here?" },
    ];
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [tool],
      executor,
      cwd: "/repo",
      sessionId,
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });

    assert.deepEqual(seenAtRequest, [1, 3], "prompt before the first request; assistant + tool_result before the second");
    assert.equal(linesWhenToolRan, 2, "the tool_use entry is on disk while the tool runs");
    const lines = readLines(path);
    assert.deepEqual(lines.map((l) => l.type), ["user", "assistant", "user", "assistant"]);
    assert.equal(lines[0]!.message.content, "what files are here?");
    assert.deepEqual(lines[1]!.message.content, [
      { type: "text", text: "Listing." },
      { type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } },
    ]);
    assert.deepEqual(lines[1]!.message.usage, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(lines[1]!.message.model, "test/model");
    assert.deepEqual(lines[2]!.message.content, [{ type: "tool_result", tool_use_id: "call-1", content: "a.ts\nb.ts", is_error: false }]);
    assert.deepEqual(lines[3]!.message.content, [{ type: "text", text: "There are two files." }]);
    assert.equal(lines[3]!.message.usage.output_tokens, 6);
    for (let i = 1; i < lines.length; i++) assert.equal(lines[i]!.parentUuid, lines[i - 1]!.uuid);
    assert.ok(lines.every((l) => l.sessionId === sessionId && l.cwd === "/repo"));

    // A second turn in the same session continues the chain and does not rewrite history.
    messages.push({ role: "user", content: "thanks" });
    requests = 1;
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [tool],
      executor,
      cwd: "/repo",
      sessionId,
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });
    const after = readLines(path);
    assert.equal(after.length, 6);
    assert.equal(after[4]!.message.content, "thanks");
    assert.equal(after[4]!.parentUuid, lines[3]!.uuid);
    assert.notEqual(after[4]!.promptId, lines[0]!.promptId);
  });
});
