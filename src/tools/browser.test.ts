import { describe, it } from "node:test";
import assert from "node:assert";
import { browserFetchTool } from "./browser.js";
import type { ToolOutput } from "./registry.js";

describe("browser_fetch", () => {
  it("gracefully reports when Playwright is not installed", async () => {
    // Playwright is not installed in the test environment, so this should
    // return a helpful error message.
    const result = (await browserFetchTool.run({ url: "https://example.com" }, { cwd: "/tmp" })) as ToolOutput;
    assert.ok(result.content.includes("Playwright is not installed"));
    assert.ok(result.content.includes("npm install"));
  });
});

describe("browser_fetch Chromium guard", async () => {
  const { chromiumVersionAtLeast, launchPatchedChromium, MIN_CHROMIUM_VERSION } = await import("./browser.js");

  it("compares dotted versions", () => {
    assert.strictEqual(chromiumVersionAtLeast("156.0.8078.73"), true);
    assert.strictEqual(chromiumVersionAtLeast("156.0.8078.80"), true);
    assert.strictEqual(chromiumVersionAtLeast("157.0.1.0"), true);
    assert.strictEqual(chromiumVersionAtLeast("156.0.8078.4"), false);
    assert.strictEqual(chromiumVersionAtLeast("141.0.7390.37"), false);
    assert.strictEqual(chromiumVersionAtLeast("garbage"), false);
    assert.strictEqual(chromiumVersionAtLeast(""), false);
  });

  function fakePlaywright(byChannel: Record<string, string | Error>) {
    const calls: Array<Record<string, unknown>> = [];
    let closed = 0;
    const pw = {
      chromium: {
        async launch(opts: Record<string, unknown> = {}) {
          calls.push(opts);
          const r = byChannel[(opts.channel as string) ?? "bundled"];
          if (r instanceof Error) throw r;
          return { version: () => r, close: async () => { closed++; }, newPage: async () => { throw new Error("unused"); } };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { pw: pw as any, calls, closed: () => closed };
  }

  it("prefers installed Chrome, always with the sandbox on", async () => {
    const f = fakePlaywright({ chrome: MIN_CHROMIUM_VERSION, bundled: "156.0.8078.4" });
    const r = await launchPatchedChromium(f.pw);
    assert.ok("browser" in r);
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(f.calls[0], { headless: true, chromiumSandbox: true, channel: "chrome" });
  });

  it("falls back to bundled Chromium when it is new enough", async () => {
    const f = fakePlaywright({ chrome: new Error("Chromium distribution 'chrome' is not found"), bundled: "156.0.8078.80" });
    const r = await launchPatchedChromium(f.pw);
    assert.ok("browser" in r);
    assert.strictEqual(f.calls[1]?.chromiumSandbox, true);
    assert.strictEqual(f.calls[1]?.channel, undefined);
  });

  it("refuses old builds and closes them", async () => {
    const f = fakePlaywright({ chrome: "155.0.1.1", bundled: "156.0.8078.4" });
    const r = await launchPatchedChromium(f.pw);
    assert.ok("error" in r);
    assert.match(r.error, /CVE-2026-118306/);
    assert.match(r.error, /156\.0\.8078\.4 is older/);
    assert.strictEqual(f.closed(), 2);
  });
});
