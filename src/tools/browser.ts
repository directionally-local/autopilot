import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  describeNonPublic,
  networkPermissionTarget,
  networkTargetReason,
  parseWebUrl,
  resolveNetworkTarget,
} from "../util/network-target.js";
import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";

interface Args {
  url: string;
  wait_for?: string;
  screenshot?: boolean;
  scroll?: boolean;
}

const TIMEOUT_MS = 30_000;
const NAV_TIMEOUT_MS = 20_000;

export const browserFetchTool: ToolSpec<Args> = {
  name: "browser_fetch",
  description:
    "Fetch a URL using a headless Chromium browser via Playwright. " +
    "Use this for JavaScript-rendered pages where `web_fetch` returns empty or incomplete content. " +
    "Returns the extracted page text. Optionally takes a screenshot and saves it to a temp file. " +
    "Requires Playwright to be installed (`npm install -g playwright` or `npx playwright install chromium`).",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full URL to navigate to." },
      wait_for: {
        type: "string",
        description: "Optional CSS selector to wait for before extracting content (e.g., '#root', '.content').",
      },
      screenshot: {
        type: "boolean",
        description: "If true, captures a full-page screenshot and returns its file path. Default: false.",
      },
      scroll: {
        type: "boolean",
        description: "If true, scrolls to the bottom of the page to trigger lazy-loaded content. Default: false.",
      },
    },
    required: ["url"],
    additionalProperties: false,
  },
  needsPermission: false,
  // As for web_fetch: a local or private network target needs the user's
  // permission, approved per origin.
  permissionReason: (args) => networkTargetReason(args.url, "browser_fetch"),
  permissionTarget: (args) => networkPermissionTarget(args.url),
  render: (args) => ({
    title: `browser ${args.url ?? ""}${args.screenshot ? " (screenshot)" : ""}`,
  }),
  async run(args, ctx): Promise<ToolOutput> {
    // Web pages only: a file:// URL would read local files (credentials
    // included) without the read tool's permission check.
    assertWebUrl(args.url);
    let playwright: typeof import("playwright") | undefined;
    try {
      playwright = await import("playwright");
    } catch {
      const msg =
        "Playwright is not installed. To use the browser tool, install it:\n" +
        "  npm install -g playwright\n" +
        "  npx playwright install chromium";
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    }

    // Re-check the target (it may resolve differently than at the
    // permission check), then keep every request the page makes — redirects
    // and subresources included — off non-public addresses other than the
    // approved origin. Residual: WebSocket connections are not routed
    // through page.route, and Chromium resolves names itself, so a DNS
    // rebinding name (public to this check, private to Chromium) is not
    // stopped.
    const approvedOrigin = ctx.approvedSensitiveReason ? networkPermissionTarget(args.url) : null;
    const checker = createRequestChecker(approvedOrigin);
    const initial = await checker(args.url);
    if (initial) {
      throw new Error(`${args.url} points to ${initial}, which needs the user's approval; it was not approved for this call. Call browser_fetch again to ask the user.`);
    }

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const blocked: string[] = [];
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        const reason = await checker(url).catch(() => "an address that could not be checked");
        if (reason) {
          blocked.push(`${url} (${reason})`);
          await route.abort("blockedbyclient");
        } else {
          await route.continue();
        }
      });
      try {
        await page.goto(args.url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
      } catch (e) {
        if (blocked.length) {
          throw new Error(
            `Navigation was blocked: it led to ${blocked[0]}, which needs the user's approval. ` +
              "To ask the user, call browser_fetch with that URL directly.",
          );
        }
        throw e;
      }

      if (args.wait_for) {
        await page.waitForSelector(args.wait_for, { timeout: TIMEOUT_MS });
      }

      if (args.scroll) {
        await autoScroll(page);
      }

      let screenshotPath: string | undefined;
      if (args.screenshot) {
        screenshotPath = join(tmpdir(), `autopilot-browser-${Date.now()}.png`);
        await mkdir(dirname(screenshotPath), { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
      }

      // Extract readable text content
      const text = await page.evaluate(() => {
        // Try to find the main content area
        const selectors = [
          "main",
          "article",
          '[role="main"]',
          ".content",
          "#content",
          ".post-content",
          ".entry-content",
          ".markdown-body",
        ];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el) return el.textContent ?? "";
        }
        // Fallback: body text minus script/style tags
        const body = document.body.cloneNode(true) as HTMLElement;
        body.querySelectorAll("script, style, nav, header, footer, aside").forEach((el) => el.remove());
        return body.textContent ?? "";
      });

      const cleaned = text
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]+/g, " ")
        .trim();

      const lines = [`URL: ${args.url}`];
      if (screenshotPath) {
        lines.push(`Screenshot: ${screenshotPath}`);
      }
      if (blocked.length) {
        lines.push(`Blocked ${blocked.length} request(s) to local or private network addresses, e.g. ${blocked[0]}`);
      }
      lines.push("", cleaned);

      const content = lines.join("\n");
      const bytes = Buffer.byteLength(content, "utf8");
      return { content, rawBytes: bytes, reducedBytes: bytes };
    } finally {
      await browser.close();
    }
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function autoScroll(page: any): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      // Safety timeout
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 10_000);
    });
  });
}

/** Throws unless `url` is an http(s) URL. */
export function assertWebUrl(url: unknown): void {
  parseWebUrl(url, "browser_fetch");
}

/**
 * Returns a checker for the page's requests: it resolves to a description
 * of the non-public address an http(s) request would reach, or null when
 * the request may proceed (public, the approved origin, or not http(s),
 * e.g. data: and blob: URLs). Results are cached per origin.
 */
export function createRequestChecker(approvedOrigin: string | null): (url: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.resolve(null);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve(null);
    const origin = networkPermissionTarget(parsed.href);
    if (origin === approvedOrigin) return Promise.resolve(null);
    let pending = cache.get(origin);
    if (!pending) {
      pending = resolveNetworkTarget(parsed, "browser_fetch").then(describeNonPublic);
      cache.set(origin, pending);
    }
    return pending;
  };
}
