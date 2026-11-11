import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLifecycle } from "./camouflage-lifecycle.test-support.js";
import type { AppActions } from "./ui/app-bridge.js";
import { configPath } from "./config.js";
import { FIRST_RUN_QUESTION, firstRunChoices } from "./providers/connect.js";
import type { ProviderId } from "./providers/presets.js";
import { DL_STATUS_OPEN } from "./providers/dl-status.js";
import { detectGpus, realProbe, type DetectedGpu } from "./gpu/detect.js";
import { NO_GPU_HINT, REMOTE_SERVER_STEPS, reportModelUpResult, resetGpuFirstRunForTesting, WHERE_QUESTION } from "./gpu/first-run.js";
import { sentGpuTelemetry, setGpuTelemetryTransportForTesting } from "./gpu/telemetry.js";
import { fakeModelsServer } from "./gpu/fake-models-server.test-support.js";

type Sent = { type: string; payload: Record<string, unknown> };
type Option = { value: string; label: string; description?: string };
type FormAnswer = Record<string, string> | null;

const RTX4090X2: DetectedGpu = { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24, totalVramGb: 48 };
const RTX3060: DetectedGpu = { vendor: "nvidia", model: "NVIDIA GeForce RTX 3060", count: 1, vramGb: 12, totalVramGb: 12 };
const MI300X: DetectedGpu = { vendor: "amd", model: "AMD Instinct MI300X", count: 8, vramGb: 192, totalVramGb: 1536 };
const ASCEND: DetectedGpu = { vendor: "ascend", model: "Ascend 910B3", count: 2, vramGb: 64, totalVramGb: 128 };

/** A View on a fake renderer: select prompts and forms answer from queues; GPU detection and dl's environment are given. */
async function fakeView(select: (string | null)[], o: { gpu?: DetectedGpu | null; env?: NodeJS.ProcessEnv; forms?: FormAnswer[] } = {}) {
  process.env.AUTOPILOT_JOBS_DB = join(await mkdtemp(join(tmpdir(), "cam-gpu-")), "jobs.db");
  const { View } = await import("./camouflage-view.js");
  const sent: Sent[] = [];
  const prompts: Sent[] = [];
  const forms = [...(o.forms ?? [])];
  const cam = attachLifecycle(
    { send: (type: string, payload: Record<string, unknown> = {}) => (sent.push({ type, payload }), true), on() { return this; }, close: async () => 0 },
    { permission: async () => ({ choice: "deny" as const }) },
  );
  const sdk = {
    mount: async () => cam,
    selectList: async (_c: unknown, spec: Record<string, unknown>) => {
      prompts.push({ type: "select", payload: spec });
      const value = select.shift();
      return value === null || value === undefined ? { id: "", cancelled: true } : { id: "", value, cancelled: false };
    },
    confirm: async () => ({ id: "", cancelled: true }),
    form: async (_c: unknown, spec: Record<string, unknown>) => {
      prompts.push({ type: "form", payload: spec });
      const values = forms.shift();
      return values ? { id: "", values, cancelled: false } : { id: "", cancelled: true };
    },
  };
  const view = new View(cam as never, sdk as never);
  view.connect(new Proxy({}, { get: () => () => undefined }) as AppActions);
  view.freeStatus = async () => DL_STATUS_OPEN;
  let detections = 0;
  view.gpuCalls = { detect: async () => (detections++, o.gpu ?? null), env: o.env ?? {} };
  const verified: Array<{ id: ProviderId; key?: string; baseUrl?: string }> = [];
  view.providerCalls = {
    dlSignIn: async () => ({ key: "at-1" }),
    verify: async (id: ProviderId, key: string | undefined, source, baseUrl?: string) => {
      verified.push({ id, ...(key ? { key } : {}), ...(baseUrl ? { baseUrl } : {}) });
      return { ok: true, connection: { id, ...(key ? { key } : {}), source, ...(baseUrl ? { baseUrl } : {}) } };
    },
    dlMe: async () => null as never,
  };
  const said = () => sent.filter((s) => s.type === "RuntimeError").map((s) => String(s.payload.message));
  const splash = () => sent.filter((s) => s.type === "Splash").map((s) => String(s.payload.text)).join("\n");
  const options = (i: number) => (prompts[i]?.payload.options as Option[]).map((x) => x.value);
  const titles = () => prompts.map((p) => String(p.payload.prompt ?? p.payload.title));
  return { view, prompts, said, splash, options, titles, verified, detections: () => detections };
}

