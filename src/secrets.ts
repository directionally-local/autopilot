/**
 * The shapes a provider secret takes, and where one sits in a git diff.
 *
 * Pure and dependency-free on purpose: the dl server refuses a patch that holds a key,
 * and dl (the laptop's installer) scans the same patch before it ever leaves the machine.
 * Both import this module, so the two can't drift apart.
 *
 * Placeholders are deliberately not exempted. A real key's random chunk can contain "test",
 * "fake" or "example", and the cost of a false positive is one clear line plus a choice to
 * continue without local changes — far cheaper than sending a live key to a sandbox.
 */

/**
 * `sk-` keys (OpenRouter sk-or-v1-…, OpenAI sk-proj-…, Anthropic sk-ant-api03-…) always contain a
 * long random chunk. Requiring a word boundary and one 20+ character chunk with a digit keeps
 * ordinary hyphenated text ("task-management-dashboard", "ask-the-user-first") from being
 * mistaken for a credential, which previously rejected long messages.
 */
const SK_CANDIDATE_RE = /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g;

function isLikelySkKey(candidate: string): boolean {
  // OpenRouter, Anthropic and OpenAI project keys carry an unambiguous prefix.
  if (/^sk-(?:or-v1-|ant-|proj-)/.test(candidate)) return true;
  return candidate.slice(3).split(/[-_]/).some((chunk) => chunk.length >= 20 && /\d/.test(chunk));
}

/** The shapes a provider secret takes, by name. A name is what a refusal quotes: never the text. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; test: (text: string) => boolean }> = [
  { name: "provider key (sk-…)", test: (text) => [...text.matchAll(SK_CANDIDATE_RE)].some((match) => isLikelySkKey(match[0])) },
  { name: "GitHub token (ghp_…)", test: (text) => /\bgh[pousr]_[A-Za-z0-9]{20,}/.test(text) },
  { name: "GitHub fine-grained token (github_pat_…)", test: (text) => /\bgithub_pat_[A-Za-z0-9_]{20,}/.test(text) },
  { name: "provider key in an env assignment", test: (text) => /(?:CLOUDFLARE|OPENROUTER|REQUESTY)_API_(?:KEY|TOKEN)\s*=/.test(text) },
];

/** Where a likely secret is: never the matched text itself. */
export interface SecretMatch {
  /** The file the diff hunk belongs to, from the diff headers (a patch only). */
  file?: string;
  /** The line in the new file, from the hunk header (a patch only). */
  line?: number;
  /** Which pattern matched, by name. */
  pattern: string;
}

function matchSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find((pattern) => pattern.test(text))?.name;
}

/**
 * Where a likely provider secret is, so a refusal can say what to fix without quoting it.
 * A git diff is read hunk by hunk, so the answer is the file and line the key would land
 * on; only added lines count, since context lines are already in the repository the server
 * clones. Any other text is scanned whole, with no location.
 */
export function findLikelyProviderSecret(value: string): SecretMatch | undefined {
  let file: string | undefined;
  let line: number | undefined;
  let inDiff = false;
  for (const raw of value.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? undefined : path.replace(/^b\//, "");
      line = undefined;
      inDiff = true;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!inDiff) {
      const pattern = matchSecret(raw);
      if (pattern) return { pattern };
      continue;
    }
    if (raw.startsWith("+")) {
      const pattern = matchSecret(raw.slice(1));
      if (pattern) return { ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}), pattern };
      if (line !== undefined) line++;
      continue;
    }
    if (raw.startsWith(" ") && line !== undefined) line++;
  }
  return undefined;
}

export function containsLikelyProviderSecret(value: string): boolean {
  return findLikelyProviderSecret(value) !== undefined;
}

export function redactLikelySecrets(value: string): string {
  return value
    .replace(SK_CANDIDATE_RE, (match) => (isLikelySkKey(match) ? "[REDACTED_PROVIDER_SECRET]" : match))
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_PROVIDER_SECRET]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_PROVIDER_SECRET]");
}

// ── Tool-result scrubbing ────────────────────────────────────────────────
//
// Tool output goes to the model. A shell command that prints a credentials
// file, or a read of one, must not hand the model live keys. These patterns
// are intentionally conservative: a missed generic value is better than
// mangling ordinary source code, and the exact-match pass below covers the
// credentials this process actually holds.

