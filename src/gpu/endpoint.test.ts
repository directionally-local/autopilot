import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModelsEndpoint, normalizeBaseUrl, serverBaseUrl } from "./endpoint.js";
import { fakeModelsServer } from "./fake-models-server.test-support.js";
import { handoffPath, modelUpResult, requestModelUp } from "./handoff.js";

describe("addresses", () => {
  it("normalizes what was typed into an OpenAI-compatible base URL", () => {
    assert.equal(normalizeBaseUrl("10.0.0.5:8000"), "http://10.0.0.5:8000/v1");
    assert.equal(normalizeBaseUrl("http://gpu:8000/"), "http://gpu:8000/v1");
    assert.equal(normalizeBaseUrl("https://llm.example.com/v1/models"), "https://llm.example.com/v1");
    assert.equal(normalizeBaseUrl("https://gw.example.com/openai/v1/"), "https://gw.example.com/openai/v1");
    assert.equal(normalizeBaseUrl("ftp://x"), undefined);
    assert.equal(normalizeBaseUrl("   "), undefined);
  });

  it("a server's address and port", () => {
    assert.equal(serverBaseUrl("gpu.example.com", "8000"), "http://gpu.example.com:8000/v1");
    assert.equal(serverBaseUrl("10.0.0.5", ""), "http://10.0.0.5:8000/v1");
    assert.equal(serverBaseUrl("fd00::5", "8001"), "http://[fd00::5]:8001/v1");
    assert.equal(serverBaseUrl("gpu", "99999"), undefined);
    assert.equal(serverBaseUrl("", "8000"), undefined);
  });
});

describe("checkModelsEndpoint", () => {
  let server: Awaited<ReturnType<typeof fakeModelsServer>>;
  before(async () => {
    server = await fakeModelsServer();
  });
  after(async () => {
    await server.close();
  });

  it("lists the models a server serves", async () => {
    assert.deepEqual(await checkModelsEndpoint(`${server.url}/v1`), { ok: true, baseUrl: `${server.url}/v1`, models: ["Qwen/Qwen3-4B-Instruct-2507"] });
    const keyed = await checkModelsEndpoint(`${server.url}/locked/v1`, "sk-right");
    assert.equal(keyed.ok, true);
    assert.equal(server.requests.at(-1)?.auth, "Bearer sk-right");
  });

  it("says what's wrong, as a short error type", async () => {
    const error = async (base: string, key?: string) => {
      const r = await checkModelsEndpoint(base, key);
      return r.ok ? "ok" : r.error;
    };
    assert.equal(await error(`${server.url}/locked/v1`), "unauthorized");
    assert.equal(await error(`${server.url}/locked/v1`, "sk-wrong"), "unauthorized");
    assert.equal(await error(`${server.url}/nope/v1`), "http");
    assert.equal(await error(`${server.url}/html/v1`), "not_openai");
    assert.equal(await error(`${server.url}/empty/v1`), "no_models");
    // A port nothing listens on.
    const closed = await fakeModelsServer();
    await closed.close();
    assert.equal(await error(`${closed.url}/v1`), "unreachable");
  });
});

describe("the dl handoff", () => {
  it("writes the model-up request, private to its owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gpu-handoff-"));
    try {
      const path = join(dir, "handoff.json");
      await requestModelUp(path, { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24, totalVramGb: 48 });
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, action: "model-up", gpu: { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24 } });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads what dl says on the relaunch", () => {
    assert.equal(handoffPath({}), undefined);
    assert.equal(handoffPath({ DL_GPU_HANDOFF: "/tmp/x/handoff.json" }), "/tmp/x/handoff.json");
    assert.equal(modelUpResult({}), undefined);
    assert.deepEqual(modelUpResult({ DL_GPU_RESULT: "ok" }), { ok: true });
    assert.deepEqual(modelUpResult({ DL_GPU_RESULT: "failed", DL_GPU_ERROR: "smoke_failed" }), { ok: false, error: "smoke_failed" });
    assert.deepEqual(modelUpResult({ DL_GPU_RESULT: "failed", DL_GPU_ERROR: "rm -rf" }), { ok: false, error: "other" });
  });
});
