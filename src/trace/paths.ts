/**
 * Where traces live on disk.
 *
 *   <root>/<session_id>/trace.jsonl
 *   <root>/<session_id>/blobs/<sha256>
 *
 * Root resolution: `KIMIFLARE_TRACE_DIR` env, then the configured
 * `trace.root`, then `${XDG_DATA_HOME:-~/.local/share}/autopilot/traces`.
 */

import { join } from "node:path";
import { readEnv } from "../util/env.js";
import { dataPath } from "../util/app-dirs.js";

export const TRACE_FILE_NAME = "trace.jsonl";
export const BLOBS_DIR_NAME = "blobs";

export function defaultTraceRoot(): string {
  return dataPath("traces");
}

/** Resolve the trace root, honouring the env override and the config value in that order. */
export function traceRoot(configRoot?: string | null): string {
  const env = readEnv("TRACE_DIR");
  if (env && env.trim()) return env.trim();
  if (configRoot && configRoot.trim()) return configRoot.trim();
  return defaultTraceRoot();
}

/**
 * Make a session id safe to use as a single path segment. Session ids are
 * already `<timestamp>_<slug>`, so this only guards against separators and
 * dot-only names if a caller passes something else.
 */
export function safeSessionSegment(sessionId: string): string {
  const cleaned = sessionId.replace(/[\\/\0]/g, "_").replace(/^\.+$/, "_");
  return cleaned || "session";
}

export function sessionTraceDir(sessionId: string, root?: string | null): string {
  return join(traceRoot(root), safeSessionSegment(sessionId));
}

export function traceFilePath(sessionDir: string): string {
  return join(sessionDir, TRACE_FILE_NAME);
}

export function blobsDir(sessionDir: string): string {
  return join(sessionDir, BLOBS_DIR_NAME);
}
