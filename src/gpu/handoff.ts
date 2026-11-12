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
 * - When it failed, also (dl 0.28 and later, each optional): DL_GPU_MODEL=<catalog id tried>,
 *   DL_GPU_REASON=<one line, e.g. "Chat test: the model returned no text, thinking mode used
 *   all tokens"> and DL_GPU_LOG=<the run log's path>.
 *
 * After a failure Autopilot shows the failure menu (Retry, See what failed, Pick another model,
 * Continue without a local model). Autopilot owns it: it owns the screens and the other ways to
 * think; dl owns running the setup again. Retry writes {"model":"<DL_GPU_MODEL>"} into the
 * request (dl runs that model again without its picker); Pick another writes {"pick":true}
 * (dl's picker, the failed model marked). An older dl ignores both and shows its picker. dl
 * leaves DL_GPU_HANDOFF out on the last relaunch it allows, and then there is no menu.
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
export async function requestModelUp(path: string, gpu: DetectedGpu | null, then: { model?: string; pick?: boolean } = {}): Promise<void> {
  const body = {
    version: HANDOFF_VERSION,
    action: "model-up",
    ...(gpu ? { gpu: { vendor: gpu.vendor, model: gpu.model, count: gpu.count, vramGb: gpu.vramGb } } : {}),
    ...(then.model ? { model: then.model } : {}),
    ...(then.pick ? { pick: true } : {}),
  };
  await writeFile(path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/** How dl's model setup went, on the relaunch after a request. Undefined on any other start. */
export type ModelUpFailure = { ok: false; error: ModelUpError; model?: string; reason?: string; log?: string };

export function modelUpResult(env: NodeJS.ProcessEnv = process.env): { ok: true } | ModelUpFailure | undefined {
  const result = env.DL_GPU_RESULT?.trim();
  if (result === "ok") return { ok: true };
  if (result !== "failed") return undefined;
  const error = env.DL_GPU_ERROR?.trim();
  const model = env.DL_GPU_MODEL?.trim();
  // eslint-disable-next-line no-control-regex
  const reason = env.DL_GPU_REASON?.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const log = env.DL_GPU_LOG?.trim();
  return {
    ok: false,
    error: (MODEL_UP_ERRORS as readonly string[]).includes(error ?? "") ? (error as ModelUpError) : "other",
    ...(model && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(model) ? { model } : {}),
    ...(reason ? { reason } : {}),
    ...(log ? { log } : {}),
  };
}
