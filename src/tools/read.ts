import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { readsCredentials, sensitivePathReason } from "../util/sensitive-paths.js";

/**
 * Fast-path size cap. Files at or below this size are read into memory
 * in a single `fs.readFile` call. Files above it require an explicit
 * `offset` + `limit` slice and stream line-by-line, checking the abort
 * signal between chunks (RF-13 second half).
 */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Hard ceiling on bytes scanned while seeking a streaming slice. Guards
 * against runaway reads — e.g. asking for `offset: 999_999_999` on a
 * 5 GB log file. Hit this and the read fails fast.
 */
const MAX_STREAM_BYTES = 50 * 1024 * 1024;

interface Args {
  path: string;
  offset?: number;
  limit?: number;
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

/**
 * Stream a slice [offset, offset+limit) of `abs` line by line. Both
 * `offset` and `limit` are 1-indexed line numbers, matching the rest of
 * the tool. Throws if the abort signal fires mid-stream or if more than
 * `MAX_STREAM_BYTES` are consumed before reaching the slice.
 */
export async function readSliceStreaming(
  abs: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  if (aborted(signal)) throw abortError();
  const rs = createReadStream(abs, { encoding: "utf8" });
  const onAbort = () => rs.destroy(abortError());
  signal?.addEventListener("abort", onAbort);
  try {
    const rl = createInterface({ input: rs, crlfDelay: Infinity });
    const startLine = Math.max(1, offset);
    const endLine = startLine + Math.max(0, limit) - 1;
    const collected: string[] = [];
    let lineNum = 0;
    let bytesScanned = 0;
    for await (const line of rl) {
      if (aborted(signal)) throw abortError();
      lineNum += 1;
      bytesScanned += Buffer.byteLength(line, "utf8") + 1; // +1 for the LF
      if (bytesScanned > MAX_STREAM_BYTES) {
        throw new Error(
          `file too large to stream: exceeded ${MAX_STREAM_BYTES} bytes while seeking slice at line ${startLine}`,
        );
      }
      if (lineNum >= startLine && lineNum <= endLine) {
        collected.push(line);
      }
      if (lineNum >= endLine) break;
    }
    return collected;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rs.destroy();
  }
}

function formatLines(lines: string[], startLine: number): string {
  const endLine = startLine + lines.length - 1;
  const width = String(endLine).length;
  return lines
    .map((l, i) => `${String(startLine + i).padStart(width, " ")}\t${l}`)
    .join("\n");
}

export const readTool: ToolSpec<Args> = {
  name: "read",
  description:
    "Read a text file from the local filesystem. Supports optional line offset/limit. Files up to 2MB are read in a single pass; larger files require an explicit offset+limit slice and are streamed line by line (cancellable mid-stream). Returns contents with 1-indexed line numbers prefixed, cat -n style. When reading a full file without offset/limit, the output is reduced to a compact outline (imports, exports, signatures, preview) by default; use expand_artifact to retrieve the full content or specify offset/limit for a targeted slice.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file. Absolute or relative to cwd." },
      offset: { type: "integer", description: "1-indexed line number to start reading from.", minimum: 1 },
      limit: { type: "integer", description: "Maximum number of lines to return.", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  needsPermission: false,
  permissionReason: (args, ctx) =>
    typeof args.path === "string" ? readsCredentials(sensitivePathReason(resolvePath(ctx.cwd, args.path))) : null,
  render: ({ path }) => ({ title: `read ${collapsePath(path, process.cwd())}` }),
  async run(args, ctx) {
    if (aborted(ctx.signal)) throw abortError();
    const abs = resolvePath(ctx.cwd, args.path);
    const st = await stat(abs);
    if (aborted(ctx.signal)) throw abortError();

    if (st.size > MAX_BYTES) {
      // Large file: require an explicit slice and stream it. Refusing
      // unbounded full reads protects the model context from a 5MB log
      // file blowing the prompt budget.
      if (args.offset === undefined || args.limit === undefined) {
        throw new Error(
          `file too large: ${st.size} bytes (max ${MAX_BYTES} for full read; supply offset+limit to stream a slice)`,
        );
      }
      const lines = await readSliceStreaming(abs, args.offset, args.limit, ctx.signal);
      return formatLines(lines, args.offset);
    }

    // Fast path: small file, read it all at once.
    const text = await readFile(abs, { encoding: "utf8", signal: ctx.signal });
    if (aborted(ctx.signal)) throw abortError();
    const lines = text.split("\n");
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
    const width = String(end).length;
    return lines
      .slice(start, end)
      .map((l, i) => `${String(start + i + 1).padStart(width, " ")}\t${l}`)
      .join("\n");
  },
};
