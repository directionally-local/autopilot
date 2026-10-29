import { createServer } from "node:net";
import { connect } from "node:net";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KimiConfig } from "../config.js";
import { setupRoutes } from "./routes.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

describe("server setup", () => {
  // Regression: #865 dropped this call, so code conversations failed to provision on
  // servers whose Hotcell has no GitHub gateway (the proxy is how they reach GitHub).
  it("starts the repository-scoped GitHub proxy when it's configured", async () => {
    const port = await freePort();
    const saved = { ...process.env };
    process.env.AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN = `127.0.0.1:${port}`;
    process.env.AUTOPILOT_ASTER_GITHUB_PROXY_URL = `http://host.docker.internal:${port}`;
    process.env.GITHUB_TOKEN = "github_pat_test_only_not_a_real_token";
    delete process.env.AUTOPILOT_HOTCELL_ENDPOINT;
    const { cleanup } = setupRoutes({ model: "test/model" } as KimiConfig);
    try {
      let up = false;
      for (let attempt = 0; attempt < 50 && !up; attempt++) {
        up = await accepts(port);
        if (!up) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(up, "the GitHub proxy listens on AUTOPILOT_ASTER_GITHUB_PROXY_LISTEN");
    } finally {
      await cleanup();
      process.env = saved;
    }
    assert.equal(await accepts(port), false, "cleanup closes it");
  });
});
