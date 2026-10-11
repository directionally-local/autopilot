import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { formatWorkerResult, fromLegacySpawnWorkerArgs, subagentTool } from "./subagent.js";
import { workerRegistry } from "./worker-registry.js";
import type { ToolContext } from "./registry.js";

const realFetch = globalThis.fetch;
const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "KIMIFLARE_OPENROUTER_KEY",
  "KIMIFLARE_BASE_URL",
  "KIMIFLARE_API_KEY",
  "REQUESTY_API_KEY",
  "KIMIFLARE_WORKER_BACKEND",
  "KIMIFLARE_WORKER_ENDPOINT",
  "KIMIFLARE_WORKER_API_KEY",
  "KIMI_MODEL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "HOTCELL_BIN",
] as const;
const saved: Record<string, string | undefined> = {};
let configHome = "";

before(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  configHome = await mkdtemp(join(tmpdir(), "autopilot-hotcell-tool-test-"));
});

beforeEach(async () => {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_DATA_HOME = join(configHome, "data");
  await rm(join(configHome, "kimiflare"), { recursive: true, force: true });
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(configHome, { recursive: true, force: true });
});

describe("subagent tool", () => {
  it("is a direct, concurrent, mission-based tool with no remote or write controls", () => {
    const parameters = subagentTool.parameters as { properties: Record<string, unknown>; required: string[] };
    assert.equal(subagentTool.name, "subagent");
    assert.deepEqual(parameters.required, ["mission"]);
    assert.deepEqual(Object.keys(parameters.properties).sort(), ["context", "maxCostUsd", "mission"]);
    assert.equal(subagentTool.concurrent, true);
    assert.equal(subagentTool.codeModeDirect, true);
    assert.match(subagentTool.description, /IN THE SAME RESPONSE/);
    assert.match(subagentTool.description, /cannot edit files/);
  });

  it("accepts arguments recorded under the old spawn_worker name", () => {
    assert.deepEqual(
      fromLegacySpawnWorkerArgs({ mode: "plan", task: "map auth", context: "ctx", budget: { maxCostUsd: 0.5 } }),
      { mission: "map auth", context: "ctx", maxCostUsd: 0.5 },
    );
  });

  it("ignores legacy remote endpoint settings and reports a provider error", async () => {
    process.env.REQUESTY_API_KEY = "rq-test";
    process.env.KIMIFLARE_WORKER_ENDPOINT = "https://remote-worker.invalid";
    process.env.KIMIFLARE_WORKER_API_KEY = "must-not-be-sent";
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw new Error("remote worker must never be called");
    }) as typeof fetch;

    await assert.rejects(
      () => subagentTool.run({ mission: "research" }, { cwd: process.cwd(), model: "openai/gpt-4o-mini" }),
      /Subagents need an OpenRouter-backed session/,
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects custom model endpoints rather than falling back to remote workers", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.KIMIFLARE_BASE_URL = "https://custom-model.invalid/v1";
    process.env.KIMIFLARE_API_KEY = "custom-key";
    process.env.KIMIFLARE_WORKER_ENDPOINT = "https://remote-worker.invalid";

    await assert.rejects(
      () => subagentTool.run({ mission: "research" }, { cwd: process.cwd(), model: "openai/gpt-4o-mini" }),
      /Subagents do not support custom model endpoints/,
    );
  });
});

describe("formatWorkerResult", () => {
  const base = {
    workerId: "w1", status: "completed" as const, task: "t", recommendations: [], webSources: [],
    costUsd: 0.0123, tokensUsed: 4567, reasoning: "", model: "openai/gpt-6-luna",
  };

  it("renders cited, structured findings and open questions", () => {
    const text = formatWorkerResult({
      ...base,
      structured: true,
      findings: [{ topic: "Auth", summary: "Refresh in auth.ts", confidence: "high", sources: ["src/auth.ts:42"], relevance: "high" }],
      openQuestions: ["Is the cache shared?"],
      filesRead: ["src/auth.ts"],
    }, "openai/gpt-6-luna");
    assert.match(text, /## Auth \(high confidence\)\nRefresh in auth.ts\nFiles: src\/auth.ts:42/);
    assert.match(text, /## Open questions\n- Is the cache shared\?/);
    assert.match(text, /Files read: src\/auth.ts/);
    assert.doesNotMatch(text, /unverified/);
  });

  it("flags unstructured raw answers", () => {
    const text = formatWorkerResult({
      ...base,
      findings: [{ topic: "Research findings", summary: "raw", confidence: "medium", sources: [], relevance: "high" }],
      filesRead: [],
    }, "openai/gpt-6-luna");
    assert.match(text, /did not return a structured report/);
  });
});

describe("cancelling a running subagent", () => {
  async function setup(): Promise<{ cwd: string; ctx: (signal: AbortSignal) => ToolContext }> {
    const cwd = await mkdtemp(join(configHome, "repo-"));
    for (const args of [["init", "-q", "-b", "main"], ["config", "user.email", "t@example.com"], ["config", "user.name", "T"]]) execFileSync("git", args, { cwd });
    await writeFile(join(cwd, "README.md"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-qm", "init"], { cwd });
    execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd });
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
    // Fake Hotcell: setup succeeds instantly, research blocks until killed.
    const bin = join(configHome, "fake-hotcell");
    await writeFile(bin, [
      "#!/bin/sh",
      'case "$1" in',
      '  create) echo "12345678-1234-1234-1234-123456789abc" ;;',
      '  exec) case "$3" in *"npm install"*) exit 0 ;; *) exec sleep 30 ;; esac ;;',
      '  stats) echo "Cost: 0.0" ;;',
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"));
    await chmod(bin, 0o755);
    process.env.HOTCELL_BIN = bin;
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    return { cwd, ctx: (signal) => ({ cwd, signal, model: "openai/gpt-6-luna" }) as unknown as ToolContext };
  }

  async function waitForWorker(): Promise<void> {
    for (let i = 0; i < 100 && workerRegistry.list().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300)); // let the research exec start
  }

  it("returns a plain cancellation result for the coordinator, and the turn is untouched", { skip: process.platform === "win32" }, async () => {
    const { ctx } = await setup();
    const turn = new AbortController();
    const running = subagentTool.run({ mission: "map the auth flow" }, ctx(turn.signal));
    await waitForWorker();
    const [worker] = workerRegistry.list();
    assert.ok(worker, "worker is registered while running");
    workerRegistry.cancel(worker.index);
    const out = await running;
    const content = typeof out === "string" ? out : out.content;
    assert.match(content, /Subagent #\d+ was cancelled by the user/);
    assert.match(content, /Do not relaunch/);
    assert.equal(turn.signal.aborted, false);
    assert.equal(workerRegistry.list().length, 0, "worker removed after it stops");
  });

  it("still reports a turn abort as a failure, not a user decision", { skip: process.platform === "win32" }, async () => {
    const { ctx } = await setup();
    const turn = new AbortController();
    const running = subagentTool.run({ mission: "map the auth flow" }, ctx(turn.signal));
    await waitForWorker();
    turn.abort();
    await assert.rejects(running, /cancelled/);
    assert.equal(workerRegistry.list().length, 0);
  });
});
