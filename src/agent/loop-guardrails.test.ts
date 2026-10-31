import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn, AgentLoopError, _resetSessionWebFetchHistoryForTests, type AgentTurnOpts, type GuardrailEvent } from "./loop.js";
import type { ToolExecutor, ToolResult } from "../tools/executor.js";
import type { ChatMessage } from "./messages.js";
import type { HooksManager } from "../hooks/manager.js";
import type { ToolSpec } from "../tools/registry.js";
import { secureSandboxUnavailableReason } from "../code-mode/index.js";

// These turns pass a session id; keep their JSONL transcripts out of the real sessions dir.
process.env.KIMIFLARE_TRANSCRIPT = "0";

// Code Mode needs the optional isolated-vm sandbox; those tests skip without it.
const NO_SANDBOX = (await secureSandboxUnavailableReason()) ?? false;

type Step = { tool: string; args: Record<string, unknown> } | { text: string };

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

/** Scripted model: each request consumes the next step (the last step repeats). */
function scriptModel(steps: Step[]): { requests: number } {
  const state = { requests: 0 };
  globalThis.fetch = async () => {
    const step = steps[Math.min(state.requests, steps.length - 1)]!;
    state.requests++;
    if ("text" in step) {
      return sse([
        { choices: [{ delta: { content: step.text } }] },
        { choices: [{ finish_reason: "stop" }] },
      ]);
    }
    return sse([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: `tc_${state.requests}`,
                  function: { name: step.tool, arguments: JSON.stringify(step.args) },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ finish_reason: "tool_calls" }] },
    ]);
  };
  return state;
}

function fakeExecutor(): { executor: ToolExecutor; runs: string[] } {
  const runs: string[] = [];
  const executor = {
    list: () => [],
    run: async (call: { id: string; name: string; arguments: string }) => {
      runs.push(call.arguments);
      return { tool_call_id: call.id, name: call.name, content: "ok", ok: true };
    },
  } as unknown as ToolExecutor;
  return { executor, runs };
}

function fakeHooks(): { hooks: HooksManager; stopFired: () => number } {
  let fired = 0;
  const hooks = {
    hasEnabledHooks: (event: string) => event === "Stop",
    fire: async () => {
      fired++;
    },
  } as unknown as HooksManager;
  return { hooks, stopFired: () => fired };
}

function baseOpts(
  executor: ToolExecutor,
  events: GuardrailEvent[],
  extra: Partial<AgentTurnOpts> = {},
): AgentTurnOpts {
  const messages: ChatMessage[] = [
    { role: "system", content: "test" },
    { role: "user", content: "do the thing" },
  ];
  return {
    openrouterApiKey: "sk-or-test",
    model: "test/model",
    messages,
    tools: [PROBE_TOOL],
    executor,
    cwd: "/tmp",
    signal: new AbortController().signal,
    callbacks: {
      askPermission: async () => "allow",
      onGuardrail: (ev) => events.push(ev),
    },
    ...extra,
  };
}

/** Every assistant tool_call must have a matching tool result (no dangling calls). */
function assertNoDanglingToolCalls(messages: ChatMessage[]): void {
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) assert.ok(answered.has(tc.id), `dangling tool call ${tc.id}`);
  }
}

const SAME = { tool: "probe", args: { q: "same" } };

// The loop blocks calls to tools the turn doesn't advertise, so the scripted
// `probe` calls need a matching spec (execution goes through fakeExecutor).
const PROBE_TOOL: ToolSpec = {
  name: "probe",
  description: "Test probe.",
  parameters: { type: "object", properties: {}, required: [] },
  needsPermission: false,
  run: async () => "ok",
};

const WEB_FETCH_TOOL: ToolSpec = {
  name: "web_fetch",
  description: "Fetch a web page.",
  parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  needsPermission: false,
  run: async () => "ok",
};

const READ_TOOL: ToolSpec = {
  name: "read",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  needsPermission: false,
  run: async () => "ok",
};

const EDIT_TOOL: ToolSpec = {
  name: "edit",
  description: "Edit a file.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
    required: ["path", "old_string", "new_string"],
  },
  needsPermission: false,
  run: async () => "ok",
};

