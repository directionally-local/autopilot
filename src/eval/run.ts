/**
 * Headless eval runner (plan §4.3): run Autopilot on every task × sample
 * under one harness configuration, write one trace per run with a
 * `test_verdict`, and append a line per run to `<out>/results.jsonl`.
 *
 * Harness failures (crash, timeout) are recorded as `passed: false` with an
 * `error`; the runner never aborts the set for one task.
 */

import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { KimiConfig } from "../config.js";
import { redactConfig } from "../trace/redact.js";
import type { TraceEvent } from "../trace/types.js";
import { loadEvalConfig, type EvalConfig } from "./config.js";
import { DEFAULT_TASK_TIMEOUT_S, loadTasks, type LoadedEvalTask } from "./tasks.js";
import { createWorktree, prepareSourceRepo, removeWorktree, type EvalWorktree } from "./workspace.js";

export interface RunEvalOptions {
  tasksDir: string;
  configFile: string;
  /** Overrides the config file's model. */
  model?: string;
  samples?: number;
  out: string;
  concurrency?: number;
  /** Glob over task ids. */
  filter?: string;
  /** Stop scheduling new runs once cumulative cost reaches this (USD). */
  maxCostUsd?: number;
  /** Keep worktrees after each run. */
  keep?: boolean;
  /** Hook for progress lines; defaults to stderr. */
  log?: (line: string) => void;
  /** Test seam: replaces the SDK session factory. */
  createSession?: typeof import("../sdk/session.js").createAgentSession;
}

export interface EvalResultLine {
  task_id: string;
  sample: number;
  config: string;
  model: string;
  passed: boolean;
  error?: string;
  exit_code: number | null;
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Model calls made by the agent. */
  turns: number;
  tool_calls: number;
  /** True when a ContextBudgetError ended the run. */
  overflow: boolean;
  duration_ms: number;
  trace_dir: string;
  session_id: string;
}

export interface RunEvalSummary {
  out: string;
  results: EvalResultLine[];
  resultsFile: string;
  /** True when `maxCostUsd` stopped the run before every job was scheduled. */
  budgetExhausted: boolean;
}

const TEST_LOG_CAP = 1024 * 1024;

interface ShellResult {
  exitCode: number | null;
  log: string;
  timedOut: boolean;
}

/** Run a shell command in `cwd`, capturing combined output (capped) with a wall-clock limit. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolveShell) => {
    const child = spawn(process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : "bash", [process.platform === "win32" ? "/c" : "-lc", command], {
      cwd,
      env: { ...process.env, CI: "1", GIT_EDITOR: "true" },
    });
    child.stdin?.end();
    let log = "";
    let timedOut = false;
    const push = (chunk: Buffer) => {
      if (log.length < TEST_LOG_CAP) log += chunk.toString("utf8").slice(0, TEST_LOG_CAP - log.length);
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolveShell({ exitCode: null, log: `${log}\n${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveShell({ exitCode: code, log, timedOut });
    });
  });
}

async function copyTaskFiles(task: LoadedEvalTask, worktree: string): Promise<void> {
  for (const [dest, src] of Object.entries(task.resolvedFiles)) {
    const target = join(worktree, dest);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(src, target);
  }
}

/** Aggregate a run's trace into the numbers reported in results.jsonl. `overflow`
 *  is decided by the runner from the error the SDK raised; it is false here. */
export async function summarizeTrace(traceFile: string): Promise<{
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  turns: number;
  tool_calls: number;
  overflow: boolean;
}> {
  const out = { cost_usd: 0, prompt_tokens: 0, completion_tokens: 0, turns: 0, tool_calls: 0, overflow: false };
  let raw: string;
  try {
    raw = await readFile(traceFile, "utf8");
  } catch {
    return out;
  }
  const requests = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: TraceEvent;
    try {
      e = JSON.parse(line) as TraceEvent;
    } catch {
      continue;
    }
    if (e.type === "llm_request") requests.add(e.payload.request_id);
    else if (e.type === "llm_response") {
      const u = e.payload.usage;
      if (u) {
        out.prompt_tokens += u.prompt_tokens;
        out.completion_tokens += u.completion_tokens;
        if (typeof u.cost === "number") out.cost_usd += u.cost;
      }
    } else if (e.type === "tool_call") out.tool_calls++;
  }
  out.turns = requests.size;
  return out;
}

