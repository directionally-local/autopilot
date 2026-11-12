/**
 * The GPU-aware first run's words and remembered answers. The screens are in
 * camouflage-view.ts (`gpuPreScreen`, `ownGpus`); this module is the UI-free part, so the copy
 * and the decisions can be tested on their own.
 *
 * Before "How should it think?", what was found on this machine decides one of:
 * - Nvidia with a 24 GB card, started by dl: "Run a private model on this GPU?" Yes hands over
 *   to `dl model up` (handoff.ts); No is remembered and the question isn't asked again.
 * - Nvidia, smaller: a one-line hint that `dl model up` can run small models.
 * - AMD or Ascend: "Support is coming. Want early access?" once, remembered. A yes may leave an
 *   email to hear when support is ready (only while telemetry is on).
 * - Nothing: a one-line hint for people whose GPUs are on a server.
 */

import { readState, writeState, type StateFile } from "../util/state.js";
import { vendorName, type DetectedGpu } from "./detect.js";
import { modelUpResult, type ModelUpError, type ModelUpFailure } from "./handoff.js";
import { sendGpuTelemetry } from "./telemetry.js";

export const INSTALL_LINE = "curl -fsSL https://dl.new | sh";

/** "NVIDIA RTX PRO 5000 Blackwell" → "NVIDIA RTX PRO 5000": the edition words don't fit a line. Same as dl's. */
export function shortGpuName(name: string): string {
  const short = name
    .replace(/\s+Blackwell\b.*$/i, "")
    .replace(/\s+(Server|Workstation)\s+Edition\b.*$/i, "")
    .replace(/\s+Max-Q\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return short.length > 32 ? short.slice(0, 32).trimEnd() : short;
}

/** "NVIDIA RTX PRO 5000 · 48 GB", "4x NVIDIA RTX PRO 6000 · 384 GB total": short enough for one line. */
export function gpuSummary(gpu: DetectedGpu): string {
  if (gpu.count <= 1) return `${shortGpuName(gpu.model)} · ${gpu.vramGb} GB`;
  return `${gpu.count}x ${shortGpuName(gpu.model)} · ${gpu.totalVramGb || gpu.vramGb * gpu.count} GB total`;
}

/** The card's name with its maker, said once: "AMD Instinct MI300X", "Huawei Ascend 910B3". */
export function gpuDisplayName(gpu: DetectedGpu): string {
  if (gpu.vendor === "ascend") return /^huawei/i.test(gpu.model) ? gpu.model : `Huawei ${/^ascend/i.test(gpu.model) ? gpu.model : `Ascend ${gpu.model}`}`;
  const maker = vendorName(gpu.vendor);
  return gpu.model.toLowerCase().startsWith(maker.toLowerCase()) ? gpu.model : `${maker} ${gpu.model}`;
}

export function privateModelQuestion(gpu: DetectedGpu): string {
  return `Found ${gpuSummary(gpu)}. Run a private model on it?`;
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

/** After a yes: an optional email, sent with the count (telemetry.ts) only when given. */
export const EARLY_ACCESS_EMAIL_TITLE = "Email for early access? (optional, Enter to skip)";

export function earlyAccessEmailSubtitle(gpu: DetectedGpu): string {
  return `Only used to tell you when ${vendorName(gpu.vendor)} support is ready.`;
}

export const EARLY_ACCESS_EMAIL_ERROR = "That doesn't look like an email. Enter one like you@example.com, or leave it empty to skip.";

export const EARLY_ACCESS_THANKS_EMAIL = "Thanks, we'll email you.";

/** A yes with telemetry off (DL_NO_TELEMETRY, DO_NOT_TRACK, CI): nothing is sent, so no email is asked for. */
export const EARLY_ACCESS_TELEMETRY_OFF = "Thanks. Telemetry is off, so nothing was sent. For early access, email contact@directionallylocal.com.";

/** Light check: one @, a dot in the domain, no spaces, at most 254 characters. The service checks again. */
export function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

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

// ── After a private model setup that failed ─────────────────────────────────

export const MODEL_UP_FAILED_TITLE = "The private model didn't start";

/** The menu's line under the title: dl's reason (which test, and why), else the error type's words. */
export function modelUpFailedSubtitle(failure: ModelUpFailure): string {
  const reason = failure.reason ?? `Why: ${MODEL_UP_WHY[failure.error]}`;
  return reason.length > 76 ? `${reason.slice(0, 73).trimEnd()}...` : reason;
}

export type ModelUpFailureChoice = "retry" | "details" | "pick" | "continue";

/** The failure menu. Pick another model only when the model itself may be the problem. */
export function modelUpFailureChoices(failure: ModelUpFailure): Array<{ value: ModelUpFailureChoice; label: string; description: string }> {
  const modelProblem = failure.error === "smoke_failed" || failure.error === "launch_failed" || failure.error === "other";
  return [
    { value: "retry", label: "Retry", description: failure.model ? `set up ${failure.model} again` : "run the setup again" },
    { value: "details", label: "See what failed", description: "the reason and the log file" },
    ...(modelProblem ? [{ value: "pick" as const, label: "Pick another model", description: "from the models that fit" }] : []),
    { value: "continue", label: "Continue without a local model for now", description: "the usual choices" },
  ];
}

/** Whether the failure menu applies: not after a cancel, nor when nothing fits (a retry can't help). */
export function offersModelUpRetry(failure: ModelUpFailure): boolean {
  return failure.error !== "cancelled" && failure.error !== "no_fit";
}

/** Lines of a run log worth showing: errors and failures, the last `max`, each cut to fit. */
export function relevantLogLines(text: string, max = 5): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "").trim();
    if (!line || !/error|exception|traceback|fail|out of memory|cuda|no text|not ready|stopped/i.test(line)) continue;
    const cut = line.length > 72 ? `${line.slice(0, 69).trimEnd()}...` : line;
    if (seen.has(cut)) continue;
    seen.add(cut);
    lines.push(cut);
  }
  return lines.slice(-max);
}

/** "See what failed": the reason, where the full log is, and its last few lines that matter. */
export function modelUpFailureDetails(failure: ModelUpFailure, logText?: string): string[] {
  const lines = [failure.reason ?? `The private model didn't start (${MODEL_UP_WHY[failure.error]}).`];
  if (failure.log) lines.push(`Full log: ${failure.log}`);
  const relevant = logText ? relevantLogLines(logText) : [];
  if (relevant.length) lines.push("Last lines that matter:", ...relevant.map((line) => `  ${line}`));
  return lines;
}

/** The end of the run log, read for "See what failed"; undefined when it can't be read. */
export async function readRunLogTail(path: string): Promise<string | undefined> {
  try {
    const { open } = await import("node:fs/promises");
    const file = await open(path, "r");
    try {
      const { size } = await file.stat();
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

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
      ? [{ value: "this_machine" as const, label: "On this machine", description: `${gpuSummary(local)} · ${canModelUp ? "dl sets it up" : "run dl model up first"}` }]
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
