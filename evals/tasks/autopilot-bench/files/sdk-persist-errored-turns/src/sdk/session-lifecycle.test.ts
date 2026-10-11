import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentSession } from "./session.js";
import type { KimiFlareSession } from "./types.js";
import type { ChatMessage } from "../agent/messages.js";

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL"] as const;

type Script = (request: { messages: ChatMessage[] }, n: number) => Promise<Response> | Response;

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

const text = (content: string) => sse([
  { choices: [{ delta: { content } }] },
  { choices: [{ finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
]);

function lastUser(messages: ChatMessage[]): string {
  return String([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
}

function hasConsecutiveUsers(messages: ChatMessage[]): boolean {
  return messages.some((m, i) => i > 0 && m.role === "user" && messages[i - 1]!.role === "user");
}

describe("SDK session turn lifecycle", () => {
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let home = "";
  let cwd = "";
  let session: KimiFlareSession | null = null;
  let requests: Array<{ messages: ChatMessage[] }> = [];

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.KIMIFLARE_BASE_URL;
    home = await mkdtemp(join(tmpdir(), "autopilot-sdk-lifecycle-"));
    cwd = join(home, "project");
    await mkdir(cwd, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_DATA_HOME = join(home, "data");
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-test-lifecycle";
    process.env.KIMI_MODEL = "moonshotai/kimi-k2.6";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    session?.dispose();
    session = null;
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  async function start(script: Script): Promise<KimiFlareSession> {
    const created = await createAgentSession({ cwd });
    session = created.session;
    requests = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[] };
      requests.push(body);
      return script(body, requests.length);
    };
    return session;
  }

  async function savedMessages(id: string): Promise<ChatMessage[]> {
    const file = JSON.parse(await readFile(join(process.env.XDG_DATA_HOME!, "kimiflare", "sessions", `${id}.json`), "utf8"));
    return file.messages as ChatMessage[];
  }

  it("persists a new session before its first turn", async () => {
    const s = await start(() => text("unused"));
    const messages = await savedMessages(s.sessionId);
    assert.ok(Array.isArray(messages));
  });

  it("saves the user message and completed tool work when a turn errors (#637)", async () => {
    const s = await start(() => new Response(JSON.stringify({ error: { message: "bad request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    await assert.rejects(s.prompt("remember the codeword PELICAN"));
    const messages = await savedMessages(s.sessionId);
    assert.ok(messages.some((m) => m.role === "user" && m.content === "remember the codeword PELICAN"));
  });

  it("delivers a steer that arrives during the final answer within the same turn", async () => {
    const s = await start(async (_request, n) => {
      if (n === 1) {
        await s.steer("also mention the tests");
        return text("first answer");
      }
      return text("answer including tests");
    });
    await s.prompt("summarize the module");
    assert.equal(requests.length, 2, "turn continued to answer the steer");
    assert.equal(lastUser(requests[1]!.messages), "also mention the tests");
    assert.equal(s.getStatus().pendingSteer.length, 0);
    const last = s.messages.at(-1)!;
    assert.equal(last.role, "assistant");
    assert.equal(last.content, "answer including tests");
  });

  it("runs follow-ups queued during a turn as their own turns", async () => {
    const s = await start(async (_request, n) => {
      if (n === 1) {
        await s.followUp("now write the changelog");
        return text("done with the first task");
      }
      return text("changelog written");
    });
    await s.prompt("fix the bug");
    assert.equal(requests.length, 2);
    assert.equal(lastUser(requests[1]!.messages), "now write the changelog");
    assert.equal(s.getStatus().pendingFollowUp.length, 0);
    assert.equal(hasConsecutiveUsers(s.messages), false, "no orphaned user messages");
    assert.equal(s.messages.at(-1)!.content, "changelog written");
    const persisted = await savedMessages(s.sessionId);
    assert.equal(persisted.at(-1)!.content, "changelog written");
  });
});
