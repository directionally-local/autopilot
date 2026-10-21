import { describe, it, beforeEach, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { submitUserPrompt, PromptBlockedError, PROMPT_BLOCKED_EXIT_CODE } from "./prompt-submit.js";
import { resetSessionLifecycleForTesting, endSessions } from "./session-lifecycle.js";
import type { HooksManager } from "./manager.js";
import type { HookEvent, HookPayload } from "./types.js";
import type { ChatMessage } from "../agent/messages.js";

function recordingHooks(veto: string | null = null) {
  const fired: Array<{ event: HookEvent; payload: HookPayload }> = [];
  const hooks = {
    hasEnabledHooks: () => true,
    fire: async (event: HookEvent, payload: HookPayload) => {
      fired.push({ event, payload });
      const vetoed = event === "UserPromptSubmit" && veto !== null;
      return { outcomes: [], vetoed, vetoReason: vetoed ? veto : "", failures: [] };
    },
  } as unknown as HooksManager;
  return { hooks, fired };
}

describe("submitUserPrompt: SessionStart then UserPromptSubmit, in every host", () => {
  beforeEach(() => resetSessionLifecycleForTesting());

  it("fires SessionStart before the first UserPromptSubmit, both with the session id", async () => {
    const { hooks, fired } = recordingHooks();
    const r = await submitUserPrompt({ hooks, sessionId: "s1", cwd: "/r", prompt: "fix the bug", resumed: false, model: "m" });
    assert.deepEqual(r, { blocked: false });
    assert.deepEqual(fired.map((f) => f.event), ["SessionStart", "UserPromptSubmit"]);
    assert.equal(fired[0]!.payload.session_id, "s1");
    assert.equal(fired[1]!.payload.session_id, "s1");
    assert.equal((fired[1]!.payload as { prompt: string }).prompt, "fix the bug");
    assert.ok((fired[1]!.payload as { tier?: string }).tier, "tier classified when not given");
    // The next prompt of the same session does not start it again.
    await submitUserPrompt({ hooks, sessionId: "s1", cwd: "/r", prompt: "again", resumed: true, model: "m" });
    assert.deepEqual(fired.map((f) => f.event), ["SessionStart", "UserPromptSubmit", "UserPromptSubmit"]);
  });

  it("reports a veto with the hook's reason, or a default one", async () => {
    const { hooks } = recordingHooks("no secrets in prompts");
    assert.deepEqual(await submitUserPrompt({ hooks, sessionId: "s2", cwd: "/r", prompt: "x", resumed: false, model: "m" }), {
      blocked: true,
      reason: "no secrets in prompts",
    });
    const quiet = recordingHooks("");
    const r = await submitUserPrompt({ hooks: quiet.hooks, sessionId: "s3", cwd: "/r", prompt: "x", resumed: false, model: "m" });
    assert.equal(r.blocked, true);
    assert.match((r as { reason: string }).reason, /UserPromptSubmit hook blocked/);
  });

  it("never blocks without hooks", async () => {
    assert.deepEqual(await submitUserPrompt({ sessionId: "s4", cwd: "/r", prompt: "x", resumed: false, model: "m" }), { blocked: false });
  });

  it("PromptBlockedError carries the reason and a stable code; the exit code is distinct", () => {
    const e = new PromptBlockedError("nope");
    assert.equal(e.reason, "nope");
    assert.equal(e.code, "prompt_blocked");
    assert.match(e.message, /UserPromptSubmit hook: nope/);
    assert.ok(![0, 1, 2, 42, 43].includes(PROMPT_BLOCKED_EXIT_CODE));
  });
});

// End to end through real hook commands: print mode and the SDK fire
// UserPromptSubmit (they used to fire only SessionStart/tool events/Stop),
// with the session id, after SessionStart, and honor a veto.
describe("print mode and the SDK fire UserPromptSubmit", () => {
  const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL", "BLOCK_PROMPT"] as const;
  const saved: Record<string, string | undefined> = {};
  const originalFetch = globalThis.fetch;
  let home = "";
  let cwd = "";
  let log = "";
  let chatRequests = 0;

  const sse = (content: string) => {
    const enc = new TextEncoder();
    const events = [
      { choices: [{ delta: { content } }] },
      { choices: [{ finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.KIMIFLARE_BASE_URL;
    delete process.env.BLOCK_PROMPT;
    home = await mkdtemp(join(tmpdir(), "autopilot-prompt-submit-"));
    cwd = join(home, "project");
    await mkdir(cwd, { recursive: true });
    process.env.XDG_CONFIG_HOME = join(home, "config");
    process.env.XDG_DATA_HOME = join(home, "data");
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-test-prompt-submit";
    process.env.KIMI_MODEL = "moonshotai/kimi-k2.6";
    log = join(home, "events.log");
    const script = join(home, "record.sh");
    // Logs "<event> <session_id json>" per hook; blocks UserPromptSubmit when BLOCK_PROMPT=1.
    const recorder = join(home, "record.cjs");
    await writeFile(
      recorder,
      `let s = "";\nprocess.stdin.on("data", (c) => (s += c)).on("end", () => {\n` +
        `  const p = JSON.parse(s);\n` +
        `  require("node:fs").appendFileSync(${JSON.stringify(log)}, p.hook_event_name + " " + JSON.stringify(p.session_id) + "\\n");\n` +
        `  if (p.hook_event_name === "UserPromptSubmit" && process.env.BLOCK_PROMPT === "1") { process.stderr.write("blocked by test"); process.exit(2); }\n` +
        `});\n`,
    );
    await writeFile(script, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)}\n`);
    await chmod(script, 0o755);
    const hook = (id: string) => [{ id, command: script }];
    await mkdir(join(home, "config", "autopilot"), { recursive: true });
    await writeFile(
      join(home, "config", "autopilot", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: hook("ss"), UserPromptSubmit: hook("ups"), Stop: hook("stop"), SessionEnd: hook("se") } }),
    );
  });

  beforeEach(async () => {
    resetSessionLifecycleForTesting();
    await writeFile(log, "");
    chatRequests = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes("chat/completions")) {
        chatRequests += 1;
        return sse("ok");
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.BLOCK_PROMPT;
    process.exitCode = undefined;
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(home, { recursive: true, force: true });
  });

  const events = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      return await fn();
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
  }

  async function print(prompt: string) {
    const { runPrintMode } = await import("../print-mode.js");
    await quietly(() =>
      runPrintMode({
        model: "moonshotai/kimi-k2.6",
        openrouterApiKey: "sk-or-test-prompt-submit",
        prompt,
        allowAll: false,
        showReasoning: false,
        updateResult: { hasUpdate: false } as never,
        format: "json",
        dir: cwd,
        completionCheck: false,
        subagentPolicy: "off",
      }),
    );
  }

  it("print mode: SessionStart → UserPromptSubmit → Stop → SessionEnd, all with the session id", async () => {
    await print("say ok");
    const ev = await events();
    assert.deepEqual(ev.map((l) => l.split(" ")[0]), ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]);
    for (const line of ev) assert.match(line, / "\d{4}-[^"]+_say-ok"$/, line);
    assert.equal(chatRequests, 1);
  });

  it("print mode: a blocking hook stops the run before the model, with exit code 44", async () => {
    process.env.BLOCK_PROMPT = "1";
    await print("say ok");
    assert.equal(chatRequests, 0, "no model call");
    assert.equal(process.exitCode, PROMPT_BLOCKED_EXIT_CODE);
    assert.deepEqual((await events()).map((l) => l.split(" ")[0]), ["SessionStart", "UserPromptSubmit", "SessionEnd"]);
  });

  it("SDK: prompt() fires UserPromptSubmit with the session id, and throws PromptBlockedError on a veto", async () => {
    const { createAgentSession } = await import("../sdk/session.js");
    const { session } = await createAgentSession({ cwd, enableHooks: true, config: { completionCheck: false, subagentPolicy: "off" } as never });
    try {
      await session.prompt("hello sdk");
      const ev = await events();
      assert.deepEqual(ev.map((l) => l.split(" ")[0]), ["SessionStart", "UserPromptSubmit", "Stop"]);
      assert.ok(ev.every((l) => l.endsWith(`"${session.sessionId}"`)), ev.join("\n"));

      process.env.BLOCK_PROMPT = "1";
      const before = session.messages.length;
      await assert.rejects(session.prompt("blocked one"), (e: unknown) => e instanceof PromptBlockedError && /blocked by test/.test(e.reason));
      assert.equal(session.messages.length, before, "a blocked prompt never enters the history");
      assert.equal(chatRequests, 1);
    } finally {
      await session.dispose();
      await endSessions("exit");
    }
  });
});
