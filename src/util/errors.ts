export class ApiError extends Error {
  /** A provider's own error code when it sends a string one (e.g. Directionally Local's "quota_exceeded"). */
  providerCode?: string;
  /** Set by the client when it has judged the failure: true when trying again may work (see agent/model-retry.ts). */
  transient?: boolean;
  /** The host's Retry-After, in milliseconds, when it sent one. */
  retryAfterMs?: number;
  /** What the provider sent with that code (Directionally Local: reset time, offers, invite link, place in line). */
  providerDetail?: Record<string, unknown>;
  /** The provider's own words for a transient failure, shown in the retry line ("The free tier is busy right now"). */
  retryMessage?: string;
  constructor(
    message: string,
    public readonly code?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

/** Friendly-message prefixes the client sets itself; the legacy `kimiflare: `
 *  spelling is still stripped so pre-rename messages humanize too (#911). */
const FRIENDLY_PREFIXES = ["autopilot: ", "kimiflare: "] as const;

/** Map an API error to a human-readable, actionable message. Messages the
 *  client already made friendly ("autopilot: …" — bad key, out of credits,
 *  moderation block, missing key) pass through; the rest are bucketed by
 *  HTTP status with any embedded JSON stripped. */
export function humanizeApiError(err: ApiError): string {
  const { code, httpStatus, message } = err;

  for (const prefix of FRIENDLY_PREFIXES) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }

  const codeStr = code !== undefined ? ` (code: ${code})` : "";

  if (httpStatus === 429) {
    return `Rate limit hit${codeStr}. Please wait a moment and try again — or pick a less busy model with /model.`;
  }

  if (httpStatus === 400) {
    if (message.includes("invalid escaped character")) {
      return `API rejected request${codeStr} (invalid JSON in conversation history). Run /clear to reset if it persists.`;
    }
    if (message.includes("Invalid model ID")) {
      return message; // already human-friendly
    }
    return `Bad request${codeStr}. The conversation may be too long or contain invalid characters. Run /compact or /clear.`;
  }

  if (httpStatus === 502 || httpStatus === 503) {
    return `No provider could serve this model right now${codeStr}. Try again shortly, or switch models with /model.`;
  }

  if (httpStatus && httpStatus >= 500) {
    return `The model provider is having issues${codeStr}. Please wait a moment and try again.`;
  }

  // Fallback: strip any embedded JSON so we don't dump raw objects to the user
  return message.replace(/\{[\s\S]*?\}/g, "(see logs for details)");
}
