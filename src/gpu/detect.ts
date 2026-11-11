/**
 * GPU detection for the first run: is there an Nvidia, AMD or Huawei Ascend accelerator on
 * this machine, which one, and how much memory does it have.
 *
 * Each vendor's tool (nvidia-smi; rocm-smi and amd-smi; npu-smi) is looked up on PATH first,
 * so a machine without them (every Mac, most laptops) answers at once without starting a
 * process. A tool that is there runs with a 1 s timeout, all of them in parallel; a failure,
 * a timeout or output we can't read counts as "not found" and is never shown. The result is
 * cached for the process (`gpuDetection`), and dl passes it back on a relaunch (DL_GPU), so
 * the probes run at most once per session.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type GpuVendor = "nvidia" | "amd" | "ascend";

export interface DetectedGpu {
  vendor: GpuVendor;
  /** The largest card's name, e.g. "NVIDIA GeForce RTX 4090". */
  model: string;
  /** How many accelerators of this vendor. */
  count: number;
  /** The largest card's memory, in GB (rounded). dl model runs one model on one GPU, so this is what decides what fits. */
  vramGb: number;
  /** All cards' memory together, in GB. */
  totalVramGb: number;
}

export const PROBE_TIMEOUT_MS = 1_000;

/**
 * The private-model offer needs a 24 GB Nvidia card: per GPU, not summed, because dl model up
 * runs vLLM on one GPU. A "24 GB" card reports a little less than 24 GiB (an RTX 4090 says
 * 24564 MiB), so the line is at 23 GiB. `dl model up`'s own fit rules decide which models run.
 */
export const PRIVATE_MODEL_MIN_MIB = 23 * 1024;

/** What one probe printed (undefined: the tool isn't there, failed or timed out). */
export type Probe = (tool: string, args: string[]) => Promise<string | undefined>;

/** Whether `tool` is an executable on PATH. Never throws. */
export async function onPath(tool: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const names = process.platform === "win32" ? [`${tool}.exe`, tool] : [tool];
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/** Runs a tool found on PATH with the timeout; a missing tool returns undefined without starting anything. */
export function realProbe(env: NodeJS.ProcessEnv = process.env, timeoutMs = PROBE_TIMEOUT_MS): Probe {
  return async (tool, args) => {
    const path = await onPath(tool, env);
    if (!path) return undefined;
    return new Promise((resolve) => {
      try {
        execFile(path, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env, windowsHide: true }, (error, stdout) => {
          resolve(error ? undefined : String(stdout));
        });
      } catch {
        resolve(undefined);
      }
    });
  };
}

const clean = (name: string) => name.replace(/[^A-Za-z0-9 ._()+/-]/g, "").replace(/\s+/g, " ").trim().slice(0, 64);
const gbOf = (mib: number) => Math.round(mib / 1024);

