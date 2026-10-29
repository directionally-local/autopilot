import { readFile } from "node:fs/promises";
import type { ToolSpec } from "./registry.js";
import { resolvePath, collapsePath } from "../util/paths.js";
import { withFileLock } from "../util/file-lock.js";
import { writeFileVerified } from "../util/safe-write.js";
import { lockKeyFor } from "../util/file-lock.js";
import { assertReadVersion, sha256 } from "./file-version.js";
import { toolInvalidArgsError, type ToolError } from "./tool-error.js";

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

/**
 * A call that carries `path` but no replacement text: the model's
 * old_string/new_string (or edits[]) never arrived. Long multi-line arguments
 * are sometimes dropped in transit (seen with DeepSeek models through
 * OpenRouter), so name exactly what is missing — the generic "pass
 * old_string" read like a tool bug and the model retried the same call.
 */
function missingPayloadError(args: Partial<Args>): ToolError {
  const present = Object.keys(args).filter((key) => key !== "path");
  const got = present.length ? `only ${present.join(", ")}` : "no other fields";
  const emptyEdits = Array.isArray(args.edits) && args.edits.length === 0;
  return toolInvalidArgsError(
    `the replacement text never arrived: this call had ${got}${emptyEdits ? " (edits[] was empty)" : ""}, so there is no old_string/new_string (or non-empty edits[]) to apply. Nothing was changed.`,
    "Re-send the edit with the full old_string/new_string payload (or a non-empty edits[]). If the payload keeps disappearing, use write to rewrite the file or bash with a heredoc instead.",
  );
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

/**
 * Schema for models that drop optional payload fields (#1000): the replacement
 * text is required and `replace_all` carries no default, so a call cannot
 * satisfy the schema by filling only `path` and `replace_all`. The `edits[]`
 * multi-edit form is omitted — call `edit` once per replacement instead.
 */
export const strictEditParameters: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string" },
    old_string: { type: "string", description: "Exact text to replace." },
    new_string: { type: "string", description: "Replacement text." },
    replace_all: { type: "boolean", description: "Replace every occurrence of old_string. Defaults to false." },
  },
  required: ["path", "old_string", "new_string"],
  additionalProperties: false,
};

export const editTool: ToolSpec<Args> = {
  name: "edit",
  description: [
    "Replace exact strings in a file. Either pass old_string/new_string for one replacement, or edits: [{old_string, new_string, replace_all?}] to make several replacements in the same file in one call.",
    "The replacement text is required: a call with only path (and replace_all) is rejected without touching the file.",
    "edits are applied in order (each sees the result of the previous ones) and all-or-nothing: if any old_string is missing or ambiguous, nothing is written.",
    "Without replace_all, each old_string must appear exactly once. Read the file in this session first; re-read it after any change. Stale or unread files are rejected with a re-read suggestion. Prompts the user for permission first and shows a diff preview.",
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
    if (pairs.length === 0) throw missingPayloadError(args);
    const abs = resolvePath(ctx.cwd, args.path);
    // Serialize per path: concurrent edits (e.g. Promise.all inside execute_code)
    // must each see the previous edit's result, not a shared stale base image.
    return withFileLock(abs, async () => {
      const key = await lockKeyFor(abs);
      const original = await readFile(abs);
      assertReadVersion(ctx.fileReadHashes, key, original, args.path, "editing");
      const { text, replaced } = applyEdits(original.toString("utf8"), pairs, args.path);
      await writeFileVerified(abs, text);
      ctx.fileReadHashes?.set(key, sha256(Buffer.from(text, "utf8")));
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
