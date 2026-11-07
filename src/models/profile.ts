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

export interface ModelProfileCaps {
  /**
   * Tool-output cap in characters (#999). Overrides the
   * context-window-derived cap (`toolOutputCapForContextWindow`) everywhere
   * it applies: the executor's read reducer and the loop's truncation.
   */
  maxToolContentChars?: number;
  /** Per-turn `web_fetch` budget; the default is 5 (session cap 25). */
  webFetchPerTurn?: number;
}

export interface ModelProfileGuardrails {
  /**
   * Identical tool calls tolerated in the recent-call window before the
   * loop guardrail blocks the next repeat; the default is 2 (the 3rd
   * identical call is blocked).
   */
  loopThreshold?: number;
}

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
  /** Output caps; absent fields keep the harness defaults. */
  caps?: ModelProfileCaps;
  /** Guardrail thresholds; absent fields keep the harness defaults. */
  guardrails?: ModelProfileGuardrails;
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

/**
 * User-provided profile overrides (config `modelProfiles`, #999). A rule is
 * matched by a case-insensitive substring — or a `/regex/` literal — against
 * the model id, so it lands on every variant of a family no matter which
 * provider serves it. Matching overrides are applied field-by-field on top of
 * the built-in profile for the same model (or over the default behavior),
 * so a user can tune one knob without re-declaring the rest.
 */
export interface ModelProfileOverride {
  /** Case-insensitive substring, or a `/regex/` literal, matched against the model id. */
  match: string;
  /** Profile id for traces and `/model`; defaults to `config:<match>`. */
  id?: string;
  promptAddendum?: string;
  strictEditSchema?: boolean;
  bashReadHint?: boolean;
  maxToolContentChars?: number;
  webFetchPerTurn?: number;
  loopThreshold?: number;
}

interface CompiledOverride {
  match: (modelId: string) => boolean;
  override: ModelProfileOverride;
}

let configOverrides: CompiledOverride[] = [];

function compileMatch(pattern: string): (modelId: string) => boolean {
  const regexLiteral = pattern.match(/^\/(.*)\/([a-z]*)$/i);
  if (regexLiteral) {
    try {
      const flags = regexLiteral[2]!.includes("i") ? regexLiteral[2]! : `${regexLiteral[2]}i`;
      const re = new RegExp(regexLiteral[1]!, flags);
      return (id) => re.test(id);
    } catch {
      // Fall through to substring matching on an invalid regex.
    }
  }
  const needle = pattern.toLowerCase();
  return (id) => id.toLowerCase().includes(needle);
}

/** Replace the config-provided overrides; called from `loadConfig` on every reload. */
export function configureModelProfiles(overrides: ModelProfileOverride[] | undefined | null): void {
  configOverrides = (overrides ?? [])
    .filter((o) => o && typeof o.match === "string" && o.match.length > 0)
    .map((override) => ({ match: compileMatch(override.match), override }));
}

/** Test hook: drop config-provided overrides. */
export function _resetModelProfileOverridesForTests(): void {
  configOverrides = [];
}

function mergeOverrides(base: ModelProfile | undefined, matches: ModelProfileOverride[]): ModelProfile | undefined {
  if (matches.length === 0) return base;
  const merged: ModelProfile = {
    id: base?.id ?? `config:${matches[0]!.match}`,
    ...(base?.promptAddendum ? { promptAddendum: base.promptAddendum } : {}),
    ...(base?.strictEditSchema !== undefined ? { strictEditSchema: base.strictEditSchema } : {}),
    ...(base?.bashReadHint !== undefined ? { bashReadHint: base.bashReadHint } : {}),
    ...(base?.caps ? { caps: { ...base.caps } } : {}),
    ...(base?.guardrails ? { guardrails: { ...base.guardrails } } : {}),
  };
  for (const o of matches) {
    if (o.id !== undefined) merged.id = o.id;
    if (o.promptAddendum !== undefined) merged.promptAddendum = o.promptAddendum;
    if (o.strictEditSchema !== undefined) merged.strictEditSchema = o.strictEditSchema;
    if (o.bashReadHint !== undefined) merged.bashReadHint = o.bashReadHint;
    if (o.maxToolContentChars !== undefined) merged.caps = { ...merged.caps, maxToolContentChars: o.maxToolContentChars };
    if (o.webFetchPerTurn !== undefined) merged.caps = { ...merged.caps, webFetchPerTurn: o.webFetchPerTurn };
    if (o.loopThreshold !== undefined) merged.guardrails = { ...merged.guardrails, loopThreshold: o.loopThreshold };
  }
  return merged;
}

/** The profile for a model id, or undefined for the default (unchanged) behavior. */
export function modelProfileFor(modelId: string | undefined | null): ModelProfile | undefined {
  if (!modelId) return undefined;
  const builtin = RULES.find((rule) => rule.match(modelId))?.profile;
  const matches = configOverrides.filter((o) => o.match(modelId)).map((o) => o.override);
  return mergeOverrides(builtin, matches);
}

/** Profile id for traces, or undefined when the model uses the default profile. */
export function modelProfileId(modelId: string | undefined | null): string | undefined {
  return modelProfileFor(modelId)?.id;
}
