import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
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

    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(args.url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });

      if (args.wait_for) {
        await page.waitForSelector(args.wait_for, { timeout: TIMEOUT_MS });
      }

      if (args.scroll) {
        await autoScroll(page);
      }

      let screenshotPath: string | undefined;
      if (args.screenshot) {
        screenshotPath = join(tmpdir(), `kimiflare-browser-${Date.now()}.png`);
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
  let protocol: string;
  try {
    protocol = new URL(String(url)).protocol;
  } catch {
    throw new Error(`browser_fetch needs an absolute http(s) URL, got: ${String(url)}`);
  }
  if (protocol !== "http:" && protocol !== "https:") {
    throw new Error(`browser_fetch only opens http(s) URLs, not ${protocol} (use the read tool for local files)`);
  }
}
