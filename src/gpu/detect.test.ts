import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGpus,
  gpuDetection,
  gpuFromEnv,
  parseAmdSmi,
  parseNpuSmi,
  parseNvidia,
  parseRocmSmi,
  qualifiesForPrivateModel,
  realProbe,
  resetGpuDetectionForTesting,
  type Probe,
} from "./detect.js";

const NVIDIA_2X4090 = "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n";

const NPU_SMI = `+------------------------------------------------------------------------------------------------+
| npu-smi 23.0.rc2                 Version: 23.0.rc2                                             |
+---------------------------+---------------+----------------------------------------------------+
| NPU   Name                | Health        | Power(W)    Temp(C)           Hugepages-Usage(page)|
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)        |
+===========================+===============+====================================================+
| 0     910B3               | OK            | 93.3        41                0    / 0             |
| 0                         | 0000:C1:00.0  | 0           0    / 0          3339 / 65536         |
+===========================+===============+====================================================+
| 1     910B3               | OK            | 90.1        40                0    / 0             |
| 0                         | 0000:C2:00.0  | 0           0    / 0          3339 / 65536         |
+===========================+===============+====================================================+
`;

describe("parsing each vendor's tool", () => {
  it("nvidia-smi: count, the largest card's name and memory, and the total", () => {
    assert.deepEqual(parseNvidia(NVIDIA_2X4090), { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24, totalVramGb: 48 });
    assert.deepEqual(parseNvidia("NVIDIA GeForce RTX 3060, 12288\n"), { vendor: "nvidia", model: "NVIDIA GeForce RTX 3060", count: 1, vramGb: 12, totalVramGb: 12 });
    assert.equal(parseNvidia("No devices were found\n"), undefined);
    assert.equal(parseNvidia(""), undefined);
  });

  it("rocm-smi and amd-smi JSON", () => {
    const rocm = JSON.stringify({ card0: { "Card series": "AMD Instinct MI300X", "VRAM Total Memory (B)": String(192 * 1024 ** 3) }, system: {} });
    assert.deepEqual(parseRocmSmi(rocm), { vendor: "amd", model: "AMD Instinct MI300X", count: 1, vramGb: 192, totalVramGb: 192 });
    const amd = JSON.stringify([{ gpu: 0, asic: { market_name: "AMD Radeon PRO W7900" }, vram: { size: { value: 49152, unit: "MB" } } }]);
    assert.deepEqual(parseAmdSmi(amd), { vendor: "amd", model: "AMD Radeon PRO W7900", count: 1, vramGb: 48, totalVramGb: 48 });
    assert.equal(parseRocmSmi("not json"), undefined);
    assert.equal(parseAmdSmi("[]"), undefined);
  });

  it("npu-smi's table", () => {
    assert.deepEqual(parseNpuSmi(NPU_SMI), { vendor: "ascend", model: "Ascend 910B3", count: 2, vramGb: 64, totalVramGb: 128 });
    assert.equal(parseNpuSmi("npu-smi: command failed"), undefined);
  });

  it("the private-model offer needs a 24 GB Nvidia card (a 4090's 24564 MiB counts)", () => {
    assert.equal(qualifiesForPrivateModel(parseNvidia(NVIDIA_2X4090)!), true);
    assert.equal(qualifiesForPrivateModel(parseNvidia("NVIDIA GeForce RTX 4080, 16376\n")!), false);
    assert.equal(qualifiesForPrivateModel(parseNvidia("NVIDIA GeForce RTX 4080, 16376\nNVIDIA GeForce RTX 4080, 16376\n")!), false, "per GPU, not summed: dl model up runs on one GPU");
    assert.equal(qualifiesForPrivateModel({ vendor: "amd", model: "MI300X", count: 1, vramGb: 192, totalVramGb: 192 }), false);
    assert.equal(qualifiesForPrivateModel(null), false);
  });
});

