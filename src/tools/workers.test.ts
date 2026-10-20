import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { workerRegistry } from "./worker-registry.js";
import { workerResultTool, workerStatusTool } from "./workers.js";
import { waitForTool } from "./wait-for.js";
import { runAgentTurn } from "../agent/loop.js";
import type { ToolContext } from "./registry.js";
import type { ToolExecutor } from "./executor.js";
import type { ChatMessage } from "../agent/messages.js";

const ctx = (sessionId: string, signal = new AbortController().signal) => ({ cwd: "/tmp", sessionId, signal }) as unknown as ToolContext;
const content = (o: string | { content: string }) => (typeof o === "string" ? o : o.content);

describe("background subagent tools", () => {
  afterEach(() => workerRegistry.clearFinished());

  it("lists, waits for and returns a background worker's findings", async () => {
    const h = workerRegistry.start("map auth", "m", undefined, { background: true, sessionId: "s1" });
    assert.match(content(await workerStatusTool.run({}, ctx("s1"))), /running .* map auth/);
    assert.match(content(await workerResultTool.run({ worker_id: h.id }, ctx("s1"))), /still running/);
    const waiting = workerResultTool.run({ worker_id: `#${h.index}`, wait: true }, ctx("s1"));
    h.complete({ status: "completed", output: "## Auth\nlives in src/auth.ts", costUsd: 0.01 });
    h.finish();
    assert.match(content(await waiting), /completed after .*\n## Auth/);
    assert.match(content(await workerStatusTool.run({}, ctx("s1"))), /completed \$0\.0100 \(findings delivered\)/);
    assert.deepStrictEqual(workerRegistry.takeUndelivered("s1"), [], "already delivered through worker_result");
    assert.match(content(await workerStatusTool.run({}, ctx("other"))), /No background subagents/);
  });

  it("wait_for accepts a worker id in any session", async () => {
    const h = workerRegistry.start("x", "m", undefined, { background: true, sessionId: "s2" });
    const waiting = waitForTool.run({ worker_id: h.id }, ctx("s2"));
    h.complete({ status: "completed", output: "found it" });
    h.finish();
    assert.match(content(await waiting), /found it/);
  });

  it("delivers a finished background result into the next turn without polling", async () => {
    const h = workerRegistry.start("survey billing", "m", undefined, { background: true, sessionId: "s3" });
    h.complete({ status: "completed", output: "## Billing\nsrc/billing.ts:42" });
    h.finish();
    const original = globalThis.fetch;
    let sent: ChatMessage[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sent = (JSON.parse(String(init?.body)) as { messages: ChatMessage[] }).messages;
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    try {
      await runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "test/model",
        messages: [{ role: "system", content: "s" }, { role: "user", content: "what next?" }],
        tools: [],
        executor: { list: () => [], run: async () => ({}) } as unknown as ToolExecutor,
        cwd: "/tmp",
        sessionId: "s3",
        signal: new AbortController().signal,
        callbacks: { askPermission: async () => "allow" },
      });
    } finally {
      globalThis.fetch = original;
    }
    const notice = sent.find((m) => m.role === "user" && String(m.content).includes("Background subagent"));
    assert.ok(notice, "the result was in the request");
    assert.match(String(notice!.content), /Automatic notice — not typed by the user.*\n## Billing\nsrc\/billing\.ts:42/s);
    assert.deepStrictEqual(workerRegistry.takeUndelivered("s3"), []);
  });
});
