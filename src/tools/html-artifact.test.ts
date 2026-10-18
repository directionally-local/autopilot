import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS, ToolExecutor } from "./executor.js";
import { ToolError } from "./tool-error.js";
import { buildArtifactHtml, cleanupOldArtifacts, createHtmlArtifact, createHtmlArtifactFromFile, htmlArtifactTool } from "./html-artifact.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe("create_artifact", () => {
  it("is registered as a permission-gated path-based tool", () => {
    assert.equal(htmlArtifactTool.needsPermission, true);
    assert.ok(ALL_TOOLS.some((tool) => tool.name === "create_artifact"));
    const parameters = htmlArtifactTool.parameters as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(parameters.required, ["title", "sourcePath"]);
    assert.ok("sourcePath" in parameters.properties);
    assert.ok(!("html" in parameters.properties));
  });

  it("wraps HTML in a self-contained Autopilot shell and isolates content in a sandbox", () => {
    const page = buildArtifactHtml("A & <report>", "<!doctype html><h1>Hi</h1>");
    assert.match(page, /A &amp; &lt;report&gt; · Autopilot/);
    assert.match(page, /position: sticky/);
    assert.match(page, /aria-label="Autopilot logo"/);
    assert.match(page, /☆ Star on GitHub/);
    assert.match(page, /https:\/\/github\.com\/sinameraji\/autopilot/);
    assert.match(page, /sandbox="allow-scripts"/);
    assert.ok(!page.includes("allow-same-origin"));
    assert.ok(page.includes("srcdoc=\"&lt;!doctype html&gt;&lt;h1&gt;Hi&lt;/h1&gt;\""));
  });

  it("rejects incomplete or invalid arguments before creating artifact files", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "autopilot-artifact-invalid-test-"));
    try {
      const rootDir = join(scratch, "artifacts");
      const invalidArgs: unknown[] = [
        {},
        { title: "Dashboard" },
        { html: "<h1>Dashboard</h1>" },
        { title: " ", html: "<h1>Dashboard</h1>" },
        { title: "Dashboard", html: "  " },
        { title: 42, html: "<h1>Dashboard</h1>" },
        { title: "Dashboard", html: 42 },
      ];

      for (const args of invalidArgs) {
        await assert.rejects(
          createHtmlArtifact(args as Parameters<typeof createHtmlArtifact>[0], process.cwd(), { rootDir }),
          (error: unknown) => error instanceof ToolError && error.code === "invalid_args" && error.recoverable,
        );
      }
      await assert.rejects(stat(rootDir), { code: "ENOENT" });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("returns an actionable executor error when the model omits sourcePath", async () => {
    const executor = new ToolExecutor([htmlArtifactTool]);
    const result = await executor.run(
      { id: "missing-source", name: "create_artifact", arguments: JSON.stringify({ title: "Dashboard" }) },
      async () => "allow",
      { cwd: process.cwd() },
    );

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "invalid_args");
    assert.equal(result.recoverable, true);
    assert.match(result.content, /sourcePath must be a non-empty path/i);
    assert.match(result.suggestion ?? "", /write to save the complete HTML file/i);
  });

  it("reads a workspace HTML file, wraps it, and opens the browser copy", async () => {
    const sourceDir = await mkdtemp(join(process.cwd(), ".autopilot-artifact-source-test-"));
    const outputRoot = await mkdtemp(join(tmpdir(), "autopilot-artifact-output-test-"));
    try {
      const sourceFile = join(sourceDir, "dashboard.html");
      await writeFile(sourceFile, "<!doctype html><h1>Dashboard</h1>", "utf8");
      let openedUrl = "";
      const result = await createHtmlArtifactFromFile(
        { title: "Dashboard", sourcePath: relative(process.cwd(), sourceFile) },
        process.cwd(),
        { rootDir: outputRoot, open: (url) => { openedUrl = url; return true; } },
      );

      assert.ok(result.includes("Opened in your browser."));
      assert.ok(result.includes("Temporary file:"));
      assert.equal(new URL(openedUrl).protocol, "file:");
      const page = await readFile(fileURLToPath(openedUrl), "utf8");
      assert.ok(page.includes("&lt;!doctype html&gt;&lt;h1&gt;Dashboard&lt;/h1&gt;"));
      assert.ok((await readFile(sourceFile, "utf8")).includes("<h1>Dashboard</h1>"));
    } finally {
      await Promise.all([
        rm(sourceDir, { recursive: true, force: true }),
        rm(outputRoot, { recursive: true, force: true }),
      ]);
    }
  });

  it("refuses source HTML that resolves outside the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "autopilot-artifact-outside-test-"));
    try {
      const sourceFile = join(outside, "private.html");
      await writeFile(sourceFile, "<h1>Not a workspace artifact</h1>", "utf8");
      await assert.rejects(
        createHtmlArtifactFromFile({ title: "No", sourcePath: sourceFile }, process.cwd()),
        (error: unknown) => error instanceof ToolError && error.code === "policy_rejection",
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes outside the workspace and reports when the browser cannot be opened", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "autopilot-artifact-test-"));
    try {
      const rootDir = join(scratch, "artifacts");
      let openedUrl = "";
      const result = await createHtmlArtifact(
        { title: "Local report", html: "<h1>Hello</h1>" },
        process.cwd(),
        { rootDir, open: (url) => { openedUrl = url; return false; } },
      );
      assert.ok(result.includes("Could not open a browser automatically."));
      assert.ok(result.includes("Temporary file:"));
      assert.equal(new URL(openedUrl).protocol, "file:");
      const path = fileURLToPath(openedUrl);
      assert.ok(path.startsWith(rootDir + sep));
      const page = await readFile(path, "utf8");
      assert.ok(page.includes("&lt;h1&gt;Hello&lt;/h1&gt;"));
      assert.ok(page.includes("autopilot-bar"));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("refuses a workspace-local storage path before creating it", async () => {
    const rootDir = join(process.cwd(), ".autopilot-artifact-test-" + randomUUID());
    await assert.rejects(
      createHtmlArtifact({ title: "Should not be written", html: "<p>test</p>" }, process.cwd(), { rootDir }),
      /Refusing to store an artifact inside the workspace/,
    );
    await assert.rejects(stat(rootDir), { code: "ENOENT" });
  });

  it("removes only artifact directories older than seven days", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "autopilot-artifact-cleanup-test-"));
    try {
      const oldArtifact = join(rootDir, "artifact-old");
      const freshArtifact = join(rootDir, "artifact-fresh");
      const unrelated = join(rootDir, "keep-me");
      await Promise.all([mkdir(oldArtifact), mkdir(freshArtifact), mkdir(unrelated)]);
      const now = Date.now();
      const oldTime = new Date(now - SEVEN_DAYS_MS - 1000);
      await utimes(oldArtifact, oldTime, oldTime);

      await cleanupOldArtifacts(rootDir, now);

      await assert.rejects(stat(oldArtifact), { code: "ENOENT" });
      assert.ok((await stat(freshArtifact)).isDirectory());
      assert.ok((await stat(unrelated)).isDirectory());
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
