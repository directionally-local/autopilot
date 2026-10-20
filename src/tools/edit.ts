import { readFile } from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";

export interface EditPair {
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

interface Args {
  path: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  /** Several replacements in one file, applied in order, all or nothing. */
  edits?: EditPair[];
}

/** The replacements a call asks for: `edits[]`, or the single old/new pair. */
export function editPairs(args: Partial<Args> | Record<string, unknown>): EditPair[] {
  const a = args as Partial<Args>;
  // Some models fill every field of the schema, sending an empty or null
  // old_string next to edits[]: only a non-empty old_string is a real edit.
  const single: EditPair[] =
    typeof a.old_string === "string" && a.old_string !== "" && typeof a.new_string === "string"
      ? [{ old_string: a.old_string, new_string: a.new_string, ...(a.replace_all ? { replace_all: true } : {}) }]
      : [];
  // Both forms given for real: apply them all, the single edit first.
  return Array.isArray(a.edits) ? [...single, ...a.edits] : single;
}

/** Apply edits in order to `text`; throws (naming the failing edit) without partial results. */
export function applyEdits(text: string, edits: EditPair[], path: string): { text: string; replaced: number } {
  let next = text;
  let replaced = 0;
  edits.forEach((edit, i) => {
    const which = edits.length > 1 ? `edits[${i}]: ` : "";
    const occurrences = countOccurrences(next, edit.old_string);
    if (occurrences === 0) {
      throw new Error(`${which}old_string not found in ${path}${i > 0 ? " (after applying the earlier edits)" : ""}; no changes were written`);
    }
    if (occurrences > 1 && !edit.replace_all) {
      throw new Error(
        `${which}old_string appears ${occurrences} times in ${path}; pass replace_all=true or include more surrounding context${edits.length > 1 ? "; no changes were written" : ""}`,
      );
    }
    next = replaceLiteral(next, edit.old_string, edit.new_string, edit.replace_all === true);
    replaced += edit.replace_all ? occurrences : 1;
  });
  return { text: next, replaced };
}

const HUNK_SEPARATOR = "\n⋯\n";

export const editTool: ToolSpec<Args> = {
  name: "edit",
  description: [
    "Replace exact strings in a file. Either pass old_string/new_string for one replacement, or edits: [{old_string, new_string, replace_all?}] to make several replacements in the same file in one call.",
    "edits are applied in order (each sees the result of the previous ones) and all-or-nothing: if any old_string is missing or ambiguous, nothing is written.",
    "Without replace_all, each old_string must appear exactly once. Prompts the user for permission first and shows a diff preview.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace (single-edit form)." },
      new_string: { type: "string", description: "Replacement text (single-edit form)." },
      replace_all: { type: "boolean", default: false },
      edits: {
        type: "array",
        minItems: 1,
        description: "Several replacements in this file, applied in order, all or nothing. Use instead of old_string/new_string.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean", default: false },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => {
    const pairs = editPairs(args);
    const multi = pairs.length > 1;
    return {
      title: `edit ${collapsePath(String(args.path ?? ""), process.cwd())}${multi ? ` (${pairs.length} edits)` : args.replace_all ? " (replace_all)" : ""}`,
      diff: {
        path: String(args.path ?? ""),
        before: pairs.map((p) => p.old_string).join(HUNK_SEPARATOR),
        after: pairs.map((p) => p.new_string).join(HUNK_SEPARATOR),
      },
    };
  },
  async run(args, ctx) {
    const pairs = editPairs(args);
    if (pairs.length === 0) throw new Error("pass old_string and new_string, or a non-empty edits[] array");
    const abs = resolvePath(ctx.cwd, args.path);
    // Serialize per path: concurrent edits (e.g. Promise.all inside execute_code)
    // must each see the previous edit's result, not a shared stale base image.
    return withFileLock(abs, async () => {
      const orig = await readFile(abs, "utf8");
      const { text, replaced } = applyEdits(orig, pairs, args.path);
      await writeFileVerified(abs, text);
      return pairs.length > 1
        ? `Applied ${pairs.length} edits (${replaced} replacement(s)) in ${args.path}.`
        : `Replaced ${replaced} occurrence(s) in ${args.path}.`;
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
