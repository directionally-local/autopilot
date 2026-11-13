/**
 * Anonymous counts from the GPU first run, for the free tier's admin dashboard: which GPUs
 * people have, what they answered, which way they picked and whether the setup worked.
 *
 * The first run happens before any sign-in, so these go to the service's anonymous telemetry
 * endpoint (POST /v1/telemetry/gpu, like install.sh's install count), not the signed-in
 * /v1/events. Counts only: a vendor, a GPU model name (64 characters at most), its memory in
 * GB, a GPU count and short words from fixed lists. Never a prompt, a key, a URL or an address,
 * and no account, device id or IP is kept by the service. The service validates the same lists
 * (installer services/free/src/events.ts). The one exception is an email the person chooses to
 * type after a yes to early access: it rides on that early_access body, and the service keeps it
 * apart from the counts, only to tell them when their GPU is supported.
 *
 * Off with DL_NO_TELEMETRY, DO_NOT_TRACK or CI, and in tests. Fire and forget: 3 s timeout,
 * never throws, and anything still sending gets at most 1.5 s at exit.
 */

import { dlOrigin } from "../providers/dl-endpoint.js";
import { onShutdown, SHUTDOWN_PHASE, withDeadline } from "../util/exit.js";
import { getUserAgent } from "../util/version.js";
import { isAutopilotTestRun } from "../util/app-dirs.js";
import type { DetectedGpu, GpuDetection } from "./detect.js";

export type GpuOption = "free" | "own_key" | "gpus" | "this_machine" | "remote_server" | "endpoint";
export type GpuPath = "this_machine" | "remote_server" | "endpoint";
export type GpuErrorType =
  | "cancelled"
  | "no_docker"
  | "no_toolkit"
  | "toolkit_install_failed"
  | "no_fit"
  | "already_running"
  | "launch_failed"
  | "smoke_failed"
  | "unreachable"
  | "unauthorized"
  | "http"
  | "not_openai"
  | "no_models"
  | "save_failed"
  | "other";

/**
 * A detection where the vendor's tool is on PATH but didn't answer (twice): it timed out, or
 * failed. Sent as `outcome` on "detected" with that vendor, so it isn't counted as "none".
 */
export type GpuDetectOutcome = "probe_timeout" | "probe_failed";

/** The bodies POST /v1/telemetry/gpu accepts. */
export type GpuTelemetry =
  | { event: "detected"; gpuVendor: "nvidia" | "amd" | "ascend" | "none"; gpuModel?: string; gpuVramGb?: number; gpuCount?: number; outcome?: GpuDetectOutcome }
  | { event: "prompt"; gpuVendor: "nvidia"; answer: "yes" | "no"; gpuVramGb?: number }
  | { event: "early_access"; gpuVendor: "amd" | "ascend"; answer: "yes" | "no"; gpuModel?: string; gpuVramGb?: number; email?: string }
  | { event: "option"; option: GpuOption; gpuVendor?: "nvidia" | "amd" | "ascend" | "none" }
  | { event: "result"; outcome: "ok" | "failed"; path: GpuPath; errorType?: GpuErrorType; gpuVendor?: "nvidia" | "amd" | "ascend" | "none" };

/** The props of a detection: vendor, model name, memory and count. */
export function gpuProps(gpu: DetectedGpu | null): { gpuVendor: "nvidia" | "amd" | "ascend" | "none"; gpuModel?: string; gpuVramGb?: number; gpuCount?: number } {
  if (!gpu) return { gpuVendor: "none" };
  return { gpuVendor: gpu.vendor, gpuModel: gpu.model.slice(0, 64), gpuVramGb: gpu.vramGb, gpuCount: gpu.count };
}

/** The "detected" count's body: what was found, or the tool that didn't answer (never "none" then). */
export function detectedTelemetry(detection: GpuDetection): GpuTelemetry {
  const { gpu, unanswered } = detection;
  if (!gpu && unanswered) return { event: "detected", gpuVendor: unanswered.vendor, outcome: unanswered.timedOut ? "probe_timeout" : "probe_failed" };
  return { event: "detected", ...gpuProps(gpu) };
}

/** DL_NO_TELEMETRY, DO_NOT_TRACK or CI. */
function telemetryOptedOut(env: NodeJS.ProcessEnv): boolean {
  const off = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
  return off(env.DL_NO_TELEMETRY) || off(env.DO_NOT_TRACK) || !!env.CI;
}

/** Whether counts may be sent at all. */
export function gpuTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !telemetryOptedOut(env) && !isAutopilotTestRun(env);
}

/**
 * Whether sendGpuTelemetry will send: the opt-outs always count, and in tests a transport
 * stands in for the network. The early-access email is only asked for when this is true.
 */
export function gpuTelemetrySends(env: NodeJS.ProcessEnv = process.env): boolean {
  return transport ? !telemetryOptedOut(env) : gpuTelemetryEnabled(env);
}

const pending = new Set<Promise<void>>();
let registered = false;
let transport: typeof fetch | undefined;
const sent: GpuTelemetry[] = [];

/** Send one count. Never throws, never waits. */
export function sendGpuTelemetry(body: GpuTelemetry, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (transport) sent.push(body);
    if (!transport && !gpuTelemetryEnabled(env)) return;
    const f = transport ?? fetch;
    const p = f(`${dlOrigin(env)}/v1/telemetry/gpu`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": getUserAgent() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3_000),
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => pending.delete(p));
    pending.add(p);
    if (!registered) {
      registered = true;
      onShutdown("gpu-telemetry", () => flushGpuTelemetry(), SHUTDOWN_PHASE.flush);
    }
  } catch {
    /* never break the first run */
  }
}

/** Wait (at most 1.5 s) for counts still being sent. */
export function flushGpuTelemetry(): Promise<void> {
  return withDeadline(Promise.all([...pending]), 1_500).then(() => undefined);
}

/** Test hooks: record bodies (and send them with `f`) regardless of the opt-outs. */
export function setGpuTelemetryTransportForTesting(f: typeof fetch | undefined): void {
  transport = f;
  sent.length = 0;
}
export function sentGpuTelemetry(): readonly GpuTelemetry[] {
  return sent;
}
