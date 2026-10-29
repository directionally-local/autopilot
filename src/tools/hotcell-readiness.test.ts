import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer, type AddressInfo } from "node:net";
import { checkHotcellReadiness, resetHotcellReadinessCache } from "./hotcell-readiness.js";

describe("checkHotcellReadiness", () => {
  it("reports ready when the daemon port accepts connections", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    resetHotcellReadinessCache();
    try {
      const result = await checkHotcellReadiness({ endpoint: `http://127.0.0.1:${port}`, useCache: false });
      assert.strictEqual(result.ready, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports the missing CLI when the port is closed and the binary is absent", async () => {
    resetHotcellReadinessCache();
    const result = await checkHotcellReadiness({
      endpoint: "http://127.0.0.1:1",
      command: "definitely-not-a-real-hotcell-binary",
      timeoutMs: 100,
      useCache: false,
    });
    assert.strictEqual(result.ready, false);
    assert.match(String(result.reason), /not installed/);
    assert.match(String(result.fix), /hotcell start --defaults/);
  });

  it("caches the probe for the TTL", async () => {
    resetHotcellReadinessCache();
    const opts = { endpoint: "http://127.0.0.1:1", command: "definitely-not-a-real-hotcell-binary", timeoutMs: 100 };
    const first = await checkHotcellReadiness(opts);
    const second = await checkHotcellReadiness(opts);
    assert.deepStrictEqual(second, first);
  });
});
