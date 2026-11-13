/**
 * Headless runs against a local OpenAI-compatible server (vLLM-shaped fake):
 * a request the provider rejects with a 4xx prints the provider's own message
 * and exits 1 in every output format, and so does a prompt that can't fit the
 * context the server reports (failing before anything is sent).
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSessionLifecycleForTesting } from "./hooks/session-lifecycle.js";
import { resetLocalContextForTesting } from "./models/local-context.js";
import { startFakeOpenAiServer, type FakeOpenAiServer } from "./agent/fake-openai-server.test-support.js";

const MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
const REJECTION = "'max_tokens' or 'max_completion_tokens' is too large: 16384. This model's maximum context length is 16384 tokens and your request has 9000 input tokens (16384 > 16384 - 9000).";
const ENV_KEYS = ["AUTOPILOT_PROVIDER", "AUTOPILOT_BASE_URL", "KIMIFLARE_BASE_URL", "OPENROUTER_API_KEY", "KIMI_MODEL", "AUTOPILOT_RECOVERY_DIR", "AUTOPILOT_MODEL_RETRIES"] as const;

describe("headless runs: provider rejections and local context", () => {
  const saved: Record<string, string | undefined> = {};
  let home = "";
  let cwd = "";
  let server: FakeOpenAiServer | null = null;
  let stdout = "";
  let stderr = "";

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    home = await mkdtemp(join(tmpdir(), "autopilot-provider-error-"));
    process.env.AUTOPILOT_RECOVERY_DIR = join(home, "recovery");
    process.env.AUTOPILOT_PROVIDER = "vllm";
  });

  beforeEach(async () => {
    resetSessionLifecycleForTesting();
    resetLocalContextForTesting();
    cwd = await mkdtemp(join(home, "project-"));
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await server?.close();
    server = null;
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  async function capture(run: () => Promise<void>): Promise<void> {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    stdout = "";
    stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
    try {
      await run();
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  }

  async function serve(opts: { maxModelLen?: number; reject?: boolean }): Promise<void> {
    server = await startFakeOpenAiServer({
      model: MODEL,
      ...(opts.maxModelLen ? { maxModelLen: opts.maxModelLen } : {}),
      ...(opts.reject ? { reject: { status: 400, body: { object: "error", message: REJECTION, type: "BadRequestError", param: null, code: 400 } } } : {}),
    });
    process.env.AUTOPILOT_BASE_URL = server.baseUrl;
  }

  async function print(format: "text" | "json" | "stream-json", prompt = "say hi"): Promise<void> {
    const { runPrintMode } = await import("./print-mode.js");
    await capture(() =>
      runPrintMode({
        model: MODEL,
        prompt,
        allowAll: false,
        showReasoning: false,
        updateResult: { hasUpdate: false } as never,
        format,
        dir: cwd,
        completionCheck: false,
        subagentPolicy: "off",
      }),
    );
  }

  it("text: prints the provider's message to stderr and exits 1", async () => {
    await serve({ reject: true });
    await print("text");
    assert.equal(process.exitCode, 1);
    assert.ok(stderr.includes(REJECTION), stderr);
    // Not retried: a 400 is the request's fault.
    assert.equal(server!.chatRequests().length, 1);
  });

  it("json: writes the result with the provider's message as `error` and exits 1", async () => {
    await serve({ reject: true });
    await print("json");
    assert.equal(process.exitCode, 1);
    const out = JSON.parse(stdout) as { error?: string; code?: number; status?: number };
    assert.equal(out.error, `Error: ${REJECTION}`);
    assert.equal(out.code, 1);
    assert.equal(out.status, 400);
  });

  it("stream-json: emits an error event with the provider's message and exits 1", async () => {
    await serve({ reject: true });
    await print("stream-json");
    assert.equal(process.exitCode, 1);
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l) as { event: string; message?: string; code?: number });
    const error = events.find((e) => e.event === "error");
    assert.ok(error, stdout);
    assert.equal(error.message, `Error: ${REJECTION}`);
    assert.equal(error.code, 1);
  });

  it("emit-events (one-shot): a RuntimeError with the provider's message, exit 1", async () => {
    await serve({ reject: true });
    const { runEmitMode } = await import("./emit-mode.js");
    await capture(() => runEmitMode({ model: MODEL, prompt: "say hi", allowAll: false }));
    assert.equal(process.exitCode, 1);
    const runtimeError = stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { event_type: string; payload: { message?: string; kind?: string } })
      .find((e) => e.event_type === "RuntimeError");
    assert.equal(runtimeError?.payload.message, REJECTION);
    assert.equal(runtimeError?.payload.kind, "api_error");
  });

  const turnRequest = () => server!.chatRequests().find((b) => Array.isArray(b.tools) && b.tools.length > 0);

  it("caps max_tokens at half the served context and finishes normally", async () => {
    await serve({ maxModelLen: 65536 });
    await print("text");
    assert.equal(process.exitCode, undefined, stderr);
    assert.equal(turnRequest()?.max_tokens, 16384);
  });

  it("lowers max_tokens to fit a small served context", async () => {
    await serve({ maxModelLen: 24000 });
    await print("text");
    assert.equal(process.exitCode, undefined, stderr);
    const sent = turnRequest()?.max_tokens as number;
    assert.ok(sent > 0 && sent <= 12000, String(sent));
  });

  for (const format of ["text", "json", "stream-json"] as const) {
    it(`${format}: a prompt too long for the served context fails before sending, exit 1`, async () => {
      await serve({ maxModelLen: 8192 });
      await print(format, "word ".repeat(40_000));
      assert.equal(process.exitCode, 1);
      assert.equal(server!.chatRequests().length, 0);
      const said = format === "text" ? stderr : stdout;
      assert.match(said, new RegExp(`This prompt is about [\\d,]+ tokens, but ${MODEL.replace(/[/.]/g, "\\$&")} on vLLM has a context of 8,192 tokens`));
      assert.match(said, /Compact with \/compact, start a new session, or raise --max-model-len on the server\./);
    });
  }
});
