import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import type { ToolSpec, ToolOutput } from "./registry.js";
import { resolvePath } from "../util/paths.js";
import { readsCredentials, sensitiveSearchRootReason } from "../util/sensitive-paths.js";
import { glob } from "../util/glob.js";

const pExecFile = promisify(execFile);

interface Args {
  pattern: string;
  path?: string;
  glob?: string;
  case_insensitive?: boolean;
  output_mode?: "content" | "files";
}

let cachedHasRg: boolean | null = null;
async function hasRipgrep(): Promise<boolean> {
  if (cachedHasRg !== null) return cachedHasRg;
  try {
    await pExecFile("rg", ["--version"]);
    cachedHasRg = true;
  } catch {
    cachedHasRg = false;
  }
  return cachedHasRg;
}

export const grepTool: ToolSpec<Args> = {
  name: "grep",
  description:
    "Search file contents for a regular expression. Shells out to ripgrep if available, otherwise uses a JavaScript fallback. Output is capped at 30KB.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern." },
      path: { type: "string", description: "Root directory. Defaults to cwd." },
      glob: { type: "string", description: "Filter files by glob, e.g. `*.ts`." },
      case_insensitive: { type: "boolean" },
      output_mode: {
        type: "string",
        enum: ["content", "files"],
        description: "`content` returns matching lines; `files` returns matching file paths only.",
      },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  needsPermission: false,
  permissionReason: (args, ctx) =>
    readsCredentials(sensitiveSearchRootReason(args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd)),
  render: (args) => ({ title: `grep ${args.pattern ?? ""}${args.glob ? ` (${args.glob})` : ""}` }),
  async run(args, ctx) {
    if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const root = args.path ? resolvePath(ctx.cwd, args.path) : ctx.cwd;
    const mode = args.output_mode ?? "content";
    if (await hasRipgrep()) return runRipgrep(args, root, mode, ctx.signal);
    return runJsFallback(args, root, mode, ctx.signal);
  },
};

async function runRipgrep(
  args: Args,
  root: string,
  mode: "content" | "files",
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const rgArgs = ["--no-heading", "--color=never", "--line-number"];
  if (args.case_insensitive) rgArgs.push("-i");
  if (args.glob) rgArgs.push("--glob", args.glob);
  if (mode === "files") rgArgs.push("-l");
  rgArgs.push("--", args.pattern, root);
  try {
    const { stdout } = await pExecFile("rg", rgArgs, { maxBuffer: 10 * 1024 * 1024, signal });
    const trimmed = stdout.trim();
    if (!trimmed) return { content: "(no matches)", rawBytes: 0, reducedBytes: 0 };
    return {
      content: trimmed,
      rawBytes: Buffer.byteLength(trimmed, "utf8"),
      reducedBytes: Buffer.byteLength(trimmed, "utf8"),
    };
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    if (err.code === 1) return { content: "(no matches)", rawBytes: 0, reducedBytes: 0 };
    throw new Error(err.stderr || String(e));
  }
}

async function runJsFallback(
  args: Args,
  root: string,
  mode: "content" | "files",
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const re = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
  const globPattern = args.glob ? `**/${args.glob}` : "**/*";
  const files = await glob(globPattern, {
    cwd: root,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
  });
  const out: string[] = [];
  for (let fi = 0; fi < Math.min(files.length, 5000); fi++) {
    // Check abort signal between files — a slow regex over a big monorepo
    // shouldn't keep running after the user hit Ctrl+C.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const file = files[fi]!;
    try {
      const content = await readFile(file, "utf8");
      if (mode === "files") {
        if (re.test(content)) out.push(file);
      } else {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            out.push(`${file}:${i + 1}:${lines[i]}`);
            if (out.length > 500) break;
          }
        }
      }
    } catch {
      /* binary or unreadable — skip */
    }
    if (out.length > 500) break;
  }
  if (!out.length) return { content: "(no matches)", rawBytes: 0, reducedBytes: 0 };
  const raw = out.join("\n");
  return {
    content: raw,
    rawBytes: Buffer.byteLength(raw, "utf8"),
    reducedBytes: Buffer.byteLength(raw, "utf8"),
  };
}