describe("detectGpus", () => {
  it("asks every tool at once and prefers Nvidia", async () => {
    const asked: string[] = [];
    const probe: Probe = async (tool) => {
      asked.push(tool);
      if (tool === "nvidia-smi") return NVIDIA_2X4090;
      if (tool === "npu-smi") return NPU_SMI;
      return undefined;
    };
    assert.equal((await detectGpus(probe))?.vendor, "nvidia");
    assert.deepEqual(asked.sort(), ["amd-smi", "npu-smi", "nvidia-smi", "rocm-smi"]);
  });

  it("a probe that throws or prints nonsense is no GPU, never an error", async () => {
    assert.equal(await detectGpus(async () => { throw new Error("boom"); }), null);
    assert.equal(await detectGpus(async () => "garbage"), null);
  });

  it("dl's hand-back (DL_GPU) is used instead of probing", async () => {
    resetGpuDetectionForTesting();
    let probed = 0;
    const gpu = await gpuDetection({ DL_GPU: JSON.stringify({ vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24 }) }, async () => { probed++; return undefined; });
    assert.deepEqual(gpu, { vendor: "nvidia", model: "NVIDIA GeForce RTX 4090", count: 2, vramGb: 24, totalVramGb: 48 });
    assert.equal(probed, 0);
    assert.equal(gpuFromEnv({ DL_GPU: "{bad" }), undefined);
    assert.equal(gpuFromEnv({ DL_GPU: JSON.stringify({ vendor: "intel" }) }), undefined);
    resetGpuDetectionForTesting();
  });

  it("is cached for the session: the probes run once", async () => {
    resetGpuDetectionForTesting();
    let probed = 0;
    const probe: Probe = async () => { probed++; return undefined; };
    await gpuDetection({}, probe);
    await gpuDetection({}, probe);
    assert.equal(probed, 4, "four tools, once");
    resetGpuDetectionForTesting();
  });
});

describe("real probes, with fake tools on PATH", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "gpu-probe-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const tool = async (bin: string, name: string, script: string) => {
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, name), 0o755);
  };

  it("finds an Nvidia GPU through a fake nvidia-smi", async () => {
    const bin = join(dir, "nvidia");
    await tool(bin, "nvidia-smi", `printf '${NVIDIA_2X4090.replace(/\n/g, "\\n")}'`);
    const gpu = await detectGpus(realProbe({ PATH: bin }));
    assert.equal(gpu?.model, "NVIDIA GeForce RTX 4090");
    assert.equal(gpu?.count, 2);
  });

  it("finds Ascend through a fake npu-smi, and AMD through a fake rocm-smi", async () => {
    const npu = join(dir, "npu");
    await writeFile(join(dir, "npu.txt"), NPU_SMI);
    await tool(npu, "npu-smi", `exec /bin/cat '${join(dir, "npu.txt")}'`);
    assert.equal((await detectGpus(realProbe({ PATH: npu })))?.vendor, "ascend");
    const rocm = join(dir, "rocm");
    await tool(rocm, "rocm-smi", `echo '${JSON.stringify({ card0: { "Card series": "AMD Instinct MI300X", "VRAM Total Memory (B)": "206158430208" } })}'`);
    assert.equal((await detectGpus(realProbe({ PATH: rocm })))?.model, "AMD Instinct MI300X");
  });

  it("a tool that fails says nothing and finds nothing", async () => {
    const bin = join(dir, "failing");
    await tool(bin, "nvidia-smi", "echo 'NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver' >&2; exit 9");
    assert.equal(await detectGpus(realProbe({ PATH: bin })), null);
  });

  it("a tool that hangs is given up on after 1 s", async () => {
    const bin = join(dir, "hanging");
    await tool(bin, "nvidia-smi", "exec /bin/sleep 10");
    const started = performance.now();
    assert.equal(await detectGpus(realProbe({ PATH: bin })), null);
    const took = performance.now() - started;
    assert.ok(took >= 900 && took < 3_000, `timed out after ~1 s (took ${Math.round(took)} ms)`);
  });

  it("no GPU tools at all (a Mac, most laptops): answers at once, without waiting for any timeout", async () => {
    const empty = join(dir, "empty");
    await mkdir(empty, { recursive: true });
    const started = performance.now();
    for (let i = 0; i < 5; i++) assert.equal(await detectGpus(realProbe({ PATH: `${empty}:${join(dir, "also-missing")}` })), null);
    const each = (performance.now() - started) / 5;
    assert.ok(each < 50, `no-GPU detection took ${each.toFixed(1)} ms; it must not slow the first screen`);
  });
});
