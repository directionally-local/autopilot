/**
 * Per-model behavior profiles (#999).
 *
 * Every model used to get the same system prompt, tool schemas and guardrail
 * thresholds. Models differ in how they use tools, and those differences cost
 * round trips, failed calls and loops. A profile is the smallest unit that
 * adapts the harness to one model family without touching the provider layer:
 * a prompt addendum, a tool-schema variant and a few opt-in hints.
 *
 * Profiles are matched by model id (vendor/family prefix), so they apply to
 * every variant of a family — including ids the live catalog has never seen.
 * The default profile is "no profile": today's behavior, unchanged.
 */

export interface ModelProfile {
  /** Stable id recorded in traces and shown by `/model`. */
  id: string;
  /** Extra system-prompt guidance appended to the session prefix. */
  promptAddendum?: string;
  /**
   * Present `edit` with `old_string`/`new_string` required and no defaulted
   * `replace_all`, and without the `edits[]` alternative form. Models that
   * fill every defaulted field and skip optional ones otherwise send
   * `{path, replace_all}` with no replacement text (#1000).
   */
  strictEditSchema?: boolean;
  /**
   * Append a one-line hint when a bash call only read a file, pointing at the
   * `read` tool (#1001).
   */
  bashReadHint?: boolean;
}

/** DeepSeek V4.x reads files through bash and drops optional edit payloads. */
const DEEPSEEK_V4: ModelProfile = {
  id: "deepseek-v4",
  promptAddendum: [
    "## Model-specific tool guidance",
    "Use the `read` tool to view files and `grep`/`glob` to search. Do not use `sed`, `awk`, `cat`, `head` or `tail` in bash for reading files. Read whole files at once instead of small chunks.",
    "When several reads, searches or status commands don't depend on each other, issue them all in one response instead of one per turn.",
    "When you call `edit`, always include both `old_string` and `new_string`. A call with only `path` is rejected without touching the file.",
  ].join("\n"),
  strictEditSchema: true,
  bashReadHint: true,
};

interface ProfileRule {
  /** Matches the model id (OpenRouter `vendor/model[:variant]` or a bare id). */
  match: (modelId: string) => boolean;
  profile: ModelProfile;
}

const RULES: ProfileRule[] = [
  {
    // "deepseek/deepseek-v4.1-flash", "deepseek-v4-pro", "deepseek/deepseek-v4:free", …
    match: (id) => /(?:^|[/:])deepseek-v4(?:[.:/-]|$)/i.test(id),
    profile: DEEPSEEK_V4,
  },
];

/** The profile for a model id, or undefined for the default (unchanged) behavior. */
export function modelProfileFor(modelId: string | undefined | null): ModelProfile | undefined {
  if (!modelId) return undefined;
  return RULES.find((rule) => rule.match(modelId))?.profile;
}

/** Profile id for traces, or undefined when the model uses the default profile. */
export function modelProfileId(modelId: string | undefined | null): string | undefined {
  return modelProfileFor(modelId)?.id;
}
