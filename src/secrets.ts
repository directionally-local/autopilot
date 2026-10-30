/**
 * The shapes a provider secret takes, and where one sits in a git diff.
 *
 * Pure and dependency-free on purpose: the Aster server refuses a patch that holds a key,
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
  if (/^sk-or-v1-[A-Za-z0-9]{16,}/.test(candidate)) return true; // OpenRouter's prefix is unambiguous
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