const BASH_TOOL: ToolSpec = {
  name: "bash",
  description: "Run a command.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  needsPermission: false,
  run: async () => "ok",
};

/** Executor that records the `readRepeat` page it was asked to serve. */
function pagingExecutor(): { executor: ToolExecutor; readRepeats: number[] } {
  const readRepeats: number[] = [];
  const executor = {
    list: () => [],
    run: async (
      call: { id: string; name: string; arguments: string },
      _ask: unknown,
      _ctx: unknown,
      _onFileChange: unknown,
      options?: { readRepeat?: number },
    ) => {
      if (call.name === "read") {
        const repeat = options?.readRepeat ?? 0;
        readRepeats.push(repeat);
        return {
          tool_call_id: call.id,
          name: call.name,
          content: repeat > 0 ? `page ${repeat}` : "File outline: preview only",
          ok: true,
        };
      }
      return { tool_call_id: call.id, name: call.name, content: "ok", ok: true };
    },
  } as unknown as ToolExecutor;
  return { executor, readRepeats };
}

describe("runAgentTurn guardrails (unattended)", () => {
  let originalFetch: typeof globalThis.fetch;
  before(() => {
    originalFetch = globalThis.fetch;
    _resetSessionWebFetchHistoryForTests();
  });
  after(() => {
    globalThis.fetch = originalFetch;
    _resetSessionWebFetchHistoryForTests();
  });

  it("allows several distinct pages from the same hostname", async () => {
    const urls = [
      "https://huggingface.co/spaces/example/model-a",
      "https://huggingface.co/spaces/example/model-b",
      "https://huggingface.co/datasets/example/data",
    ];
    const model = scriptModel([
      ...urls.map((url) => ({ tool: "web_fetch", args: { url } })),
      { text: "Finished researching." },
    ]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, {
      sessionId: "same-host-web-fetch-regression",
      tools: [WEB_FETCH_TOOL],
    });

    await runAgentTurn(opts);

    assert.deepStrictEqual(runs.map((args) => (JSON.parse(args) as { url: string }).url), urls);
    assert.strictEqual(model.requests, urls.length + 1);
    assert.deepStrictEqual(events, []);
  });

  it("recovers from a loop automatically without waiting for input", async () => {
    // 3rd identical call is blocked -> recovery prompt -> model answers.
    const model = scriptModel([SAME, SAME, SAME, { text: "done, different approach" }]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const toolResults: ToolResult[] = [];
    const opts = baseOpts(executor, events);
    opts.callbacks.onToolResult = (result) => toolResults.push(result);

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery"]);
    assert.ok(toolResults.some((result) => result.guardrail), "blocked loop feedback should be marked internal");
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(model.requests, 4);
    assert.ok(
      opts.messages.some((m) => m.role === "system" && String(m.content).includes("Do not repeat them")),
    );
    assert.strictEqual(opts.messages.at(-1)!.content, "done, different approach");
    assertNoDanglingToolCalls(opts.messages);
  });

  it("blocks a repeat of a call that already failed on its arguments", async () => {
    // Same arguments can never succeed, so the retry is blocked on the first
    // repeat (not after LOOP_THRESHOLD) and the model hears the original error.
    const model = scriptModel([SAME, SAME, { text: "changed approach" }]);
    const runs: string[] = [];
    const executor = {
      list: () => [],
      run: async (call: { id: string; name: string; arguments: string }) => {
        runs.push(call.arguments);
        return {
          tool_call_id: call.id,
          name: call.name,
          content: "Error running probe: the replacement text never arrived",
          ok: false,
          errorCode: "invalid_args",
        };
      },
    } as unknown as ToolExecutor;
    const events: GuardrailEvent[] = [];
    const toolResults: ToolResult[] = [];
    const opts = baseOpts(executor, events);
    opts.callbacks.onToolResult = (result) => toolResults.push(result);

    await runAgentTurn(opts);

    assert.strictEqual(runs.length, 1, "the identical retry must not reach the tool");
    const blocked = toolResults.find((result) => result.guardrail);
    assert.ok(blocked, "the retry should be blocked by the guardrail");
    assert.match(String(blocked!.content), /already failed on its arguments/);
    assert.match(String(blocked!.content), /the replacement text never arrived/);
    assert.strictEqual(model.requests, 3);
    assert.strictEqual(opts.messages.at(-1)!.content, "changed approach");
    assertNoDanglingToolCalls(opts.messages);
  });

  it("serves a repeated full-file read as the next page instead of blocking it", async () => {
    const readRepeats: number[] = [];
    const executor = {
      list: () => [],
      run: async (
        call: { id: string; name: string; arguments: string },
        _ask: unknown,
        _ctx: unknown,
        _onFileChange: unknown,
        options?: { readRepeat?: number },
      ) => {
        const repeat = options?.readRepeat ?? 0;
        readRepeats.push(repeat);
        return {
          tool_call_id: call.id,
          name: call.name,
          content: repeat > 0 ? `page ${repeat}` : "File outline: preview only",
          ok: true,
        };
      },
    } as unknown as ToolExecutor;
    const model = scriptModel([
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { text: "I can now inspect the file content." },
    ]);
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }] });

    await runAgentTurn(opts);

    // Outline, then three forward pages — never a block, never the same bytes.
    assert.deepStrictEqual(readRepeats, [0, 1, 2, 3]);
    assert.deepStrictEqual(events, []);
    assert.strictEqual(model.requests, 5);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("keeps paging a repeated read when other calls are interleaved", async () => {
    // The page cursor is per file, not a sliding-window count: an unrelated
    // call in between must not reset it and hand back the same outline again.
    const { executor, readRepeats } = pagingExecutor();
    const model = scriptModel([
      { tool: "read", args: { path: "src/large.rs" } },
      SAME,
      { tool: "read", args: { path: "src/large.rs" } },
      SAME,
      { tool: "read", args: { path: "src/large.rs" } },
      { text: "Read enough." },
    ]);
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }, PROBE_TOOL] });

    await runAgentTurn(opts);

    assert.deepStrictEqual(readRepeats, [0, 1, 2], "each repeat must advance a page");
    assert.deepStrictEqual(events, []);
    assert.strictEqual(model.requests, 6);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("serves a re-read after an edit instead of blocking it", async () => {
    // The edit tool's staleness check tells the model to read the file again.
    // That re-read must be served, not counted as a repeat of the reads that
    // preceded the change.
    const { executor, readRepeats } = pagingExecutor();
    const model = scriptModel([
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "edit", args: { path: "src/large.rs", old_string: "a", new_string: "b" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { text: "Verified the edit." },
    ]);
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, {
      tools: [{ ...READ_TOOL, isReadOnly: true }, EDIT_TOOL],
    });

    await runAgentTurn(opts);

    assert.deepStrictEqual(readRepeats, [0, 1, 2, 3, 0], "the post-edit read starts a fresh cursor");
    assert.deepStrictEqual(events, []);
    assert.strictEqual(model.requests, 7);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("blocks a whole-file read once its pages are exhausted, with an actionable message", async () => {
    const { executor, readRepeats } = pagingExecutor();
    const model = scriptModel([
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { tool: "read", args: { path: "src/large.rs" } },
      { text: "Switching to offset/limit." },
    ]);
    const events: GuardrailEvent[] = [];
    const toolResults: ToolResult[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }] });
    opts.callbacks.onToolResult = (result) => toolResults.push(result);

    await runAgentTurn(opts);

    assert.deepStrictEqual(readRepeats, [0, 1, 2, 3], "only the pages that exist are served");
    const blocked = toolResults.find((result) => result.guardrail);
    assert.ok(blocked, "the exhausted read should be blocked");
    assert.match(String(blocked!.content), /offset\/limit/);
    // Read-only loop: a summary, never a crash.
    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery"]);
    assert.strictEqual(opts.messages.at(-1)!.content, "Switching to offset/limit.");
    assertNoDanglingToolCalls(opts.messages);
  });

  it("does not treat a repeat separated by another call as a loop", async () => {
    // "edit, test, edit, test" is re-verification after progress, not
    // thrashing. Only a run of identical calls is a loop.
    const verify = { tool: "bash", args: { command: "npm test" } };
    const edit = { tool: "edit", args: { path: "src/a.ts", old_string: "a", new_string: "b" } };
    const model = scriptModel([verify, edit, verify, edit, verify, { text: "All green." }]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [BASH_TOOL, EDIT_TOOL] });

    await runAgentTurn(opts);

    assert.deepStrictEqual(events, []);
    assert.strictEqual(runs.length, 5, "every verification run must reach the tool");
    assert.strictEqual(model.requests, 6);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("still blocks a run of identical calls with nothing in between", async () => {
    const verify = { tool: "bash", args: { command: "npm test" } };
    const model = scriptModel([verify, verify, verify, { text: "changed approach" }]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [BASH_TOOL] });

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery"]);
    assert.strictEqual(runs.length, 2, "the third identical call is blocked");
    assertNoDanglingToolCalls(opts.messages);
  });

  it("ends a read-only loop with a summary instead of an error", async () => {
    // A repeated slice read is a real repeat (no page to serve), so the
    // guardrail blocks it — but a read-only loop must not surface as a crash.
    const model = scriptModel([{ tool: "read", args: { path: "src/large.rs", offset: 1, limit: 10 } }]);
    const { executor } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }] });

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery", "loop_stopped"]);
    const last = opts.messages.at(-1)!;
    assert.strictEqual(last.role, "assistant");
    assert.match(String(last.content), /repeating blocked tool calls/);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("ends a loop of harness-refused calls with a summary, not AgentLoopError", async () => {
    // `edit` is not advertised this turn, so every call is blocked as
    // unavailable. That is the harness refusing, not the model thrashing on
    // side effects, so the turn ends with a summary instead of an error (#1080).
    const model = scriptModel([{ tool: "edit", args: { path: "src/a.ts", old_string: "a", new_string: "b" } }]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events);

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery", "loop_stopped"]);
    assert.strictEqual(runs.length, 0);
    assert.ok(model.requests > 0);
    assert.match(String(opts.messages.at(-1)!.content), /repeating blocked tool calls/);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("pages a repeated whole-file read inside Code Mode", { skip: NO_SANDBOX }, async () => {
    // `api.read` inside execute_code used to get the outline every time, so
    // the identical script was blocked on its third run (#1080). It now draws
    // on the same per-file page cursor as a direct read, and a repeat that was
    // served a new page is not treated as a loop.
    const { executor, readRepeats } = pagingExecutor();
    const script = { tool: "execute_code", args: { code: 'console.log(await api.read({ path: "src/large.rs" }));' } };
    const model = scriptModel([script, script, script, script, { text: "Read the whole file." }]);
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }], codeMode: true });

    await runAgentTurn(opts);

    assert.deepStrictEqual(readRepeats, [0, 1, 2, 3], "each run of the script advances a page");
    assert.deepStrictEqual(events, []);
    assert.strictEqual(model.requests, 5);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("blocks an identical Code Mode read once the file's pages are exhausted", { skip: NO_SANDBOX }, async () => {
    const { executor, readRepeats } = pagingExecutor();
    const script = { tool: "execute_code", args: { code: 'console.log(await api.read({ path: "src/large.rs" }));' } };
    scriptModel([script, script, script, script, script, script, { text: "Done." }]);
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { tools: [{ ...READ_TOOL, isReadOnly: true }], codeMode: true });

    await runAgentTurn(opts);

    // Outline + 3 pages, one more run past the budget (no progress), then the
    // guard blocks the identical script again.
    assert.deepStrictEqual(readRepeats, [0, 1, 2, 3, 0]);
    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery"]);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("ends the turn with a summary when the loop repeats after recovery", async () => {
    // Model never changes approach, even during the final summary request.
    const model = scriptModel([SAME]);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const { hooks, stopFired } = fakeHooks();
    const opts = baseOpts(executor, events, { hooks });

    await assert.rejects(runAgentTurn(opts), (err: unknown) => err instanceof AgentLoopError);

    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery", "loop_stopped"]);
    // Two executed calls before each block; the summary request's tool call is never run.
    assert.strictEqual(runs.length, 4);
    assert.strictEqual(model.requests, 7);
    const last = opts.messages.at(-1)!;
    assert.strictEqual(last.role, "assistant");
    assert.strictEqual(last.tool_calls, undefined);
    assert.match(String(last.content), /repeating blocked tool calls/);
    assert.strictEqual(stopFired(), 1);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("uses the model's own summary text when it complies on the final request", async () => {
    scriptModel([SAME, SAME, SAME, SAME, SAME, SAME, { text: "Summary: blocked on X." }]);
    const { executor } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events);

    await assert.rejects(runAgentTurn(opts), (err: unknown) => err instanceof AgentLoopError);
    assert.strictEqual(opts.messages.at(-1)!.content, "Summary: blocked on X.");
  });

  it("resets the iteration counter automatically and stops at the hard ceiling", async () => {
    let n = 0;
    const steps: Step[] = Array.from({ length: 10 }, () => ({ tool: "probe", args: { n: n++ } }));
    const model = scriptModel(steps);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const { hooks, stopFired } = fakeHooks();
    const opts = baseOpts(executor, events, {
      hooks,
      maxToolIterations: 2,
      maxTotalToolIterations: 5,
      toolLimitBehavior: "continue",
    });

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["limit_reset", "limit_reset", "limit_ceiling"]);
    assert.strictEqual(runs.length, 5);
    // 5 tool iterations + 1 tool-free summary request; bounded, not unbounded.
    assert.strictEqual(model.requests, 6);
    const last = opts.messages.at(-1)!;
    assert.strictEqual(last.tool_calls, undefined);
    assert.match(String(last.content), /safety ceiling/);
    assert.strictEqual(stopFired(), 1);
    assertNoDanglingToolCalls(opts.messages);
  });

  it("continueOnLimit still maps to automatic reset with a default ceiling", async () => {
    let n = 0;
    const steps: Step[] = Array.from({ length: 20 }, () => ({ tool: "probe", args: { n: n++ } }));
    scriptModel(steps);
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const opts = baseOpts(executor, events, { maxToolIterations: 2, continueOnLimit: true });

    await runAgentTurn(opts);

    // Default ceiling is 5 × maxToolIterations.
    assert.strictEqual(runs.length, 10);
    assert.strictEqual(events.at(-1)!.kind, "limit_ceiling");
  });

  it("stops cleanly at the limit with toolLimitBehavior: stop", async () => {
    let n = 0;
    scriptModel(Array.from({ length: 5 }, () => ({ tool: "probe", args: { n: n++ } })));
    const { executor, runs } = fakeExecutor();
    const events: GuardrailEvent[] = [];
    const { hooks, stopFired } = fakeHooks();
    const opts = baseOpts(executor, events, { hooks, maxToolIterations: 2, toolLimitBehavior: "stop" });

    await runAgentTurn(opts);

    assert.deepStrictEqual(events.map((e) => e.kind), ["limit_stopped"]);
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(stopFired(), 1);
  });

  it("throws at the limit by default (headless behavior preserved)", async () => {
    let n = 0;
    scriptModel(Array.from({ length: 5 }, () => ({ tool: "probe", args: { n: n++ } })));
    const { executor } = fakeExecutor();
    const opts = baseOpts(executor, [], { maxToolIterations: 1 });

    await assert.rejects(runAgentTurn(opts), /tool iteration limit reached \(1\)/);
  });

  it("honors abort during loop recovery and skips the Stop hook", async () => {
    scriptModel([SAME]);
    const { executor } = fakeExecutor();
    const controller = new AbortController();
    const events: GuardrailEvent[] = [];
    const { hooks, stopFired } = fakeHooks();
    const opts = baseOpts(executor, events, { hooks, signal: controller.signal });
    opts.callbacks.onGuardrail = (ev) => {
      events.push(ev);
      if (ev.kind === "loop_recovery") controller.abort();
    };

    await assert.rejects(
      runAgentTurn(opts),
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );
    assert.deepStrictEqual(events.map((e) => e.kind), ["loop_recovery"]);
    assert.strictEqual(stopFired(), 0);
  });
});
