import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEventStream, RemoteApiError, RemoteClient, type DeviceAuthorization } from "./client.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>, max = Infinity): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= max) break;
  }
  return items;
}

describe("remote API client", () => {
  it("parses SSE frames split across chunks and skips heartbeats", async () => {
    const events = await collect(parseEventStream(streamOf([
      "id: 7\nevent: assistant.del",
      "ta\ndata: {\"text\":\"hi\"}\n\n: heartbeat\n\n",
      "id: 8\r\nevent: completed\r\ndata: {}\r\n\r\n",
    ])));
    assert.deepEqual(events, [
      { id: 7, type: "assistant.delta", data: { text: "hi" } },
      { id: 8, type: "completed", data: {} },
    ]);
  });

  it("reconnects from the last event ID and never repeats an event", async () => {
    const cursors: string[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      const cursor = (init?.headers as Record<string, string>)["Last-Event-ID"]!;
      cursors.push(cursor);
      const body = cursor === "0"
        ? "id: 1\nevent: a\ndata: {}\n\nid: 2\nevent: b\ndata: {}\n\n"
        : "id: 2\nevent: b\ndata: {}\n\nid: 3\nevent: completed\ndata: {}\n\n";
      return new Response(streamOf([body]), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;
    const client = new RemoteClient("https://box.example.com", "aster_token", fakeFetch);
    const events = await collect(client.events("conv", 0), 3);
    assert.deepEqual(events.map((event) => event.id), [1, 2, 3]);
    assert.deepEqual(cursors, ["0", "2"]);
  });

  it("stops reconnecting on a client error such as a revoked credential", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ error: { code: "invalid_credential", message: "nope" } }), { status: 401 })) as unknown as typeof fetch;
    const client = new RemoteClient("https://box.example.com", "aster_token", fakeFetch);
    await assert.rejects(() => collect(client.events("conv", 0)), (error) => error instanceof RemoteApiError && error.code === "invalid_credential");
  });

  it("polls a pairing through pending and slow_down until the credential arrives", async () => {
    const replies = [
      { status: 400, body: { error: { code: "authorization_pending", message: "" } } },
      { status: 400, body: { error: { code: "slow_down", message: "" } } },
      { status: 200, body: { token: "aster_issued", credentialId: "c1", name: "laptop", workspaceIds: ["default"], scopes: [], expiresAt: "2027-01-01T00:00:00.000Z" } },
    ];
    const fakeFetch = (async () => {
      const reply = replies.shift()!;
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    const sleeps: number[] = [];
    const client = new RemoteClient("https://box.example.com", undefined, fakeFetch);
    const device: DeviceAuthorization = { deviceCode: "d", userCode: "BCDF-GHJK", verificationUri: "", verificationUriComplete: "", expiresIn: 600, interval: 5 };
    const credential = await client.waitForCredential(device, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(credential.token, "aster_issued");
    assert.deepEqual(sleeps, [5_000, 5_000, 10_000]);

    const denied = new RemoteClient("https://box.example.com", undefined, (async () =>
      new Response(JSON.stringify({ error: { code: "access_denied", message: "denied" } }), { status: 400 })) as unknown as typeof fetch);
    await assert.rejects(() => denied.waitForCredential(device, { sleep: async () => {} }), /denied/);
  });
});
