/**
 * An in-process stub of the Aster API endpoints attach-remote uses, for
 * tests: create, get, turns, events (SSE with Last-Event-ID), cancel,
 * models, approvals. Turns play a scripted list of events.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface StubConversation {
  conversationId: string;
  workspaceId: string;
  model: string;
  status: string;
  activeRunId: string | null;
  kind: "code";
  repository: string;
  branch: string;
  pullRequestURL?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AsterStub {
  url: string;
  token: string;
  conversations: Map<string, StubConversation>;
  events: Map<string, Array<StubEvent & { id: number }>>;
  /** Every request, in order: method, path, headers that matter, JSON body. */
  requests: Array<{ method: string; path: string; idempotencyKey?: string; lastEventId?: string; body?: Record<string, unknown> }>;
  /** What a turn plays after it's accepted (default: a short scripted turn). */
  script: (conversationId: string, text: string) => StubEvent[];
  /** Hold a turn's terminal event until release() (to test cancel and queueing). */
  holdTerminal: boolean;
  release: () => void;
  /** Answer every authenticated request 401 from now on. */
  revoked: boolean;
  /** Close each SSE response after this many events (to test resume). */
  dropAfter: number | null;
  /** Re-send the last event when an SSE stream (re)opens (at-least-once delivery). */
  resendOnConnect: boolean;
  /** GET /models' `catalog` (the IDs are always model-a and model-b). */
  modelCatalog: Array<Record<string, unknown>>;
  /** Answer GET /models 503 (the server's catalog is unavailable). */
  modelsDown: boolean;
  approvals: Map<string, { approvalId: string; status: string; tool: string; explanation: string; arguments: Record<string, unknown>; decision?: string }>;
  append: (conversationId: string, event: StubEvent) => number;
  seed: (conversation: Partial<StubConversation> & { conversationId: string }, events?: StubEvent[]) => void;
  close: () => Promise<void>;
}

export function defaultScript(_id: string, text: string): StubEvent[] {
  return [
    { type: "assistant.delta", data: { text: `Working on: ${text}. ` } },
    { type: "tool.activity", data: { tool: "bash", toolCallId: "call-1", activity: "started", input: "npm test" } },
    { type: "tool.activity", data: { tool: "bash", toolCallId: "call-1", activity: "completed", output: "ok\n2 passing" } },
    { type: "todo.updated", data: { items: [{ title: "Run tests", status: "done" }, { title: "Open PR", status: "in_progress" }] } },
    { type: "usage", data: { inputTokens: 1200, outputTokens: 80, costUsd: 0.0123, cumulative: true } },
    { type: "assistant.delta", data: { text: "All tests pass." } },
    { type: "checkpoint.created", data: { id: "abcdef1234567890", message: "Fix tests", createdAt: new Date().toISOString() } },
  ];
}

