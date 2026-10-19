import { readFile } from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";

interface Args {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editTool: ToolSpec<Args> = {
  name: "edit",
  description:
    "Replace an exact string in a file. If replace_all is false (default), the old_string must appear exactly once or the call fails. Prompts the user for permission first and shows a diff preview.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", default: false },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({
    title: `edit ${collapsePath(String(args.path ?? ""), process.cwd())}${args.replace_all ? " (replace_all)" : ""}`,
    diff: { path: String(args.path ?? ""), before: String(args.old_string ?? ""), after: String(args.new_string ?? "") },
  }),
  async run(args, ctx) {
    const abs = resolvePath(ctx.cwd, args.path);
    // Serialize per path: concurrent edits (e.g. Promise.all inside execute_code)
    // must each see the previous edit's result, not a shared stale base image.
    return withFileLock(abs, async () => {
      const orig = await readFile(abs, "utf8");
      const occurrences = countOccurrences(orig, args.old_string);
      if (occurrences === 0) throw new Error(`old_string not found in ${args.path}`);
      if (occurrences > 1 && !args.replace_all) {
        throw new Error(
          `old_string appears ${occurrences} times in ${args.path}; pass replace_all=true or include more surrounding context`,
        );
      }
      const next = replaceLiteral(orig, args.old_string, args.new_string, args.replace_all === true);
      await writeFileVerified(abs, next);
      return `Replaced ${occurrences} occurrence(s) in ${args.path}.`;
    });
  },
};

/**
 * Literal replacement. `String.prototype.replace` with a string pattern still
 * interprets `$&`, `$'`, `` $` ``, `$$` and `$n` in the replacement, which turned
 * a `new_string` containing `$'` into a duplicated file tail.
 */
export function replaceLiteral(haystack: string, needle: string, replacement: string, all: boolean): string {
  if (all) return haystack.split(needle).join(replacement);
  const i = haystack.indexOf(needle);
  if (i === -1) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return count;
    count++;
    from = i + needle.length;
  }
}
