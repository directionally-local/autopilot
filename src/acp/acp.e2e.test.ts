/**
 * `autopilot acp` end to end: the real CLI in a child process, driven over
 * stdio by the ACP SDK's own client side (as Zed or T3 Code would), against
 * a fake OpenAI-compatible model server and a stdio MCP server the client
 * passes in. Covers the handshake, sessions (new, list, load), streaming,
 * tool calls with permission prompts (allowed and denied), MCP passthrough,
 * model and mode selection, cancel, and the no-credentials error.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  client as acpClient,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

const ROOT = join(import.meta.dirname, "..", "..");
const ENTRY = join(ROOT, "src", "index.tsx");
const SETUP = join(ROOT, "scripts", "test-setup.mjs");

// ── A fake model server ─────────────────────────────────────────────────────

type Reply = { text?: string; toolCall?: { name: string; args: Record<string, unknown> }; hang?: boolean };

interface FakeModel {
  url: string;
  replies: Reply[];
  /** Every chat request body, in order. */
  requests: Array<{ model: string; messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools?: Array<{ function: { name: string } }> }>;
  userAgents: string[];
  close(): Promise<void>;
}

async function fakeModel(): Promise<FakeModel> {
  const replies: Reply[] = [];
  const requests: FakeModel["requests"] = [];
  const userAgents: string[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "fake-a", object: "model" }, { id: "fake-b", object: "model" }] }));
        return;
      }
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as FakeModel["requests"][number];
      // Side calls (titles, classification) carry no tools; only turns are scripted.
      if (!parsed.tools?.length) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify(chunk({ content: "ok" }, "stop"))}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      requests.push(parsed);
      userAgents.push(String(req.headers["user-agent"] ?? ""));
      const reply = replies.shift() ?? { text: "(no reply scripted)" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (reply.hang) {
        res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: "Working" }))}\n\n`);
        req.socket.on("close", () => res.destroy());
        return; // never finishes: the client cancels
      }
      if (reply.toolCall) {
        const id = `call-${++n}`;
        res.write(`data: ${JSON.stringify(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: reply.toolCall.name, arguments: "" } }] }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.toolCall.args) } }] }, "tool_calls"))}\n\n`);
      } else {
        const text = reply.text ?? "";
        const half = Math.ceil(text.length / 2);
        res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: text.slice(0, half) }))}\n\n`);
        res.write(`data: ${JSON.stringify(chunk({ content: text.slice(half) }, "stop"))}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    replies,
    requests,
    userAgents,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: "chatcmpl-1", model: "fake-a", choices: [{ index: 0, delta, finish_reason: finish }] };
}

// ── A stdio MCP server (raw JSON-RPC, one tool: ping) ───────────────────────

const MCP_SERVER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
  else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "ping", description: "Answers pong", inputSchema: { type: "object", properties: { word: { type: "string" } } } }] } });
  else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "pong:" + (msg.params.arguments.word ?? "") + ":" + (process.env.ECHO_SUFFIX ?? "") }] } });
  else send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
});
`;

// ── The agent process and the SDK client ────────────────────────────────────

interface Agent {
  child: ChildProcess;
  connection: ClientConnection;
  updates: SessionNotification[];
  permissions: RequestPermissionRequest[];
  /** How the next permission request is answered. */
  answer: (req: RequestPermissionRequest) => RequestPermissionResponse;
  stderr: () => string;
  stop(): Promise<void>;
}

function startAgent(overrides: Record<string, string | undefined>): Agent {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...overrides })) if (v !== undefined) env[k] = v;
  const child = spawn(process.execPath, ["--import", "tsx", "--import", SETUP, ENTRY, "acp"], {
    cwd: ROOT,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const agent: Agent = {
    child,
    updates: [],
    permissions: [],
    answer: () => ({ outcome: { outcome: "selected", optionId: "allow_once" } }),
    stderr: () => stderr,
    connection: undefined as unknown as ClientConnection,
    async stop() {
      agent.connection.close();
      child.stdin!.end();
      if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
    },
  };
  const app = acpClient({ name: "test-client" })
    .onNotification("session/update", ({ params }) => {
      agent.updates.push(params);
    })
    .onRequest("session/request_permission", ({ params }) => {
      agent.permissions.push(params);
      return agent.answer(params);
    });
  agent.connection = app.connect(
    ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>),
  );
  return agent;
}

const textOf = (updates: SessionNotification[], kind: string) =>
  updates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === kind)
    .map((u) => ("content" in u && u.content && !Array.isArray(u.content) && u.content.type === "text" ? u.content.text : ""))
    .join("");