const PEM_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** dl's key prefixes (dl.new API keys and the short-lived Autopilot key). */
const DL_KEY_RE = /(?<![A-Za-z0-9])(dlk_|dl_ak_|dl_sk_)[A-Za-z0-9_-]{8,}/g;

/** GitHub classic and fine-grained tokens. */
const GITHUB_TOKEN_RE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/** AWS access key ids. */
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;

/** An Authorization header, with an optional Bearer/Basic/Token scheme. */
const AUTHORIZATION_HEADER_RE =
  /(?<![A-Za-z0-9])(["']?authorization["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token)\s+)?([^\s"'`,;}\]]+)/gi;

/** A bare `Bearer <token>` outside an Authorization header. */
const BEARER_TOKEN_RE = /(?<![A-Za-z0-9])(Bearer)\s+([A-Za-z0-9._~+/=-]{8,})/g;

/**
 * Credential-shaped key/value pairs in JSON, YAML, .env and shell output.
 * Handles a pretty-printed value on its own line, including the `N\t` gutter
 * the read tool puts in front of every line.
 */
const CREDENTIAL_KEY_VALUE_RE =
  /(?<![A-Za-z0-9])(["']?)(api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|authorization|password|passwd|credentials?|token|secret|keys?)(\1)([ \t]*(?::|=)[ \t]*(?:\r?\n[ \t]*(?:\d+[ \t]*\t[ \t]*)?)?)("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s"'`,;{}\[\]]+)/gi;

const STRONG_CREDENTIAL_KEY_RE =
  /^(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?key|authorization|password|passwd|credentials?)$/i;
const WEAK_CREDENTIAL_KEY_RE = /^(?:token|secret|keys?)$/i;

/** Code-shaped values that are not secrets: type names, env lookups, calls. */
const NON_SECRET_VALUE_RE =
  /^(?:string|number|boolean|unknown|any|never|void|object|symbol|bigint|null|undefined|true|false|none|nil|yes|no|process\.env\b.*|env\..*|os\.environ\b.*|import\.meta\b.*|get[A-Za-z0-9_$]*|read[A-Za-z0-9_$]*|load[A-Za-z0-9_$]*|fetch[A-Za-z0-9_$]*)$/i;
const PLACEHOLDER_VALUE_RE =
  /^(?:\.{3,}|x{3,}|\*{3,}|redacted|<redacted.*>|\$\{.*\}|%[A-Z0-9_]+%|your[_-].*|change[_-]?me|placeholder|example|sample)$/i;
const CODE_ASSIGNMENT_BEFORE_RE = /(?:\b(?:const|let|var)\s+|\bthis\.|[A-Za-z0-9_$]\.|=>\s*|\breturn\s+)$/;
const CODE_REFERENCE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

function maskSkKey(candidate: string): string {
  if (!isLikelySkKey(candidate)) return candidate;
  if (candidate.startsWith("sk-or-v1-")) return "sk-or-v1-****";
  if (candidate.startsWith("sk-ant-")) return "sk-ant-****";
  if (candidate.startsWith("sk-proj-")) return "sk-proj-****";
  return "sk-****";
}

function maskGithubToken(token: string): string {
  return /^github_pat_/.test(token) ? "github_pat_****" : `${token.slice(0, 4)}****`;
}

function isNonSecretValue(value: string): boolean {
  const v = value.trim();
  return (
    !v ||
    v.startsWith("<redacted") ||
    PLACEHOLDER_VALUE_RE.test(v) ||
    NON_SECRET_VALUE_RE.test(v) ||
    /[(){}\[\]]/.test(v) ||
    /\s/.test(v)
  );
}

function maskAuthorizationHeader(match: string, prefix: string, scheme: string | undefined, value: string): string {
  if (value.startsWith("<redacted") || PLACEHOLDER_VALUE_RE.test(value)) return match;
  // A scheme means the rest really is a token; without one, leave code
  // references such as `authorization: req.headers.authorization` alone.
  if (!scheme && (isNonSecretValue(value) || CODE_REFERENCE_RE.test(value))) return match;
  return `${prefix}${scheme ? `${scheme} ****` : "<redacted>"}`;
}

/**
 * Weak credential names (key/token/secret) are common in ordinary source
 * (React keys, i18n strings, editor grammars, k8s labels). Mask their values
 * only when the value itself looks random enough to be a credential.
 */
function looksLikeWeakCredential(value: string): boolean {
  const v = value.trim();
  if (v.length < 16 || /\s/.test(v)) return false;
  if (v.includes("://") || /^[.~]?[\\/]/.test(v)) return false;
  // Dotted identifiers and dotted words are not secrets; a JWT-like dotted
  // token still qualifies when it has a long random chunk.
  const dotChunks = v.split(".");
  if (dotChunks.length > 1 && !dotChunks.some((chunk) => chunk.length >= 20)) return false;
  const alnum = v.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 16) return false;
  if (!/\d/.test(alnum)) return false;
  const hasLower = /[a-z]/.test(alnum);
  const hasUpper = /[A-Z]/.test(alnum);
  if ((!hasLower || !hasUpper) && alnum.length < 24) return false;
  // Words joined by hyphens/underscores (my-secret-name-in-k8s) are labels,
  // not tokens, even when one segment contains a digit.
  const chunks = v.split(/[-_]+/).filter(Boolean);
  if (chunks.length >= 3 && chunks.every((chunk) => chunk.length <= 12)) {
    const alphabetic = chunks.filter((chunk) => /^[A-Za-z]+$/.test(chunk));
    if (alphabetic.length >= Math.ceil(chunks.length * 0.6)) return false;
  }
  // A slash between wordy chunks is a path/URL, not a single token.
  if (/[A-Za-z]{2,}[\\/][A-Za-z]{2,}/.test(v)) return false;
  return true;
}

function shouldMaskCredentialValue(key: string, value: string, quoted: boolean): boolean {
  if (isNonSecretValue(value)) return false;
  const strong = STRONG_CREDENTIAL_KEY_RE.test(key);
  const weak = WEAK_CREDENTIAL_KEY_RE.test(key);
  if (!strong && !weak) return false;
  const v = value.trim();
  if (strong) {
    if (v.length < 4) return false;
    if (quoted) return true;
    if (CODE_REFERENCE_RE.test(v)) return false;
    // ALL_CAPS names are env/file config keys; their values are credentials
    // even when the value itself is a plain word.
    if (/^[A-Z][A-Z0-9_]*$/.test(key)) return true;
    const hasDigit = /\d/.test(v);
    const hasSymbol = /[._~+/=:@-]/.test(v);
    return hasDigit || hasSymbol || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v);
  }
  return looksLikeWeakCredential(v);
}

const EXACT_VALUE_MIN_LENGTH = 6;
const EXACT_REGEX_CACHE_LIMIT = 32;
const exactRegexCache = new Map<string, RegExp>();

function exactValuesPattern(values: Iterable<string | null | undefined>): RegExp | undefined {
  const list = [
    ...new Set(
      [...values]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length >= EXACT_VALUE_MIN_LENGTH),
    ),
  ].sort((a, b) => b.length - a.length);
  if (list.length === 0) return undefined;
  const cacheKey = list.join("\u0000");
  const cached = exactRegexCache.get(cacheKey);
  if (cached) return cached;
  const pattern = new RegExp(list.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  if (exactRegexCache.size >= EXACT_REGEX_CACHE_LIMIT) exactRegexCache.clear();
  exactRegexCache.set(cacheKey, pattern);
  return pattern;
}

function exactValueLabel(value: string): string {
  if (/^(?:dlk_|dl_ak_|dl_sk_)/.test(value)) return "<redacted:dl key>";
  if (/^sk-/.test(value)) return "<redacted:provider key>";
  if (/^(?:gh[pousr]_|github_pat_)/.test(value)) return "<redacted:github token>";
  if (/^AKIA/.test(value)) return "<redacted:aws key>";
  return "<redacted:runtime secret>";
}

/**
 * Every marker {@link scrubSecrets} writes where a secret was. Shared with
 * write/edit so a scrubbed result cannot be written back over the real value.
 * `Bearer/Basic/Token ****` and the prefixed `****` forms are all included.
 */
export const REDACTION_PLACEHOLDER_RE =
  /<redacted(?:-key|:[^>]*)?>|(?:dlk_|dl_ak_|dl_sk_|sk-(?:ant-|or-v1-|proj-)?|gh[pousr]_|github_pat_|AKIA)\*{4}|\b(?:Bearer|Basic|Token) \*{4}/g;

/** The placeholders present in text: unique, in first-seen order. */
export function findRedactionPlaceholders(text: string): string[] {
  return [...new Set(text.match(REDACTION_PLACEHOLDER_RE) ?? [])];
}

/**
 * The first placeholder in `newText` that does not already occur in
 * `existingText`, or undefined. A file that already contains a placeholder
 * (e.g. documentation about redaction) may keep it; a new one is write-back.
 */
export function introducedRedactionPlaceholder(newText: string, existingText: string): string | undefined {
  const existing = new Set(findRedactionPlaceholders(existingText));
  return findRedactionPlaceholders(newText).find((placeholder) => !existing.has(placeholder));
}

/** Exact values this process actually holds: provider keys, dl key, env keys. */
export interface ScrubSecretsOptions {
  exactValues?: Iterable<string | null | undefined>;
}

/**
 * Mask secrets in text that is about to become a tool result. Unlike
 * {@link redactLikelySecrets}, this keeps a useful prefix (`dlk_****`) and
 * also masks credential-key values and exact runtime credentials.
 */
export function scrubSecrets(text: string, options: ScrubSecretsOptions = {}): string {
  if (!text) return text;
  let out = text.replace(PEM_PRIVATE_KEY, "<redacted-key>");
  out = out.replace(AUTHORIZATION_HEADER_RE, maskAuthorizationHeader);
  out = out.replace(BEARER_TOKEN_RE, (match, scheme: string, token: string) =>
    isNonSecretValue(token) ? match : `${scheme} ****`,
  );
  out = out.replace(DL_KEY_RE, (_match, prefix: string) => `${prefix}****`);
  out = out.replace(SK_CANDIDATE_RE, (match) => maskSkKey(match));
  out = out.replace(GITHUB_TOKEN_RE, (token) => maskGithubToken(token));
  out = out.replace(AWS_ACCESS_KEY_RE, "AKIA****");
  out = out.replace(
    CREDENTIAL_KEY_VALUE_RE,
    (match, keyQuote, key, closingQuote, separator, value, offset) =>
      maskCredentialKeyValueWithOffset(text, match, keyQuote, key, closingQuote, separator, value, offset),
  );
  const exact = exactValuesPattern(options.exactValues ?? []);
  if (exact) out = out.replace(exact, (value) => exactValueLabel(value));
  return out;
}

function fullEnvKeyName(source: string, offset: number, key: string): string {
  const prefix = /[A-Za-z0-9_]*$/.exec(source.slice(0, offset))?.[0] ?? "";
  return prefix + key;
}

/**
 * `TOKEN=value`, `GITHUB_TOKEN=value` and `export SECRET=value`: an ALL_CAPS
 * name, a bare `=`, and an unquoted value. dotenv files and `env` output leak
 * keys this way even when the value is all lowercase.
 */
function isEnvStyleAssignment(
  source: string,
  offset: number,
  key: string,
  separator: string,
  value: string,
  quoted: boolean,
): boolean {
  if (quoted || separator !== "=" || value.length < 8 || value.startsWith("$")) return false;
  if (isNonSecretValue(value)) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(fullEnvKeyName(source, offset, key));
}

function maskCredentialKeyValueWithOffset(
  source: string,
  match: string,
  keyQuote: string,
  key: string,
  _closingQuote: string,
  separator: string,
  value: string,
  offset: number,
): string {
  if (/^authorization$/i.test(key)) return match;
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  const inner = quote ? value.slice(1, -1) : value;
  const envStyle = isEnvStyleAssignment(source, offset, key, separator, inner, quote !== "");
  if (!envStyle && !shouldMaskCredentialValue(key, inner, quote !== "")) return match;
  if (!quote && CODE_ASSIGNMENT_BEFORE_RE.test(source.slice(Math.max(0, offset - 24), offset))) return match;
  return `${keyQuote}${key}${keyQuote}${separator}${quote}<redacted>${quote}`;
}
