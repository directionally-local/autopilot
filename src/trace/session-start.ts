/**
 * Builds and emits the `session_start` event: harness version and commit,
 * repository identity, model, redacted config, and hashes of the tool
 * schemas and system prompt the model will see.
 *
 * All git lookups are best-effort and bounded; a missing git or a non-repo
 * cwd yields nulls, never an error.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { KimiConfig } from "../config.js";
import type { ToolDef } from "../agent/messages.js";
import { getAppVersion } from "../util/version.js";
import { sha256Hex } from "./blobs.js";
import type { TraceRecorder } from "./recorder.js";
import { redactConfig } from "./redact.js";
import type { SessionStartPayload, TraceSessionMode } from "./types.js";

const execFileAsync = promisify(execFile);

export interface CollectSessionStartOptions {
  cwd: string;
  model: string;
  mode: TraceSessionMode;
  /** The live config; credential keys are redacted before recording. */
  config: KimiConfig | Record<string, unknown> | null | undefined;
  /** Tool definitions exactly as sent to the model. */
  tools: ToolDef[];
  systemPrompt: string;
  /** "full" unless a narrower profile is active. */
  toolProfile?: string;
}

async function git(args: string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 3000, windowsHide: true });
    const out = stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Directory containing Autopilot's own package.json, when running from a source checkout. */
function harnessCheckoutDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/trace -> ../../ ; dist -> ../
  for (const candidate of [join(here, "..", ".."), join(here, "..")]) {
    if (existsSync(join(candidate, "package.json")) && existsSync(join(candidate, ".git"))) return candidate;
  }
  return null;
}

/** git HEAD of the running Autopilot checkout, or null when installed from npm. */
export async function resolveHarnessCommit(): Promise<string | null> {
  const dir = harnessCheckoutDir();
  if (!dir) return null;
  return git(["rev-parse", "HEAD"], dir);
}

/**
 * Collect the payload. `blob` stores the tool-definition JSON and returns
 * its sha (or null when the recorder is disabled).
 */
export async function collectSessionStart(
  opts: CollectSessionStartOptions,
  blob: (content: string) => string | null,
): Promise<SessionStartPayload> {
  const toolsJson = JSON.stringify(opts.tools);
  const [harnessCommit, repoRemote, repoHead] = await Promise.all([
    resolveHarnessCommit(),
    git(["remote", "get-url", "origin"], opts.cwd),
    git(["rev-parse", "HEAD"], opts.cwd),
  ]);
  return {
    autopilot_version: getAppVersion(),
    harness_commit: harnessCommit,
    cwd: opts.cwd,
    repo_remote: repoRemote,
    repo_head: repoHead,
    model: opts.model,
    mode: opts.mode,
    config: redactConfig((opts.config ?? {}) as Record<string, unknown>),
    tool_profile: opts.toolProfile ?? "full",
    tool_schemas_sha: sha256Hex(toolsJson),
    tools_blob: blob(toolsJson) ?? "",
    system_prompt_sha: sha256Hex(opts.systemPrompt),
  };
}

/** Emit `session_start` on `recorder`; a no-op (no git calls) when the recorder is disabled. */
export async function emitSessionStart(recorder: TraceRecorder, opts: CollectSessionStartOptions): Promise<void> {
  if (!recorder.enabled) return;
  const payload = await collectSessionStart(opts, (content) => recorder.blob(content));
  recorder.emit("session_start", payload, null);
}