const events = () => sentGpuTelemetry().map((e) => ({ ...e }));
const savedConfig = async () => JSON.parse(await readFile(configPath(), "utf8")) as { provider: string; model: string; providers: Record<string, { baseUrl?: string; apiKey?: string }> };

describe("GPU-aware first run", () => {
  let root: string;
  let handoffDir: string;
  const saved = process.env.XDG_CONFIG_HOME;
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "gpu-first-run-"));
  });
  beforeEach(async () => {
    process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "h-"));
    handoffDir = await mkdtemp(join(root, "dl-gpu-"));
    setGpuTelemetryTransportForTesting(async () => new Response(null, { status: 204 }));
    resetGpuFirstRunForTesting();
  });
  afterEach(() => setGpuTelemetryTransportForTesting(undefined));
  after(async () => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    await rm(root, { recursive: true, force: true });
  });
  const dl = () => ({ DL_GPU_HANDOFF: join(handoffDir, "handoff.json"), AUTOPILOT_LAUNCHED_BY: "dl" });

  it("the question has three answers: Free (the default), your own key, your own GPUs", async () => {
    const { view, prompts, options } = await fakeView([null]);
    assert.equal(await view.firstRunSetup({ upgrading: false }), false);
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.deepEqual(options(0), ["free", "own-key", "gpus"]);
    assert.deepEqual(firstRunChoices().map((c) => c.label).slice(1), ["Use my own API key", "Use your own GPUs"]);
    assert.deepEqual(
      firstRunChoices({ free: "paused" } as never).map((c) => c.value),
      ["own-key", "gpus", "free"],
      "paused, Free goes last as before",
    );
    view.dispose();
  });

  it("no GPU: the usual question, plus one line for GPUs on a server; counted once as none", async () => {
    const { view, said, prompts } = await fakeView([null]);
    await view.firstRunSetup({ upgrading: false });
    assert.ok(said().includes(NO_GPU_HINT));
    assert.equal(NO_GPU_HINT, "Have GPUs on a server? Run curl -fsSL https://dl.new | sh there.");
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION, "nothing asked before the question");
    assert.deepEqual(events(), [{ event: "detected", gpuVendor: "none" }]);
    const again = await fakeView([null]);
    await again.view.firstRunSetup({ upgrading: false });
    assert.deepEqual(events(), [{ event: "detected", gpuVendor: "none" }], "the detection is counted once per machine");
    view.dispose();
    again.view.dispose();
  });

  it("Nvidia with 24 GB, started by dl, yes: hands over to dl model up and skips the question", async () => {
    const { view, prompts, said } = await fakeView(["yes"], { gpu: RTX4090X2, env: dl() });
    assert.equal(await view.firstRunSetup({ upgrading: false }), "model-up");
    assert.equal(prompts.length, 1, "the provider question is skipped");
    assert.equal(prompts[0]?.payload.prompt, "Found 2x NVIDIA GeForce RTX 4090 (24 GB each). Run a private model on this GPU?");
    assert.equal(prompts[0]?.payload.default, "yes");
    assert.deepEqual(JSON.parse(await readFile(dl().DL_GPU_HANDOFF, "utf8")), {
      version: 1,
      action: "model-up",
      gpu: { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24 },
    });
    assert.deepEqual(events(), [
      { event: "detected", gpuVendor: "nvidia", gpuModel: "NVIDIA GeForce RTX 4090", gpuVramGb: 24, gpuCount: 2 },
      { event: "prompt", gpuVendor: "nvidia", answer: "yes", gpuVramGb: 24 },
    ]);
    assert.ok(!said().some((l) => /dl model up can run|Have GPUs/.test(l)));
    view.dispose();
  });

  it("Nvidia with 24 GB, no: the usual question, and the answer is remembered", async () => {
    const { view, prompts, options } = await fakeView(["no", null], { gpu: RTX4090X2, env: dl() });
    assert.equal(await view.firstRunSetup({ upgrading: false }), false);
    assert.equal(prompts[1]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.deepEqual(options(1), ["free", "own-key", "gpus"]);
    assert.deepEqual(events().at(-1), { event: "prompt", gpuVendor: "nvidia", answer: "no", gpuVramGb: 24 });
    const again = await fakeView([null], { gpu: RTX4090X2, env: dl() });
    await again.view.firstRunSetup({ upgrading: false });
    assert.equal(again.prompts[0]?.payload.prompt, FIRST_RUN_QUESTION, "not asked again");
    view.dispose();
    again.view.dispose();
  });

  it("Nvidia under 24 GB: the usual question, plus the dl model up hint", async () => {
    const { view, prompts, said } = await fakeView([null], { gpu: RTX3060, env: dl() });
    await view.firstRunSetup({ upgrading: false });
    assert.ok(said().includes("Found 1x NVIDIA GeForce RTX 3060 (12 GB). dl model up can run small models on it."));
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    view.dispose();
  });

  it("a 24 GB card without dl (plain autopilot): a pointer to dl model up instead of the offer", async () => {
    const { view, prompts, said } = await fakeView([null], { gpu: RTX4090X2, env: {} });
    await view.firstRunSetup({ upgrading: false });
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.ok(said().includes("Found 2x NVIDIA GeForce RTX 4090 (24 GB each). To run a private model on it: curl -fsSL https://dl.new | sh, then dl model up."));
    view.dispose();
  });

  it("AMD: early access asked once (No is the default), counted with the GPU, then the usual question", async () => {
    const { view, prompts, said } = await fakeView(["yes", null], { gpu: MI300X, env: dl() });
    await view.firstRunSetup({ upgrading: false });
    assert.equal(prompts[0]?.payload.prompt, "Detected AMD Instinct MI300X. Support is coming. Want early access?");
    assert.equal(prompts[0]?.payload.default, "no");
    assert.equal(prompts[1]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.ok(said().includes("Thanks, counted."));
    assert.deepEqual(events().at(-1), { event: "early_access", gpuVendor: "amd", answer: "yes", gpuModel: "AMD Instinct MI300X", gpuVramGb: 192 });
    const again = await fakeView([null], { gpu: MI300X, env: dl() });
    await again.view.firstRunSetup({ upgrading: false });
    assert.equal(again.prompts[0]?.payload.prompt, FIRST_RUN_QUESTION, "asked once");
    view.dispose();
    again.view.dispose();
  });

  it("Ascend: the same question, with Huawei's name", async () => {
    const { view, prompts } = await fakeView(["no", null], { gpu: ASCEND, env: dl() });
    await view.firstRunSetup({ upgrading: false });
    assert.equal(prompts[0]?.payload.prompt, "Detected Huawei Ascend 910B3. Support is coming. Want early access?");
    assert.deepEqual(events().at(-1), { event: "early_access", gpuVendor: "ascend", answer: "no", gpuModel: "Ascend 910B3", gpuVramGb: 64 });
    view.dispose();
  });

  it("back from a dl model up that failed: says why, doesn't offer it again this time, counts the failure", async () => {
    const env = { ...dl(), DL_GPU_RESULT: "failed", DL_GPU_ERROR: "smoke_failed" };
    const { view, prompts, said } = await fakeView([null], { gpu: RTX4090X2, env });
    reportModelUpResult(env);
    await view.firstRunSetup({ upgrading: false });
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.ok(said().includes("The private model didn't start (its tests failed). Pick another way for now; dl model up works any time."));
    assert.deepEqual(events()[0], { event: "result", outcome: "failed", path: "this_machine", errorType: "smoke_failed", gpuVendor: "nvidia" });
    view.dispose();
  });

  it("Use your own GPUs → On this machine hands over to dl model up", async () => {
    const { view, prompts, options } = await fakeView(["no", "gpus", "this_machine"], { gpu: RTX4090X2, env: dl() });
    assert.equal(await view.firstRunSetup({ upgrading: false }), "model-up");
    assert.equal(prompts[2]?.payload.prompt, WHERE_QUESTION);
    assert.deepEqual(options(2), ["this_machine", "remote_server", "endpoint"]);
    assert.deepEqual(events().filter((e) => e.event === "option").map((e) => (e as { option: string }).option), ["gpus", "this_machine"]);
    view.dispose();
  });

  describe("on another server, or an endpoint", () => {
    let server: Awaited<ReturnType<typeof fakeModelsServer>>;
    before(async () => {
      server = await fakeModelsServer();
    });
    after(async () => {
      await server.close();
    });

    it("another server: the two commands, its address and port, /v1/models checked, saved as vLLM", async () => {
      const port = new URL(server.url).port;
      const { view, prompts, said, splash, options } = await fakeView(["gpus", "remote_server"], { forms: [{ address: "127.0.0.1", port }] });
      assert.equal(await view.firstRunSetup({ upgrading: false }), true);
      assert.deepEqual(options(1), ["remote_server", "endpoint"], "no GPU here: no 'this machine'");
      for (const line of REMOTE_SERVER_STEPS) assert.ok(splash().includes(line.trim()), line);
      assert.equal(prompts[2]?.payload.title, "Your GPU server");
      assert.ok(said().includes(`✓ http://127.0.0.1:${port}/v1 serves 1 model`));
      const cfg = await savedConfig();
      assert.equal(cfg.provider, "vllm");
      assert.equal(cfg.model, "Qwen/Qwen3-4B-Instruct-2507", "the only model is picked for you");
      assert.equal(cfg.providers.vllm?.baseUrl, `http://127.0.0.1:${port}/v1`);
      assert.deepEqual(events().at(-1), { event: "result", outcome: "ok", path: "remote_server" });
      view.dispose();
    });

    it("another server that can't be reached: says so, with the tunnel hint, and asks again", async () => {
      const closed = await fakeModelsServer();
      await closed.close();
      const port = new URL(closed.url).port;
      const { view, said, prompts } = await fakeView(["gpus", "remote_server", null, null], { forms: [{ address: "127.0.0.1", port }, null] });
      assert.equal(await view.firstRunSetup({ upgrading: false }), false);
      assert.ok(said().some((l) => l.startsWith(`Couldn't reach http://127.0.0.1:${port}/v1`)));
      assert.ok(said().some((l) => l.includes(`ssh -N -L ${port}:127.0.0.1:${port} you@that-server`)));
      assert.equal(prompts.filter((p) => p.payload.title === "Your GPU server").length, 2, "the form comes back");
      assert.deepEqual(events().filter((e) => e.event === "result"), [{ event: "result", outcome: "failed", path: "remote_server", errorType: "unreachable" }]);
      view.dispose();
    });

    it("an endpoint you run: URL and key, its models listed to pick from, saved with the key", async () => {
      const { view, verified, prompts } = await fakeView(["gpus", "endpoint", "b"], { forms: [{ url: `${server.url}/two/v1`, key: "" }] });
      assert.equal(await view.firstRunSetup({ upgrading: false }), true);
      const picker = prompts.find((p) => p.payload.prompt === "Pick a model");
      assert.deepEqual((picker?.payload.options as Option[]).map((x) => x.value), ["a", "b"]);
      const cfg = await savedConfig();
      assert.equal(cfg.provider, "vllm");
      assert.equal(cfg.model, "b");
      assert.equal(cfg.providers.vllm?.baseUrl, `${server.url}/two/v1`);
      assert.deepEqual(verified.at(-1), { id: "vllm", baseUrl: `${server.url}/two/v1` });
      assert.deepEqual(events().at(-1), { event: "result", outcome: "ok", path: "endpoint" });
      view.dispose();
    });

    it("an endpoint that needs a key: rejected without one, saved with the right one", async () => {
      const { view, said } = await fakeView(["gpus", "endpoint"], { forms: [{ url: `${server.url}/locked/v1` }, { url: `${server.url}/locked/v1`, key: "sk-right" }] });
      assert.equal(await view.firstRunSetup({ upgrading: false }), true);
      assert.ok(said().includes(`${server.url}/locked/v1 needs an API key, or rejected this one.`));
      assert.ok(events().some((e) => e.event === "result" && e.outcome === "failed" && e.errorType === "unauthorized"));
      const cfg = await savedConfig();
      assert.equal(cfg.providers.vllm?.apiKey, "sk-right");
      view.dispose();
    });

    it("a URL that isn't one: says how it should look", async () => {
      const { view, said } = await fakeView(["gpus", "endpoint", null, null], { forms: [{ url: "ftp://nope" }, null] });
      assert.equal(await view.firstRunSetup({ upgrading: false }), false);
      assert.ok(said().includes("Enter a URL like http://10.0.0.5:8000/v1"));
      view.dispose();
    });
  });

  it("no GPU tools on this machine: the question shows as fast as before (no probe timeout waited for)", async () => {
    const empty = await mkdtemp(join(root, "no-gpu-tools-"));
    const { view, prompts } = await fakeView([null]);
    view.gpuCalls = { detect: () => detectGpus(realProbe({ PATH: empty })), env: dl() };
    const started = performance.now();
    let shownAfter = Infinity;
    const select = (view as unknown as { select: (...a: unknown[]) => Promise<string | null> }).select.bind(view);
    (view as unknown as { select: (...a: unknown[]) => Promise<string | null> }).select = (...a: unknown[]) => {
      shownAfter = Math.min(shownAfter, performance.now() - started);
      return select(...a);
    };
    await view.firstRunSetup({ upgrading: false });
    assert.equal(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.ok(shownAfter < 100, `the question showed after ${shownAfter.toFixed(1)} ms`);
    view.dispose();
  });

  it("detection runs once for the whole first run", async () => {
    const { view, detections } = await fakeView(["gpus", null, null], { gpu: RTX3060, env: dl() });
    await view.firstRunSetup({ upgrading: false });
    assert.equal(detections(), 1);
    view.dispose();
  });
});
