import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, runShell, summarizeTrace } from "./run.js";
import { createMemoryRecorder, createNoopRecorder } from "../trace/recorder.js";
import type { KimiFlareSession } from "../sdk/types.js";
import type { ChatMessage } from "../agent/messages.js";

const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL", "KIMIFLARE_TRACE", "KIMIFLARE_TRACE_DIR"] as const;

function sse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

let home: string;
let repo: string;
let tasksDir: string;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

before(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  home = await mkdtemp(join(tmpdir(), "autopilot-eval-run-"));
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
  process.env.OPENROUTER_API_KEY = "sk-or-test-eval";

  repo = join(home, "repo");
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);

  tasksDir = join(home, "tasks");
  await mkdir(join(tasksDir, "files"), { recursive: true });
  await writeFile(join(tasksDir, "files", "check.sh"), "test -f README.md && test -f spec.txt\n", "utf8");
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(
    join(tasksDir, "ok.json"),
    JSON.stringify({ id: "ok", repo, base_commit: base, prompt: "say hi", setup: "echo setup > .setup", test: "bash check.sh", files: { "check.sh": "files/check.sh", "spec.txt": "files/check.sh" } }),
  );
  await writeFile(join(tasksDir, "bad.json"), JSON.stringify({ id: "bad", repo, base_commit: base, prompt: "say hi", test: "exit 3" }));
  await writeFile(join(home, "config.json"), JSON.stringify({ name: "test-arm", config: { codeMode: false, completionCheck: false } }));
});

after(async () => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(home, { recursive: true, force: true });
});

describe("runShell", () => {
  it("captures output, exit codes, and timeouts", async () => {
    const ok = await runShell("echo hi; exit 4", process.cwd(), 5000);
    assert.strictEqual(ok.exitCode, 4);
    assert.match(ok.log, /hi/);
    const slow = await runShell("sleep 5", process.cwd(), 200);
    assert.strictEqual(slow.timedOut, true);
  });
});

describe("runEval", () => {
  it("runs each task against a scripted model and records results.jsonl and a test_verdict", async () => {
    globalThis.fetch = async () =>
      sse([
        { id: "gen_1", choices: [{ delta: { content: "hi" } }] },
        { choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8, cost: 0.002 } },
      ]);
    const out = join(home, "out");
    const logs: string[] = [];
    const summary = await runEval({
      tasksDir,
      configFile: join(home, "config.json"),
      model: "test/model",
      samples: 1,
      out,
      concurrency: 2,
      log: (l) => logs.push(l),
    });
    assert.strictEqual(summary.results.length, 2);
    const byId = new Map(summary.results.map((r) => [r.task_id, r]));
    const ok = byId.get("ok")!;
    assert.strictEqual(ok.passed, true);
    assert.strictEqual(ok.exit_code, 0);
    assert.strictEqual(ok.config, "test-arm");
    assert.strictEqual(ok.model, "test/model");
    assert.strictEqual(ok.turns, 1);
    assert.strictEqual(ok.tool_calls, 0);
    assert.ok(Math.abs(ok.cost_usd - 0.002) < 1e-9);
    assert.strictEqual(ok.prompt_tokens, 7);
    assert.strictEqual(ok.overflow, false);
    assert.strictEqual(ok.error, undefined);
    const bad = byId.get("bad")!;
    assert.strictEqual(bad.passed, false);
    assert.strictEqual(bad.exit_code, 3);

    // results.jsonl has one line per run.
    const lines = (await readFile(summary.resultsFile, "utf8")).trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.every((l) => JSON.parse(l).task_id));
    // The merged, redacted config is next to it.
    const cfg = JSON.parse(await readFile(join(out, "config.json"), "utf8"));
    assert.strictEqual(cfg.name, "test-arm");
    assert.deepStrictEqual(cfg.config, { codeMode: false, completionCheck: false });

    // The trace holds session_start, the agent's turn, the verdict, and session_end{eval_done}.
    const trace = (await readFile(join(ok.trace_dir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const types = trace.map((e) => e.type);
    assert.strictEqual(types[0], "session_start");
    assert.ok(types.includes("llm_request") && types.includes("turn_end"));
    const verdict = trace.find((e) => e.type === "outcome" && e.payload.kind === "test_verdict");
    assert.ok(verdict, "test_verdict recorded");
    assert.strictEqual(verdict.payload.passed, true);
    assert.strictEqual(verdict.payload.task_id, "ok");
    assert.strictEqual(verdict.payload.command, "bash check.sh");
    assert.strictEqual(trace.at(-1).type, "session_end");
    assert.strictEqual(trace.at(-1).payload.reason, "eval_done");
    assert.strictEqual(trace[0].payload.config.codeMode, false);
    // Worktrees are cleaned up by default.
    await assert.rejects(stat(join(out, "work", "ok", "0")));
    assert.ok(logs.some((l) => /2\/2|1\/2/.test(l)));
  });

  it("records a harness failure instead of aborting the set", async () => {
    const out = join(home, "out2");
    const createSession: typeof import("../sdk/session.js").createAgentSession = async (opts) => {
      const session = {
        sessionId: opts.sessionId ?? "s",
        cwd: opts.cwd ?? "",
        isStreaming: false,
        messages: [] as ChatMessage[],
        trace: createNoopRecorder(),
        prompt: async () => {
          throw Object.assign(new Error("input too large"), { name: "ContextBudgetError" });
        },
        steer: async () => {},
        followUp: async () => {},
        abort: async () => {},
        setModel: () => {},
        setMode: () => {},
        setReasoningEffort: () => {},
        resolvePermission: () => {},
        subscribe: () => () => {},
        getUsage: () => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, turnCount: 0 }),
        getStatus: () => ({ isStreaming: false, isCompacting: false, pendingSteer: [], pendingFollowUp: [], currentMode: "auto" as const }),
        save: async () => {},
        dispose: () => {},
      } as unknown as KimiFlareSession;
      return { session };
    };
    const summary = await runEval({ tasksDir, configFile: join(home, "config.json"), model: "m", out, filter: "ok", createSession, log: () => {} });
    assert.strictEqual(summary.results.length, 1);
    const r = summary.results[0]!;
    assert.strictEqual(r.overflow, true, "ContextBudgetError is reported as overflow");
    assert.match(r.error ?? "", /ContextBudgetError/);
    // The test still ran after the agent failed: check.sh passes because the files were restored.
    assert.strictEqual(r.passed, true);
  });

  it("summarizeTrace tolerates a missing file", async () => {
    const rec = createMemoryRecorder("x");
    assert.ok(rec);
    assert.deepStrictEqual(await summarizeTrace(join(home, "nope.jsonl")), { cost_usd: 0, prompt_tokens: 0, completion_tokens: 0, turns: 0, tool_calls: 0, overflow: false });
  });
});
