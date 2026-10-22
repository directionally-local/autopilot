import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { runAgentTurn } from "./loop.js";
import { ToolExecutor as RealToolExecutor, type ToolExecutor, type PermissionRequest } from "../tools/executor.js";
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

  it("does not execute tool calls when the usage callback stops an over-budget response", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "read the file" },
    ];
    let toolExecutions = 0;
    const tool: ToolSpec = {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } } },
      needsPermission: false,
      run: async () => "unexpected",
    };
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const events = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: "" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: "README.md" }) } }] } }] },
        { choices: [{ finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.02 } },
      ];
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
      list: () => [tool],
      run: async () => { toolExecutions++; return { ok: true, content: "unexpected" }; },
    } as unknown as ToolExecutor;

    await assert.rejects(runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [tool],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: {
        onUsageFinal: () => { throw new Error("max_cost_usd_exceeded"); },
        askPermission: async () => "allow",
      },
    }), /max_cost_usd_exceeded/);
    assert.equal(toolExecutions, 0);
    assert.equal(messages.length, 2);
  });

  it("preserves malformed streamed tool arguments through the agent loop", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "Create an artifact" },
    ];
    const tool: ToolSpec = {
      name: "create_artifact",
      description: "Open an HTML artifact",
      parameters: { type: "object", properties: { title: { type: "string" }, sourcePath: { type: "string" } }, required: ["title", "sourcePath"] },
      needsPermission: true,
      run: async () => "unexpected",
    };
    const rawArguments = '{"title":"Dashboard","sourcePath":"report.html';
    let fetchCount = 0;
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const first = fetchCount++ === 0;
      const events = first
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-truncated", type: "function", function: { name: "create_artifact", arguments: rawArguments } }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    let executedArguments = "";
    const executor = {
      list: () => [tool],
      run: async (call: { id: string; name: string; arguments: string }) => {
        executedArguments = call.arguments;
        return {
          tool_call_id: call.id,
          name: call.name,
          content: "Error: invalid JSON arguments. No tool action was performed.",
          ok: false,
          errorCode: "invalid_args",
          recoverable: true,
          suggestion: "Use write, then call create_artifact with sourcePath.",
        };
      },
    } as unknown as ToolExecutor;

    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [tool],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });

    assert.equal(fetchCount, 2);
    assert.equal(executedArguments, rawArguments);
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

  it("runs concurrent worker calls in parallel behind one batched permission prompt", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "research three things" },
    ];
    let active = 0;
    let maxActive = 0;
    const worker: ToolSpec<{ task: string }> = {
      name: "spawn_worker",
      description: "fake isolated worker",
      parameters: { type: "object", properties: { task: { type: "string" } } },
      needsPermission: true,
      concurrent: true,
      run: async (args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active--;
        return `done: ${args.task}`;
      },
    };
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [
            { choices: [{ delta: { tool_calls: ["a", "b", "c"].map((task, index) => ({ index, id: `call-${task}`, type: "function", function: { name: "spawn_worker", arguments: JSON.stringify({ task }) } })) } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [
            { choices: [{ delta: { content: "synthesized" } }] },
            { choices: [{ finish_reason: "stop" }] },
          ];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const asks: PermissionRequest[] = [];
    let outstanding = 0;
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [worker],
      executor: new RealToolExecutor([worker]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: {
        askPermission: async (req) => {
          outstanding++;
          assert.equal(outstanding, 1, "permission prompts must never overlap");
          asks.push(req);
          await new Promise((resolve) => setTimeout(resolve, 5));
          outstanding--;
          return "allow";
        },
      },
    });

    assert.equal(maxActive, 3, "all three workers ran at the same time");
    assert.equal(asks.length, 1, "one prompt approves the whole batch");
    assert.equal((asks[0]!.args.batch as unknown[]).length, 3);
    const toolMessages = messages.filter((m) => m.role === "tool");
    assert.deepEqual(toolMessages.map((m) => m.tool_call_id), ["call-a", "call-b", "call-c"], "results keep call order");
    assert.deepEqual(toolMessages.map((m) => m.content), ["done: a", "done: b", "done: c"]);
  });

  it("keeps mutating batches sequential even when they include a concurrent tool", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "go" },
    ];
    let active = 0;
    let maxActive = 0;
    const slow = (name: string, extra: Partial<ToolSpec>): ToolSpec => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      needsPermission: false,
      ...extra,
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        return "ok";
      },
    });
    const tools = [slow("spawn_worker", { concurrent: true }), slow("write", {})];
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [
            { choices: [{ delta: { tool_calls: [
              { index: 0, id: "w", type: "function", function: { name: "spawn_worker", arguments: "{}" } },
              { index: 1, id: "m", type: "function", function: { name: "write", arguments: "{}" } },
            ] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools,
      executor: new RealToolExecutor(tools),
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });
    assert.equal(maxActive, 1);
  });

  it("sends the delegation directive on every request without persisting it", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "base prompt" },
      { role: "user", content: "investigate A and B" },
    ];
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }];
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const read: ToolSpec = { name: "read", description: "read", parameters: { type: "object", properties: {} }, needsPermission: false, isReadOnly: true, run: async () => "contents" };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [read],
      executor: { list: () => [read], run: async (call: { id: string; name: string }) => ({ tool_call_id: call.id, name: call.name, ok: true, content: "contents" }) } as unknown as ToolExecutor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      delegationDirective: "Delegate independent research with spawn_worker.",
      callbacks: { askPermission: async () => "allow" },
    });
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      const directive = body.messages.findIndex((m) => m.role === "system" && String(m.content).includes("Delegate independent research"));
      assert.equal(directive, 2, "directive follows the turn's user message on every iteration");
    }
    assert.ok(!JSON.stringify(messages).includes("Delegate independent research"), "directive is never persisted");
  });

  it("compacts older turns at preflight to fit the model budget, in place", async () => {
    const big = "y".repeat(140_000); // ~40k estimated tokens per turn
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 4; i++) {
      messages.push({ role: "user", content: `q${i}` });
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: `r${i}`, type: "function", function: { name: "read", arguments: "{}" } }] });
      messages.push({ role: "tool", tool_call_id: `r${i}`, name: "read", content: big });
      messages.push({ role: "assistant", content: `a${i}` });
    }
    messages.push({ role: "user", content: "current question" });
    const original = messages;
    let sentTokens = 0;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
      sentTokens = body.messages.reduce((n, m) => n + String(m.content ?? "").length, 0) / 3.5;
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ finish_reason: "stop" }] }]) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const state = { value: (await import("./session-state.js")).emptySessionState() };
    const { ArtifactStore } = await import("./session-state.js");
    const store = new ArtifactStore();
    const compacted: Array<{ tokensBefore: number; tokensAfter: number }> = [];
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "unknown/small-model", // inferred 128k window → ~103k input budget
      messages,
      tools: [],
      executor: { list: () => [], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      compaction: { getState: () => state.value, setState: (s) => { state.value = s; }, getStore: () => store },
      callbacks: { askPermission: async () => "allow", onCompacted: (info) => compacted.push(info) },
    });
    assert.equal(compacted.length, 1);
    assert.ok(compacted[0]!.tokensBefore > 103_424 && compacted[0]!.tokensAfter <= 103_424);
    assert.ok(sentTokens <= 103_424, `request fit the budget: ${sentTokens}`);
    assert.equal(messages, original, "same array instance");
    assert.equal(messages.at(-1)!.content, "ok", "host's array holds the final answer");
    assert.ok(store.list().length > 0, "archived raw tool output is kept");
  });

  it("fails deterministically with ContextBudgetError when the active turn alone is too large", async () => {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response("unexpected", { status: 500 });
    };
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "z".repeat(500_000) },
    ];
    const { ArtifactStore, emptySessionState } = await import("./session-state.js");
    const store = new ArtifactStore();
    await assert.rejects(
      runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "unknown/small-model",
        messages,
        tools: [],
        executor: { list: () => [], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor,
        cwd: "/tmp",
        signal: new AbortController().signal,
        compaction: { getState: emptySessionState, setState: () => {}, getStore: () => store },
        callbacks: { askPermission: async () => "allow" },
      }),
      (err: Error) => err.name === "ContextBudgetError" && /current turn alone is too large/.test(err.message),
    );
    assert.equal(requests, 0, "no request was sent");
  });

  it("keeps the caller's messages array in sync when onIterationEnd returns a new one", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
    ];
    const original = messages;
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "t1", type: "function", function: { name: "read", arguments: "{}" } }] } }] }, { choices: [{ finish_reason: "tool_calls" }] }]
        : [{ choices: [{ delta: { content: "final" } }] }, { choices: [{ finish_reason: "stop" }] }];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const read: ToolSpec = { name: "read", description: "read", parameters: { type: "object", properties: {} }, needsPermission: false, run: async () => "data" };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [read],
      executor: { list: () => [read], run: async (call: { id: string; name: string }) => ({ tool_call_id: call.id, name: call.name, ok: true, content: "data" }) } as unknown as ToolExecutor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      // Simulates a host compaction that returns a fresh array.
      onIterationEnd: async (current) => current.filter(() => true),
      callbacks: { askPermission: async () => "allow" },
    });
    assert.equal(messages, original);
    assert.equal(messages.at(-1)!.content, "final", "messages appended after the hook reach the caller's array");
  });

  it("keeps subagents as direct tools next to execute_code in Code Mode", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "investigate auth and billing" },
    ];
    let active = 0;
    let maxActive = 0;
    const read: ToolSpec = { name: "read", description: "read a file", parameters: { type: "object", properties: {} }, needsPermission: false, isReadOnly: true, run: async () => "x" };
    const subagent: ToolSpec<{ mission: string }> = {
      name: "subagent",
      description: "delegate",
      parameters: { type: "object", properties: { mission: { type: "string" } } },
      needsPermission: false,
      concurrent: true,
      codeModeDirect: true,
      run: async (args) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return `findings: ${args.mission}`;
      },
    };
    const bodies: Array<{ tools?: Array<{ function: { name: string; description: string } }> }> = [];
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [
            { choices: [{ delta: { tool_calls: ["auth", "billing"].map((mission, index) => ({ index, id: `s-${mission}`, type: "function", function: { name: "subagent", arguments: JSON.stringify({ mission }) } })) } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ]
        : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [read, subagent],
      executor: new RealToolExecutor([read, subagent]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      codeMode: true,
      callbacks: { askPermission: async () => "allow" },
    });
    const offered = bodies[0]!.tools!.map((t) => t.function.name);
    assert.deepEqual(offered, ["execute_code", "subagent"]);
    const api = bodies[0]!.tools![0]!.function.description;
    assert.match(api, /read/);
    assert.doesNotMatch(api.split("Not in this API")[0]!, /subagent/, "subagent is not in the sandbox API");
    assert.match(api, /Not in this API — call these as separate tools instead: subagent/);
    assert.equal(maxActive, 2, "both subagents ran in parallel");
    assert.deepEqual(messages.filter((m) => m.role === "tool").map((m) => m.content), ["findings: auth", "findings: billing"]);
  });

  it("turns Code Mode off, with one warning, when the isolated-vm sandbox is unavailable", async () => {
    const { setSecureSandboxProbeForTesting, resetFallbackWarningFlag } = await import("../code-mode/sandbox.js");
    setSecureSandboxProbeForTesting("Cannot find module 'isolated-vm'");
    resetFallbackWarningFlag();
    const read: ToolSpec = { name: "read", description: "read", parameters: { type: "object", properties: {} }, needsPermission: false, isReadOnly: true, run: async () => "x" };
    const bodies: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }]) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const warnings: string[] = [];
    const turn = () =>
      runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "test/model",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "go" }],
        tools: [read],
        executor: new RealToolExecutor([read]),
        cwd: "/tmp",
        sessionId: "no-sandbox",
        signal: new AbortController().signal,
        codeMode: true,
        callbacks: { askPermission: async () => "allow", onWarning: (w) => warnings.push(w) },
      });
    try {
      await turn();
      await turn();
      assert.deepEqual(bodies[0]!.tools!.map((t) => t.function.name), ["read"], "no execute_code without the sandbox");
      assert.equal(warnings.filter((w) => w.startsWith("Code Mode is off")).length, 1);
    } finally {
      setSecureSandboxProbeForTesting(undefined);
      resetFallbackWarningFlag();
    }
  });

  it("maps the legacy spawn_worker name onto the subagent tool", async () => {
    const messages: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
    const seen: string[] = [];
    const subagent: ToolSpec = { name: "subagent", description: "d", parameters: { type: "object", properties: {} }, needsPermission: false, concurrent: true, run: async (args) => { seen.push(JSON.stringify(args)); return "ok"; } };
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      const encoder = new TextEncoder();
      const events = requests === 1
        ? [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "old", type: "function", function: { name: "spawn_worker", arguments: JSON.stringify({ mode: "plan", task: "legacy mission" }) } }] } }] }, { choices: [{ finish_reason: "tool_calls" }] }]
        : [{ choices: [{ delta: { content: "done" } }] }, { choices: [{ finish_reason: "stop" }] }];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [subagent],
      executor: new RealToolExecutor([subagent]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });
    assert.equal(seen.length, 1, "executed rather than rejected as unavailable");
    assert.equal(messages.find((m) => m.role === "assistant")?.tool_calls?.[0]?.function.name, "subagent");
  });

  describe("end-of-turn completion check", () => {
    function scripted(responses: Array<Array<Record<string, unknown>>>) {
      const bodies: Array<{ messages: ChatMessage[] }> = [];
      globalThis.fetch = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const events = responses[Math.min(bodies.length - 1, responses.length - 1)]!;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      return bodies;
    }
    const say = (content: string) => [{ choices: [{ delta: { content } }] }, { choices: [{ finish_reason: "stop" }] }];
    const run = (messages: ChatMessage[], completionCheck: (i: unknown) => Promise<number | null>, tier: "light" | "medium" = "medium", guardrails: string[] = []) =>
      runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "test/model",
        messages,
        tools: [],
        executor: { list: () => [], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor,
        cwd: "/tmp",
        signal: new AbortController().signal,
        intentClassification: { intent: "x", tier, rawScore: 0.5, confidence: 0.8 },
        completionCheck: async (input) => completionCheck(input),
        callbacks: { askPermission: async () => "allow", onGuardrail: (ev) => guardrails.push(ev.kind) },
      });

    it("asks the agent to continue once when it stopped after only planning", async () => {
      const bodies = scripted([say("I've reviewed the repo. Next I'll implement it."), say("Still planning."), say("unused")]);
      const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "Implement the feature" }];
      const guardrails: string[] = [];
      let checks = 0;
      await run(messages, async () => { checks++; return 0.03; }, "medium", guardrails);
      assert.equal(bodies.length, 2, "one continuation, then the turn ends");
      assert.equal(checks, 1, "checked once; never loops");
      assert.ok(bodies[1]!.messages.some((m) => m.role === "system" && String(m.content).includes("You ended your turn before completing")));
      assert.deepEqual(guardrails, ["completion_nudge"]);
    });

    it("ends normally when the check says the work is done, unavailable, or the turn is light", async () => {
      for (const [p, tier, expectedChecks] of [[0.96, "medium", 1], [null, "medium", 1], [0.01, "light", 0]] as const) {
        const bodies = scripted([say("Done: fixed the typo in README.md.")]);
        let checks = 0;
        await run([{ role: "system", content: "s" }, { role: "user", content: "fix it" }], async () => { checks++; return p; }, tier);
        assert.equal(bodies.length, 1);
        assert.equal(checks, expectedChecks);
      }
    });
  });

  it("awaits a promised delegation directive and sends it", async () => {
    const bodies: Array<{ messages: ChatMessage[] }> = [];
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ finish_reason: "stop" }] }]) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages: [{ role: "system", content: "s" }, { role: "user", content: "audit three subsystems" }],
      tools: [],
      executor: { list: () => [], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      delegationDirective: new Promise((r) => setTimeout(() => r("Launch one subagent per part."), 20)),
      callbacks: { askPermission: async () => "allow" },
    });
    assert.ok(bodies[0]!.messages.some((m) => m.role === "system" && String(m.content).includes("Launch one subagent per part.")));
  });
});
