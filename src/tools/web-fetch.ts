import TurndownService from "turndown";
import { getUserAgent } from "../util/version.js";
import {
  describeNonPublic,
  networkPermissionTarget,
  networkTargetReason,
  parseWebUrl,
  resolveNetworkTarget,
} from "../util/network-target.js";
import type { ToolSpec, ToolOutput, ToolContext } from "./registry.js";

interface Args {
  url: string;
}

const MAX_BYTES = 1 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export const webFetchTool: ToolSpec<Args> = {
  name: "web_fetch",
  description:
    "Fetch a URL over HTTPS and return its content. HTML pages are converted to markdown. Large pages are reduced to a summary by default; use expand_artifact to retrieve the full content. Fetching a local or private network address (localhost, 127.0.0.1, 10.x, 169.254.x, ...) asks the user first.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL, http(s)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  needsPermission: false,
  // A loopback / link-local / private target (a dev server, but also cloud
  // metadata credentials or the local `serve` API) is fetched only with
  // the user's permission, approved per origin.
  permissionReason: (args) => networkTargetReason(args.url, "web_fetch"),
  permissionTarget: (args) => networkPermissionTarget(args.url),
  render: (args) => ({ title: `GET ${args.url ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { res, url: finalUrl } = await fetchCheckingRedirects(args.url, ctx, controller.signal);
      const ct = res.headers.get("content-type") ?? "";
      const body = await res.text();
      const bounded = body.length > MAX_BYTES ? body.slice(0, MAX_BYTES) : body;
      const heading = finalUrl === args.url ? args.url : `${args.url} (redirected to ${finalUrl})`;
      let raw: string;
      if (ct.toLowerCase().includes("html")) {
        const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
        raw = `# ${heading}\n\n${td.turndown(bounded)}`;
      } else {
        raw = `# ${heading}\n\n${bounded}`;
      }
      return {
        content: raw,
        rawBytes: Buffer.byteLength(raw, "utf8"),
        reducedBytes: Buffer.byteLength(raw, "utf8"),
      };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};

/**
 * Fetches `url`, following up to MAX_REDIRECTS redirects itself so every
 * hop is checked. A hop to a non-public address is refused unless it is
 * the origin the user approved for this call (ctx.approvedSensitiveReason
 * is set only when the permission check flagged the initial URL and the
 * user allowed it). The initial URL is re-checked too: a name that looked
 * public at the permission check but resolves privately now is refused.
 *
 * Residual risk: fetch() resolves the hostname again when it connects, so
 * a DNS server that answers a public address to these checks and a
 * private one to the connection (DNS rebinding with a zero TTL) is not
 * stopped. Pinning the checked address needs a custom undici dispatcher,
 * which Node's built-in fetch does not expose without the undici package.
 */
async function fetchCheckingRedirects(
  startUrl: string,
  ctx: ToolContext,
  signal: AbortSignal,
): Promise<{ res: Response; url: string }> {
  const approvedOrigin = ctx.approvedSensitiveReason ? networkPermissionTarget(startUrl) : null;
  let url = parseWebUrl(startUrl, "web_fetch");
  let from: URL | null = null;
  for (let hop = 0; ; hop++) {
    const target = await resolveNetworkTarget(url, "web_fetch");
    const described = describeNonPublic(target);
    if (described && networkPermissionTarget(url.href) !== approvedOrigin) {
      throw new Error(
        from
          ? `Redirect from ${from.href} to ${url.href} was not followed: it points to ${described}, which needs the user's approval. ` +
              `To ask the user, call web_fetch with ${url.href} directly.`
          : `${url.href} points to ${described}, which needs the user's approval; it was not approved for this call. Call web_fetch again to ask the user.`,
      );
    }
    const res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: { "User-Agent": getUserAgent() },
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || res.status === 304 || !location) {
      return { res, url: url.href };
    }
    await res.body?.cancel().catch(() => undefined);
    if (hop >= MAX_REDIRECTS) throw new Error(`Too many redirects (more than ${MAX_REDIRECTS}) fetching ${startUrl}`);
    from = url;
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new Error(`Invalid redirect location from ${url.href}: ${location}`);
    }
    url = parseWebUrl(next.href, "web_fetch");
  }
}
