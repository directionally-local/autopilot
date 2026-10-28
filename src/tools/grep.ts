import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import type { ToolSpec, ToolOutput } from "./registry.js";
import { resolvePath } from "../util/paths.js";
import { readsCredentials, sensitiveSearchRootReason } from "../util/sensitive-paths.js";
import { glob } from "../util/glob.js";

const pExecFile = promisify(execFile);
const MAX_OUTPUT_BYTES = 30 * 1024;

function outputResult(raw: string): ToolOutput {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  if (rawBytes <= MAX_OUTPUT_BYTES) {
    return { content: raw, rawBytes, reducedBytes: rawBytes };
  }
  const suffix = "\n[truncated at 30 KB]";
  const allowance = MAX_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8");
  let excerpt = Buffer.from(raw, "utf8").subarray(0, allowance).toString("utf8");
  while (Buffer.byteLength(excerpt, "utf8") > allowance) excerpt = excerpt.slice(0, -1);
  const content = excerpt + suffix;
  return { content, rawBytes, reducedBytes: Buffer.byteLength(content, "utf8") };
}

async function ignoredByGit(root: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  return new Promise((resolve) => {
    const child = spawn("git", ["check-ignore", "--no-index", "-z", "--stdin"], { cwd: root });
    const stdout: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.resume();
    child.on("error", () => resolve(new Set()));
    child.on("close", () => {
      resolve(new Set(Buffer.concat(stdout).toString("utf8").split("\0").filter(Boolean)));
    });
    child.stdin.end(files.join("\0") + "\0");
  });
}

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
    "Search file contents for a regular expression. Shells out to ripgrep if available, otherwise uses a JavaScript fallback that respects Git ignore rules. Output is capped at 30KB.",
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
    return outputResult(trimmed);
  } catch (e) {
    const err = e as { code?: number; stderr?: string };
    if (err.code === 1) return { content: "(no matches)", rawBytes: 0, reducedBytes: 0 };
    throw new Error(err.stderr || String(e));
  }
}

export async function runJsFallback(
  args: Args,
  root: string,
  mode: "content" | "files",
  signal?: AbortSignal,
): Promise<ToolOutput> {
  const re = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
  const globPattern = args.glob ? `**/${args.glob}` : "**/*";
  let files: string[];
  let singleFileTarget = false;
  try {
    const info = await stat(root);
    singleFileTarget = info.isFile();
    files = singleFileTarget ? [root] : await glob(globPattern, {
      cwd: root,
      absolute: true,
      dot: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
  } catch {
    throw new Error(`Search path does not exist or cannot be accessed: ${root}`);
  }
  const ignored = singleFileTarget
    ? new Set<string>()
    : await ignoredByGit(
        root,
        files.map((file) => (file.startsWith(root) ? file.slice(root.length).replace(/^\/+/, "") : file)),
      );
  const searchFiles = (singleFileTarget ? files : files.filter((file) => {
    const relativePath = file.startsWith(root) ? file.slice(root.length).replace(/^\/+/, "") : file;
    return !ignored.has(relativePath);
  })).slice(0, 5000);
  const out: string[] = [];
  for (let fi = 0; fi < searchFiles.length; fi++) {
    // Check abort signal between files — a slow regex over a big monorepo
    // shouldn't keep running after the user hit Ctrl+C.
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const file = searchFiles[fi]!;
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
  return outputResult(out.join("\n"));
}
