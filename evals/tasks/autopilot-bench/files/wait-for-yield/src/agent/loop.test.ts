import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn } from "./loop.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "./messages.js";
import type { RunWaitRequest, ToolSpec } from "../tools/registry.js";

describe("runAgentTurn", () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("exits gracefully when signal aborts during streaming", async () => {
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hi" },
    ];

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // Delay data so readSSE is pending when abort fires.
          const t = setTimeout(() => {
            try {
              c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
              c.close();
            } catch {
              /* controller may already be closed */
            }
          }, 200);
          // Clean up timeout if stream is cancelled early.
          controller.signal.addEventListener("abort", () => clearTimeout(t), { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const executor = {
      list: () => [],
      run: async () => {
        throw new Error("should not reach executor");
      },
    } as unknown as ToolExecutor;

    // Abort while the stream is pending.
    setTimeout(() => controller.abort(), 50);

    // Should throw because runAgentTurn checks signal.aborted after streaming.
    await assert.rejects(
      async () => {
        await runAgentTurn({
          openrouterApiKey: "sk-or-test",
          model: "test/model",
          messages,
          tools: [],
          executor,
          cwd: "/tmp",
          signal: controller.signal,
          callbacks: {
            askPermission: async () => "allow",
          },
        });
      },
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    // No assistant message should have been appended because abort happened
    // before the stream produced any usable content.
    assert.strictEqual(messages.length, 2);
  });

  it("throws AbortError when signal aborts after streaming but before tool execution", async () => {
    const controller = new AbortController();
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "hi" },
    ];

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc_1","function":{"name":"read","arguments":""}}]}}]}\n\n',
            ),
          );
          c.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"x\\"}"}}]}}]}\n\n',
            ),
          );
          c.enqueue(encoder.encode('data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n'));
          c.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const executor = {
      list: () => [],
      run: async () => {
        throw new Error("should not reach executor");
      },
    } as unknown as ToolExecutor;

    await assert.rejects(
      async () => {
        await runAgentTurn({
          openrouterApiKey: "sk-or-test",
          model: "test/model",
          messages,
          tools: [],
          executor,
          cwd: "/tmp",
          signal: controller.signal,
          callbacks: {
            // Abort as soon as the assistant message is finalized (after streaming,
            // before tool execution starts).
            onAssistantFinal: () => {
              controller.abort();
            },
            askPermission: async () => "allow",
          },
        });
      },
      (err: unknown) => err instanceof DOMException && err.name === "AbortError",
    );

    // Assistant message should have been appended during streaming.
    assert.strictEqual(messages.length, 3);
    assert.strictEqual(messages[2]!.role, "assistant");
    assert.ok(Array.isArray(messages[2]!.tool_calls));
    assert.strictEqual(messages[2]!.tool_calls!.length, 1);

    // No tool result should have been appended because abort happened before execution.
    assert.strictEqual(messages.filter((m) => m.role === "tool").length, 0);
  });

  it("blocks an unadvertised worker tool call before executor invocation", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "Explain this function." },
    ];
    let fetchCalls = 0;
    let workerRuns = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      const events = fetchCalls === 1
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_worker", type: "function", function: { name: "spawn_worker", arguments: JSON.stringify({ mode: "plan", task: "research" }) } }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ delta: { content: "I will handle this locally." } }] },
            { choices: [{ finish_reason: "stop" }] },
          ];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const executor = {
      list: () => [{ name: "spawn_worker" }],
      run: async () => {
        workerRuns++;
        throw new Error("unadvertised worker call must not reach the executor");
      },
    } as unknown as ToolExecutor;

    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: {
        askPermission: async () => "allow",
      },
    });

    assert.equal(workerRuns, 0);
    assert.ok(fetchCalls >= 2);
    assert.ok(messages.some((message) => message.role === "tool" && /not available under this turn's policy/.test(String(message.content))));
  });

  it("ends the turn after a durable wait request without making another model call", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "wait briefly" },
    ];
    let fetchCalls = 0;
    const waitRequest = { runId: "run-1", timerId: "timer-1", condition: "time" as const, wakeAt: Date.now() + 1000 };
    globalThis.fetch = async () => {
      fetchCalls++;
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_wait", type: "function", function: { name: "wait_for", arguments: JSON.stringify({ duration_ms: 1000 }) } }] } }] },
        { choices: [{ finish_reason: "tool_calls" }] },
      ];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const waitTool: ToolSpec = {
      name: "wait_for",
      description: "wait",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      needsPermission: false,
      run: async () => "unused",
    };
    const executor = {
      list: () => [waitTool],
      run: async () => ({
        tool_call_id: "call_wait",
        name: "wait_for",
        content: "Yielding until the timer.",
        ok: true,
        waitRequest,
      }),
    } as unknown as ToolExecutor;
    let yielded: RunWaitRequest | undefined;
    let persisted = false;

    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [waitTool],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      onIterationEnd: async (updatedMessages) => {
        persisted = true;
        return updatedMessages;
      },
      callbacks: {
        askPermission: async () => "allow",
        onRunYield: (request) => {
          assert.equal(persisted, true);
          yielded = request;
        },
      },
    });

    assert.equal(fetchCalls, 1);
    assert.deepEqual(yielded, waitRequest);
    assert.ok(messages.some((message) => message.role === "tool" && message.tool_call_id === "call_wait"));
  });

  it("keeps Code Mode's synthetic execute_code tool available to the loop", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "Print a short result." },
    ];
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      const events = fetchCalls === 1
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_code", type: "function", function: { name: "execute_code", arguments: JSON.stringify({ code: "console.log('code-mode-ok')" }) } }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ delta: { content: "Done." } }] },
            { choices: [{ finish_reason: "stop" }] },
          ];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const executor = {
      list: () => [],
      run: async () => { throw new Error("execute_code must use the sandbox path"); },
    } as unknown as ToolExecutor;

    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      codeMode: true,
      callbacks: { askPermission: async () => "allow" },
    });

    assert.equal(fetchCalls, 2);
    assert.ok(messages.some((message) => message.role === "tool" && !/not available under this turn's policy/.test(String(message.content))));
  });
});
