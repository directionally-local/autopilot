import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { cellProviderFromEnv, cellSessionConfig, normalizeGatewayBaseUrl } from "./aster-cell.js";
import { startRpcServer } from "./rpc.js";

test("appends /v1 to the Hotcell gateway base URL exactly once", () => {
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("http://host.docker.internal:4752/openrouter/"), "http://host.docker.internal:4752/openrouter/v1");
  assert.equal(normalizeGatewayBaseUrl("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1");
  assert.equal(normalizeGatewayBaseUrl(undefined), undefined);
});

test("the cell follows the provider the server configured, or OpenRouter from the daemon's own injection", () => {
  const openrouter = cellProviderFromEnv({ OPENROUTER_BASE_URL: "http://gw:4752/openrouter", OPENROUTER_API_KEY: "or-token" });
  assert.deepEqual(openrouter, { id: "openrouter", baseUrl: "http://gw:4752/openrouter/v1", apiKey: "or-token", ready: true });
  assert.deepEqual(cellSessionConfig("moonshotai/kimi-k2.6", openrouter), { model: "moonshotai/kimi-k2.6", mode: "auto", openrouterApiKey: "or-token" });
  assert.equal(cellProviderFromEnv({ OPENROUTER_BASE_URL: "http://gw:4752/openrouter" }).ready, false, "OpenRouter needs its token");

  // A DeepSeek cell: the server set AUTOPILOT_PROVIDER, AUTOPILOT_BASE_URL and the preset's key env to the egress token.
  const deepseek = cellProviderFromEnv({ AUTOPILOT_PROVIDER: "deepseek", AUTOPILOT_BASE_URL: "http://gw:4752/deepseek", DEEPSEEK_API_KEY: "egress-token", OPENROUTER_API_KEY: "ignored" });
  assert.deepEqual(deepseek, { id: "deepseek", baseUrl: "http://gw:4752/deepseek", apiKey: "egress-token", ready: true });
  assert.deepEqual(cellSessionConfig("deepseek-v4-pro", deepseek), {
    model: "deepseek-v4-pro", mode: "auto", provider: "deepseek", providers: { deepseek: { baseUrl: "http://gw:4752/deepseek", apiKey: "egress-token" } },
  });
  assert.equal(cellProviderFromEnv({ AUTOPILOT_PROVIDER: "deepseek", AUTOPILOT_BASE_URL: "http://gw:4752/deepseek" }).ready, false, "DeepSeek needs a key");

  // A keyless Ollama cell is ready with the gateway URL alone.
  const ollama = cellProviderFromEnv({ AUTOPILOT_PROVIDER: "ollama", AUTOPILOT_BASE_URL: "http://gw:4752/ollama/v1/" });
  assert.deepEqual(ollama, { id: "ollama", baseUrl: "http://gw:4752/ollama/v1", ready: true });
  assert.deepEqual(cellSessionConfig("qwen3:32b", ollama), { model: "qwen3:32b", mode: "auto", provider: "ollama", providers: { ollama: { baseUrl: "http://gw:4752/ollama/v1" } } });

  assert.equal(cellProviderFromEnv({ AUTOPILOT_PROVIDER: "not-a-provider", OPENROUTER_BASE_URL: "http://gw/openrouter", OPENROUTER_API_KEY: "k" }).id, "openrouter", "unknown ids fall back to OpenRouter");
});

test("registers the server's entry for the session's model, so the cell knows its real context window", async () => {
  const { acceptModelInfo } = await import("./aster-cell.js");
  const { getModelOrInfer, registerOpenRouterModels } = await import("../models/registry.js");
  const id = "test-vendor/huge-window-1017";
  assert.equal(getModelOrInfer(id).contextWindow, 128_000, "unknown here: the generic guess");
  const entry = { id, contextWindow: 1_048_576, maxOutputTokens: 65_536, pricing: { inputPerMtok: 0.3, outputPerMtok: 1.2 }, supports: { tools: true, reasoning: true, streaming: true }, parameters: ["tools", "reasoning"] };
  assert.equal(acceptModelInfo(entry, id), entry);
  assert.equal(getModelOrInfer(id).contextWindow, 1_048_576);
  assert.deepEqual(getModelOrInfer(id).parameters, ["tools", "reasoning"]);

  // A live catalog, when one loads, still wins over the hint.
  registerOpenRouterModels([{ ...entry, contextWindow: 2_000_000 }]);
  assert.equal(getModelOrInfer(id).contextWindow, 2_000_000);
  registerOpenRouterModels([]);

  // Anything that isn't an entry for this model is ignored.
  const other = "test-vendor/other-model";
  assert.equal(acceptModelInfo(entry, other), undefined, "an entry for another model");
  assert.equal(acceptModelInfo({ ...entry, id: other, contextWindow: 12 }, other), undefined);
  assert.equal(acceptModelInfo({ ...entry, id: other, contextWindow: "1m" }, other), undefined);
  assert.equal(acceptModelInfo({ id: other, contextWindow: 1_048_576 }, other), undefined, "no pricing or supports");
  assert.equal(acceptModelInfo(undefined, other), undefined);
  assert.equal(getModelOrInfer(other).contextWindow, 128_000);
});

function sse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("a cell session's edits land in the cell's clone, where the runtime commits and opens the PR", async () => {
  const keys = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-cell-edit-")));
  const workspace = join(root, "workspace");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", workspace]);
    git("-c", "user.email=cell@example.com", "-c", "user.name=cell", "commit", "-q", "--allow-empty", "-m", "start");
    // Data dirs outside the clone: nothing may move the session's edits there.
    delete process.env.KIMIFLARE_BASE_URL;
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-test-cell";
    process.env.KIMI_MODEL = "moonshotai/kimi-k2.6";

    // The main turn (it carries the tools) writes a file, then answers once the tool ran.
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: unknown[]; messages?: Array<{ role: string }> };
      const toolRan = body.messages?.some((m) => m.role === "tool");
      return body.tools?.length && !toolRan
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "fix.txt", content: "fixed\n" }) } }] } }] },
            { choices: [{ finish_reason: "tool_calls" }] },
          ])
        : sse([{ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }]);
    };

    const replies = new Map<string, { type: string; error?: string }>();
    let buffer = "";
    output.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const message = JSON.parse(line) as { id?: string; type: string; error?: string };
        if (message.id) replies.set(message.id, message);
      }
    });
    const rpc = async (command: Record<string, unknown> & { id: string }) => {
      input.write(JSON.stringify(command) + "\n");
      for (let i = 0; i < 400 && !replies.has(command.id); i++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(command.id);
    };
    void startRpcServer(input, output);

    // The same commands the bridge sends.
    const sessionId = crypto.randomUUID();
    const created = await rpc({ id: crypto.randomUUID(), type: "new_session", cwd: workspace, sessionId, config: cellSessionConfig("moonshotai/kimi-k2.6", cellProviderFromEnv()) });
    assert.equal(created?.type, "ok", created?.error);
    const turn = await rpc({ id: crypto.randomUUID(), type: "prompt", message: "write the fix", options: { mode: "auto" } });
    assert.equal(turn?.type, "ok", turn?.error);

    assert.equal(await readFile(join(workspace, "fix.txt"), "utf8"), "fixed\n");
    assert.match(git("status", "--porcelain"), /\?\? fix\.txt/);
    assert.equal(git("branch", "--show-current").trim(), "main");
    assert.equal(git("worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "no extra worktree");
  } finally {
    input.end();
    globalThis.fetch = originalFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(root, { recursive: true, force: true });
  }
});