function sessionIdFor(runName: string, task: LoadedEvalTask, sample: number): string {
  return `eval-${runName}-${task.id}-${sample}`.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

async function runOne(
  task: LoadedEvalTask,
  sample: number,
  ctx: {
    runName: string;
    evalConfig: EvalConfig;
    model: string;
    out: string;
    tracesRoot: string;
    keep: boolean;
    log: (line: string) => void;
    createSession: NonNullable<RunEvalOptions["createSession"]>;
  },
): Promise<EvalResultLine> {
  const startedAt = performance.now();
  const sessionId = sessionIdFor(ctx.runName, task, sample);
  const traceDir = join(ctx.tracesRoot, sessionId);
  const base: EvalResultLine = {
    task_id: task.id,
    sample,
    config: ctx.evalConfig.name,
    model: ctx.model,
    passed: false,
    exit_code: null,
    cost_usd: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    turns: 0,
    tool_calls: 0,
    overflow: false,
    duration_ms: 0,
    trace_dir: traceDir,
    session_id: sessionId,
  };
  const finish = (patch: Partial<EvalResultLine>): EvalResultLine => ({
    ...base,
    ...patch,
    duration_ms: Math.round(performance.now() - startedAt),
  });

  let worktree: EvalWorktree | null = null;
  try {
    const sourceRepo = await prepareSourceRepo(task.repo, join(ctx.out, "cache"));
    worktree = await createWorktree(sourceRepo, task.base_commit, join(ctx.out, "work", task.id, String(sample)));
    await copyTaskFiles(task, worktree.path);
    const timeoutMs = (task.timeout_s ?? DEFAULT_TASK_TIMEOUT_S) * 1000;

    if (task.setup) {
      ctx.log(`[${task.id}#${sample}] setup`);
      const setup = await runShell(task.setup, worktree.path, timeoutMs);
      if (setup.exitCode !== 0) {
        await writeFile(join(worktree.path, ".eval-setup.log"), setup.log, "utf8").catch(() => undefined);
        return finish({ error: `setup failed (exit ${setup.exitCode}${setup.timedOut ? ", timed out" : ""}): ${setup.log.slice(-500)}` });
      }
    }

    ctx.log(`[${task.id}#${sample}] agent (${ctx.model})`);
    const config: Partial<KimiConfig> = {
      ...ctx.evalConfig.config,
      model: ctx.model,
      trace: { enabled: true, root: ctx.tracesRoot },
    };
    const { session } = await ctx.createSession({ cwd: worktree.path, sessionId, config, memoryEnabled: false, lspEnabled: false });
    let agentError: string | undefined;
    let overflow = false;
    const agentStartedAt = performance.now();
    const timer = setTimeout(() => {
      agentError = `agent timed out after ${timeoutMs} ms`;
      void session.abort();
    }, timeoutMs);
    try {
      await session.prompt(task.prompt, { mode: "auto" });
    } catch (err) {
      const e = err as Error;
      if (e.name === "ContextBudgetError") overflow = true;
      if (!agentError) agentError = `${e.name}: ${e.message}`;
    } finally {
      clearTimeout(timer);
    }
    const agentMs = Math.round(performance.now() - agentStartedAt);

    // The verified files are restored so the agent cannot have changed them.
    await copyTaskFiles(task, worktree.path);
    ctx.log(`[${task.id}#${sample}] test`);
    const testStartedAt = performance.now();
    const test = await runShell(task.test, worktree.path, timeoutMs);
    const testMs = Math.round(performance.now() - testStartedAt);
    const passed = test.exitCode === 0 && !test.timedOut;
    await mkdir(traceDir, { recursive: true }).catch(() => undefined);
    await writeFile(join(traceDir, "test.log"), test.log, "utf8").catch(() => undefined);
    if (session.trace.enabled) {
      session.trace.emit(
        "outcome",
        {
          kind: "test_verdict",
          task_id: task.id,
          passed,
          command: task.test,
          exit_code: test.exitCode ?? -1,
          duration_ms: testMs,
          log_blob: session.trace.blob(test.log) ?? "",
        },
        null,
      );
    }
    session.dispose({ traceEndReason: "eval_done" });
    await session.trace.flush();

    const stats = await summarizeTrace(join(traceDir, "trace.jsonl"));
    ctx.log(`[${task.id}#${sample}] ${passed ? "PASS" : "FAIL"} in ${agentMs + testMs} ms${agentError ? ` (${agentError.slice(0, 120)})` : ""}`);
    return finish({
      passed,
      exit_code: test.exitCode,
      ...(agentError ? { error: agentError } : {}),
      ...stats,
      overflow: overflow || stats.overflow,
    });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.log(`[${task.id}#${sample}] harness error: ${message.slice(0, 200)}`);
    return finish({ error: message });
  } finally {
    if (worktree && !ctx.keep) await removeWorktree(worktree).catch(() => undefined);
  }
}

/** Run every task × sample with bounded concurrency; returns the result lines in completion order. */
export async function runEval(opts: RunEvalOptions): Promise<RunEvalSummary> {
  const out = resolve(opts.out);
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const evalConfig = await loadEvalConfig(opts.configFile);
  const model = opts.model ?? evalConfig.model;
  if (!model) throw new Error("no model: pass --model or set \"model\" in the eval config");
  const tasks = await loadTasks(opts.tasksDir, opts.filter);
  if (tasks.length === 0) throw new Error(`no tasks in ${opts.tasksDir}${opts.filter ? ` matching ${opts.filter}` : ""}`);
  const samples = Math.max(1, Math.floor(opts.samples ?? 1));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const createSession = opts.createSession ?? (await import("../sdk/session.js")).createAgentSession;

  await mkdir(out, { recursive: true });
  const tracesRoot = join(out, "traces");
  const runName = evalConfig.name;
  const resultsFile = join(out, "results.jsonl");
  await writeFile(
    join(out, "config.json"),
    JSON.stringify({ name: evalConfig.name, model, temperature: evalConfig.temperature ?? null, config: redactConfig(evalConfig.config), tasks: opts.tasksDir, samples, started_at: new Date().toISOString() }, null, 2),
    "utf8",
  );

  const jobs: Array<{ task: LoadedEvalTask; sample: number }> = [];
  for (const task of tasks) for (let n = 0; n < samples; n++) jobs.push({ task, sample: n });
  log(`eval ${runName}: ${tasks.length} task(s) × ${samples} sample(s) on ${model}, concurrency ${concurrency}, out ${out}`);

  const results: EvalResultLine[] = [];
  let next = 0;
  let spent = 0;
  let budgetExhausted = false;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      if (opts.maxCostUsd !== undefined && spent >= opts.maxCostUsd) {
        budgetExhausted = true;
        return;
      }
      const job = jobs[next++]!;
      const line = await runOne(job.task, job.sample, { runName, evalConfig, model, out, tracesRoot, keep: opts.keep === true, log, createSession });
      spent += line.cost_usd;
      results.push(line);
      await appendFile(resultsFile, JSON.stringify(line) + "\n", "utf8");
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));

  if (budgetExhausted) {
    log(`eval ${runName}: budget cap $${opts.maxCostUsd} reached after ${results.length}/${jobs.length} runs`);
  }
  const passed = results.filter((r) => r.passed).length;
  log(`eval ${runName}: ${passed}/${results.length} passed; results in ${resultsFile}`);
  return { out, results, resultsFile, budgetExhausted };
}
