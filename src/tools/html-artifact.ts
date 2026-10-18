import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePath } from "../util/paths.js";
import { openBrowser } from "../util/open-browser.js";
import type { ToolSpec } from "./registry.js";
import { ToolError } from "./tool-error.js";

interface Args {
  title: string;
  sourcePath: string;
}

interface ArtifactHtml {
  title: string;
  html: string;
}

interface ArtifactOptions {
  rootDir?: string;
  now?: () => number;
  open?: (url: string) => boolean;
}

const ARTIFACT_ROOT = "autopilot-artifacts";
const ARTIFACT_PREFIX = "artifact-";
const ARTIFACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const AUTOPILOT_URL = "https://github.com/sinameraji/autopilot";
const MAX_ARTIFACT_TITLE_LENGTH = 160;
const MAX_ARTIFACT_HTML_LENGTH = 1_000_000;

export const htmlArtifactTool: ToolSpec<Args> = {
  name: "create_artifact",
  description:
    "Open a polished standalone HTML artifact in the user's browser. First use the normal write tool to save the complete HTML document as a local .html file in the workspace. Then call create_artifact with its title and sourcePath; do not pass the full HTML as a tool argument. The source file is kept in the workspace, and a branded, sandboxed browser copy is stored outside the project. Use for visual or interactive deliverables, dashboards, diagrams, prototypes, and substantial structured reports—not short answers, explanations, code snippets, or routine code changes.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Non-empty, short human-readable artifact title.",
      },
      sourcePath: {
        type: "string",
        description: "Workspace-relative path to the complete HTML file already created with the write tool.",
      },
    },
    required: ["title", "sourcePath"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({
    title: "create artifact: " + String(args.title ?? "Missing title").slice(0, 80),
    body: `Read ${String(args.sourcePath ?? "Missing sourcePath")} · opens in your browser`,
  }),
  async run(args, ctx) {
    return createHtmlArtifactFromFile(args, ctx.cwd);
  },
};

/** Read a workspace HTML file, wrap it, store it under the OS temp directory, then try to open it. */
export async function createHtmlArtifactFromFile(
  args: Args,
  cwd: string,
  options: ArtifactOptions = {},
): Promise<string> {
  assertArtifactSourceArgs(args);
  const workspaceRoot = await getWorkspaceRoot(cwd);
  const workspaceReal = await realpath(workspaceRoot);
  const inputPath = resolvePath(cwd, args.sourcePath);
  let inputReal: string;
  try {
    inputReal = await realpath(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolError({
        code: "not_found",
        message: `Artifact source file not found: ${args.sourcePath}`,
        suggestion: "Use the write tool to create the complete HTML file first, then pass its path as sourcePath.",
      });
    }
    throw error;
  }
  if (!isWithin(workspaceReal, inputReal)) {
    throw new ToolError({
      code: "policy_rejection",
      message: "Artifact sourcePath must resolve to a file inside the current workspace.",
      suggestion: "Write the HTML file inside the workspace and retry with its workspace-relative path.",
    });
  }
  const info = await stat(inputReal);
  if (!info.isFile()) {
    throw new ToolError({ code: "invalid_args", message: "Artifact sourcePath must be a regular HTML file." });
  }
  if (info.size > MAX_ARTIFACT_HTML_LENGTH * 4) {
    throw new ToolError({ code: "invalid_args", message: `Artifact HTML exceeds ${MAX_ARTIFACT_HTML_LENGTH} characters.` });
  }
  const html = await readFile(inputReal, "utf8");
  return createHtmlArtifact({ title: args.title, html }, cwd, options);
}

