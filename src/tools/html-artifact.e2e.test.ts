import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentTurn } from "../agent/loop.js";
import type { ChatMessage } from "../agent/messages.js";
import { ToolExecutor } from "./executor.js";
import { createHtmlArtifactFromFile, htmlArtifactTool } from "./html-artifact.js";
import { writeTool } from "./write.js";
import { secureSandboxUnavailableReason } from "../code-mode/sandbox.js";

const sandboxUnavailableReason = await secureSandboxUnavailableReason();

describe("artifact workflow end to end", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalBaseUrl: string | undefined;

  before(() => {
    originalFetch = globalThis.fetch;
    originalBaseUrl = process.env.KIMIFLARE_BASE_URL;
    delete process.env.KIMIFLARE_BASE_URL;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.KIMIFLARE_BASE_URL;
    else process.env.KIMIFLARE_BASE_URL = originalBaseUrl;
  });

  it("writes a large HTML document, then creates and opens its local artifact", async (t) => {
    if (sandboxUnavailableReason) {
      t.skip(`requires secure Code Mode: ${sandboxUnavailableReason}`);
      return;
    }
    const workspace = await mkdtemp(join(tmpdir(), "autopilot-artifact-e2e-work-"));
    const outputRoot = await mkdtemp(join(tmpdir(), "autopilot-artifact-e2e-output-"));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Dashboard</title></head><body><main><h1>Revenue dashboard</h1><p>${"Quarterly revenue data and interactive chart point. ".repeat(320)}</p></main></body></html>`;
    assert.ok(Buffer.byteLength(html, "utf8") > 12_000, "the HTML must exceed the size of the previously malformed artifact arguments");

    let openedUrl = "";
    const artifactTool = {
      ...htmlArtifactTool,
      run: async (args: Parameters<typeof createHtmlArtifactFromFile>[0], ctx: { cwd: string }) =>
        createHtmlArtifactFromFile(args, ctx.cwd, {
          rootDir: outputRoot,
          open: (url) => { openedUrl = url; return true; },
        }),
    };
    const tools = [writeTool, artifactTool];
    const executor = new ToolExecutor(tools);
    const code = [
      `await api.write({ path: "dashboard.html", content: ${JSON.stringify(html)} });`,
      'const result = await api.create_artifact({ title: "Revenue dashboard", sourcePath: "dashboard.html" });',
      "console.log(result);",
    ].join("\n");
    const executeCodeArguments = JSON.stringify({ code });
    assert.ok(Buffer.byteLength(executeCodeArguments, "utf8") > 12_000);

    const responseFrames = [
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call-artifact-code",
              type: "function",
              function: { name: "execute_code", arguments: executeCodeArguments },
            }],
          },
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      { choices: [{ index: 0, delta: { content: "Created the Revenue dashboard artifact." }, finish_reason: "stop" }] },
    ];
    let requestIndex = 0;
    globalThis.fetch = async () => {
      const frame = responseFrames[requestIndex++];
      const events = frame ? [frame] : [];
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "test" },
      { role: "user", content: "Create a dashboard artifact." },
    ];
    const approvedTools: string[] = [];
    const results: Array<{ name: string; ok?: boolean }> = [];

    try {
      await runAgentTurn({
        openrouterApiKey: "sk-or-test",
        model: "test/model",
        messages,
        tools,
        executor,
        cwd: workspace,
        signal: new AbortController().signal,
        codeMode: true,
        callbacks: {
          askPermission: async ({ tool }) => {
            approvedTools.push(tool.name);
            return "allow";
          },
          onToolResult: (result) => results.push({ name: result.name, ok: result.ok }),
        },
      });

      assert.equal(requestIndex, 2, "one model tool turn followed by one final response");
      assert.deepEqual(approvedTools, ["write", "create_artifact"]);
      assert.ok(results.some((result) => result.name === "write" && result.ok));
      assert.ok(results.some((result) => result.name === "create_artifact" && result.ok));
      assert.ok(results.some((result) => result.name === "execute_code" && result.ok));
      assert.equal(await readFile(join(workspace, "dashboard.html"), "utf8"), html);
      assert.equal(new URL(openedUrl).protocol, "file:");

      const artifactPath = fileURLToPath(openedUrl);
      const artifactHtml = await readFile(artifactPath, "utf8");
      assert.match(artifactHtml, /autopilot-bar/);
      assert.ok(artifactHtml.includes("&lt;!doctype html&gt;&lt;html lang=&quot;en&quot;&gt;"));
      assert.ok(artifactHtml.includes("Quarterly revenue data and interactive chart point."));
    } finally {
      await Promise.all([
        rm(workspace, { recursive: true, force: true }),
        rm(outputRoot, { recursive: true, force: true }),
      ]);
    }
  });
});
