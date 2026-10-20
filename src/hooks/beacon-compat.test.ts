import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { hookWirePayload } from "./runner.js";
import { endSession, endSessions, noteSessionStart, resetSessionLifecycleForTesting } from "./session-lifecycle.js";
import type { HooksManager } from "./manager.js";
import type { HookEvent, HookPayload, PostToolUsePayload } from "./types.js";
import { lastAssistantMessage } from "../agent/loop.js";
import { initOtelSink, flushOtelSink, resetOtelSinkForTesting, setFetchForTesting } from "../util/otel-sink.js";
import { emitOtelEvent, withOtelEvents } from "../util/otel-events.js";

describe("hook payloads speak Claude Code's field names too (#871)", () => {
  it("PostToolUse carries hook_event_name, tool_name, tool_input, tool_response, tool_call_id, transcript_path", () => {
    const wire = hookWirePayload({
      event: "PostToolUse",
      session_id: "s1",
      cwd: "/repo",
      tool: "bash",
      tool_call_id: "call_1",
      args: { command: "ls" },
      result: { ok: true, content: "exit=0\n--- stdout ---\na\nb", exitCode: 0, stdout: "a\nb\n", stderr: "", interrupted: false },
    });
    assert.strictEqual(wire.hook_event_name, "PostToolUse");
    assert.strictEqual(wire.tool_name, "Bash");
    assert.deepStrictEqual(wire.tool_input, { command: "ls" });
    assert.strictEqual(wire.tool_call_id, "call_1");
    assert.match(String(wire.transcript_path), /sessions\/s1\.jsonl$/);
    assert.equal(wire.transcript_format, "claude-jsonl");
    // Autopilot's own fields stay for existing hooks.
    assert.strictEqual(wire.event, "PostToolUse");
    assert.strictEqual(wire.tool, "bash");
    assert.strictEqual(wire.autopilot_tool_name, "bash");
    assert.strictEqual(wire.client, "autopilot");
    assert.strictEqual(wire["beacon.harness.name"], "autopilot");
    assert.ok(!("error" in wire));
  });

  it("non-tool events get hook_event_name but no tool fields", () => {
    const wire = hookWirePayload({ event: "UserPromptSubmit", session_id: null, cwd: "/r", prompt: "hi" });
    assert.strictEqual(wire.hook_event_name, "UserPromptSubmit");
    assert.strictEqual(wire.prompt, "hi");
    assert.strictEqual(wire["beacon.harness.name"], "autopilot");
    assert.ok(!("tool_name" in wire) && !("transcript_path" in wire));
  });
});

describe("Claude Code tool names and input shapes (#877)", () => {
  const pre = (tool: string, args: Record<string, unknown>) =>
    hookWirePayload({ event: "PreToolUse", session_id: "s", cwd: "/repo", tool, args });

  it("maps Autopilot's tools onto Claude Code's names; unknown tools keep theirs", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["bash", { command: "ls" }, "Bash"],
      ["edit", { path: "a.ts", old_string: "a", new_string: "b" }, "Edit"],
      ["edit", { path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] }, "MultiEdit"],
      ["write", { path: "a.ts", content: "x" }, "Write"],
      ["read", { path: "a.ts" }, "Read"],
      ["glob", { pattern: "**/*.ts" }, "Glob"],
      ["grep", { pattern: "foo" }, "Grep"],
      ["web_fetch", { url: "https://example.com" }, "WebFetch"],
      ["search_web", { query: "q" }, "WebSearch"],
      ["memory_recall", { query: "q" }, "memory_recall"],
      ["mcp_github_list", { a: 1 }, "mcp_github_list"],
    ];
    for (const [tool, args, name] of cases) {
      const wire = pre(tool, args);
      assert.strictEqual(wire.tool_name, name, tool);
      assert.strictEqual(wire.autopilot_tool_name, tool);
      assert.strictEqual(wire.tool, tool);
      assert.deepStrictEqual(wire.args, args);
    }
    assert.deepStrictEqual(pre("memory_recall", { query: "q" }).tool_input, { query: "q" });
  });

  it("uses Claude Code's field names, with absolute file paths", () => {
    assert.deepStrictEqual(pre("write", { path: "src/a.ts", content: "x" }).tool_input, { file_path: "/repo/src/a.ts", content: "x" });
    assert.deepStrictEqual(pre("read", { path: "/abs/a.ts", offset: 3, limit: 10 }).tool_input, { file_path: "/abs/a.ts", offset: 3, limit: 10 });
    assert.deepStrictEqual(pre("edit", { path: "a.ts", old_string: "a", new_string: "b", replace_all: true }).tool_input, {
      file_path: "/repo/a.ts",
      old_string: "a",
      new_string: "b",
      replace_all: true,
    });
    assert.deepStrictEqual(pre("bash", { command: "ls", timeout_ms: 5000 }).tool_input, { command: "ls", timeout: 5000 });
    assert.deepStrictEqual(pre("grep", { pattern: "x", path: "src", case_insensitive: true, output_mode: "files" }).tool_input, {
      pattern: "x",
      path: "/repo/src",
      "-i": true,
      output_mode: "files_with_matches",
    });
  });

  it("a multi-replacement edit becomes MultiEdit with every pair in edits[], single pair first", () => {
    const wire = pre("edit", {
      path: "a.ts",
      old_string: "one",
      new_string: "1",
      edits: [{ old_string: "two", new_string: "2", replace_all: true }, { old_string: "three", new_string: "3" }],
    });
    assert.strictEqual(wire.tool_name, "MultiEdit");
    assert.deepStrictEqual(wire.tool_input, {
      file_path: "/repo/a.ts",
      edits: [
        { old_string: "one", new_string: "1" },
        { old_string: "two", new_string: "2", replace_all: true },
        { old_string: "three", new_string: "3" },
      ],
    });
  });
});