/** Write an isolated artifact under the OS temp directory, then try to open it. */
export async function createHtmlArtifact(
  args: ArtifactHtml,
  cwd: string,
  options: ArtifactOptions = {},
): Promise<string> {
  assertArtifactHtmlArgs(args);
  const rootDir = options.rootDir ?? join(tmpdir(), ARTIFACT_ROOT);
  const workspaceRoot = await getWorkspaceRoot(cwd);
  const workspaceReal = await realpath(workspaceRoot);
  if (isWithin(workspaceReal, resolve(rootDir))) {
    throw new Error("Refusing to store an artifact inside the workspace: " + rootDir);
  }
  await ensureSecureRoot(rootDir);
  const rootReal = await realpath(rootDir);
  if (isWithin(workspaceReal, rootReal)) {
    throw new Error("Refusing to store an artifact inside the workspace: " + rootReal);
  }

  await cleanupOldArtifacts(rootDir, (options.now ?? Date.now)());
  const artifactDir = await mkdtemp(join(rootDir, ARTIFACT_PREFIX));
  await chmod(artifactDir, 0o700);
  const filePath = join(artifactDir, "index.html");
  await writeFile(filePath, buildArtifactHtml(args.title, args.html), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  const opened = (options.open ?? openBrowser)(pathToFileURL(filePath).href);
  const status = opened ? "Opened in your browser." : "Could not open a browser automatically.";
  return "Artifact: " + args.title + "\n" + status + "\nTemporary file: " + filePath;
}

/** Remove only old, tool-owned artifact directories; leave unrelated temp files alone. */
export async function cleanupOldArtifacts(rootDir: string, now = Date.now()): Promise<void> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(ARTIFACT_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(rootDir, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < ARTIFACT_MAX_AGE_MS) continue;
      await rm(path, { recursive: true, force: true });
    } catch {
      // Stale temp artifacts are best-effort cleanup; do not block a new artifact.
    }
  }
}

/** Wrap model HTML in a tiny, self-contained, branded page. */
export function buildArtifactHtml(title: string, html: string): string {
  assertArtifactHtmlArgs({ title, html });
  const safeTitle = escapeHtml(title);
  const safeSrcdoc = escapeAttribute(html);
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="theme-color" content="#090909">',
    "  <title>" + safeTitle + " · Autopilot</title>",
    "  <style>",
    '    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    "    * { box-sizing: border-box; }",
    "    html, body { width: 100%; height: 100%; margin: 0; }",
    "    body { display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; background: #090909; color: #f4f4f5; }",
    "    .autopilot-bar { position: sticky; top: 0; z-index: 10; display: flex; min-height: 54px; align-items: center; justify-content: space-between; gap: 16px; padding: 0 22px; border-bottom: 1px solid #262626; background: rgba(9, 9, 9, .96); backdrop-filter: blur(12px); }",
    "    .autopilot-brand { display: inline-flex; align-items: center; gap: 9px; color: #f5f5f5; font-size: 14px; font-weight: 650; letter-spacing: -.025em; text-decoration: none; }",
    "    .autopilot-mark { width: 20px; height: 20px; flex: none; }",
    "    .autopilot-actions { display: flex; align-items: center; gap: 16px; }",
    "    .autopilot-actions a { color: #a3a3a3; font-size: 12px; text-decoration: none; transition: color .15s ease; }",
    "    .autopilot-actions a:hover { color: #fff; }",
    "    .autopilot-actions .star { padding: 7px 11px; border: 1px solid #343434; border-radius: 7px; color: #f0f0f0; }",
    "    .autopilot-actions .star:hover { border-color: #ff9933; color: #ffb15c; }",
    "    main { min-width: 0; min-height: 0; }",
    "    iframe { display: block; width: 100%; height: 100%; border: 0; background: #fff; }",
    "    @media (max-width: 520px) { .autopilot-bar { min-height: 48px; padding: 0 14px; } .autopilot-actions { gap: 10px; } .autopilot-actions a { font-size: 11px; } }",
    "  </style>",
    "</head>",
    "<body>",
    '  <header class="autopilot-bar">',
    '    <a class="autopilot-brand" href="' + AUTOPILOT_URL + '" target="_blank" rel="noopener noreferrer" aria-label="Autopilot on GitHub">',
    '      <svg class="autopilot-mark" viewBox="0 0 24 24" role="img" aria-label="Autopilot logo" xmlns="http://www.w3.org/2000/svg">',
    '        <path fill="#ff9933" d="M12 1.8a10.2 10.2 0 1 0 10.2 10.2A10.21 10.21 0 0 0 12 1.8Zm0 2.3a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Z"/>',
    '        <path fill="#ff9933" d="m6.9 16.8 4.3-9.6c.3-.7 1.3-.7 1.6 0l4.3 9.6h-2.5l-2.6-6-2.6 6H6.9Z"/>',
    "      </svg>",
    "      <span>autopilot</span>",
    "    </a>",
    '    <nav class="autopilot-actions" aria-label="Autopilot links">',
    '      <a href="' + AUTOPILOT_URL + '" target="_blank" rel="noopener noreferrer">About Autopilot ↗</a>',
    '      <a class="star" href="' + AUTOPILOT_URL + '" target="_blank" rel="noopener noreferrer" aria-label="Star Autopilot on GitHub">☆ Star on GitHub</a>',
    "    </nav>",
    "  </header>",
    '  <main><iframe title="' + escapeAttribute(title) + '" sandbox="allow-scripts" srcdoc="' + safeSrcdoc + '"></iframe></main>',
    "</body>",
    "</html>",
  ];
  return lines.join("\n") + "\n";
}

