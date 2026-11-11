import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** A fake OpenAI-compatible server: GET /v1/models answers by path prefix. */
export async function fakeModelsServer(): Promise<{ url: string; requests: Array<{ path: string; auth?: string }>; close: () => Promise<void> }> {
  const requests: Array<{ path: string; auth?: string }> = [];
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    const send = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (req.url === "/v1/models") return send(200, JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3-4B-Instruct-2507", object: "model" }] }));
    if (req.url === "/two/v1/models") return send(200, JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }));
    if (req.url === "/locked/v1/models") return req.headers.authorization === "Bearer sk-right" ? send(200, JSON.stringify({ data: [{ id: "m" }] })) : send(401, "{}");
    if (req.url === "/empty/v1/models") return send(200, JSON.stringify({ data: [] }));
    if (req.url === "/html/v1/models") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html></html>");
    }
    send(500, "{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