export async function startAsterStub(): Promise<AsterStub> {
  const token = "aster_test_token";
  let seq = 0;
  let held: Array<() => void> = [];
  const stub: AsterStub = {
    url: "",
    token,
    conversations: new Map(),
    events: new Map(),
    requests: [],
    script: defaultScript,
    holdTerminal: false,
    release: () => {
      const run = held;
      held = [];
      for (const f of run) f();
    },
    revoked: false,
    dropAfter: null,
    resendOnConnect: false,
    modelCatalog: [],
    modelsDown: false,
    approvals: new Map(),
    append: (conversationId, event) => {
      const list = stub.events.get(conversationId) ?? [];
      const id = list.length + 1;
      list.push({ ...event, id });
      stub.events.set(conversationId, list);
      return id;
    },
    seed: (partial, events = []) => {
      const now = new Date().toISOString();
      stub.conversations.set(partial.conversationId, {
        workspaceId: "default",
        model: "vendor/model-a",
        status: "completed",
        activeRunId: null,
        kind: "code",
        repository: "acme/project",
        branch: `aster/${partial.conversationId.slice(0, 8)}`,
        createdAt: now,
        updatedAt: now,
        ...partial,
      });
      stub.events.set(partial.conversationId, []);
      for (const e of events) stub.append(partial.conversationId, e);
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const publicConversation = (c: StubConversation) => ({ ...c, lastEventId: stub.events.get(c.conversationId)?.length ?? 0 });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = url.pathname;
    const method = req.method ?? "GET";
    let body: Record<string, unknown> | undefined;
    if (method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    }
    stub.requests.push({
      method,
      path,
      ...(typeof req.headers["idempotency-key"] === "string" ? { idempotencyKey: req.headers["idempotency-key"] } : {}),
      ...(typeof req.headers["last-event-id"] === "string" ? { lastEventId: req.headers["last-event-id"] } : {}),
      ...(body ? { body } : {}),
    });
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const fail = (status: number, code: string, message = code) => json(status, { error: { code, message } });
    if (req.headers.authorization !== `Bearer ${token}` || stub.revoked) return fail(401, "unauthorized", "Invalid or expired credential");

    if (path === "/api/v1/models" && method === "GET") {
      if (stub.modelsDown) return fail(503, "model_catalog_unavailable");
      return json(200, { models: ["vendor/model-a", "vendor/model-b"], catalog: stub.modelCatalog });
    }
    if (path === "/api/v1/conversations" && method === "POST") {
      if (!req.headers["idempotency-key"]) return fail(400, "idempotency_key_required");
      const id = `c0ffee00-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      stub.seed({ conversationId: id, model: String(body?.model), repository: String(body?.repository), status: "ready", workspaceId: String(body?.workspaceId) });
      stub.append(id, { type: "conversation.created", data: { conversationId: id } });
      return json(201, publicConversation(stub.conversations.get(id)!));
    }
    let m = /^\/api\/v1\/conversations\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const c = stub.conversations.get(m[1]!);
      return c ? json(200, publicConversation(c)) : fail(404, "conversation_not_found", "Conversation not found");
    }
    m = /^\/api\/v1\/conversations\/([^/]+)\/turns$/.exec(path);
    if (m && method === "POST") {
      const c = stub.conversations.get(m[1]!);
      if (!c) return fail(404, "conversation_not_found");
      if (c.activeRunId) return fail(409, "conversation_busy");
      if (typeof body?.model === "string") {
        if (!["vendor/model-a", "vendor/model-b"].includes(body.model)) return fail(400, "model_not_allowed");
        c.model = body.model;
      }
      const runId = `run-${++seq}`;
      c.activeRunId = runId;
      c.status = "running";
      json(202, { conversationId: c.conversationId, clientTurnId: body?.clientTurnId, runId, status: "running" });
      const events = stub.script(c.conversationId, String(body?.text ?? ""));
      void (async () => {
        for (const e of events) {
          await new Promise((r) => setTimeout(r, 5));
          if (c.activeRunId !== runId) return;
          stub.append(c.conversationId, e);
        }
        const finish = () => {
          if (c.activeRunId !== runId) return;
          c.activeRunId = null;
          c.status = "completed";
          c.pullRequestURL ??= `https://github.com/${c.repository}/pull/7`;
          stub.append(c.conversationId, { type: "completed", data: {} });
        };
        if (stub.holdTerminal) held.push(finish);
        else finish();
      })();
      return;
    }
    m = /^\/api\/v1\/conversations\/([^/]+)\/cancel$/.exec(path);
    if (m && method === "POST") {
      const c = stub.conversations.get(m[1]!);
      if (!c) return fail(404, "conversation_not_found");
      if (c.activeRunId) {
        c.activeRunId = null;
        c.status = "cancelled";
        stub.append(c.conversationId, { type: "cancelled", data: { code: "cancelled_by_client" } });
      }
      return json(200, publicConversation(c));
    }
    m = /^\/api\/v1\/conversations\/([^/]+)\/events$/.exec(path);
    if (m && method === "GET") {
      const id = m[1]!;
      if (!stub.conversations.has(id)) return fail(404, "conversation_not_found");
      let last = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (stub.resendOnConnect && last > 0) {
        const e = stub.events.get(id)![last - 1]!;
        res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
      }
      let sent = 0;
      let closed = false;
      res.on("close", () => (closed = true));
      const pump = () => {
        if (closed) return;
        if (stub.revoked) {
          closed = true;
          res.end();
          return;
        }
        for (const e of stub.events.get(id)!.slice(last)) {
          res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
          last = e.id;
          if (stub.dropAfter !== null && ++sent >= stub.dropAfter) {
            closed = true;
            res.end();
            return;
          }
        }
        setTimeout(pump, 10);
      };
      pump();
      return;
    }
    m = /^\/api\/v1\/approvals\/([^/]+)$/.exec(path);
    if (m) {
      const a = stub.approvals.get(m[1]!);
      if (!a) return fail(404, "approval_not_found");
      if (method === "GET") return json(200, a);
      a.status = body?.decision === "allow" ? "approved" : "denied";
      a.decision = String(body?.decision);
      return json(200, { approvalId: a.approvalId, status: a.status, decision: a.decision });
    }
    return fail(404, "not_found");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
