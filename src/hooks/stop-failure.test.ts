import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runAgentTurn, stopFailureKind, BudgetExhaustedError, type AgentTurnOpts } from "../agent/loop.js";
import { ContextBudgetError } from "../agent/context-budget.js";
import { ApiError } from "../util/errors.js";
import { getAppVersion } from "../util/version.js";
import { hookWirePayload, HOOK_PAYLOAD_VERSION } from "./runner.js";
import { HOOK_EVENTS, type HookEvent, type HookPayload } from "./types.js";
import type { HooksManager } from "./manager.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "../agent/messages.js";

// These turns pass a session id; keep their JSONL transcripts out of the sessions dir.
process.env.KIMIFLARE_TRANSCRIPT = "0";

function sse(lines: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(encoder.encode(`data: ${JSON.stringify(l)}\n\n`));
      c.enqueue(encoder.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const answer = (text: string) => async () =>
  sse([{ choices: [{ delta: { content: text } }] }, { choices: [{ finish_reason: "stop" }] }]);

/** Records every Stop / StopFailure the turn fires. */
function recordingHooks(): { hooks: HooksManager; fired: { event: HookEvent; payload: HookPayload }[] } {
  const fired: { event: HookEvent; payload: HookPayload }[] = [];
  const hooks = {
    hasEnabledHooks: (event: HookEvent) => event === "Stop" || event === "StopFailure",
    fire: async (event: HookEvent, payload: HookPayload) => {
      fired.push({ event, payload });
      return { outcomes: [], vetoed: false, vetoReason: "", failures: [] };
    },
  } as unknown as HooksManager;
  return { hooks, fired };
}

function opts(hooks: HooksManager, signal: AbortSignal = new AbortController().signal): AgentTurnOpts {
  const messages: ChatMessage[] = [
    { role: "system", content: "test" },
    { role: "user", content: "do the thing" },
  ];
  return {
    openrouterApiKey: "sk-or-test",
    model: "test/model",
    messages,
    tools: [],
    executor: { list: () => [], run: async () => ({ ok: true, content: "ok" }) } as unknown as ToolExecutor,
    cwd: "/tmp",
    sessionId: "sess-stop-failure",
    signal,
    hooks,
    callbacks: { askPermission: async () => "allow" },
  };
}

describe("StopFailure: every prompt ends in Stop or StopFailure", () => {
  it("is a hook event", () => {
    assert.ok(HOOK_EVENTS.includes("StopFailure"));
  });

  it("a clean turn fires Stop and no StopFailure", async () => {
    globalThis.fetch = answer("done") as typeof fetch;
    const { hooks, fired } = recordingHooks();
    await runAgentTurn(opts(hooks));
    assert.deepEqual(
      fired.map((f) => f.event),
      ["Stop"],
    );
  });

  it("a turn the model call fails fires StopFailure (model_error), not Stop", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request", code: 400 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const { hooks, fired } = recordingHooks();
    await assert.rejects(runAgentTurn(opts(hooks)));
    assert.deepEqual(
      fired.map((f) => f.event),
      ["StopFailure"],
    );
    const p = fired[0]!.payload as Extract<HookPayload, { event: "StopFailure" }>;
    assert.equal(p.error, "model_error");
    assert.equal(p.is_interrupt, false);
    assert.equal(p.session_id, "sess-stop-failure");
    assert.equal(p.cwd, "/tmp");
  });

  it("an interrupted turn fires StopFailure (interrupted, is_interrupt), not Stop", async () => {
    const controller = new AbortController();
    globalThis.fetch = (async (_url: unknown, init?: { signal?: AbortSignal }) => {
      controller.abort();
      init?.signal?.throwIfAborted();
      throw new DOMException("aborted", "AbortError");
    }) as typeof fetch;
    const { hooks, fired } = recordingHooks();
    await assert.rejects(runAgentTurn(opts(hooks, controller.signal)));
    assert.deepEqual(
      fired.map((f) => f.event),
      ["StopFailure"],
    );
    const p = fired[0]!.payload as Extract<HookPayload, { event: "StopFailure" }>;
    assert.equal(p.error, "interrupted");
    assert.equal(p.is_interrupt, true);
  });

  it("names the failure by its class", () => {
    assert.equal(stopFailureKind(new DOMException("aborted", "AbortError")), "interrupted");
    assert.equal(stopFailureKind(new BudgetExhaustedError()), "budget_exhausted");
    assert.equal(stopFailureKind(new ContextBudgetError(10, 5, 8)), "context_limit");
    assert.equal(stopFailureKind(new ApiError("boom")), "model_error");
    assert.equal(stopFailureKind(new Error("other")), "error");
    assert.equal(stopFailureKind("thrown string"), "error");
  });
});

describe("payload versioning", () => {
  it("every payload names the Autopilot version and the payload contract version", () => {
    const wire = hookWirePayload({ event: "StopFailure", session_id: "s", cwd: "/r", error: "interrupted", is_interrupt: true });
    assert.equal(wire.autopilot_version, getAppVersion());
    assert.equal(wire.hook_payload_version, HOOK_PAYLOAD_VERSION);
    assert.equal(HOOK_PAYLOAD_VERSION, 1);
    assert.equal(wire.hook_event_name, "StopFailure");
    assert.equal(wire.client, "autopilot");
  });

  it("PreCompact says what triggered it", () => {
    const wire = hookWirePayload({ event: "PreCompact", session_id: "s", cwd: "/r", trigger: "manual" });
    assert.equal(wire.trigger, "manual");
  });
});
