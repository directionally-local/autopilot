/**
 * KimiFlare headless HTTP server.
 *
 * Provides a local REST API + SSE event stream for CI integration,
 * editor plugins, and scripting. Built on Node's built-in `http` module
 * to avoid extra dependencies.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import type { KimiConfig } from "../config.js";
import { logger } from "../util/logger.js";
import { installExitHandlers, onShutdown } from "../util/exit.js";
import { setupRoutes } from "./routes.js";
import type { AsterApiRuntime } from "./aster-api.js";

export interface ServerOpts {
  port: number;
  hostname: string;
  config: KimiConfig;
  /** Injectable Aster runtime; defaults to the Hotcell-backed runtime when its env is configured. */
  asterRuntime?: AsterApiRuntime;
}

export async function startServer(opts: ServerOpts): Promise<Server> {
  const { handleRequest, cleanup } = setupRoutes(opts.config, { asterRuntime: opts.asterRuntime });

  const password = process.env.KIMIFLARE_SERVER_PASSWORD;
  if (!password && !isLoopbackHost(opts.hostname)) {
    throw new Error(`Refusing to listen on ${opts.hostname} without KIMIFLARE_SERVER_PASSWORD: the API can run tools on this machine.`);
  }
  const corsOrigins = parseOrigins(process.env.KIMIFLARE_SERVER_CORS_ORIGINS);

  const server = createServer((req, res) => {
    const isAsterApi = req.url?.startsWith("/api/v1/") === true;
    if (!isAsterApi) {
      const verdict = checkLegacyRequest(req.headers, { listenHost: opts.hostname, corsOrigins });
      if (!verdict.ok) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: verdict.error }));
        return;
      }
      if (verdict.allowOrigin) {
        res.setHeader("Access-Control-Allow-Origin", verdict.allowOrigin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Last-Event-ID");
      }
    }

    if (req.method === "OPTIONS" && !isAsterApi) {
      res.writeHead(204);
      res.end();
      return;
    }

    // Legacy local API Basic auth. The versioned Aster API authenticates its own scoped bearer token.
    if (!isAsterApi && password) {
      const auth = req.headers.authorization ?? "";
      const expected = "Basic " + Buffer.from(`kimiflare:${password}`).toString("base64");
      if (auth !== expected) {
        res.writeHead(401, { "WWW-Authenticate": 'Basic realm="kimiflare"' });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    void handleRequest(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  // Graceful shutdown (#877): stop sessions (awaiting their SessionEnd
  // hooks), close the listener, flush OTel — bounded by the shared exit
  // deadline — then exit.
  const unregisterShutdown = onShutdown("server", async () => {
    // Abort turns and close session SSE streams, stop accepting connections,
    // then drop the rest: a global /event stream never ends on its own and
    // would hold server.close() open until the deadline.
    const ended = cleanup();
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await Promise.all([ended, closed]);
  });
  server.on("close", () => {
    unregisterShutdown();
    void cleanup();
  });
  installExitHandlers({ signals: ["SIGINT", "SIGTERM"], exitCode: () => 0, crashes: true });

  return new Promise((resolve, reject) => {
    server.listen(opts.port, opts.hostname, () => {
      logger.info("server: listening", { hostname: opts.hostname, port: opts.port });
      console.log(`kimiflare serve: http://${opts.hostname}:${opts.port}`);
      console.log(`  API docs: http://${opts.hostname}:${opts.port}/doc`);
      console.log(`  SSE stream: http://${opts.hostname}:${opts.port}/event`);
      resolve(server);
    });
    server.on("error", reject);
  });
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return LOOPBACK_NAMES.has(h) || h.startsWith("127.");
}

function parseOrigins(value: string | undefined): string[] {
  return (value ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean);
}

/** Host header without its port (`[::1]:4096` -> `[::1]`). */
function hostName(header: string): string {
  return header.startsWith("[") ? header.slice(0, header.indexOf("]") + 1) : (header.split(":")[0] ?? "");
}

/**
 * Browser protections for the legacy local API, which can run tools on this
 * machine. A web page the user has open must not be able to reach it:
 *  - cross-origin requests are refused unless the origin is listed in
 *    KIMIFLARE_SERVER_CORS_ORIGINS (no wildcard CORS);
 *  - on a loopback listener the Host header must be a loopback name, which
 *    defeats DNS rebinding (attacker.example resolving to 127.0.0.1).
 * Non-browser clients (curl, SDKs, editor plugins) send no Origin and are unaffected.
 */
export function checkLegacyRequest(
  headers: { host?: string; origin?: string },
  opts: { listenHost: string; corsOrigins: string[] },
): { ok: true; allowOrigin?: string } | { ok: false; error: string } {
  if (isLoopbackHost(opts.listenHost) && !isLoopbackHost(hostName(headers.host ?? ""))) {
    return { ok: false, error: "Host not allowed" };
  }
  const origin = headers.origin;
  if (!origin) return { ok: true };
  if (opts.corsOrigins.includes(origin)) return { ok: true, allowOrigin: origin };
  // Same-origin requests (a page this server served) are fine.
  try {
    if (headers.host && new URL(origin).host === headers.host) return { ok: true };
  } catch {
    // malformed Origin: refuse below
  }
  return { ok: false, error: "Cross-origin request refused; set KIMIFLARE_SERVER_CORS_ORIGINS to allow an origin" };
}
