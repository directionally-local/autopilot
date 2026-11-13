/**
 * GPU detection for the first run: is there an Nvidia, AMD or Huawei Ascend accelerator on
 * this machine, which one, and how much memory does it have.
 *
 * Each vendor's tool (nvidia-smi; rocm-smi and amd-smi; npu-smi) is looked up on PATH first,
 * so a machine without them (every Mac, most laptops) answers at once without starting a
 * process. A tool that is there gets up to 10 s (PROBE_BUDGET_MS), all of them in parallel:
 * with persistence mode off, the first nvidia-smi after idle can take seconds while the driver
 * wakes the cards. A tool that is there but times out or fails is tried once more; if it still
 * doesn't answer, the GPU is likely there and the detection says which tool and why
 * (`unanswered`), so the first run can say so instead of taking the no-GPU path. Output we
 * can't read from a tool that succeeded counts as "not found". The result is cached for the
 * process (`gpuDetection`), and dl passes it back on a relaunch (DL_GPU), so the probes run
 * at most once per session.
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

/**
 * How long each tool gets per try (it is tried twice when it times out or fails). nvidia-smi
 * can take several seconds on its first call after idle with persistence mode off; rocm-smi and
 * amd-smi are Python tools that start slowly and also wake the driver; npu-smi reads the
 * driver's state. A machine without any of them never waits.
 */
export const PROBE_BUDGET_MS: Readonly<Record<string, number>> = {
  "nvidia-smi": 10_000,
  "rocm-smi": 10_000,
  "amd-smi": 10_000,
  "npu-smi": 10_000,
};
const DEFAULT_PROBE_BUDGET_MS = 10_000;

/**
 * The private-model offer needs a 24 GB Nvidia card: per GPU, not summed, because dl model up
 * runs vLLM on one GPU. A "24 GB" card reports a little less than 24 GiB (an RTX 4090 says
 * 24564 MiB), so the line is at 23 GiB. `dl model up`'s own fit rules decide which models run.
 */
export const PRIVATE_MODEL_MIN_MIB = 23 * 1024;

/** A tool that is on PATH but didn't answer: it timed out, or exited with an error. */
export interface ProbeFailure {
  failed: "timeout" | "error";
  /** One short line: the tool's first line of error output, or what happened. */
  reason: string;
}

/** What one probe printed; undefined: the tool isn't there; a ProbeFailure: it is, but didn't answer. */
export type Probe = (tool: string, args: string[]) => Promise<string | undefined | ProbeFailure>;

/** A vendor's tool that was found on PATH but didn't answer, twice. */
export interface UnansweredTool {
  vendor: GpuVendor;
  tool: string;
  timedOut: boolean;
  reason: string;
}

/** A session's detection: the GPU found, or none; and, when none was found, a tool that is there but didn't answer. */
export interface GpuDetection {
  gpu: DetectedGpu | null;
  unanswered?: UnansweredTool;
}

const isFailure = (out: unknown): out is ProbeFailure => !!out && typeof out === "object" && "failed" in out;

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

/** One printable line of at most 100 characters. */
function shortLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const line = text.split("\n").map((l) => l.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return line.length > 100 ? `${line.slice(0, 97).trimEnd()}...` : line;
}

/**
 * Runs a tool found on PATH within its budget (PROBE_BUDGET_MS, or `timeoutMs` for every tool);
 * a missing tool returns undefined without starting anything.
 */
export function realProbe(env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): Probe {
  return async (tool, args) => {
    const path = await onPath(tool, env);
    if (!path) return undefined;
    const budget = timeoutMs ?? PROBE_BUDGET_MS[tool] ?? DEFAULT_PROBE_BUDGET_MS;
    return new Promise((resolve) => {
      try {
        execFile(path, args, { timeout: budget, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, env, windowsHide: true }, (error, stdout, stderr) => {
          if (!error) return resolve(String(stdout));
          const timedOut = (error as { killed?: boolean }).killed === true && (error as { signal?: string | null }).signal === "SIGKILL";
          if (timedOut) return resolve({ failed: "timeout", reason: `no reply within ${Math.round(budget / 100) / 10} s` });
          const code = (error as { code?: unknown }).code;
          resolve({ failed: "error", reason: shortLine(String(stderr)) || shortLine(String(stdout)) || (typeof code === "number" ? `exit code ${code}` : shortLine(error.message) || "it failed") });
        });
      } catch (error) {
        resolve({ failed: "error", reason: shortLine((error as Error).message) || "it couldn't start" });
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

type ToolResult = { gpu?: DetectedGpu; unanswered?: UnansweredTool };

/**
 * All probes at once; the first vendor found wins, Nvidia first. A tool that is there but times
 * out or fails is tried once more; when nothing was found, the first tool (same order) that still
 * didn't answer is `unanswered`. A probe that throws counts as not there. Never throws.
 */
export async function probeGpus(probe: Probe = realProbe()): Promise<GpuDetection> {
  const once = (tool: string, args: string[]) => probe(tool, args).catch(() => undefined);
  const run = async (vendor: GpuVendor, tool: string, args: string[], parse: (out: string) => DetectedGpu | undefined): Promise<ToolResult> => {
    let out = await once(tool, args);
    if (isFailure(out)) out = await once(tool, args);
    if (isFailure(out)) return { unanswered: { vendor, tool, timedOut: out.failed === "timeout", reason: out.reason } };
    const gpu = typeof out === "string" && out ? parse(out) : undefined;
    return gpu ? { gpu } : {};
  };
  const results = await Promise.all([
    run("nvidia", "nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], parseNvidia),
    run("amd", "rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"], parseRocmSmi),
    run("amd", "amd-smi", ["static", "--asic", "--vram", "--json"], parseAmdSmi),
    run("ascend", "npu-smi", ["info"], parseNpuSmi),
  ]);
  const gpu = results.find((r) => r.gpu)?.gpu;
  if (gpu) return { gpu };
  const unanswered = results.find((r) => r.unanswered)?.unanswered;
  return unanswered ? { gpu: null, unanswered } : { gpu: null };
}

/** The GPU found, or null (a tool that didn't answer counts as none here; see probeGpus). Never throws. */
export async function detectGpus(probe: Probe = realProbe()): Promise<DetectedGpu | null> {
  return (await probeGpus(probe)).gpu;
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

let cached: Promise<GpuDetection> | undefined;

/**
 * This session's detection, started on first call (call it early: it runs in the background)
 * and shared after. dl's DL_GPU, when given, is used instead of probing.
 */
export function gpuDetection(env: NodeJS.ProcessEnv = process.env, probe?: Probe): Promise<GpuDetection> {
  if (!cached) {
    const handed = gpuFromEnv(env);
    cached = handed !== undefined ? Promise.resolve({ gpu: handed }) : probeGpus(probe ?? realProbe(env));
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
