/**
 * The GPU first run's contract with dl (the installer's src/laptop/gpu-handoff.ts is the other
 * side; keep the two in step). Autopilot owns the screens and detection; dl owns `dl model up`.
 *
 * dl → Autopilot, environment variables on plain `autopilot` (`dl`, and the install script's
 * auto-start):
 * - DL_GPU_HANDOFF=PATH: dl can run `dl model up` on this machine. To ask for it, write
 *   {"version":1,"action":"model-up","gpu":{vendor,model,count,vramGb}} to PATH and exit.
 *   dl runs the setup on the terminal, then starts Autopilot again.
 * - On that relaunch: DL_GPU_RESULT=ok|failed, DL_GPU_ERROR=<error type> when failed, and
 *   DL_GPU=<the gpu object above>, so the probes don't run again.
 *
 * Without DL_GPU_HANDOFF (plain `autopilot`, or a dl from before this) the screens still run,
 * but a GPU on this machine gets a pointer to `dl model up` instead of the setup. A dl from
 * before this never reads the file, so nothing is asked of it.
 */

import { chmod, writeFile } from "node:fs/promises";
import type { DetectedGpu } from "./detect.js";

export const HANDOFF_VERSION = 1;

/** dl's error types for a model setup that didn't finish (installer src/model-first-run.ts). */
export const MODEL_UP_ERRORS = [
  "cancelled",
  "no_docker",
  "no_toolkit",
  "toolkit_install_failed",
  "no_fit",
  "already_running",
  "launch_failed",
  "smoke_failed",
  "other",
] as const;
export type ModelUpError = (typeof MODEL_UP_ERRORS)[number];

/** Where to ask dl for `dl model up`, when dl offered it. */
export function handoffPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.DL_GPU_HANDOFF?.trim();
  return path ? path : undefined;
}

/** Ask dl for `dl model up` (Autopilot exits next). */
export async function requestModelUp(path: string, gpu: DetectedGpu | null): Promise<void> {
  const body = {
    version: HANDOFF_VERSION,
    action: "model-up",
    ...(gpu ? { gpu: { vendor: gpu.vendor, model: gpu.model, count: gpu.count, vramGb: gpu.vramGb } } : {}),
  };
  await writeFile(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** How dl's model setup went, on the relaunch after a request. Undefined on any other start. */
export function modelUpResult(env: NodeJS.ProcessEnv = process.env): { ok: true } | { ok: false; error: ModelUpError } | undefined {
  const result = env.DL_GPU_RESULT?.trim();
  if (result === "ok") return { ok: true };
  if (result !== "failed") return undefined;
  const error = env.DL_GPU_ERROR?.trim();
  return { ok: false, error: (MODEL_UP_ERRORS as readonly string[]).includes(error ?? "") ? (error as ModelUpError) : "other" };
}
