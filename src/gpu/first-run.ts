/**
 * The GPU-aware first run's words and remembered answers. The screens are in
 * camouflage-view.ts (`gpuPreScreen`, `ownGpus`); this module is the UI-free part, so the copy
 * and the decisions can be tested on their own.
 *
 * Before "How should it think?", what was found on this machine decides one of:
 * - Nvidia with a 24 GB card, started by dl: "Run a private model on this GPU?" Yes hands over
 *   to `dl model up` (handoff.ts); No is remembered and the question isn't asked again.
 * - Nvidia, smaller: a one-line hint that `dl model up` can run small models.
 * - AMD or Ascend: "Support is coming. Want early access?" once, remembered.
 * - Nothing: a one-line hint for people whose GPUs are on a server.
 */

import { readState, writeState, type StateFile } from "../util/state.js";
import { vendorName, type DetectedGpu } from "./detect.js";
import { modelUpResult, type ModelUpError } from "./handoff.js";
import { sendGpuTelemetry } from "./telemetry.js";

export const INSTALL_LINE = "curl -fsSL https://dl.new | sh";

/** "2x NVIDIA GeForce RTX 4090 (24 GB each)", "1x NVIDIA A100 80GB PCIe (80 GB)". */
export function gpuSummary(gpu: DetectedGpu): string {
  return `${gpu.count}x ${gpu.model} (${gpu.vramGb} GB${gpu.count > 1 ? " each" : ""})`;
}

/** The card's name with its maker, said once: "AMD Instinct MI300X", "Huawei Ascend 910B3". */
export function gpuDisplayName(gpu: DetectedGpu): string {
  if (gpu.vendor === "ascend") return /^huawei/i.test(gpu.model) ? gpu.model : `Huawei ${/^ascend/i.test(gpu.model) ? gpu.model : `Ascend ${gpu.model}`}`;
  const maker = vendorName(gpu.vendor);
  return gpu.model.toLowerCase().startsWith(maker.toLowerCase()) ? gpu.model : `${maker} ${gpu.model}`;
}

export function privateModelQuestion(gpu: DetectedGpu): string {
  return `Found ${gpuSummary(gpu)}. Run a private model on this GPU?`;
}

export const PRIVATE_MODEL_SUBTITLE = "Your code and prompts stay on this machine · Esc to skip";

export const PRIVATE_MODEL_CHOICES = [
  { value: "yes", label: "Yes", description: "dl sets up vLLM, tests it, then opens on it" },
  { value: "no", label: "No", description: "pick another way; dl model up works any time" },
] as const;

export function smallNvidiaHint(gpu: DetectedGpu): string {
  return `Found ${gpuSummary(gpu)}. dl model up can run small models on it.`;
}

/** A 24 GB Nvidia card, but no dl to run the setup (plain `autopilot`). */
export function noDlHint(gpu: DetectedGpu): string {
  return `Found ${gpuSummary(gpu)}. To run a private model on it: ${INSTALL_LINE}, then dl model up.`;
}

export const NO_GPU_HINT = `Have GPUs on a server? Run ${INSTALL_LINE} there.`;

export function earlyAccessQuestion(gpu: DetectedGpu): string {
  return `Detected ${gpuDisplayName(gpu)}. Support is coming. Want early access?`;
}

export const EARLY_ACCESS_SUBTITLE = "Counted anonymously: the GPU and your answer, nothing else";

export const EARLY_ACCESS_CHOICES = [
  { value: "no", label: "No" },
  { value: "yes", label: "Yes", description: "count me in for this GPU" },
] as const;

export const EARLY_ACCESS_THANKS = "Thanks, counted.";

const MODEL_UP_WHY: Record<ModelUpError, string> = {
  cancelled: "cancelled",
  no_docker: "Docker isn't installed or running",
  no_toolkit: "the Nvidia container toolkit is missing",
  toolkit_install_failed: "the Nvidia container toolkit didn't install",
  no_fit: "no model fits this GPU yet",
  already_running: "the model set up earlier is stopped",
  launch_failed: "vLLM didn't start",
  smoke_failed: "its tests failed",
  other: "see above",
};

