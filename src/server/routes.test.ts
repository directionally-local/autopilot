import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KimiConfig } from "../config.js";
import { setupRoutes } from "./routes.js";
import { RunStore } from "../runs/store.js";
import { registerOpenRouterModels } from "../models/registry.js";
import { loadSession, saveSession, sessionsDir } from "../sessions.js";

describe("unattended run HTTP routes", () => {
  it("requires server auth configuration and validates run options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autopilot-run-routes-"));
    const oldRunsDb = process.env.AUTOPILOT_RUNS_DB;
    const oldDataHome = process.env.XDG_DATA_HOME;
    const oldPassword = process.env.KIMIFLARE_SERVER_PASSWORD;
    process.env.AUTOPILOT_RUNS_DB = join(dir, "runs.db");
    process.env.XDG_DATA_HOME = join(dir, "data");
    delete process.env.KIMIFLARE_SERVER_PASSWORD;

    const routes = setupRoutes({} as KimiConfig);
    const server = createServer((req, res) => { void routes.handleRequest(req, res); });
    try {
      const address = await listen(server);
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const disabled = await fetch(`${baseUrl}/runs`, { method: "POST", body: "{}" });
      assert.equal(disabled.status, 503);

      process.env.KIMIFLARE_SERVER_PASSWORD = "test-only-password";
      const malformed = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "null",
      });
      assert.equal(malformed.status, 400);

      const invalidWorktree = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", worktree: "yes" }),
      });
      assert.equal(invalidWorktree.status, 400);

      const missingWorktreeCwd = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect" }),
      });
      assert.equal(missingWorktreeCwd.status, 400);

      const nonGitCwd = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir }),
      });
      assert.equal(nonGitCwd.status, 400);

      const unknownTool = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, allowedTools: ["unknown_tool"] }),
      });
      assert.equal(unknownTool.status, 400);

      const invalidLimit = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxToolIterations: 0 }),
      });
      assert.equal(invalidLimit.status, 400);

      const invalidTokenBudget = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxTotalTokens: 0 }),
      });
      assert.equal(invalidTokenBudget.status, 400);

      const invalidCostBudget = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, maxCostUsd: 0 }),
      });
      assert.equal(invalidCostBudget.status, 400);

      const configurableBudgets = await fetch(`${baseUrl}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "inspect", cwd: dir, worktree: false, allowedTools: ["unknown_tool"], maxToolIterations: 5001, maxRuntimeMs: 604_800_001, maxTotalTokens: 100_000_001, maxCostUsd: 10_001 }),
      });
      assert.equal(configurableBudgets.status, 400);
      assert.match((await configurableBudgets.json() as { error: string }).error, /unknown tool/);

      const store = new RunStore();
      let completedRunId: string;
      try {
        const run = store.createRun({ task: "Already completed", cwd: dir });
        store.transition(run.id, "running");
        store.transition(run.id, "completed");
        completedRunId = run.id;
      } finally { store.close(); }
      const notPaused = await fetch(`${baseUrl}/runs/${completedRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxRuntimeMs: null }),
      });
      assert.equal(notPaused.status, 409);

      const sessionId = "budget-resume-session";
      const timestamp = new Date().toISOString();
      await saveSession({ id: sessionId, cwd: dir, model: "moonshotai/kimi-k2.6", createdAt: timestamp, updatedAt: timestamp, messages: [
        { role: "system", content: "You are a test agent." },
        { role: "user", content: "Continue this task." },
      ] });
      const pausedStore = new RunStore();
      let pausedRunId: string;
      try {
        const run = pausedStore.createRun({ task: "Resume through API", cwd: dir, sessionId, maxTotalTokens: 1 });
        pausedStore.transition(run.id, "running");
        assert.equal(pausedStore.recordUsage(run.id, { promptTokens: 1, completionTokens: 0 }).run.status, "needs_input");
        pausedRunId = run.id;
      } finally { pausedStore.close(); }
      const resumed = await fetch(`${baseUrl}/runs/${pausedRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTotalTokens: null }),
      });
      assert.equal(resumed.status, 202);
      const resumeBody = await resumed.json() as { run: { status: string; maxTotalTokens: number | null } };
      assert.equal(resumeBody.run.status, "running");
      assert.equal(resumeBody.run.maxTotalTokens, null);

      // A context-overflow pause resumes on a larger-context model, without a budget change.
      const overflowStore = new RunStore();
      let overflowRunId: string;
      const overflowSession = "context-overflow-session";
      await saveSession({ id: overflowSession, cwd: dir, model: "moonshotai/kimi-k2.6", createdAt: timestamp, updatedAt: timestamp, messages: [
        { role: "system", content: "You are a test agent." },
        { role: "user", content: "Keep going." },
      ] });
      try {
        const run = overflowStore.createRun({ task: "Long task", cwd: dir, sessionId: overflowSession });
        overflowStore.transition(run.id, "running");
        overflowStore.transition(run.id, "needs_input", "context_budget_exceeded: the current turn needs ~215,000 tokens");
        overflowRunId = run.id;
      } finally { overflowStore.close(); }
      const badModel = await fetch(`${baseUrl}/runs/${overflowRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "" }),
      });
      assert.equal(badModel.status, 400);
      const switched = await fetch(`${baseUrl}/runs/${overflowRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "google/gemini-3.8-flash" }),
      });
      assert.equal(switched.status, 202, await switched.clone().text());
      const saved = await loadSession(join(sessionsDir(), `${overflowSession}.json`));
      assert.equal(saved?.model, "google/gemini-3.8-flash");
      assert.match(String(saved?.messages.at(-1)?.content), /context_budget_exceeded.*It now runs on google\/gemini-3\.8-flash\./);
    } finally {
      routes.cleanup();
      await close(server);
      restoreEnv("AUTOPILOT_RUNS_DB", oldRunsDb);
      restoreEnv("XDG_DATA_HOME", oldDataHome);
      restoreEnv("KIMIFLARE_SERVER_PASSWORD", oldPassword);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("unattended run whose active turn outgrows the context", () => {
  it("lands in needs_input with the diagnostic instead of failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autopilot-run-overflow-"));
    const saved = { runs: process.env.AUTOPILOT_RUNS_DB, data: process.env.XDG_DATA_HOME, pw: process.env.KIMIFLARE_SERVER_PASSWORD };
    process.env.AUTOPILOT_RUNS_DB = join(dir, "runs.db");
    process.env.XDG_DATA_HOME = join(dir, "data");
    process.env.KIMIFLARE_SERVER_PASSWORD = "test-only-password";
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
    // The overflow is detected before any request: no network call may happen.
    const realFetch = globalThis.fetch;
    let serverFetch: typeof fetch | null = realFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("http://127.0.0.1")) return serverFetch!(input, init);
      throw new Error(`unexpected network call: ${String(input)}`);
    }) as typeof fetch;
    // A small-window model makes a task under the 20,000-character limit overflow.
    registerOpenRouterModels([
      { id: "test/tiny-window", contextWindow: 4_000, maxOutputTokens: 1_000, pricing: { inputPerMtok: 1, outputPerMtok: 1 }, supports: { tools: true, reasoning: false, streaming: true } },
    ]);
    const routes = setupRoutes({ openrouterApiKey: "sk-or-test", model: "test/tiny-window", subagentPolicy: "off", memoryEnabled: false } as KimiConfig);
    const server = createServer((req, res) => { void routes.handleRequest(req, res); });
    try {
      const { port } = await listen(server);
      const huge = "Analyse every line of this log:\n" + "2026-10-20 INFO request ok path=/api/items status=200\n".repeat(340);
      const created = await serverFetch(`http://127.0.0.1:${port}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: huge, cwd: dir, worktree: false, allowedTools: ["read"] }),
      });
      assert.equal(created.status, 202, await created.clone().text());
      const { runId } = (await created.json()) as { runId: string };
      let status = "";
      let reason: string | null = null;
      for (let i = 0; i < 100 && status !== "needs_input" && status !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const store = new RunStore();
        try {
          const r = store.getRun(runId)!;
          status = r.status;
          reason = r.stopReason;
        } finally { store.close(); }
      }
      assert.equal(status, "needs_input", String(reason));
      assert.match(String(reason), /^context_budget_exceeded: the current turn needs ~[\d,]+ tokens but test\/tiny-window has [\d,]+ available/);
    } finally {
      globalThis.fetch = realFetch;
      serverFetch = null;
      routes.cleanup();
      await close(server);
      restoreEnv("AUTOPILOT_RUNS_DB", saved.runs);
      restoreEnv("XDG_DATA_HOME", saved.data);
      restoreEnv("KIMIFLARE_SERVER_PASSWORD", saved.pw);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("run admission: concurrency limit and operator kill switch", () => {
  it("refuses runs past the limit, and stop-all cancels everything until lifted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autopilot-run-admission-"));
    const saved = { runs: process.env.AUTOPILOT_RUNS_DB, data: process.env.XDG_DATA_HOME, pw: process.env.KIMIFLARE_SERVER_PASSWORD, max: process.env.AUTOPILOT_MAX_CONCURRENT_RUNS };
    process.env.AUTOPILOT_RUNS_DB = join(dir, "runs.db");
    process.env.XDG_DATA_HOME = join(dir, "data");
    process.env.KIMIFLARE_SERVER_PASSWORD = "test-only-password";
    process.env.AUTOPILOT_MAX_CONCURRENT_RUNS = "2";
    const routes = setupRoutes({} as KimiConfig);
    const server = createServer((req, res) => { void routes.handleRequest(req, res); });
    try {
      const { port } = await listen(server);
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: unknown = {}) =>
        fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const store = new RunStore();
      const ids: string[] = [];
      try {
        for (const task of ["one", "two"]) {
          const run = store.createRun({ task, cwd: dir });
          store.transition(run.id, "running");
          ids.push(run.id);
        }
        const waiting = store.createRun({ task: "three", cwd: dir });
        store.transition(waiting.id, "running");
        store.transition(waiting.id, "needs_input", "budget");
        ids.push(waiting.id);
      } finally { store.close(); }

      const full = await post("/runs", { task: "four", cwd: dir });
      assert.equal(full.status, 429);
      assert.match(((await full.json()) as { error: string }).error, /2 runs are already active \(limit 2/);

      const stopped = await post("/runs/stop-all", { reason: "deploying" });
      assert.equal(stopped.status, 200);
      const stopBody = (await stopped.json()) as { halted: boolean; cancelledRuns: string[] };
      assert.equal(stopBody.halted, true);
      assert.deepEqual([...stopBody.cancelledRuns].sort(), [...ids].sort());

      const check = new RunStore();
      try {
        for (const id of ids) assert.equal(check.getRun(id)!.status, "cancelled");
      } finally { check.close(); }

      const refused = await post("/runs", { task: "five", cwd: dir });
      assert.equal(refused.status, 503);
      assert.match(((await refused.json()) as { error: string }).error, /halted by the operator \(deploying\)/);

      const lifted = await fetch(`${base}/runs/stop-all`, { method: "DELETE" });
      assert.equal(lifted.status, 200);
      // Admission passes again (this one then fails validation: not a git repository).
      const after = await post("/runs", { task: "six", cwd: dir });
      assert.equal(after.status, 400);
    } finally {
      routes.cleanup();
      await close(server);
      restoreEnv("AUTOPILOT_RUNS_DB", saved.runs);
      restoreEnv("XDG_DATA_HOME", saved.data);
      restoreEnv("KIMIFLARE_SERVER_PASSWORD", saved.pw);
      restoreEnv("AUTOPILOT_MAX_CONCURRENT_RUNS", saved.max);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function listen(server: Server): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a TCP server address"));
        return;
      }
      resolve({ port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("UserPromptSubmit hooks on server prompts", () => {
  it("a blocking hook answers 403 prompt_blocked and starts no session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autopilot-prompt-hook-"));
    const oldConfigHome = process.env.XDG_CONFIG_HOME;
    const oldDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_CONFIG_HOME = join(dir, "config");
    process.env.XDG_DATA_HOME = join(dir, "data");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "config", "autopilot"), { recursive: true });
    await writeFile(
      join(dir, "config", "autopilot", "settings.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ id: "no-deploy", command: "echo 'no deploys from here' >&2; exit 2" }] } }),
    );
    const routes = setupRoutes({ model: "moonshotai/kimi-k2.6" } as KimiConfig);
    const server = createServer((req, res) => { void routes.handleRequest(req, res); });
    try {
      const { port } = await listen(server);
      const res = await fetch(`http://127.0.0.1:${port}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "deploy to prod", cwd: dir }),
      });
      assert.equal(res.status, 403);
      const body = (await res.json()) as { error: string; reason: string };
      assert.equal(body.error, "prompt_blocked");
      assert.match(body.reason, /no deploys from here/);
      const list = (await (await fetch(`http://127.0.0.1:${port}/session`)).json()) as unknown;
      assert.equal(JSON.stringify(list).includes("deploy-to-prod"), false, "no session was started");
    } finally {
      await close(server);
      await routes.cleanup();
      restoreEnv("XDG_CONFIG_HOME", oldConfigHome);
      restoreEnv("XDG_DATA_HOME", oldDataHome);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
