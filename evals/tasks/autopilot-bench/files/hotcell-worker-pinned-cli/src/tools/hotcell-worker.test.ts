import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  getCleanRepository,
  resolveWorkerPackage,
  parseCellId,
  parseNamedCellId,
  parseHotcellStats,
  runHotcellWorker,
  shellQuote,
  type HotcellProcessResult,
  type HotcellProcessRunner,
} from "./hotcell-worker.js";

const directories: string[] = [];
const cellId = "12345678-1234-1234-1234-123456789abc";

async function makeRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "autopilot-hotcell-test-"));
  directories.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  await writeFile(join(cwd, "README.md"), "test repo\n");
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/project.git"], { cwd });
  // Simulate a pushed branch: the commit is on a remote-tracking ref.
  execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
  return cwd;
}

function fakeRunner(options: {
  createOutput?: string;
  createCode?: number;
  createStderr?: string;
  createTimedOut?: boolean;
  workerCode?: number;
  workerStderr?: string;
  cleanupCode?: number;
  listOutput?: string;
  onExec?: (signal?: AbortSignal) => void;
  calls?: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }>;
} = {}): HotcellProcessRunner {
  return async (_executable, args, runOptions): Promise<HotcellProcessResult> => {
    options.calls?.push({ args, options: runOptions });
    if (args[0] === "create") return {
      code: options.createCode ?? 0,
      stdout: options.createOutput ?? `Created sandbox ${cellId}\n`,
      stderr: options.createStderr ?? "",
      aborted: options.createTimedOut ?? false,
      timedOut: options.createTimedOut,
    };
    if (args[0] === "ls") return { code: 0, stdout: options.listOutput ?? "", stderr: "", aborted: false };
    if (args[0] === "exec" && args[2]?.includes("npm install --prefix")) {
      return { code: 0, stdout: "", stderr: "", aborted: false };
    }
    if (args[0] === "exec") {
      options.onExec?.(runOptions.signal);
      return {
        code: options.workerCode ?? 0,
        stdout: JSON.stringify({ text: "Found a useful result.", usage: { totalTokens: 15 } }),
        stderr: options.workerStderr ?? "",
        aborted: options.workerCode === 130,
      };
    }
    if (args[0] === "stats") {
      return { code: 0, stdout: "  LLM:   2 calls, 10 in + 5 out tokens, $0.0130\n  Cost:  0.013010 (cpu 0.0001)\n", stderr: "", aborted: false };
    }
    if (args[0] === "rm") return { code: options.cleanupCode ?? 0, stdout: "", stderr: "", aborted: false };
    return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Hotcell worker helpers", () => {
  it("parses cell IDs, Hotcell metrics, and safely quotes shell values", () => {
    assert.equal(parseCellId(`created ${cellId}`), cellId);
    assert.equal(parseCellId("Created sandbox hc_ab12cd34ef56\nOPENROUTER_BASE_URL=http://gateway"), "hc_ab12cd34ef56");
    assert.equal(parseNamedCellId("ID NAME IMAGE STATUS\n12345678 autopilot-worker image error", "autopilot-worker"), "12345678");
    assert.equal(parseNamedCellId("ID NAME IMAGE STATUS\n12345678 unrelated image error", "autopilot-worker"), undefined);
    assert.deepEqual(parseHotcellStats("LLM: 2 calls, 1,000 in + 500 out tokens, $0.13\nCost: 0.140000"), {
      tokensUsed: 1500,
      costUsd: 0.14,
    });
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
  });

  it("requires a clean repository with a credential-free origin", async () => {
    const cwd = await makeRepo();
    const repo = await getCleanRepository(cwd);
    assert.match(repo.commit, /^[0-9a-f]{40}$/);
    assert.equal(repo.url, "https://github.com/example/project.git");
    await writeFile(join(cwd, "dirty.txt"), "uncommitted");
    await assert.rejects(() => getCleanRepository(cwd), /clean Git checkout/);
  });

  it("requires HEAD to be pushed before creating any cell", async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, "local.txt"), "local only\n");
    execFileSync("git", ["add", "local.txt"], { cwd });
    execFileSync("git", ["commit", "-qm", "unpushed"], { cwd });
    await assert.rejects(() => getCleanRepository(cwd), /not on any remote-tracking branch.*git push/s);

    let processCalls = 0;
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: async () => {
        processCalls++;
        return { code: 0, stdout: "", stderr: "", aborted: false };
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /git push/);
    assert.equal(processCalls, 0, "no cell is created for an unpushed commit");
  });

  it("pins the worker CLI to the coordinator version unless overridden", () => {
    const previous = process.env.KIMIFLARE_WORKER_PACKAGE;
    delete process.env.KIMIFLARE_WORKER_PACKAGE;
    try {
      assert.match(resolveWorkerPackage(), /^autopilot-ai@\d+\.\d+\.\d+/);
      process.env.KIMIFLARE_WORKER_PACKAGE = "autopilot-ai@next";
      assert.equal(resolveWorkerPackage(), "autopilot-ai@next");
      assert.equal(resolveWorkerPackage("https://example.com/autopilot-ai-1.0.0.tgz"), "https://example.com/autopilot-ai-1.0.0.tgz");
      assert.throws(() => resolveWorkerPackage("autopilot-ai; rm -rf /"), /Invalid Hotcell worker package/);
    } finally {
      if (previous === undefined) delete process.env.KIMIFLARE_WORKER_PACKAGE;
      else process.env.KIMIFLARE_WORKER_PACKAGE = previous;
    }
  });

  it("creates a capped cell at the pinned revision, uses the exact model, and always removes it", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Inspect the repository",
      context: "Only inspect committed files",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ calls }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.model, "openai/gpt-6-luna");
    assert.equal(result.tokensUsed, 15);
    assert.equal(result.costUsd, 0.01301);
    assert.ok(calls[0]!.args.includes("--egress-spend-cap"));
    assert.ok(calls[0]!.args.includes("0.25"));
    assert.ok(calls[0]!.args.includes("--ref"));
    const repo = await getCleanRepository(cwd);
    const createArgs = calls[0]!.args;
    assert.equal(createArgs[createArgs.indexOf("--ref") + 1], repo.ref);
    assert.equal(createArgs[createArgs.indexOf("--ref") + 1], repo.ref);
    assert.ok(!createArgs.includes("--setup"), "mandatory setup runs in exec so errors are not swallowed by Hotcell's best-effort setup hook");
    assert.deepEqual(calls.map((call) => call.args[0]), ["create", "exec", "exec", "stats", "rm"]);

    // Setup exec: pinned checkout plus a private install of the worker CLI.
    const setup = calls[1]!.args[2]!;
    assert.ok(setup.includes('find /workspace -mindepth 2 -maxdepth 5 -name .git'));
    assert.ok(setup.includes(`git -C "$REPO_ROOT" fetch --quiet origin '${repo.commit}'`));
    assert.ok(setup.includes(`git -C "$REPO_ROOT" checkout --quiet --detach '${repo.commit}'`));
    assert.match(setup, /npm install --prefix \/tmp\/autopilot-worker .*'autopilot-ai@\d+\.\d+\.\d+'/);
    assert.equal(calls[1]!.options.timeoutMs, 300_000, "setup has its own timeout");

    // Research exec: runs the installed CLI from the target repo, never the repo's own code or install.
    const command = calls[2]!.args[2]!;
    for (const text of [setup, command]) {
      assert.ok(!text.includes("npm ci"), "target repo dependencies are never installed");
      assert.ok(!text.includes("src/index.tsx"), "target repo is not assumed to be Autopilot");
    }
    assert.ok(command.includes('cd "$REPO_ROOT"'));
    assert.ok(command.includes("/tmp/autopilot-worker/node_modules/.bin/autopilot --format json"));
    assert.match(command, /--model 'openai\/gpt-6-luna'/);
    assert.match(command, /--worker-profile research/);
    assert.ok(!command.includes("Inspect the repository"), "mission should not be interpolated as shell text");
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("recovers a successfully created cell by name when create output omits its ID", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    let cellName = "";
    const runner: HotcellProcessRunner = async (_executable, args, options) => {
      calls.push({ args, options });
      if (args[0] === "create") {
        cellName = args[args.indexOf("--name") + 1]!;
        return { code: 0, stdout: "created successfully", stderr: "", aborted: false };
      }
      if (args[0] === "ls") {
        return { code: 0, stdout: `ID NAME IMAGE STATUS\n${cellId} ${cellName} image running`, stderr: "", aborted: false };
      }
      if (args[0] === "exec") {
        return { code: 0, stdout: JSON.stringify({ text: "Recovered by name." }), stderr: "", aborted: false };
      }
      if (args[0] === "stats") return { code: 0, stdout: "Cost: 0.01", stderr: "", aborted: false };
      if (args[0] === "rm") return { code: 0, stdout: "", stderr: "", aborted: false };
      return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
    };
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: runner,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls.map((call) => call.args[0]), ["create", "ls", "exec", "exec", "stats", "rm"]);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("cleans a named cell after setup failure and redacts diagnostics", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    let cellName = "";
    const runner: HotcellProcessRunner = async (_executable, args, options) => {
      calls.push({ args, options });
      if (args[0] === "create") {
        cellName = args[args.indexOf("--name") + 1]!;
        return { code: 1, stdout: "", stderr: "setup failed OPENROUTER_API_KEY=do-not-leak", aborted: false };
      }
      if (args[0] === "ls") {
        return { code: 0, stdout: `ID NAME IMAGE STATUS\n${cellId} ${cellName} image error`, stderr: "", aborted: false };
      }
      if (args[0] === "rm") return { code: 0, stdout: "", stderr: "", aborted: false };
      return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
    };
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: runner,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /setup failed/);
    assert.doesNotMatch(result.error ?? "", /do-not-leak|OPENROUTER_API_KEY/);
    assert.deepEqual(calls.map((call) => call.args[0]), ["create", "ls", "rm"]);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("rejects an invalid model before creating a cell", async () => {
    const cwd = await makeRepo();
    let processCalls = 0;
    await assert.rejects(() => runHotcellWorker({
      task: "Research",
      model: "not a model",
      budgetUsd: 0.25,
      cwd,
      processRunner: async () => {
        processCalls++;
        return { code: 0, stdout: "", stderr: "", aborted: false };
      },
    }), /Invalid model ID/);
    assert.equal(processCalls, 0);
  });

  it("reports a missing OpenRouter route and removes the created cell", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ createOutput: `Created ${cellId} (no providers configured)`, calls }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /OpenRouter gateway route/);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("reports setup timeout separately and removes a partially created cell", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ createTimedOut: true, calls }),
    });
    assert.equal(result.status, "timed_out");
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("reports worker setup failure and timeout distinctly, then removes the cell", async () => {
    const cwd = await makeRepo();
    for (const [setupResult, status, pattern] of [
      [{ code: 1, stdout: "", stderr: "npm ERR! 404 autopilot-ai@9.9.9 OPENROUTER_API_KEY=do-not-leak", aborted: false }, "failed", /Worker setup failed \(exit 1\).*404/s],
      [{ code: 124, stdout: "", stderr: "", aborted: true, timedOut: true }, "timed_out", /setup .*timed out/],
    ] as const) {
      const calls: string[][] = [];
      const runner: HotcellProcessRunner = async (_executable, args) => {
        calls.push(args);
        if (args[0] === "create") return { code: 0, stdout: cellId, stderr: "", aborted: false };
        if (args[0] === "exec") return setupResult;
        if (args[0] === "rm") return { code: 0, stdout: "", stderr: "", aborted: false };
        return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
      };
      const result = await runHotcellWorker({ task: "Research", model: "openai/gpt-6-luna", budgetUsd: 0.25, cwd, processRunner: runner });
      assert.equal(result.status, status);
      assert.match(result.error ?? "", pattern);
      assert.doesNotMatch(result.error ?? "", /do-not-leak/);
      assert.deepEqual(calls.map((args) => args[0]), ["create", "exec", "rm"], "research never runs after failed setup");
    }
  });

  it("runs two workers concurrently in separate cells and removes both", async () => {
    const cwd = await makeRepo();
    let activeCells = 0;
    let maxActiveCells = 0;
    let created = 0;
    const runner: HotcellProcessRunner = async (_executable, args) => {
      if (args[0] === "create") {
        created++;
        activeCells++;
        maxActiveCells = Math.max(maxActiveCells, activeCells);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        const id = created === 1 ? "11111111-1111-1111-1111-111111111111" : "22222222-2222-2222-2222-222222222222";
        return { code: 0, stdout: id, stderr: "", aborted: false };
      }
      if (args[0] === "exec") {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
        return { code: 0, stdout: JSON.stringify({ text: "done" }), stderr: "", aborted: false };
      }
      if (args[0] === "stats") return { code: 0, stdout: "Cost: 0.01", stderr: "", aborted: false };
      if (args[0] === "rm") {
        activeCells--;
        return { code: 0, stdout: "", stderr: "", aborted: false };
      }
      return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
    };
    const results = await Promise.all([1, 2].map((n) => runHotcellWorker({
      task: `Research task ${n}`,
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      maxParallel: 2,
      cwd,
      processRunner: runner,
    })));
    assert.equal(results.length, 2);
    assert.ok(results.every((result) => result.status === "completed"));
    assert.equal(maxActiveCells, 2);
    assert.equal(activeCells, 0);
  });

  it("reports budget exhaustion as partial and cleans up after a non-zero agent exit", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ workerCode: 42, calls }),
    });
    assert.equal(result.status, "budget_exhausted");
    assert.equal(result.partialResult, true);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("surfaces sanitized stderr for worker process failures", async () => {
    const cwd = await makeRepo();
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ workerCode: 1, workerStderr: "autopilot: command not found OPENROUTER_API_KEY=do-not-leak" }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /autopilot: command not found/);
    assert.doesNotMatch(result.error ?? "", /do-not-leak|OPENROUTER_API_KEY/);
  });

  it("maps Hotcell gateway spend-cap responses distinctly", async () => {
    const cwd = await makeRepo();
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ workerCode: 1, workerStderr: "HTTP 402: spend cap reached" }),
    });
    assert.equal(result.status, "spend_exhausted");
    assert.equal(result.budgetExceeded, true);
    assert.match(result.error ?? "", /spend cap/);
  });

  it("maps cancellation distinctly and still destroys the cell", async () => {
    const cwd = await makeRepo();
    const controller = new AbortController();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      signal: controller.signal,
      processRunner: fakeRunner({ calls, onExec: () => controller.abort(), workerCode: 130 }),
    });
    assert.equal(result.status, "cancelled");
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("surfaces cleanup failure rather than reporting a successful worker", async () => {
    const cwd = await makeRepo();
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      budgetUsd: 0.25,
      cwd,
      processRunner: fakeRunner({ cleanupCode: 1 }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /cleanup failed/);
  });
});
