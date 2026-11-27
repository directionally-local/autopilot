import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { sensitivePathReason, writesCredentials } from "../util/sensitive-paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";
import { lockKeyFor } from "../util/file-lock.js";
import { assertReadVersion, sha256 } from "./file-version.js";
import { introducedRedactionPlaceholder } from "../secrets.js";
import { ToolError } from "./tool-error.js";

interface Args {
  path: string;
  content: string;
}

export const writeTool: ToolSpec<Args> = {
  name: "write",
  description:
    "Create a file or overwrite an existing one with the given contents. Existing files must be read in this session first and are rejected if they changed since; new files may be created without a read. Prompts the user for permission first and shows a diff preview.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  needsPermission: true,
  // A write into a credentials location is flagged, like a read of one (T2-01).
  permissionReason: (args, ctx) =>
    typeof args.path === "string" && args.path
      ? writesCredentials(sensitivePathReason(resolvePath(ctx.cwd, args.path)))
      : null,
  render: (args) => ({
    title: `write ${collapsePath(String(args.path ?? ""), process.cwd())} (${String(args.content ?? "").length} chars)`,
    diff: { path: String(args.path ?? ""), before: "", after: String(args.content ?? "") },
  }),
  async run(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    return withFileLock(abs, async () => {
      const key = await lockKeyFor(abs);
      let before: Buffer | undefined;
      try {
        before = await readFile(abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (before) {
        assertReadVersion(ctx.fileReadHashes, key, before, args.path, "overwriting");
        const introduced = introducedRedactionPlaceholder(args.content, before.toString("utf8"));
        if (introduced) {
          throw new ToolError({
            code: "policy_rejection",
            message: `Refusing to write ${args.path}: the content contains the redaction placeholder "${introduced}" from a scrubbed tool result. Writing it back would replace the real secret on disk with the placeholder. Edit around the secret instead of rewriting the file.`,
            suggestion: "use edit to change only the parts around the secret, or ask the user to make this change",
          });
        }
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFileVerified(abs, args.content);
      ctx.fileReadHashes?.set(key, sha256(Buffer.from(args.content, "utf8")));
      const verb = before ? "Overwrote" : "Created";
      return `${verb} ${args.path} (${args.content.length} chars).`;
    });
  },
};
