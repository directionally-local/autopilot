/**
 * A fake OpenAI-compatible local server (vLLM-shaped) on 127.0.0.1 for tests:
 * GET /v1/models lists one model with `max_model_len`, POST
 * /v1/chat/completions streams a short reply, or answers with a scripted
 * error status and body. Every request is recorded.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeOpenAiServerOpts {
  model: string;
  /** Listed as `max_model_len` on the model's /models entry; omitted when undefined. */
  maxModelLen?: number;
  /** Status for GET /models (default 200). */
  modelsStatus?: number;
  /** Answer chat completions with this status and body instead of a stream. */
  reject?: { status: number; body: unknown };
  /** Reply text (default "ok"). */
  reply?: string;
}

export interface FakeOpenAiServer {
  baseUrl: string;
  requests: Array<{ method: string; path: string; body: Record<string, unknown> | null }>;
  chatRequests(): Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startFakeOpenAiServer(opts: FakeOpenAiServerOpts): Promise<FakeOpenAiServer> {
  const requests: FakeOpenAiServer["requests"] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      let body: Record<string, unknown> | null = null;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method ?? "GET", path, body });
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(opts.modelsStatus ?? 200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: opts.model, object: "model", owned_by: "vllm", ...(opts.maxModelLen ? { max_model_len: opts.maxModelLen } : {}) }],
          }),
        );
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        if (opts.reject) {
          res.writeHead(opts.reject.status, { "content-type": "application/json" });
          res.end(typeof opts.reject.body === "string" ? opts.reject.body : JSON.stringify(opts.reject.body));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = [
          { choices: [{ index: 0, delta: { content: opts.reply ?? "ok" } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
        ];
        for (const f of frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    chatRequests: () => requests.filter((r) => r.path === "/v1/chat/completions").map((r) => r.body ?? {}),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
