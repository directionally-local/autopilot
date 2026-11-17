import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { renderAppWithBridge, type Cfg } from "./app.js";
import type { ChatMessage } from "./agent/messages.js";
import type { AppActions, AppSnapshot } from "./ui/app-bridge.js";
import { PARALLEL_MCP_URL } from "./tools/parallel-search.js";
import { getUserAgent } from "./util/version.js";

const fields = { objective: "Find the public Node.js fs readFile documentation", search_queries: ["Node.js fs readFile documentation"] };
const command = `/search parallel-public-docs ${JSON.stringify(fields)}`;
const sourceUrl = "https://nodejs.org/api/fs.html";

async function until(condition: () => unknown, detail: () => unknown = () => "") {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `Timed out: ${JSON.stringify(detail())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Real App, supervisor and native Agent loop. Only the model and (unless
 * explicitly opted into live retrieval) the external MCP service are fixtures.
 * Cwd and home contain no real project, credentials, account or session state. */
async function appFixture(live = false, initialPrompt?: { full: string; display: string }) {
  const previousCwd = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "foreground-app-"));
  process.chdir(root);
  let script: "plan" | "plain" | "search" = "plain";
  const modelRequests: Array<{ messages: ChatMessage[] }> = [];
  const server = createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-test-fixture", max_model_len: 32768 }] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: ChatMessage[] };
      modelRequests.push(body);
      const lastUser = body.messages.findLastIndex((m) => m.role === "user");
      const tool = body.messages.slice(lastUser + 1).findLast((m) => m.role === "tool");
      const url = tool && /https:\/\/nodejs\.org\/[^\s"<>\\]+/.exec(String(tool.content))?.[0];
      const delta = script === "plan" ? { content: command }
        : script === "plain" ? { content: "The generated prompt was received as ordinary text." }
        : tool ? { content: url ? `The public documentation is here: ${url}` : "No result was available." }
        : { tool_calls: [{ index: 0, id: "lookup", type: "function", function: { name: "search_web", arguments: JSON.stringify({ query: fields.objective }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" in delta ? "tool_calls" : "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const originalFetch = globalThis.fetch;
  const outbound: Array<{ body: { method: string; params?: unknown }; userAgent: string | null }> = [];
  const unexpected: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith(baseUrl)) return originalFetch(url, init);
    if (String(url) !== PARALLEL_MCP_URL) {
      unexpected.push(String(url));
      throw new Error(`Unexpected external request: ${String(url)}`);
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(init?.redirect, "error");
    const body = JSON.parse(init?.body as string) as { id?: number; method: string; params?: { protocolVersion?: string } };
    outbound.push({ body, userAgent: new Headers(init?.headers).get("User-Agent") });
    if (live) return originalFetch(url, init);
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = body.method === "initialize"
      ? { protocolVersion: body.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { content: [{ type: "text", text: `Node.js documentation\nURL: ${sourceUrl}` }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { headers: { "content-type": "application/json" } });
  };
  let actions: AppActions;
  let snapshot: AppSnapshot;
  const snapshots: AppSnapshot[] = [];
  const cfg: Cfg = {
    model: "local-test-fixture", baseUrl, codeMode: false, memoryEnabled: false,
    modesEnabled: true, subagentPolicy: "off", projectTour: false, starTip: false, inviteTip: false,
    mcpServers: {}, lspEnabled: false, coauthor: false,
  };
  const running = renderAppWithBridge(cfg, {
    connect(next) { actions = next; },
    sync(next) { snapshot = next; snapshots.push(next); },
  }, { hasUpdate: false, localVersion: "3.24.0", latestVersion: "3.24.0" }, "global", null, { initialPrompt });
  await until(() => actions! && snapshot!);
  const text = () => snapshot.events.map((e) => "text" in e ? e.text : "").join("\n");
  const preview = async () => {
    const before = snapshots.length;
    actions.submit(command);
    await until(() => snapshots.length > before && /By typing \/search approve/.test(text()), text);
    return [...text().matchAll(/By typing \/search approve ([\w-]+)/g)].at(-1)![1]!;
  };
  return {
    get actions() { return actions; }, get snapshot() { return snapshot; },
    snapshots, text, preview, outbound, modelRequests,
    setScript(next: typeof script) { script = next; },
    async idleAfter(count: number) {
      await until(() => modelRequests.length > count && !snapshot.busy, text);
    },
    async close() {
      actions.exit();
      await running;
      globalThis.fetch = originalFetch;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
      assert.deepEqual(unexpected, [], "unrelated services must never receive test data");
    },
  };
}

test("a real generated plan starting /search cannot open a preview or authorize Parallel", async () => {
  const app = await appFixture();
  try {
    app.actions.pickMode("plan");
    await until(() => app.snapshot.mode === "plan");
    app.setScript("plan");
    app.actions.submit("Draft a plan for finding the public documentation.");
    await until(() => app.snapshot.modals.includes("planComplete"), app.text);
    assert.ok(app.text().includes(command), "the deterministic model actually generated the /search plan");
    app.setScript("plain");
    const before = app.modelRequests.length;
    app.actions.pickPlanComplete("auto");
    await app.idleAfter(before);
    assert.equal(app.modelRequests.at(-1)!.messages.findLast((m) => m.role === "user")?.content, command);
    assert.ok(app.snapshots.every((s) => s.events.every((e) => !("text" in e) || !e.text.includes("lookup preview"))));
    assert.equal(app.outbound.length, 0, "generated plan resubmission performs no Parallel I/O");
  } finally { await app.close(); }
});

test("typed bridge input approves the exact public lookup once through the real App and Agent", async () => {
  await checkTypedApp(false);
});

test("typed foreground lookup with a local model and live keyless Parallel retrieval", { skip: process.env.AUTOPILOT_TEST_LIVE_PARALLEL !== "1" }, async () => {
  await checkTypedApp(true);
});

async function checkTypedApp(live: boolean) {
  const app = await appFixture(live);
  try {
    app.setScript("search");
    const token = await app.preview();
    assert.equal(app.outbound.length, 0);
    assert.equal(app.modelRequests.length, 0, "preview and token never reach the model");
    assert.ok(app.text().includes(JSON.stringify(fields, null, 2)));
    assert.ok(app.text().includes(PARALLEL_MCP_URL));
    app.actions.submit(`/search approve ${token}`);
    app.actions.submit(`/search approve ${token}`); // type-ahead while busy must not queue
    await app.idleAfter(0);
    const calls = app.outbound.filter((r) => r.body.method === "tools/call");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.body.params, { name: "web_search", arguments: fields });
    assert.ok(app.outbound.every((r) => r.userAgent === getUserAgent()));
    const answer = app.snapshot.events.findLast((e) => e.kind === "assistant");
    assert.ok(answer?.kind === "assistant");
    const original = /https:\/\/nodejs\.org\/[^\s"<>\\]+/.exec(answer.text)?.[0];
    assert.ok(original, app.text());
    const toolResult = app.modelRequests.at(-1)!.messages.findLast((m) => m.role === "tool");
    assert.ok(String(toolResult?.content).includes(original));
    assert.equal(app.modelRequests.length, 2);
    app.actions.submit(`/search approve ${token}`); // replay after the turn also fails
    await until(() => app.text().includes("No matching public-documentation preview"), app.text);
    assert.equal(app.modelRequests.length, 2);
    assert.ok(app.snapshots.every((s) => s.events.every((e) => e.kind !== "user" || !e.text.includes(token))));
    if (live) console.log(JSON.stringify({ retrieval: "live keyless Parallel via typed App bridge", model: "deterministic localhost fixture", destination: PARALLEL_MCP_URL, arguments: fields, userAgent: calls[0]!.userAgent, originalSourceUrl: original, answer: answer.text }));
  } finally { await app.close(); }
}

test("startup handoff, dialog command and permission feedback cannot prepare or approve a lookup", async () => {
  const app = await appFixture(false, { full: command, display: "Startup handoff" });
  try {
    await app.idleAfter(0);
    assert.ok(!app.text().includes("lookup preview"));
    app.actions.runCommand(command);
    const token = await app.preview();
    const before = app.modelRequests.length;
    app.actions.denyWithFeedback(`/search approve ${token}`);
    await app.idleAfter(before);
    app.actions.submit(`/search approve ${token}`);
    await until(() => app.text().includes("No matching public-documentation preview"), app.text);
    assert.equal(app.outbound.length, 0);
  } finally { await app.close(); }
});


test("Esc or SIGINT immediately after approval cancels preparation before any model or Parallel I/O", async () => {
  for (const interrupt of ["Esc", "SIGINT"]) {
    const app = await appFixture();
    try {
      app.setScript("search");
      const token = await app.preview();
      app.actions.submit(`/search approve ${token}`);
      if (interrupt === "Esc") app.actions.interrupt();
      else process.emit("SIGINT");
      await until(() => !app.snapshot.busy && app.text().includes("(interrupted)"), app.text);
      assert.equal(app.modelRequests.length, 0, interrupt);
      assert.equal(app.outbound.length, 0, interrupt);
      // The cancelled token cannot restart the lookup or remain queued.
      app.actions.submit(`/search approve ${token}`);
      await until(() => app.text().includes("No matching public-documentation preview"), app.text);
      assert.equal(app.outbound.length, 0, interrupt);
      // Preparation cleanup leaves the terminal able to authorize a fresh turn.
      const fresh = await app.preview();
      app.actions.submit(`/search approve ${fresh}`);
      await app.idleAfter(0);
      assert.equal(app.outbound.filter((r) => r.body.method === "tools/call").length, 1, interrupt);
    } finally { await app.close(); }
  }
});
