/**
 * Cheap write-time redaction for trace blobs and event payloads.
 *
 * This is the light pass from docs/plans/trace-and-dataset-dev-plan.md §1.5:
 * a handful of regexes, no entropy scan. The thorough scan runs at export
 * time (Phase 5). Everything that reaches disk through the recorder goes
 * through {@link redactLight} first.
 */

const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Well-known token shapes: OpenRouter keys, GitHub tokens, bearer/basic auth headers. */
const TOKEN_SHAPES: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]+/g,
  /ghp_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /Bearer [A-Za-z0-9._-]+/g,
  /Basic [A-Za-z0-9+/=]+/g,
];

/**
 * `api_key=value`, `secret: value`, `"token": "value"` and friends. The key
 * name (and the separator) survive; the value is replaced. Quotes around the
 * key and value are kept so JSON-style `"api_key": "..."` stays parseable.
 */
const KEY_VALUE = /(api[_-]?key|secret|token|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"']+/gi;

/** Replace secret-looking values in `text`. Returns the input unchanged when nothing matches. */
export function redactLight(text: string): string {
  if (!text) return text;
  let out = text.replace(PEM_BLOCK, "<redacted-key>");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "<redacted>");
  out = out.replace(KEY_VALUE, "$1$2<redacted>");
  return out;
}

/** Keys whose values are credentials. Matched case-insensitively on the key's suffix. */
const SECRET_KEY_SUFFIXES = ["apikey", "token", "secret", "password"];

export function isSecretConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Deep-copy a config-like object with every credential-bearing key replaced
 * by "<redacted>" (keys ending in ApiKey, Token, apiToken, secret, password;
 * case-insensitive). Used for `session_start.config`.
 */
export function redactConfig<T>(value: T): T {
  return redactValue(value, true) as T;
}

/**
 * Deep-copy any JSON-ish value applying {@link redactLight} to every string
 * leaf. Keys are left alone so the structure stays parseable. Used on event
 * payloads before they are serialized.
 */
export function redactDeep<T>(value: T): T {
  return redactValue(value, false) as T;
}

function redactValue(value: unknown, redactSecretKeys: boolean): unknown {
  if (typeof value === "string") return redactLight(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, redactSecretKeys));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (redactSecretKeys && isSecretConfigKey(k) && v !== null && v !== "") {
        out[k] = "<redacted>";
      } else {
        out[k] = redactValue(v, redactSecretKeys);
      }
    }
    return out;
  }
  return value;
}
