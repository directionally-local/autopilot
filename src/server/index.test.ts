import { describe, it, after } from "node:test";
import assert from "node:assert";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KimiConfig } from "../config.js";
import { checkLegacyRequest, isLoopbackHost, startServer } from "./index.js";

const local = { listenHost: "127.0.0.1", corsOrigins: [] as string[] };

describe("checkLegacyRequest", () => {
  it("lets non-browser clients through and refuses other origins", () => {
    assert.deepStrictEqual(checkLegacyRequest({ host: "127.0.0.1:4096" }, local), { ok: true });
    assert.deepStrictEqual(checkLegacyRequest({ host: "localhost:4096", origin: "http://localhost:4096" }, local), { ok: true });
    assert.equal(checkLegacyRequest({ host: "127.0.0.1:4096", origin: "https://evil.example" }, local).ok, false);
    assert.equal(checkLegacyRequest({ host: "127.0.0.1:4096", origin: "null" }, local).ok, false);
  });

  it("refuses non-loopback Host headers on a loopback listener (DNS rebinding)", () => {
    assert.equal(checkLegacyRequest({ host: "attacker.example:4096" }, local).ok, false);
    assert.equal(checkLegacyRequest({}, local).ok, false);
    assert.deepStrictEqual(checkLegacyRequest({ host: "[::1]:4096" }, local), { ok: true });
    assert.deepStrictEqual(checkLegacyRequest({ host: "box.lan:4096" }, { ...local, listenHost: "0.0.0.0" }), { ok: true });
  });

  it("reflects only configured CORS origins", () => {
    const opts = { ...local, corsOrigins: ["https://app.example"] };
    assert.deepStrictEqual(checkLegacyRequest({ host: "127.0.0.1:4096", origin: "https://app.example" }, opts), { ok: true, allowOrigin: "https://app.example" });
    assert.ok(isLoopbackHost("127.0.0.2") && isLoopbackHost("localhost") && !isLoopbackHost("0.0.0.0"));
  });
});

describe("startServer without a password", () => {
  const prev = { ...process.env };
  process.env.HOME = mkdtempSync(join(tmpdir(), "serve-guard-"));
  delete process.env.KIMIFLARE_SERVER_PASSWORD;
  delete process.env.KIMIFLARE_SERVER_CORS_ORIGINS;
  after(() => {
    process.env = prev;
  });
  const config = { openrouterApiKey: "k", model: "m/m" } as KimiConfig;

  it("refuses to listen beyond loopback", async () => {
    await assert.rejects(startServer({ port: 0, hostname: "0.0.0.0", config }), /KIMIFLARE_SERVER_PASSWORD/);
  });

  it("blocks browser and rebinding requests but serves local clients", async () => {
    const server = await startServer({ port: 0, hostname: "127.0.0.1", config });
    const port = (server.address() as { port: number }).port;
    const get = (headers: Record<string, string>, method = "GET") =>
      new Promise<{ status: number; cors: string | undefined }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/session", method, headers }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, cors: res.headers["access-control-allow-origin"] as string | undefined });
        });
        req.on("error", reject);
        req.end();
      });
    try {
      assert.deepStrictEqual(await get({}), { status: 200, cors: undefined });
      assert.equal((await get({ Origin: "https://evil.example" })).status, 403);
      assert.equal((await get({ Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }, "OPTIONS")).status, 403);
      assert.equal((await get({ Host: `attacker.example:${port}` })).status, 403);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
