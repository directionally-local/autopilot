/**
 * Secret redaction for memory content.
 *
 * Applied before content is stored, embedded, or sent to a plumbing model.
 * This is a best-effort regex filter, not a guarantee: it covers the common
 * provider token shapes but not passwords, JWTs, private keys, or arbitrary
 * connection strings.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_KEY]" },
  { pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, replacement: "[REDACTED_GH_TOKEN]" },
  { pattern: /sk-[a-zA-Z0-9]{48}/g, replacement: "[REDACTED_SK_KEY]" },
  { pattern: /\b[0-9a-f]{32,64}\b/g, replacement: "[REDACTED_HEX_KEY]" },
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
