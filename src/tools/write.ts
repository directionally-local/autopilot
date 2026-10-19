import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";

interface Args {
  path: string;
  content: string;
}

export const writeTool: ToolSpec<Args> = {
  name: "write",
  description:
    "Create a file or overwrite an existing one with the given contents. Prompts the user for permission first and shows a diff preview.",
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
      let before = "";
      try {
        before = await readFile(abs, "utf8");
      } catch {
        /* new file */
      }
      await mkdir(dirname(abs), { recursive: true });
      await writeFileVerified(abs, args.content);
      const verb = before ? "Overwrote" : "Created";
      return `${verb} ${args.path} (${args.content.length} chars).`;
    });
  },
};
