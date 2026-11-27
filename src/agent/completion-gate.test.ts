import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentTurn } from "./loop.js";
import type { ToolExecutor, ToolResult } from "../tools/executor.js";
import { JobManager } from "../jobs/manager.js";
import type { ChatMessage } from "./messages.js";
import type { ToolSpec } from "../tools/registry.js";
import { completionGateNotice, isTestCommand, recordBashResult, runningSessionJobs } from "./completion-gate.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const bashToolSpec: ToolSpec = {
  name: "bash",
  description: "Run a shell command.",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  needsPermission: false,
  run: async () => "unused",
};

function streamResponse(events: unknown[]): Response {
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

/** One scripted model response per call, recording each request body. */
function scriptedModel(responses: unknown[][]): { calls: Array<{ messages: ChatMessage[] }> } {
  const calls: Array<{ messages: ChatMessage[] }> = [];
  let index = 0;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: ChatMessage[] };
    calls.push(body);
    const events = responses[Math.min(index++, responses.length - 1)] ?? [];
    return streamResponse(events);
  };
  return { calls };
}

function finalAnswer(text: string): unknown[] {
  return [{ choices: [{ delta: { content: text }, finish_reason: "stop" }] }];
}

describe("isTestCommand", () => {
  it("recognizes full and scoped test commands", () => {
    for (const command of [
      "npm test",
      "npm run test",
      "npm run test:file -- src/tools/bash.test.ts",
      "pnpm test",
      "yarn run test:unit",
      "bun test",
      "npx tsx --test src/x.test.ts",
      "node --test src/x.test.ts",
      "cargo test",
      "go test ./...",
      "pytest -q",
      "make test",
      "vitest run",
      "CI=1 npm test",
    ]) {
      assert.strictEqual(isTestCommand(command), true, command);
    }
  });

  it("does not mistake builds, configs, or lookups for test runs", () => {
    for (const command of [
      "npm run build",
      "npm run typecheck",
      "cat jest.config.js",
      "grep -rn test src",
      "git commit -m 'add tests'",
      "echo npm test",
    ]) {
      assert.strictEqual(isTestCommand(command), false, command);
    }
  });
});

describe("completionGateNotice", () => {
  it("is null when nothing is outstanding", () => {
    assert.strictEqual(completionGateNotice({ runningJobs: [] }), null);
    assert.strictEqual(completionGateNotice({ runningJobs: [], lastTest: { command: "npm test", exitCode: 0 } }), null);
  });

  it("names running jobs and a failed test", () => {
    const notice = completionGateNotice({
      runningJobs: [{ id: "job-1", command: "npm run build" }],
      lastTest: { command: "npm test", exitCode: 1 },
    })!;
    assert.match(notice, /job-1/);
    assert.match(notice, /still running/);
    assert.match(notice, /npm test/);
    assert.match(notice, /exit 1/);
    assert.match(notice, /say plainly in your final answer/);
  });
});

describe("recordBashResult", () => {
  it("keeps only the latest test run", () => {
    const state = {};
    recordBashResult(state, "npm test", { exitCode: 1 });
    assert.deepStrictEqual(state, { lastTest: { command: "npm test", exitCode: 1 } });
    recordBashResult(state, "npm run build", { exitCode: 2 });
    assert.deepStrictEqual(state, { lastTest: { command: "npm test", exitCode: 1 } }, "non-test commands are ignored");
    recordBashResult(state, "npm test", { exitCode: 0 });
    assert.deepStrictEqual(state, { lastTest: { command: "npm test", exitCode: 0 } });
  });

  it("counts a timed-out test as failed", () => {
    const state = {};
    recordBashResult(state, "cargo test", { exitCode: null, timedOut: true });
    assert.deepStrictEqual(state, { lastTest: { command: "cargo test", exitCode: 124 } });
  });
});

describe("runAgentTurn completion gate", () => {
  it("surfaces a failed test before the final answer", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "fix the bug" },
    ];
    const model = scriptedModel([
      [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) } }] } }] },
        { choices: [{ finish_reason: "tool_calls" }] },
      ],
      finalAnswer("Done."),
      finalAnswer("Not done yet: npm test is still failing."),
    ]);
    const executor = {
      list: () => [bashToolSpec],
      run: async (call: { id: string; name: string }): Promise<ToolResult> => ({
        tool_call_id: call.id,
        name: call.name,
        content: "exit=1\n--- stderr ---\n1 test failed",
        ok: true,
        meta: { exitCode: 1 },
      }),
    } as unknown as ToolExecutor;

    await runAgentTurn({
      openrouterApiKey: "sk-or-test",
      model: "test/model",
      messages,
      tools: [bashToolSpec],
      executor,
      cwd: "/tmp",
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    });

    assert.equal(model.calls.length, 3, "the gate adds one round trip before the turn ends");
    const gateRequest = model.calls[2]!;
    const gateText = gateRequest.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    assert.match(gateText, /Completion gate/);
    assert.match(gateText, /last test command failed with exit 1/);
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.match(String(messages.at(-1)?.content), /still failing/);
  });

  it("surfaces a background job that is still running before the final answer", { skip: process.platform === "win32" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-jobs-"));
    const jobsDbPath = join(dir, "jobs.db");
    const sessionId = "gate-session";
    const jobs = new JobManager(jobsDbPath);
    const record = jobs.start({
      command: "sleep 30",
      cwd: dir,
      shell: "bash",
      shellArgs: ["-lc"],
      timeoutMs: 60_000,
      sessionId,
    });
    jobs.close();

    try {
      assert.deepStrictEqual(
        runningSessionJobs(sessionId, dir, jobsDbPath).map((job) => job.id),
        [record.id],
      );

      const messages: ChatMessage[] = [
        { role: "system", content: "test" },
        { role: "user", content: "start the server and tell me when it is up" },
      ];
      const model = scriptedModel([
        finalAnswer("Done."),
        finalAnswer(`Still waiting on background job ${record.id}.`),
      ]);

      await runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "test/model",
        messages,
        tools: [bashToolSpec],
        executor: { list: () => [bashToolSpec], run: async () => { throw new Error("no tools expected"); } } as unknown as ToolExecutor,
        cwd: dir,
        sessionId,
        jobsDbPath,
        signal: new AbortController().signal,
        callbacks: { askPermission: async () => "allow" },
      });

      assert.equal(model.calls.length, 2);
      const gateText = model.calls[1]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      assert.match(gateText, /still running/);
      assert.ok(gateText.includes(record.id), "the running job's id is named");
      assert.match(String(messages.at(-1)?.content), new RegExp(`Still waiting on background job ${record.id}`));
    } finally {
      const cleanup = new JobManager(jobsDbPath);
      try {
        cleanup.cancel(record.id);
      } catch {
        // already gone
      }
      cleanup.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
