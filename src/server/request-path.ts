import type { IncomingMessage } from "node:http";

/**
 * The request path exactly as the routers see it: WHATWG URL parsing, which
 * resolves `.`/`..` segments (including `%2e` and backslash spellings).
 * Auth decisions must use this, never the raw `req.url`, or a request such
 * as `/api/v1/../../prompt` is authenticated as one route and served as another.
 * Returns null when the target cannot be parsed.
 */
export function requestPathname(req: Pick<IncomingMessage, "url">): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** True when the raw request path contains a `.` or `..` segment in any spelling. */
export function hasDotSegment(rawUrl: string | undefined): boolean {
  const path = (rawUrl ?? "/").split(/[?#]/, 1)[0] ?? "";
  return path.split(/[/\\]/).some((seg) => {
    const decoded = seg.replace(/%2e/gi, ".");
    return decoded === "." || decoded === "..";
  });
}
