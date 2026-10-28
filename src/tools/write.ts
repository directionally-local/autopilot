import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";
import { lockKeyFor } from "../util/file-lock.js";
import { assertReadVersion, sha256 } from "./file-version.js";

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
      if (before) assertReadVersion(ctx.fileReadHashes, key, before, args.path, "overwriting");
      await mkdir(dirname(abs), { recursive: true });
      await writeFileVerified(abs, args.content);
      ctx.fileReadHashes?.set(key, sha256(Buffer.from(args.content, "utf8")));
      const verb = before ? "Overwrote" : "Created";
      return `${verb} ${args.path} (${args.content.length} chars).`;
    });
  },
};
