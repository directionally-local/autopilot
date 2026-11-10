import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resetSessionLifecycleForTesting } from "./hooks/session-lifecycle.js";
import { HEADLESS_PROMPT_SECTION } from "./agent/system-prompt.js";
import { UNFINISHED_EXIT_CODE } from "./print-outcome.js";
import type { PermissionRules } from "./config.js";

// End to end through runPrintMode with a scripted model: print mode approves
// what interactive mode approves, denies what it would ask a person about,
// tells the model it is headless, and exits 45 when the run didn't finish.
describe("print mode: interactive policy, headless prompt, exit codes", () => {
  const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL", "AUTOPILOT_RECOVERY_DIR"] as const;
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let home = "";
  let cwd = "";
  /** Scripted replies for the main turn's model calls, in order. */
  let script: Array<{ tool?: { name: string; args: Record<string, unknown> }; text?: string }> = [];
  /** The system prompts the main turn sent. */
  let systemPrompts: string[] = [];
  let stdout = "";
  let stderr = "";

  const sse = (frames: unknown[]) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  const usage = { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.KIMIFLARE_BASE_URL;
    home = await mkdtemp(join(tmpdir(), "autopilot-print-mode-"));
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_DATA_HOME = join(home, "data");
    process.env.AUTOPILOT_RECOVERY_DIR = join(home, "recovery");
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-test-print-mode";
    process.env.KIMI_MODEL = "moonshotai/kimi-k2.6";
  });

  beforeEach(async () => {
    resetSessionLifecycleForTesting();
    cwd = await mkdtemp(join(home, "project-"));
    await mkdir(cwd, { recursive: true });
    script = [];
    systemPrompts = [];
    let step = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).includes("chat/completions")) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { tools?: unknown[]; messages?: Array<{ role: string; content: unknown }> };
      // Side calls (no tools offered) get a plain answer.
      if (!body.tools?.length) return sse([{ choices: [{ delta: { content: "ok" } }] }, { choices: [{ finish_reason: "stop" }] }, usage]);
      const first = body.messages?.[0];
      if (first?.role === "system" && typeof first.content === "string") systemPrompts.push(first.content);
      const reply = script[step++] ?? { text: "Done." };
      if (reply.tool) {
        return sse([
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name: reply.tool.name, arguments: JSON.stringify(reply.tool.args) } }] } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          usage,
        ]);
      }
      return sse([{ choices: [{ delta: { content: reply.text } }] }, { choices: [{ finish_reason: "stop" }] }, usage]);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = undefined;
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  async function print(prompt: string, extra: { allowAll?: boolean; permissions?: Record<string, PermissionRules>; format?: "text" | "json" | "stream-json" } = {}) {
    const { runPrintMode } = await import("./print-mode.js");
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    stdout = "";
    stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array) => ((stdout += String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => ((stderr += String(chunk)), true)) as typeof process.stderr.write;
    try {
      await runPrintMode({
        model: "moonshotai/kimi-k2.6",
        openrouterApiKey: "sk-or-test-print-mode",
        prompt,
        allowAll: extra.allowAll ?? false,
        showReasoning: false,
        updateResult: { hasUpdate: false } as never,
        format: extra.format ?? "text",
        dir: cwd,
        completionCheck: false,
        subagentPolicy: "off",
        ...(extra.permissions ? { permissions: extra.permissions } : {}),
      });
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  }

  it("writes a file without --dangerously-allow-all, and a clean run exits 0", async () => {
    script = [{ tool: { name: "write", args: { path: "notes.txt", content: "hello\n" } } }, { text: "Wrote notes.txt." }];
    await print("write notes.txt");
    assert.equal(await readFile(join(cwd, "notes.txt"), "utf8"), "hello\n");
    assert.equal(process.exitCode, undefined, stderr);
    assert.doesNotMatch(stderr, /did not finish|permission denied/);
  });

  it("tells the model the run is headless", async () => {
    script = [{ text: "Done." }];
    await print("say done");
    assert.ok(systemPrompts.length > 0);
    assert.ok(systemPrompts.every((p) => p.includes(HEADLESS_PROMPT_SECTION)), "headless section in every main-turn system prompt");
  });

  it("denies an irreversible command without an exact rule and exits 45", async () => {
    script = [{ tool: { name: "bash", args: { command: "terraform destroy" } } }, { text: "Could not destroy the workspace." }];
    await print("tear it down");
    assert.equal(process.exitCode, UNFINISHED_EXIT_CODE);
    assert.match(stderr, /\[denied: This can't be undone/);
    assert.match(stderr, /run did not finish: 1 tool call was denied \(bash\)/);
  });

  it("a config deny rule still denies (the old read-only behaviour), with exit 45 and a stream-json event", async () => {
    script = [{ tool: { name: "write", args: { path: "notes.txt", content: "x" } } }, { text: "I couldn't write the file." }];
    await print("write notes.txt", { permissions: { write: { "**": "deny" } }, format: "stream-json" });
    assert.equal(existsSync(join(cwd, "notes.txt")), false);
    assert.equal(process.exitCode, UNFINISHED_EXIT_CODE);
    const events = stdout.trim().split("\n").map((l) => JSON.parse(l) as { event: string; [k: string]: unknown });
    const denied = events.find((e) => e.event === "permission_denied");
    assert.equal(denied?.reason, "config_rule");
    const unfinished = events.find((e) => e.event === "unfinished");
    assert.deepEqual(unfinished?.reasons, ["denied_tool_calls"]);
    assert.equal(unfinished?.code, UNFINISHED_EXIT_CODE);
    assert.equal(events.at(-1)?.event, "done");
    // The model hears that no one can approve it, not "ask the user".
    const result = events.find((e) => e.event === "tool_result");
    assert.match(String(result?.content), /do not retry it or ask for permission/);
  });

  it("a final question exits 45, reported in the json output", async () => {
    script = [{ text: "I found two config files. Which one should I change?" }];
    await print("fix the config", { format: "json" });
    assert.equal(process.exitCode, UNFINISHED_EXIT_CODE);
    const out = JSON.parse(stdout) as { unfinished?: { reasons: string[]; question?: string } };
    assert.deepEqual(out.unfinished?.reasons, ["asks_user"]);
    assert.equal(out.unfinished?.question, "I found two config files. Which one should I change?");
  });
});
