import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { ToolContext, ToolSpec } from "../tools/registry.js";
import { editTool } from "../tools/edit.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { resolvePath } from "../util/paths.js";
import { containsLikelyProviderSecret, findLikelyProviderSecret, redactLikelySecrets } from "../secrets.js";

const ASTR_TOOLS: ToolSpec[] = [readTool, writeTool, editTool];
const SENSITIVE_NAMES = new Set([
  ".git", ".ssh", ".aws", ".azure", ".config", ".netrc", ".npmrc", ".git-credentials",
  "id_rsa", "id_ed25519", "credentials", "secrets",
]);

export function createAsterTools(workspaceRoot: string): ToolSpec[] {
  return ASTR_TOOLS.map((tool) => ({
    ...tool,
    run: async (args: Record<string, unknown>, context: ToolContext) => {
      await assertAsterWorkspacePath(workspaceRoot, args.path, tool.name !== "read");
      return tool.run(args, { ...context, cwd: workspaceRoot });
    },
  }));
}

export async function assertAsterWorkspacePath(workspaceRoot: string, value: unknown, allowMissing = false): Promise<string> {
  if (typeof value !== "string" || !value.trim()) throw new Error("workspace_path_invalid");
  const root = await realpath(workspaceRoot);
  const candidate = resolvePath(root, value);
  assertInside(root, candidate);
  assertNotSensitive(root, candidate);

  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("workspace_path_unavailable");
    let ancestor = candidate;
    while (true) {
      try {
        actual = await realpath(ancestor);
        break;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("workspace_path_unavailable");
        const parent = relative(root, ancestor);
        if (!parent || parent === ".") throw new Error("workspace_path_unavailable");
        ancestor = ancestor.slice(0, ancestor.lastIndexOf(sep));
      }
    }
  }
  assertInside(root, actual);
  assertNotSensitive(root, actual);
  return candidate;
}

export function assertAsterCellPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("workspace_path_invalid");
  const root = "/workspace";
  const candidate = value.startsWith("/") ? posixNormalize(value) : posixNormalize(`${root}/${value}`);
  if (candidate !== root && !candidate.startsWith(root + "/")) throw new Error("workspace_path_forbidden");
  const parts = candidate.slice(root.length).split("/").filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".env" || part.startsWith(".env.") || SENSITIVE_NAMES.has(part))) {
    throw new Error("workspace_sensitive_path_forbidden");
  }
  return candidate;
}

function posixNormalize(value: string): string {
  const parts = value.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return "/__escape__";
      out.pop();
      continue;
    }
    out.push(part);
  }
  return "/" + out.join("/");
}

// The secret patterns live in a pure module so dl can scan the same patch before it leaves
// the laptop; re-exported here for the server's own callers.
export { containsLikelyProviderSecret, findLikelyProviderSecret, redactLikelySecrets, type SecretMatch } from "../secrets.js";

function assertInside(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("workspace_path_forbidden");
}

function assertNotSensitive(root: string, candidate: string): void {
  const parts = relative(root, candidate).split(sep).filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => part === ".env" || part.startsWith(".env.") || SENSITIVE_NAMES.has(part))) {
    throw new Error("workspace_sensitive_path_forbidden");
  }
}