function summarize(vendor: GpuVendor, cards: Array<{ name: string; mib: number }>): DetectedGpu | undefined {
  if (cards.length === 0) return undefined;
  const largest = cards.reduce((a, b) => (b.mib > a.mib ? b : a));
  const total = cards.reduce((sum, card) => sum + card.mib, 0);
  return { vendor, model: clean(largest.name) || vendorName(vendor), count: cards.length, vramGb: gbOf(largest.mib), totalVramGb: gbOf(total) };
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`: "NVIDIA GeForce RTX 4090, 24564" per GPU. */
export function parseNvidia(stdout: string): DetectedGpu | undefined {
  const cards = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.lastIndexOf(",");
      const mib = Number(line.slice(at + 1).trim());
      return { name: line.slice(0, at).trim(), mib };
    })
    .filter((card) => card.name && Number.isFinite(card.mib) && card.mib > 0);
  return summarize("nvidia", cards);
}

/** `rocm-smi --showproductname --showmeminfo vram --json`: one object per card. */
export function parseRocmSmi(stdout: string): DetectedGpu | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const cards: Array<{ name: string; mib: number }> = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^card\d+$/i.test(key) || !value || typeof value !== "object") continue;
    const card = value as Record<string, unknown>;
    const field = (pattern: RegExp) => Object.entries(card).find(([k]) => pattern.test(k))?.[1];
    const name = String(field(/^card series$/i) ?? field(/^card model$/i) ?? field(/market name/i) ?? "AMD GPU");
    const bytes = Number(field(/vram total memory/i));
    cards.push({ name, mib: Number.isFinite(bytes) ? bytes / 1024 / 1024 : 0 });
  }
  return summarize("amd", cards);
}

/** `amd-smi static --asic --vram --json`: a list (or {gpu_data: [...]}) of cards. */
export function parseAmdSmi(stdout: string): DetectedGpu | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { gpu_data?: unknown })?.gpu_data) ? (raw as { gpu_data: unknown[] }).gpu_data : [];
  const cards = list
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const asic = (item.asic ?? {}) as Record<string, unknown>;
      const vram = (item.vram ?? {}) as Record<string, unknown>;
      const size = vram.size as unknown;
      let mib = 0;
      if (typeof size === "number") mib = size;
      else if (typeof size === "string") mib = Number.parseFloat(size) * (/GB/i.test(size) ? 1024 : 1);
      else if (size && typeof size === "object") {
        const { value, unit } = size as { value?: unknown; unit?: unknown };
        mib = Number(value) * (String(unit).toUpperCase() === "GB" ? 1024 : 1);
      }
      return { name: String(asic.market_name ?? "AMD GPU"), mib: Number.isFinite(mib) ? mib : 0 };
    });
  return summarize("amd", cards);
}

/**
 * `npu-smi info`: a table with two rows per chip, the first naming it ("| 0     910B3 | OK …")
 * and the second ending with HBM usage in MB ("… 3339 / 65536 |").
 */
export function parseNpuSmi(stdout: string): DetectedGpu | undefined {
  const lines = stdout.split("\n");
  const cards: Array<{ name: string; mib: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /^\|\s*\d+\s+((?:Ascend\s*)?\d{3}[A-Za-z0-9]*)\s*\|/.exec(lines[i]!);
    if (!head) continue;
    const memory = [...(lines[i + 1] ?? "").matchAll(/(\d+)\s*\/\s*(\d+)/g)].at(-1);
    const name = head[1]!.replace(/^Ascend\s*/i, "");
    cards.push({ name: `Ascend ${name}`, mib: memory ? Number(memory[2]) : 0 });
  }
  return summarize("ascend", cards);
}

export function vendorName(vendor: GpuVendor): string {
  return vendor === "nvidia" ? "Nvidia" : vendor === "amd" ? "AMD" : "Huawei Ascend";
}

/** All probes at once; the first vendor found wins, Nvidia first. Never throws. */
export async function detectGpus(probe: Probe = realProbe()): Promise<DetectedGpu | null> {
  const safe = (tool: string, args: string[], parse: (out: string) => DetectedGpu | undefined) =>
    probe(tool, args).then((out) => (out ? parse(out) : undefined)).catch(() => undefined);
  const [nvidia, rocm, amd, ascend] = await Promise.all([
    safe("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], parseNvidia),
    safe("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"], parseRocmSmi),
    safe("amd-smi", ["static", "--asic", "--vram", "--json"], parseAmdSmi),
    safe("npu-smi", ["info"], parseNpuSmi),
  ]);
  return nvidia ?? rocm ?? amd ?? ascend ?? null;
}

/** dl's hand-back of an earlier detection (DL_GPU), when it's well-formed. */
export function gpuFromEnv(env: NodeJS.ProcessEnv = process.env): DetectedGpu | null | undefined {
  const text = env.DL_GPU?.trim();
  if (!text) return undefined;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.vendor !== "nvidia" && raw.vendor !== "amd" && raw.vendor !== "ascend") return undefined;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    const vramGb = num(raw.vramGb);
    const count = Math.round(num(raw.count)) || 1;
    return { vendor: raw.vendor, model: clean(String(raw.model ?? "")) || vendorName(raw.vendor), count, vramGb, totalVramGb: num(raw.totalVramGb) || vramGb * count };
  } catch {
    return undefined;
  }
}

let cached: Promise<DetectedGpu | null> | undefined;

/**
 * This session's detection, started on first call (call it early: it runs in the background)
 * and shared after. dl's DL_GPU, when given, is used instead of probing.
 */
export function gpuDetection(env: NodeJS.ProcessEnv = process.env, probe?: Probe): Promise<DetectedGpu | null> {
  if (!cached) {
    const handed = gpuFromEnv(env);
    cached = handed !== undefined ? Promise.resolve(handed) : detectGpus(probe ?? realProbe(env));
  }
  return cached;
}

export function resetGpuDetectionForTesting(): void {
  cached = undefined;
}

/** Whether the private-model offer applies: Nvidia with a 24 GB card. */
export function qualifiesForPrivateModel(gpu: DetectedGpu | null): boolean {
  return gpu?.vendor === "nvidia" && gpu.vramGb * 1024 >= PRIVATE_MODEL_MIN_MIB;
}
