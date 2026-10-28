import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { ToolError } from "./tool-error.js";

/** Return the SHA-256 digest of the exact bytes read from disk. */
export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Hash a file without buffering the whole file in memory. */
export async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path, signal ? { signal } : undefined);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Reject edits/overwrites that lack a current read snapshot for this session. */
export function assertReadVersion(
  snapshots: Map<string, string> | undefined,
  key: string,
  currentBytes: Uint8Array,
  path: string,
  action: "editing" | "overwriting",
): void {
  // ToolSpec.run is also used directly by a few internal utilities and tests.
  // Production tool calls pass through ToolExecutor, which always supplies this map.
  if (!snapshots) return;

  const expected = snapshots.get(key);
  if (expected === undefined) {
    throw new ToolError({
      code: "policy_rejection",
      message: `${path} has not been read in this session; call read before ${action} it.`,
      recoverable: true,
      suggestion: `Read ${path}, review its current contents, then retry the ${action}.`,
    });
  }
  if (expected !== sha256(currentBytes)) {
    throw new ToolError({
      code: "policy_rejection",
      message: `${path} changed since it was last read; call read again before ${action} it.`,
      recoverable: true,
      suggestion: `Read ${path} again, review the changes, then retry the ${action}.`,
    });
  }
}