function assertArtifactSourceArgs(value: unknown): asserts value is Args {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError({
      code: "invalid_args",
      recoverable: true,
      message: "Invalid create_artifact arguments: expected an object with a title and sourcePath.",
      suggestion: "Use write to save the complete HTML file in the workspace, then pass its path as sourcePath.",
    });
  }

  const args = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof args.title !== "string" || args.title.trim().length === 0 || args.title.length > MAX_ARTIFACT_TITLE_LENGTH) {
    issues.push(`title must be a non-empty string of at most ${MAX_ARTIFACT_TITLE_LENGTH} characters`);
  }
  if (typeof args.sourcePath !== "string" || args.sourcePath.trim().length === 0) {
    issues.push("sourcePath must be a non-empty path to an HTML file created with write");
  }
  if (issues.length > 0) {
    throw new ToolError({
      code: "invalid_args",
      recoverable: true,
      message: `Invalid create_artifact arguments: ${issues.join("; ")}.`,
      suggestion: "Use write to save the complete HTML file in the workspace, then call create_artifact with its title and sourcePath.",
    });
  }
}

function assertArtifactHtmlArgs(value: unknown): asserts value is ArtifactHtml {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError({
      code: "invalid_args",
      recoverable: true,
      message: "Invalid artifact content: expected an object with a title and HTML document.",
      suggestion: "Provide a non-empty title and complete HTML content.",
    });
  }

  const args = value as Record<string, unknown>;
  const issues: string[] = [];
  if (typeof args.title !== "string" || args.title.trim().length === 0 || args.title.length > MAX_ARTIFACT_TITLE_LENGTH) {
    issues.push(`title must be a non-empty string of at most ${MAX_ARTIFACT_TITLE_LENGTH} characters`);
  }
  if (typeof args.html !== "string" || args.html.trim().length === 0 || args.html.length > MAX_ARTIFACT_HTML_LENGTH) {
    issues.push(`html must be a non-empty string of at most ${MAX_ARTIFACT_HTML_LENGTH} characters`);
  }
  if (issues.length > 0) {
    throw new ToolError({
      code: "invalid_args",
      recoverable: true,
      message: `Invalid artifact content: ${issues.join("; ")}.`,
      suggestion: "Supply a non-empty title and complete HTML document.",
    });
  }
}

async function ensureSecureRoot(rootDir: string): Promise<void> {
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const info = await lstat(rootDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Artifact storage path is not a real directory: " + rootDir);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error("Artifact storage directory is not owned by the current user: " + rootDir);
  }
  if ((info.mode & 0o077) !== 0) await chmod(rootDir, 0o700);
}

async function getWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
