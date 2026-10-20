import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { hookWirePayload } from "./runner.js";
import { endSession, endSessions, noteSessionStart, resetSessionLifecycleForTesting } from "./session-lifecycle.js";
import type { HooksManager } from "./manager.js";
import type { HookEvent, HookPayload } from "./types.js";
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
      result: { ok: true, content: "a\nb" },
    });
    assert.strictEqual(wire.hook_event_name, "PostToolUse");
    assert.strictEqual(wire.tool_name, "bash");
    assert.deepStrictEqual(wire.tool_input, { command: "ls" });
    assert.deepStrictEqual(wire.tool_response, { ok: true, content: "a\nb" });
    assert.strictEqual(wire.tool_call_id, "call_1");
    assert.match(String(wire.transcript_path), /sessions\/s1\.json$/);
    // Autopilot's own fields stay for existing hooks.
    assert.strictEqual(wire.event, "PostToolUse");
    assert.strictEqual(wire.tool, "bash");
    assert.strictEqual(wire.client, "autopilot");
  });

  it("non-tool events get hook_event_name but no tool fields", () => {
    const wire = hookWirePayload({ event: "UserPromptSubmit", session_id: null, cwd: "/r", prompt: "hi" });
    assert.strictEqual(wire.hook_event_name, "UserPromptSubmit");
    assert.strictEqual(wire.prompt, "hi");
    assert.ok(!("tool_name" in wire) && !("transcript_path" in wire));
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
});