/** Said on the relaunch after `dl model up` didn't finish. */
export function modelUpFailedLine(error: ModelUpError): string {
  if (error === "cancelled") return "Private model setup cancelled. Pick another way for now; dl model up works any time.";
  return `The private model didn't start (${MODEL_UP_WHY[error]}). Pick another way for now; dl model up works any time.`;
}

// ── "Use your own GPUs" ─────────────────────────────────────────────────────

export type GpuWhere = "this_machine" | "remote_server" | "endpoint";

export const WHERE_QUESTION = "Where are your GPUs?";

export function whereChoices(local: DetectedGpu | null, canModelUp: boolean): Array<{ value: GpuWhere; label: string; description: string }> {
  return [
    ...(local?.vendor === "nvidia"
      ? [{ value: "this_machine" as const, label: "On this machine", description: `${gpuSummary(local)}, ${canModelUp ? "dl sets up vLLM here" : "run dl model up first"}` }]
      : []),
    { value: "remote_server", label: "Another server of mine", description: "set it up there with dl, then connect" },
    { value: "endpoint", label: "I already run vLLM or another OpenAI-compatible server", description: "enter its URL" },
  ];
}

/** "On this machine" without dl to run the setup. */
export const THIS_MACHINE_WITHOUT_DL = `In a terminal on this machine, run ${INSTALL_LINE}, then dl model up. Autopilot uses the model it sets up.`;

export const REMOTE_SERVER_STEPS = ["On that server, run these two commands:", `  ${INSTALL_LINE}`, "  dl model up", "Then enter its address here."];

export const REMOTE_SERVER_TITLE = "Your GPU server";

/** dl model up listens on the server's loopback: when it can't be reached, a tunnel can. */
export function remoteTunnelHint(port: string): string {
  return `dl model up serves on 127.0.0.1 on that server. To reach it from here, keep a tunnel open in another terminal: ssh -N -L ${port}:127.0.0.1:${port} you@that-server, then enter 127.0.0.1 and port ${port}.`;
}

export const ENDPOINT_TITLE = "Your OpenAI-compatible server";
export const ENDPOINT_URL_ERROR = "Enter a URL like http://10.0.0.5:8000/v1";

export function servedLine(baseUrl: string, models: number): string {
  return `✓ ${baseUrl} serves ${models} model${models === 1 ? "" : "s"}`;
}

// ── Remembered answers (state.json) ──────────────────────────────────────────

export type GpuFirstRunState = NonNullable<StateFile["gpuFirstRun"]>;

export async function readGpuState(): Promise<GpuFirstRunState> {
  return (await readState().catch(() => ({}) as StateFile)).gpuFirstRun ?? {};
}

/** Merge into the remembered answers. Never throws: a state file that can't be written only means asking again. */
export async function rememberGpu(patch: GpuFirstRunState): Promise<void> {
  try {
    const state = await readState();
    const current = state.gpuFirstRun ?? {};
    state.gpuFirstRun = { ...current, ...patch, ...(patch.earlyAccess ? { earlyAccess: { ...current.earlyAccess, ...patch.earlyAccess } } : {}) };
    await writeState(state);
  } catch {
    /* asked again next time */
  }
}

let resultReported = false;

/** On the relaunch after dl model up (DL_GPU_RESULT), count how it went. Once per process. */
export function reportModelUpResult(env: NodeJS.ProcessEnv = process.env): void {
  if (resultReported) return;
  const result = modelUpResult(env);
  if (!result) return;
  resultReported = true;
  sendGpuTelemetry(
    result.ok
      ? { event: "result", outcome: "ok", path: "this_machine", gpuVendor: "nvidia" }
      : { event: "result", outcome: "failed", path: "this_machine", errorType: result.error, gpuVendor: "nvidia" },
    env,
  );
}

export function resetGpuFirstRunForTesting(): void {
  resultReported = false;
}
