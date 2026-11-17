import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { runAgentTurn, type AgentTurnOpts } from "./loop.js";
import type { ChatMessage } from "./messages.js";
import { ALL_TOOLS, ToolExecutor } from "../tools/executor.js";
import { createForegroundSearchChoice } from "../ui/foreground-search.js";
import { PARALLEL_MCP_URL } from "../tools/parallel-search.js";
import { getUserAgent } from "../util/version.js";
import type { HooksManager } from "../hooks/manager.js";

const fields = { objective: "Find the public Node.js fs readFile documentation", search_queries: ["Node.js fs readFile documentation"] };
const sourceUrl = "https://nodejs.org/api/fs.html#fspromisesreadfilepath-options";
const searchTool = ALL_TOOLS.find((tool) => tool.name === "search_web")!;

function approved(signal: AbortSignal) {
  const choice = createForegroundSearchChoice();
  const preview = choice.command(`parallel-public-docs ${JSON.stringify(fields)}`);
  const token = /\/search approve ([\w-]+)/.exec(preview.notice)![1]!;
  return choice.command(`approve ${token}`).permit!.bind(signal);
}

/** A deterministic local model fixture. Its second reply cites a URL actually
 * present in the normal tool-result message, with no hard-coded answer URL. */
async function modelFixture() {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-test-fixture", max_model_len: 32768 }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const messages = body.messages as ChatMessage[];
      const result = messages.findLast((m) => m.role === "tool");
      const resultText = result && typeof result.content === "string" ? result.content : "";
      const url = /https:\/\/nodejs\.org\/[^\s"<>\\]+/.exec(resultText)?.[0];
      const delta = result
        ? { content: url ? `The public documentation is here: ${url}` : "No public documentation result was available." }
        : { tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: fields.objective }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [{ choices: [{ index: 0, delta }] }, { choices: [{ index: 0, delta: {}, finish_reason: result ? "stop" : "tool_calls" }] }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function mcpFixture(init?: RequestInit, content = `1. Node.js documentation\nURL: ${sourceUrl}\nreadFile reads the contents of a file.`) {
  const body = JSON.parse(init?.body as string) as { id?: number; method: string; params?: { protocolVersion?: string } };
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  const result = body.method === "initialize"
    ? { protocolVersion: body.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
    : { content: content ? [{ type: "text", text: content }] : [] };
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
}

test("native agent loop selects Parallel and carries an original URL into its normal answer (fixtures)", async () => {
  await checkNativeLoop(false);
});

test("native agent loop with a deterministic local model and real keyless Parallel retrieval", { skip: process.env.AUTOPILOT_TEST_LIVE_PARALLEL !== "1" }, async () => {
  await checkNativeLoop(true);
});

async function checkNativeLoop(live: boolean) {
  const model = await modelFixture();
  const originalFetch = globalThis.fetch;
  const outbound: Array<{ body: { method: string; params?: unknown }; userAgent: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(model.baseUrl)) return originalFetch(url, init);
    assert.equal(String(url), PARALLEL_MCP_URL);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(init?.body as string) as { method: string; params?: unknown };
    outbound.push({ body, userAgent: new Headers(init?.headers).get("User-Agent") });
    return live ? originalFetch(url, init) : mcpFixture(init);
  };
  try {
    const signal = new AbortController().signal;
    const messages: ChatMessage[] = [{ role: "system", content: "Look up the public documentation and include its original source URL." }, { role: "user", content: fields.objective }];
    await runAgentTurn({
      model: "local-test-fixture", customEndpoint: { baseUrl: model.baseUrl }, messages,
      tools: [searchTool], executor: new ToolExecutor([searchTool]), cwd: process.cwd(), signal,
      foregroundSearch: approved(signal), codeMode: false,
      callbacks: { askPermission: async () => "allow" },
    });
    const calls = outbound.filter((request) => request.body.method === "tools/call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.body.params, { name: "web_search", arguments: fields });
    assert.ok(outbound.every((request) => request.userAgent === getUserAgent()));
    const toolMessage = messages.find((m) => m.role === "tool");
    assert.ok(toolMessage && typeof toolMessage.content === "string");
    const source = /https:\/\/nodejs\.org\/[^\s"<>\\]+/.exec(toolMessage.content)?.[0];
    assert.ok(source, `Expected an original Node.js source URL: ${toolMessage.content.slice(0, 1000)}`);
    assert.ok(String(messages.at(-1)?.content).includes(source));
    assert.equal(model.requests.length, 2);
    if (live) console.log(JSON.stringify({ retrieval: "live keyless Parallel", model: "deterministic local fixture", destination: PARALLEL_MCP_URL, arguments: fields, userAgent: calls[0]!.userAgent, originalSourceUrl: source, answer: messages.at(-1)?.content }));
  } finally {
    globalThis.fetch = originalFetch;
    await model.close();
  }
}

test("changed text, extra metadata, a different turn, delegated and sandbox contexts cannot spend the permit", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("unexpected network"); };
  try {
    const signal = new AbortController().signal;
    const search = approved(signal);
    const ctx = { cwd: process.cwd(), signal };
    for (const args of [{ query: "model generated text" }, { query: fields.objective, count: 1 }, { query: fields.objective, session_id: "extra" }]) {
      await assert.rejects(search.run(args, ctx), /exact approved/);
    }
    for (const changed of [{ signal: new AbortController().signal }, { runId: "background-run" }, { codeModeParentToolCallId: "sandbox-call" }]) {
      await assert.rejects(search.run({ query: fields.objective }, { ...ctx, ...changed }), /original active foreground/);
    }
    const controller = new AbortController();
    const aborted = approved(controller.signal);
    controller.abort();
    await assert.rejects(aborted.run({ query: fields.objective }, { cwd: process.cwd(), signal: controller.signal }), /original active foreground/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("headless, durable and Code Mode turns reject foreground selection before any I/O", async () => {
  for (const mode of [{ headless: true }, { runId: "background" }, { codeMode: true }]) {
    const signal = new AbortController().signal;
    const opts: AgentTurnOpts = {
      model: "local-test-fixture", messages: [], tools: [searchTool], executor: new ToolExecutor([searchTool]),
      cwd: process.cwd(), signal, foregroundSearch: approved(signal), callbacks: { askPermission: async () => "allow" }, ...mode,
    };
    await assert.rejects(runAgentTurn(opts), /native foreground turn/);
  }
});

test("one permit remains single-use under concurrent native calls and empty results", async () => {
  const originalFetch = globalThis.fetch;
  let queries = 0;
  globalThis.fetch = async (_url, init) => {
    if ((init?.body as string).includes('"tools/call"')) queries++;
    return mcpFixture(init, "");
  };
  try {
    const signal = new AbortController().signal;
    const search = approved(signal);
    const ctx = { cwd: process.cwd(), signal };
    const results = await Promise.allSettled([search.run({ query: fields.objective }, ctx), search.run({ query: fields.objective }, ctx)]);
    assert.equal(queries, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const result = results.find((item) => item.status === "fulfilled");
    assert.ok(result?.status === "fulfilled" && result.value.content.includes("No results found"));
    await assert.rejects(search.run({ query: fields.objective }, ctx), /already been consumed/);
  } finally { globalThis.fetch = originalFetch; }
});

test("unavailable retrieval consumes approval and never falls back to DuckDuckGo", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => { urls.push(String(url)); return new Response("unavailable", { status: 503 }); };
  try {
    const signal = new AbortController().signal;
    const search = approved(signal);
    const ctx = { cwd: process.cwd(), signal };
    await assert.rejects(search.run({ query: fields.objective }, ctx));
    await assert.rejects(search.run({ query: fields.objective }, ctx), /already been consumed/);
    assert.deepEqual(urls, [PARALLEL_MCP_URL]);
  } finally { globalThis.fetch = originalFetch; }
});

test("inactive native agent loop keeps DuckDuckGo and returns its original URL", async () => {
  const model = await modelFixture();
  const originalFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(model.baseUrl)) return originalFetch(url, init);
    const target = new URL(String(url));
    assert.equal(target.origin, "https://html.duckduckgo.com");
    assert.equal(target.searchParams.get("q"), fields.objective);
    searches++;
    return new Response(`<div class="result"><div><a class="result__a" href="${sourceUrl}">Public documentation</a><a class="result__snippet">readFile documentation</a></div></div>`);
  };
  try {
    const messages: ChatMessage[] = [{ role: "user", content: fields.objective }];
    await runAgentTurn({ model: "local-test-fixture", customEndpoint: { baseUrl: model.baseUrl }, messages, tools: [searchTool], executor: new ToolExecutor([searchTool]), cwd: process.cwd(), signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" } });
    assert.equal(searches, 1);
    assert.ok(String(messages.at(-1)?.content).includes(sourceUrl));
  } finally { globalThis.fetch = originalFetch; await model.close(); }
});

test("native hook veto is preserved despite a foreground permit and generic auto-approval", async () => {
  const hooks = {
    hasEnabledHooks: (event: string) => event === "PreToolUse",
    fire: async () => ({ vetoed: true, vetoReason: "user policy" }),
  } as unknown as HooksManager;
  const signal = new AbortController().signal;
  const result = await new ToolExecutor([searchTool], { hooks }).run(
    { id: "denied", name: "search_web", arguments: JSON.stringify({ query: fields.objective }) },
    async () => "allow", { cwd: process.cwd(), signal }, undefined, { foregroundSearch: approved(signal) },
  );
  assert.equal(result.denied, true);
  assert.equal(result.errorCode, "policy_rejection");
});

test("ending a turn revokes even an unused permit", async () => {
  const signal = new AbortController().signal;
  const search = approved(signal);
  await assert.rejects(runAgentTurn({ model: "local-test-fixture", messages: [], tools: [], executor: new ToolExecutor([]), cwd: process.cwd(), signal, foregroundSearch: search, headless: true, callbacks: { askPermission: async () => "allow" } }));
  await assert.rejects(search.run({ query: fields.objective }, { cwd: process.cwd(), signal }), /original active foreground/);
});

test("foreground cancellation aborts an in-flight HTTP request", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let httpSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => {
    httpSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      httpSignal!.addEventListener("abort", () => reject(httpSignal!.reason), { once: true });
      controller.abort(new Error("user cancelled"));
    });
  };
  try {
    await assert.rejects(approved(controller.signal).run({ query: fields.objective }, { cwd: process.cwd(), signal: controller.signal }), /user cancelled/);
    assert.equal(httpSignal?.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});

test("the 15-second request deadline aborts HTTP I/O", async (t) => {
  const originalFetch = globalThis.fetch;
  const timeout = new AbortController();
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 15_000);
    return timeout.signal;
  });
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    timeout.abort(new DOMException("request deadline", "TimeoutError"));
  });
  try {
    const signal = new AbortController().signal;
    await assert.rejects(approved(signal).run({ query: fields.objective }, { cwd: process.cwd(), signal }), /request deadline/);
  } finally { globalThis.fetch = originalFetch; }
});