describe("tool_response and failure shape (#877)", () => {
  const post = (tool: string, args: Record<string, unknown>, result: PostToolUsePayload["result"]) =>
    hookWirePayload({ event: "PostToolUse", session_id: "s", cwd: "/repo", tool, args, result });

  it("bash reports stdout, stderr, exit_code and interrupted next to ok/content", () => {
    const wire = post("bash", { command: "echo hi" }, { ok: true, content: "exit=0", exitCode: 0, stdout: "hi\n", stderr: "warn\n", interrupted: false });
    assert.deepStrictEqual(wire.tool_response, {
      ok: true,
      content: "exit=0",
      success: true,
      is_error: false,
      stdout: "hi\n",
      stderr: "warn\n",
      exit_code: 0,
      interrupted: false,
    });
    assert.ok(!("error" in wire));
  });

  it("a non-zero exit is a failure, with Claude Code's `Exit code N` error", () => {
    const wire = post("bash", { command: "false" }, { ok: true, content: "exit=1", exitCode: 1, stdout: "out\n", stderr: "boom\n", interrupted: false });
    assert.strictEqual(wire.tool_name, "Bash");
    assert.strictEqual(wire.error, "Exit code 1\nout\nboom");
    assert.strictEqual(wire.is_interrupt, false);
    const response = wire.tool_response as Record<string, unknown>;
    assert.strictEqual(response.exit_code, 1);
    assert.strictEqual(response.success, false);
    assert.strictEqual(response.is_error, true);
    assert.strictEqual(response.ok, true); // Autopilot's own field is unchanged
  });

  it("a killed command is interrupted", () => {
    const wire = post("bash", { command: "sleep 9" }, { ok: true, content: "(timed out after 1000ms)", exitCode: null, stdout: "", stderr: "", interrupted: true });
    assert.strictEqual(wire.is_interrupt, true);
    assert.strictEqual(wire.error, "(timed out after 1000ms)");
    assert.strictEqual((wire.tool_response as Record<string, unknown>).interrupted, true);
  });

  it("a failed write or edit is flagged and does not claim a file edit", () => {
    for (const [tool, args] of [
      ["write", { path: "a.ts", content: "x" }],
      ["edit", { path: "a.ts", old_string: "a", new_string: "b" }],
      ["edit", { path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] }],
    ] as const) {
      const wire = post(tool, args, { ok: false, content: "Error running write: EACCES", errorCode: "unknown" });
      assert.strictEqual(wire.tool_name, tool, "no Write/Edit/MultiEdit for a change that never landed");
      assert.strictEqual(wire.error, "Error running write: EACCES");
      assert.strictEqual(wire.is_interrupt, false);
      assert.deepStrictEqual(wire.tool_response, { ok: false, content: "Error running write: EACCES", errorCode: "unknown", success: false, is_error: true });
    }
    const ok = post("write", { path: "a.ts", content: "x" }, { ok: true, content: "Created a.ts (1 chars)." });
    assert.strictEqual(ok.tool_name, "Write");
    assert.strictEqual((ok.tool_response as Record<string, unknown>).filePath, "/repo/a.ts");
  });

  it("any other failed tool keeps its Claude name and carries the error", () => {
    const wire = post("read", { path: "nope.ts" }, { ok: false, content: "ENOENT", errorCode: "not_found" });
    assert.strictEqual(wire.tool_name, "Read");
    assert.strictEqual(wire.error, "ENOENT");
    const aborted = post("grep", { pattern: "x" }, { ok: false, content: "aborted", errorCode: "aborted" });
    assert.strictEqual(aborted.is_interrupt, true);
  });
});

