import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  flushDlEvents,
  hashRemote,
  noteDlSessionStart,
  queuedDlEvents,
  recordDlEvent,
  repoHashFor,
  resetDlEventsForTesting,
  sanitizeProps,
  setDlEventsTransportForTesting,
  withDlEvents,
  type DlEvent,
} from "./dl-events.js";
import { endSession, noteSessionStart, resetSessionLifecycleForTesting } from "../hooks/session-lifecycle.js";
import { runAgentTurn } from "../agent/loop.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ChatMessage } from "../agent/messages.js";

const SECRET_PROMPT = "please refactor src/secret/payroll.ts with the API key hunter2";

function sse(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("free-tier usage events", () => {
  const ENV = ["AUTOPILOT_DL_FREE_TOKEN", "AUTOPILOT_DL_FREE_URL", "XDG_CONFIG_HOME"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let home: string;
  let posts: Array<{ url: string; auth: string | null; events: DlEvent[] }>;
  let replies: number[];

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "dl-events-"));
  });
  beforeEach(() => {
    resetDlEventsForTesting();
    resetSessionLifecycleForTesting();
    process.env.XDG_CONFIG_HOME = home;
    process.env.AUTOPILOT_DL_FREE_TOKEN = "at";
    process.env.AUTOPILOT_DL_FREE_URL = "http://dl.test";
    posts = [];
    replies = [];
    setDlEventsTransportForTesting(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        posts.push({ url: String(input), auth: headers.get("authorization"), events: (JSON.parse(String(init?.body)) as { events: DlEvent[] }).events });
        const status = replies.shift() ?? 202;
        if (status === 0) throw new Error("network down");
        return new Response(JSON.stringify({ accepted: 1 }), { status });
      }) as typeof fetch,
      async () => {},
    );
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    resetDlEventsForTesting();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  it("keeps only allowlisted props", () => {
    const props = sanitizeProps({
      turns: 3,
      toolCalls: { bash: 2, read: 1, "../etc/passwd x": 1 },
      model: "deepseek/deepseek-v4.1-flash-1017",
      prompt: SECRET_PROMPT,
      completion: "the answer",
      path: "/Users/me/secret",
      content: "file contents",
      durationMs: 12.7,
    });
    assert.deepStrictEqual(props, { turns: 3, toolCalls: { bash: 2, read: 1 }, durationMs: 13, model: "deepseek/deepseek-v4.1-flash-1017" });
  });

  it("correlates equivalent Git remotes without including credentials or transport", async () => {
    const canonical = hashRemote("git@github.com:o/r.git");
    assert.strictEqual(hashRemote("https://github.com/o/r"), canonical);
    assert.strictEqual(hashRemote("ssh://git@GITHUB.com/o/r.git"), canonical);
    assert.strictEqual(hashRemote("https://user:secret@github.com/o/r.git?token=secret#fragment"), canonical);
    assert.notStrictEqual(hashRemote("https://github.com/o/other.git"), canonical, "distinct repositories remain distinct");
    assert.notStrictEqual(hashRemote("ftp://github.com/o/r.git"), canonical, "unsupported schemes are not treated as Git remote identities");
    assert.strictEqual(hashRemote("https://[::1/o/r"), createHash("sha256").update("https://[::1/o/r").digest("hex"), "malformed remotes retain the legacy opaque hash behavior");
    assert.strictEqual(hashRemote("git@github.com:o/r.git"), createHash("sha256").update("github.com/o/r").digest("hex"));

    const repo = await mkdtemp(join(tmpdir(), "dl-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd: repo });
    assert.strictEqual(await repoHashFor(repo), hashRemote("https://github.com/o/r.git"));
    assert.strictEqual(await repoHashFor(tmpdir()), undefined);
    await rm(repo, { recursive: true, force: true });
  });

  it("posts batches of up to 100 to /v1/events with the access token", async () => {
    for (let i = 0; i < 150; i++) recordDlEvent("turn.end", "s1", { turns: i });
    await flushDlEvents();
    assert.deepStrictEqual(posts.map((p) => p.events.length), [100, 50]);
    assert.strictEqual(posts[0]!.url, "http://dl.test/v1/events");
    assert.strictEqual(posts[0]!.auth, "Bearer at");
    const ev = posts[0]!.events[0]!;
    assert.ok(ev.id && ev.at && ev.type === "turn.end");
    assert.match(ev.sessionId, /^[0-9a-f-]{36}$/, "a random UUID, never the local session id (which can carry a prompt slug)");
    assert.ok(posts.flatMap((p) => p.events).every((e) => e.sessionId === ev.sessionId));
    assert.strictEqual(new Set(posts.flatMap((p) => p.events.map((e) => e.id))).size, 150);
  });

  it("retries a failed batch once, then drops it without throwing", async () => {
    replies = [0, 503];
    recordDlEvent("error", "s1", { errorCode: "http_500" });
    await flushDlEvents();
    assert.strictEqual(posts.length, 2);
    assert.strictEqual(queuedDlEvents().length, 0);
    replies = [503, 202];
    recordDlEvent("error", "s1", { errorCode: "http_500" });
    await flushDlEvents();
    assert.strictEqual(posts.length, 4);
  });

  it("drops events when nobody is signed in", async () => {
    delete process.env.AUTOPILOT_DL_FREE_TOKEN;
    recordDlEvent("turn.end", "s1", {});
    await flushDlEvents();
    assert.strictEqual(posts.length, 0);
    assert.strictEqual(queuedDlEvents().length, 0);
  });

  it("counts tools and notices an opened PR without sending the URL or output", async () => {
    await noteSessionStart({ sessionId: "s2", cwd: tmpdir(), resumed: false });
    await noteDlSessionStart("s2", { model: "m", cwd: tmpdir() });
    const seen: string[] = [];
    const { callbacks, toolCalls } = withDlEvents({ onToolResult: (r: { name: string }) => void seen.push(r.name) } as never, "s2");
    callbacks.onToolResult?.({ tool_call_id: "1", name: "bash", ok: true, content: "Creating pull request\nhttps://github.com/o/r/pull/12\n" });
    callbacks.onToolResult?.({ tool_call_id: "2", name: "bash", ok: true, content: "https://github.com/o/r/pull/12" });
    callbacks.onToolResult?.({ tool_call_id: "3", name: "read", ok: true, content: "see https://github.com/o/r/pull/9 for context" });
    assert.deepStrictEqual(toolCalls, { bash: 2, read: 1 });
    assert.deepStrictEqual(seen, ["bash", "bash", "read"]);
    const types = queuedDlEvents().map((e) => e.type);
    assert.deepStrictEqual(types, ["session.start", "pr.opened"]);
    assert.ok(!JSON.stringify(queuedDlEvents()).includes("github.com"));
    // Session end (via the SessionEnd lifecycle) reports totals and flushes.
    await endSession("s2", "exit");
    const all = posts.flatMap((p) => p.events);
    const end = all.find((e) => e.type === "session.end")!;
    assert.deepStrictEqual([end.props.toolCalls, end.props.exitReason, end.props.provider], [{ bash: 2, read: 1 }, "exit", "directionally-local"]);
  });

  async function turn(auth: Record<string, unknown>, sessionId: string): Promise<void> {
    globalThis.fetch = (async () => sse("done")) as typeof fetch;
    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: SECRET_PROMPT },
    ];
    await runAgentTurn({
      ...auth,
      model: "deepseek/deepseek-v4.1-flash-1017",
      messages,
      tools: [],
      executor: { list: () => [], run: async () => ({ ok: true, content: "" }) } as unknown as ToolExecutor,
      cwd: tmpdir(),
      sessionId,
      signal: new AbortController().signal,
      callbacks: { askPermission: async () => "allow" },
    } as never);
    await new Promise((r) => setTimeout(r, 30));
  }

  it("records session.start and turn.end for a free-tier turn, with no content", async () => {
    await turn({ providerId: "directionally-local", customEndpoint: { baseUrl: "http://dl.test/v1", apiKey: "at", providerId: "directionally-local" } }, "2026-11-02T09-10-50-017Z_refactor-payroll");
    const events = queuedDlEvents();
    assert.deepStrictEqual(events.map((e) => e.type), ["session.start", "turn.end"]);
    const end = events[1]!;
    assert.deepStrictEqual([end.props.turns, end.props.exitReason, end.props.model, end.props.provider], [1, "complete", "deepseek/deepseek-v4.1-flash-1017", "directionally-local"]);
    const start = events[0]!;
    assert.strictEqual(start.props.os, process.platform);
    assert.ok(start.props.autopilotVersion);
    const wire = JSON.stringify(events);
    assert.ok(!wire.includes("payroll") && !wire.includes("hunter2") && !wire.includes("done") && !wire.includes(tmpdir()));
  });

  it("sends nothing for other providers", async () => {
    await turn({ openrouterApiKey: "sk-or-test" }, "s4");
    await turn({ providerId: "deepseek", customEndpoint: { baseUrl: "https://api.deepseek.com", apiKey: "k", providerId: "deepseek" } }, "s5");
    assert.strictEqual(queuedDlEvents().length, 0);
    await flushDlEvents();
    assert.strictEqual(posts.length, 0);
  });
});