describe("autopilot acp over stdio", { timeout: 120_000 }, () => {
  let model: FakeModel;
  let agent: Agent;
  let cwd: string;
  let mcpScript: string;
  let sessionId: string;

  before(async () => {
    model = await fakeModel();
    cwd = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-")));
    mcpScript = join(cwd, "..", `mcp-echo-${process.pid}.mjs`);
    writeFileSync(mcpScript, MCP_SERVER);
    agent = startAgent({
      AUTOPILOT_BASE_URL: model.url,
      AUTOPILOT_API_KEY: "test-key",
      KIMI_MODEL: "fake-a",
      AUTOPILOT_SUBAGENT_POLICY: "off",
      AUTOPILOT_COMPILED_CONTEXT: "0",
    });
  });

  after(async () => {
    await agent?.stop();
    await model?.close();
  });

  it("initializes as dl-autopilot with sign-in methods and session capabilities", async () => {
    const init = await agent.connection.agent.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true, auth: { terminal: true } },
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    assert.strictEqual(init.protocolVersion, 1);
    assert.strictEqual(init.agentInfo?.name, "dl-autopilot");
    assert.strictEqual(init.agentInfo?.title, "Autopilot by dl.new");
    assert.strictEqual(init.agentCapabilities?.loadSession, true);
    assert.deepStrictEqual(init.agentCapabilities?.mcpCapabilities, { http: true, sse: true });
    const terminal = init.authMethods?.find((m) => "type" in m && m.type === "terminal");
    assert.ok(terminal && "args" in terminal, "a terminal sign-in for clients that can open one");
    assert.deepStrictEqual(terminal.args, ["--login"]);
    assert.ok(init.authMethods?.some((m) => m.id === "dl-login"));
  });

  it("starts a session with modes, the provider's models and the client's MCP server", async () => {
    const res = await agent.connection.agent.request("session/new", {
      cwd,
      mcpServers: [{ name: "echo", command: process.execPath, args: [mcpScript], env: [{ name: "ECHO_SUFFIX", value: "from-zed" }] }],
    });
    sessionId = res.sessionId;
    assert.strictEqual(res.modes?.currentModeId, "edit");
    const modelOption = res.configOptions?.find((o) => o.id === "model");
    assert.ok(modelOption && modelOption.type === "select");
    assert.strictEqual(modelOption.currentValue, "fake-a");
    const values = (modelOption.options as Array<{ value: string }>).map((o) => o.value);
    assert.ok(values.includes("fake-a") && values.includes("fake-b"), `models: ${values.join(", ")}`);
  });

  it("streams a reply, with the model's tools including the MCP tool, as Autopilot", async () => {
    model.replies.push({ text: "Hello from the fake model." });
    const res = await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });
    assert.strictEqual(res.stopReason, "end_turn");
    assert.strictEqual(textOf(agent.updates, "agent_message_chunk"), "Hello from the fake model.");
    const last = model.requests.at(-1)!;
    assert.strictEqual(last.model, "fake-a");
    assert.ok(last.tools?.some((t) => t.function.name === "mcp_echo_ping"), "the client's MCP tool is offered");
    assert.match(model.userAgents.at(-1)!, /^autopilot\//, "requests identify as Autopilot");
    assert.ok(agent.updates.some((u) => u.update.sessionUpdate === "usage_update"));
  });

  it("asks before a write; allowed, the file is written and the tool call completes", async () => {
    agent.updates.length = 0;
    agent.answer = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } });
    model.replies.push({ toolCall: { name: "write", args: { path: "hello.txt", content: "hi there\n" } } }, { text: "Wrote it." });
    const res = await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write hello.txt" }] });
    assert.strictEqual(res.stopReason, "end_turn");
    assert.strictEqual(agent.permissions.length, 1);
    const asked = agent.permissions[0]!;
    assert.strictEqual(asked.toolCall.kind, "edit");
    assert.deepStrictEqual(asked.options.map((o) => o.kind), ["allow_once", "allow_always", "reject_once"]);
    assert.strictEqual(readFileSync(join(cwd, "hello.txt"), "utf8"), "hi there\n");
    const call = agent.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call");
    assert.ok(call && call.sessionUpdate === "tool_call");
    assert.strictEqual(asked.toolCall.toolCallId, call.toolCallId, "the permission names the call the client shows");
    assert.deepStrictEqual(call.locations, [{ path: join(cwd, "hello.txt") }]);
    const statuses = agent.updates.flatMap((u) => (u.update.sessionUpdate === "tool_call_update" && u.update.toolCallId === call.toolCallId ? [u.update.status] : []));
    assert.strictEqual(statuses.at(-1), "completed");
    assert.strictEqual(textOf(agent.updates, "agent_message_chunk"), "Wrote it.");
  });

  it("a denied write doesn't run and the model hears it was denied", async () => {
    agent.updates.length = 0;
    agent.permissions.length = 0;
    agent.answer = () => ({ outcome: { outcome: "selected", optionId: "deny" } });
    model.replies.push({ toolCall: { name: "write", args: { path: "nope.txt", content: "x" } } }, { text: "Okay, I won't." });
    const res = await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write nope.txt" }] });
    assert.strictEqual(res.stopReason, "end_turn");
    assert.strictEqual(agent.permissions.length, 1);
    assert.strictEqual(existsSync(join(cwd, "nope.txt")), false);
    const failed = agent.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call_update" && u.status === "failed");
    assert.ok(failed, "the tool call is reported failed");
    const toolMessage = model.requests.at(-1)!.messages.find((m) => m.role === "tool" && String(m.content).includes("Permission denied"));
    assert.ok(toolMessage, "the model is told");
  });

  it("calls the client's MCP server's tool after asking", async () => {
    agent.updates.length = 0;
    agent.permissions.length = 0;
    agent.answer = () => ({ outcome: { outcome: "selected", optionId: "allow_once" } });
    model.replies.push({ toolCall: { name: "mcp_echo_ping", args: { word: "hey" } } }, { text: "MCP answered." });
    const res = await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "ping it" }] });
    assert.strictEqual(res.stopReason, "end_turn");
    assert.strictEqual(agent.permissions.length, 1);
    const toolMessage = model.requests.at(-1)!.messages.find((m) => m.role === "tool" && String(m.content).includes("pong:hey:from-zed"));
    assert.ok(toolMessage, "the MCP tool ran with the env the client gave it");
  });

  it("auto mode runs a write without asking; the model can be switched", async () => {
    agent.permissions.length = 0;
    const modeRes = await agent.connection.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "auto" });
    assert.strictEqual(modeRes.configOptions.find((o) => o.id === "mode")?.currentValue, "auto");
    const modelRes = await agent.connection.agent.request("session/set_config_option", { sessionId, configId: "model", value: "fake-b" });
    assert.strictEqual(modelRes.configOptions.find((o) => o.id === "model")?.currentValue, "fake-b");
    model.replies.push({ toolCall: { name: "write", args: { path: "auto.txt", content: "auto\n" } } }, { text: "Done." });
    await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "write auto.txt" }] });
    assert.strictEqual(agent.permissions.length, 0);
    assert.strictEqual(readFileSync(join(cwd, "auto.txt"), "utf8"), "auto\n");
    assert.strictEqual(model.requests.at(-1)!.model, "fake-b");
    await agent.connection.agent.request("session/set_mode", { sessionId, modeId: "edit" });
    assert.ok(agent.updates.some((u) => u.update.sessionUpdate === "current_mode_update" && u.update.currentModeId === "edit"));
  });

  it("an irreversible command is asked about even in auto mode, with run-once / don't-run only", async () => {
    agent.permissions.length = 0;
    agent.answer = () => ({ outcome: { outcome: "selected", optionId: "deny" } });
    await agent.connection.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "auto" });
    model.replies.push({ toolCall: { name: "bash", args: { command: "terraform destroy" } } }, { text: "Not running it." });
    await agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "tear it all down" }] });
    assert.strictEqual(agent.permissions.length, 1);
    const asked = agent.permissions[0]!;
    assert.match(asked.toolCall.title ?? "", /can't be undone/);
    assert.deepStrictEqual(asked.options.map((o) => o.kind), ["allow_once", "reject_once"]);
    await agent.connection.agent.request("session/set_config_option", { sessionId, configId: "mode", value: "edit" });
  });

  it("cancel stops a running turn with stopReason cancelled", async () => {
    model.replies.push({ hang: true });
    const prompt = agent.connection.agent.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "take forever" }] });
    // Wait until the model is streaming, then cancel.
    const deadline = Date.now() + 30_000;
    while (!textOf(agent.updates, "agent_message_chunk").includes("Working") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await agent.connection.agent.notify("session/cancel", { sessionId });
    const res = await prompt;
    assert.strictEqual(res.stopReason, "cancelled");
  });

  it("lists the session and loads it back with its history", async () => {
    const list = await agent.connection.agent.request("session/list", { cwd });
    assert.ok(list.sessions.some((s) => s.sessionId === sessionId && s.cwd === cwd));
    await agent.connection.agent.request("session/close", { sessionId });
    agent.updates.length = 0;
    await agent.connection.agent.request("session/load", { sessionId, cwd, mcpServers: [] });
    assert.ok(textOf(agent.updates, "user_message_chunk").includes("write hello.txt"));
    assert.ok(textOf(agent.updates, "agent_message_chunk").includes("Hello from the fake model."));
    assert.ok(agent.updates.some((u) => u.update.sessionUpdate === "tool_call"));
    await assert.rejects(agent.connection.agent.request("session/load", { sessionId: "../../etc/passwd", cwd, mcpServers: [] }));
  });

  it("without any provider set up, session/new asks to sign in (auth_required)", async () => {
    const bare = startAgent({ AUTOPILOT_BASE_URL: undefined, AUTOPILOT_API_KEY: undefined, OPENROUTER_API_KEY: undefined });
    try {
      await bare.connection.agent.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
      await assert.rejects(
        bare.connection.agent.request("session/new", { cwd, mcpServers: [] }),
        (err: { code?: number }) => err.code === -32000,
      );
    } finally {
      await bare.stop();
    }
  });
});