describe("Stop carries last_assistant_message (#877)", () => {
  it("is the turn's last assistant text, never an earlier turn's", () => {
    assert.deepStrictEqual(
      lastAssistantMessage([
        { role: "user", content: "hi" },
        { role: "assistant", content: null, tool_calls: [] },
        { role: "tool", content: "r", tool_call_id: "1" },
        { role: "assistant", content: "Done: edited a.ts." },
      ]),
      { last_assistant_message: "Done: edited a.ts." },
    );
    assert.deepStrictEqual(
      lastAssistantMessage([
        { role: "assistant", content: "previous answer" },
        { role: "user", content: "next" },
        { role: "assistant", content: null, tool_calls: [] },
      ]),
      {},
    );
    const wire = hookWirePayload({ event: "Stop", session_id: "s", cwd: "/r", last_assistant_message: "bye" });
    assert.strictEqual(wire.last_assistant_message, "bye");
  });
});

function fakeHooks() {
  const fired: HookPayload[] = [];
  const hooks = {
    hasEnabledHooks: (_e: HookEvent) => true,
    fire: async (_e: HookEvent, payload: HookPayload) => {
      fired.push(payload);
      return { outcomes: [], vetoed: false, vetoReason: "" };
    },
  } as unknown as HooksManager;
  return { hooks, fired };
}

describe("SessionStart / SessionEnd", () => {
  beforeEach(() => resetSessionLifecycleForTesting());

  it("starts once per session, with source and model; ends on clear and on exit", async () => {
    const { hooks, fired } = fakeHooks();
    await noteSessionStart({ hooks, sessionId: "a", cwd: "/r", resumed: false, model: "m/x", provider: "openrouter" });
    await noteSessionStart({ hooks, sessionId: "a", cwd: "/r", resumed: false });
    await noteSessionStart({ hooks, sessionId: "b", cwd: "/r", resumed: true });
    assert.deepStrictEqual(fired.map((p) => [p.event, p.session_id, (p as { source?: string }).source]), [
      ["SessionStart", "a", "startup"],
      ["SessionStart", "b", "resume"],
    ]);
    assert.strictEqual((fired[0] as { model?: string }).model, "m/x");
    await endSession("a", "clear");
    await endSessions("exit");
    await endSessions("exit");
    assert.deepStrictEqual(fired.slice(2).map((p) => [p.event, p.session_id, (p as { reason?: string }).reason]), [
      ["SessionEnd", "a", "clear"],
      ["SessionEnd", "b", "exit"],
    ]);
  });
});

describe("structured OTel events", () => {
  let bodies: unknown[] = [];
  beforeEach(() => {
    bodies = [];
    resetOtelSinkForTesting();
    initOtelSink({ endpoint: "http://127.0.0.1:4318" });
    setFetchForTesting(async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 200 });
    });
  });
  afterEach(() => {
    setFetchForTesting(null);
    resetOtelSinkForTesting();
  });

  const records = () =>
    bodies.flatMap((b) =>
      (b as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> }).resourceLogs[0]!.scopeLogs[0]!.logRecords,
    ).map((r) => Object.fromEntries(r.attributes.map((a) => [a.key, Object.values(a.value)[0]])));

  it("model usage and tool results become gen_ai events, with fractional costs kept", async () => {
    const callbacks = withOtelEvents({ askPermission: async () => "allow" } as never, { sessionId: "s9", model: "anthropic/claude-x", provider: "openrouter" });
    callbacks.onUsageFinal!({ prompt_tokens: 1200, completion_tokens: 80, cost: 0.0042, prompt_tokens_details: { cached_tokens: 1000 } } as never);
    callbacks.onToolResult!({ tool_call_id: "c1", name: "read", ok: true, content: "12345" });
    emitOtelEvent("session.start", "s9", { "session.source": "startup" });
    await flushOtelSink();
    const [usage, tool, start] = records();
    assert.strictEqual(usage!["event.name"], "autopilot.api_request");
    assert.strictEqual(usage!["gen_ai.request.model"], "anthropic/claude-x");
    assert.strictEqual(usage!["gen_ai.provider.name"], "openrouter");
    assert.strictEqual(usage!["gen_ai.usage.input_tokens"], "1200");
    assert.strictEqual(usage!["gen_ai.usage.cached_input_tokens"], "1000");
    assert.strictEqual(usage!["cost.usd"], 0.0042);
    assert.strictEqual(usage!["session.id"], "s9");
    assert.strictEqual(tool!["gen_ai.tool.name"], "read");
    assert.strictEqual(tool!["tool.success"], true);
    assert.strictEqual(start!["event.name"], "autopilot.session.start");
  });

  it("names the service, scope and Beacon harness `autopilot`", async () => {
    emitOtelEvent("session.start", "s1", {});
    await flushOtelSink();
    const body = bodies[0] as { resourceLogs: Array<{ resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> }; scopeLogs: Array<{ scope: { name: string } }> }> };
    const resource = Object.fromEntries(body.resourceLogs[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]));
    assert.strictEqual(resource["service.name"], "autopilot");
    assert.strictEqual(resource["beacon.harness.name"], "autopilot");
    assert.strictEqual(body.resourceLogs[0]!.scopeLogs[0]!.scope.name, "autopilot");
  });
});
