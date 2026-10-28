import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { getRepositorySnapshot } from "./hotcell-snapshot.js";
import {
  parseWorkerReport,
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
// These tests cover the install path; the runtime cache has its own tests.
let savedCacheEnv: string | undefined;
before(() => {
  savedCacheEnv = process.env.KIMIFLARE_WORKER_CACHE;
  process.env.KIMIFLARE_WORKER_CACHE = "0";
  // These tests cover the clone path; archive mode has its own tests below.
  process.env.KIMIFLARE_WORKER_ARCHIVE = "0";
});
after(() => {
  if (savedCacheEnv === undefined) delete process.env.KIMIFLARE_WORKER_CACHE;
  else process.env.KIMIFLARE_WORKER_CACHE = savedCacheEnv;
  delete process.env.KIMIFLARE_WORKER_ARCHIVE;
});
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
    if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
    if (args[0] === "create") return {
      code: options.createCode ?? 0,
      stdout: options.createOutput ?? `Created sandbox ${cellId}\n`,
      stderr: options.createStderr ?? "",
      aborted: options.createTimedOut ?? false,
      timedOut: options.createTimedOut,
    };
    if (args[0] === "ls") return { code: 0, stdout: options.listOutput ?? "", stderr: "", aborted: false };
    if (args[0] === "exec" && !args[2]?.includes("--format json")) {
      return { code: 0, stdout: "", stderr: "", aborted: false }; // locate / setup
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

  it("requires a credential-free origin the daemon can clone", async () => {
    const cwd = await makeRepo();
    execFileSync("git", ["remote", "set-url", "origin", "https://user:token@github.com/example/project.git"], { cwd });
    await assert.rejects(() => getRepositorySnapshot(cwd), /credential-free/);
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

  it("creates a cell without a spend cap at the pinned revision and always removes it", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Inspect the repository",
      context: "Only inspect committed files",
      model: "openai/gpt-6-luna",
      cwd,
      processRunner: fakeRunner({ calls }),
    });

    assert.equal(result.status, "completed");
    assert.equal(result.model, "openai/gpt-6-luna");
    assert.equal(result.tokensUsed, 15);
    assert.equal(result.costUsd, 0.01301);
    assert.deepEqual(calls[0]!.args, ["start", "--defaults"]);
    assert.equal(calls[0]!.options.timeoutMs, 30_000);
    assert.ok(calls[1]!.args.includes("--egress"));
    assert.ok(!calls[1]!.args.includes("--egress-spend-cap"));
    assert.ok(calls[1]!.args.includes("--ref"));
    const repo = await getRepositorySnapshot(cwd);
    const createArgs = calls[1]!.args;
    assert.equal(createArgs[createArgs.indexOf("--ref") + 1], repo.ref);
    assert.ok(!createArgs.includes("--setup"), "mandatory setup runs in exec so errors are not swallowed by Hotcell's best-effort setup hook");
    assert.deepEqual(calls.map((call) => call.args[0]), ["start", "create", "exec", "exec", "exec", "stats", "rm"]);

    // Locate exec: records the clone, skipping the runtime directory.
    const locate = calls[2]!.args[2]!;
    assert.ok(locate.includes("-path /workspace/.autopilot-worker -prune -o -name .git"));
    assert.ok(locate.includes("/tmp/autopilot-repo-root"));

    // Setup exec: pinned checkout plus a private install of the worker CLI.
    const setup = calls[3]!.args[2]!;
    assert.ok(setup.includes(`git -C "$REPO_ROOT" fetch --quiet origin '${repo.commit}'`));
    assert.ok(setup.includes(`git -C "$REPO_ROOT" checkout --quiet --detach '${repo.commit}'`));
    assert.match(setup, /npm install --prefix \/workspace\/.autopilot-worker .*'autopilot-ai@\d+\.\d+\.\d+'/);
    assert.equal(calls[3]!.options.timeoutMs, 300_000, "setup has its own timeout");

    // Research exec: runs the installed CLI from the target repo, never the repo's own code or install.
    const command = calls[4]!.args[2]!;
    for (const text of [setup, command]) {
      assert.ok(!text.includes("npm ci"), "target repo dependencies are never installed");
      assert.ok(!text.includes("src/index.tsx"), "target repo is not assumed to be Autopilot");
    }
    assert.ok(command.includes('cd "$REPO_ROOT"'));
    assert.ok(command.includes("/workspace/.autopilot-worker/node_modules/.bin/autopilot --format json"));
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
      if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
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
      cwd,
      processRunner: runner,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(calls.map((call) => call.args[0]), ["start", "create", "ls", "exec", "exec", "exec", "stats", "rm"]);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("cleans a named cell after setup failure and redacts diagnostics", async () => {
    const cwd = await makeRepo();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    let cellName = "";
    const runner: HotcellProcessRunner = async (_executable, args, options) => {
      calls.push({ args, options });
      if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
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
      cwd,
      processRunner: runner,
    });

    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /setup failed/);
    assert.doesNotMatch(result.error ?? "", /do-not-leak|OPENROUTER_API_KEY/);
    assert.deepEqual(calls.map((call) => call.args[0]), ["start", "create", "ls", "rm"]);
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("fails clearly when the Hotcell daemon cannot start and does not create a cell", async () => {
    const cwd = await makeRepo();
    const calls: string[][] = [];
    const runner: HotcellProcessRunner = async (_executable, args) => {
      calls.push(args);
      return { code: args[0] === "start" ? 1 : 0, stdout: "", stderr: args[0] === "start" ? "Docker is not running" : "", aborted: false };
    };
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      cwd,
      processRunner: runner,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /daemon startup failed.*Docker is not running/);
    assert.deepEqual(calls, [["start", "--defaults"]]);
  });

  it("rejects an invalid model before creating a cell", async () => {
    const cwd = await makeRepo();
    let processCalls = 0;
    await assert.rejects(() => runHotcellWorker({
      task: "Research",
      model: "not a model",
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
      cwd,
      processRunner: fakeRunner({ createTimedOut: true, calls }),
    });
    assert.equal(result.status, "timed_out");
    assert.deepEqual(calls.at(-1)?.args, ["rm", cellId]);
  });

  it("reports worker setup failure and timeout distinctly, then removes the cell", async () => {
    const cwd = await makeRepo();
    for (const [setupResult, status, pattern] of [
      [{ code: 1, stdout: "", stderr: "npm ERR! 404 autopilot-ai@9.9.9 OPENROUTER_API_KEY=do-not-leak", aborted: false }, "failed", /Subagent setup failed \(exit 1\).*404/s],
      [{ code: 124, stdout: "", stderr: "", aborted: true, timedOut: true }, "timed_out", /setup timed out/],
    ] as const) {
      const calls: string[][] = [];
      const runner: HotcellProcessRunner = async (_executable, args) => {
        calls.push(args);
        if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
        if (args[0] === "create") return { code: 0, stdout: cellId, stderr: "", aborted: false };
        if (args[0] === "exec") return setupResult;
        if (args[0] === "rm") return { code: 0, stdout: "", stderr: "", aborted: false };
        return { code: 1, stdout: "", stderr: "unexpected command", aborted: false };
      };
      const result = await runHotcellWorker({ task: "Research", model: "openai/gpt-6-luna", cwd, processRunner: runner });
      assert.equal(result.status, status);
      assert.match(result.error ?? "", pattern);
      assert.doesNotMatch(result.error ?? "", /do-not-leak/);
      assert.deepEqual(calls.map((args) => args[0]), ["start", "create", "exec", "rm"], "research never runs after failed setup");
    }
  });

  it("runs two workers concurrently in separate cells and removes both", async () => {
    const cwd = await makeRepo();
    let activeCells = 0;
    let maxActiveCells = 0;
    let created = 0;
    const runner: HotcellProcessRunner = async (_executable, args) => {
      if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
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
      cwd,
      processRunner: fakeRunner({ workerCode: 1, workerStderr: "HTTP 402: egress spend cap exceeded" }),
    });
    assert.equal(result.status, "spend_exhausted");
    assert.equal(result.budgetExceeded, true);
    assert.equal(result.partialResult, true);
    assert.ok(result.findings.length > 0, "findings produced before the cap should be retained");
    assert.match(result.error ?? "", /spend cap/);
  });

  it("does not classify unrelated HTTP 402 errors as spend-cap exhaustion", async () => {
    const cwd = await makeRepo();
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
      cwd,
      processRunner: fakeRunner({ workerCode: 1, workerStderr: "HTTP 402: payment required" }),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.budgetExceeded, undefined);
    assert.match(result.error ?? "", /HTTP 402: payment required/);
  });

  it("maps cancellation distinctly and still destroys the cell", async () => {
    const cwd = await makeRepo();
    const controller = new AbortController();
    const calls: Array<{ args: string[]; options: { cwd: string; signal?: AbortSignal; timeoutMs: number } }> = [];
    const result = await runHotcellWorker({
      task: "Research",
      model: "openai/gpt-6-luna",
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
      cwd,
      processRunner: fakeRunner({ cleanupCode: 1 }),
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /cleanup failed/);
  });


  it("parses the worker's trailing JSON report with bounds", () => {
    const text = [
      "Here is an early example:",
      "```json",
      '{"findings":[{"topic":"ignored","summary":"earlier block"}]}',
      "```",
      "Final report:",
      "```json",
      JSON.stringify({
        findings: [
          { topic: "Auth flow", summary: "Tokens refresh in src/auth.ts.", files: ["src/auth.ts:42", 7], confidence: "high" },
          { topic: "No summary" },
          { summary: "x".repeat(5_000), confidence: "certain" },
        ],
        openQuestions: ["Is the cache shared?"],
        filesRead: ["src/auth.ts"],
      }),
      "```",
    ].join("\n");
    const report = parseWorkerReport(text)!;
    assert.equal(report.findings.length, 2, "last block wins; entries without a summary are dropped");
    assert.deepEqual(report.findings[0], { topic: "Auth flow", summary: "Tokens refresh in src/auth.ts.", confidence: "high", sources: ["src/auth.ts:42"], relevance: "high" });
    assert.equal(report.findings[1]!.topic, "Finding");
    assert.equal(report.findings[1]!.confidence, "medium", "unknown confidence normalized");
    assert.equal(report.findings[1]!.summary.length, 2_000);
    assert.deepEqual(report.openQuestions, ["Is the cache shared?"]);
    assert.deepEqual(report.filesRead, ["src/auth.ts"]);
    assert.equal(parseWorkerReport("no report"), null);
    assert.equal(parseWorkerReport("```json\n{not json}\n```"), null);
    assert.equal(parseWorkerReport('```json\n{"findings":[]}\n```'), null);
  });

  it("asks for a structured report without token caps and returns structured findings", async () => {
    const cwd = await makeRepo();
    const calls: string[][] = [];
    const report = { findings: [{ topic: "Entry point", summary: "CLI routes in src/index.tsx.", files: ["src/index.tsx:10"], confidence: "high" }], openQuestions: ["Q?"], filesRead: ["src/index.tsx"] };
    const runner: HotcellProcessRunner = async (_executable, args) => {
      calls.push(args);
      if (args[0] === "create") return { code: 0, stdout: cellId, stderr: "", aborted: false };
      if (args[0] === "exec" && args[2]?.includes("npm install --prefix")) return { code: 0, stdout: "", stderr: "", aborted: false };
      if (args[0] === "exec") return { code: 0, stdout: JSON.stringify({ text: "Summary.\n```json\n" + JSON.stringify(report) + "\n```" }), stderr: "", aborted: false };
      if (args[0] === "stats") return { code: 0, stdout: "Cost: 0.01", stderr: "", aborted: false };
      return { code: 0, stdout: "", stderr: "", aborted: false };
    };
    const result = await runHotcellWorker({ task: "Map the CLI", model: "openai/gpt-6-luna", cwd, processRunner: runner });
    assert.equal(result.status, "completed");
    assert.equal(result.structured, true);
    assert.deepEqual(result.findings[0]!.sources, ["src/index.tsx:10"]);
    assert.deepEqual(result.openQuestions, ["Q?"]);
    assert.deepEqual(result.filesRead, ["src/index.tsx"]);
    const research = calls.filter((args) => args[0] === "exec").at(-1)![2]!;
    assert.doesNotMatch(research, /--max-input-tokens/);
    const prompt = Buffer.from(/printf '%s' '([A-Za-z0-9+/=]+)'/.exec(research)![1]!, "base64").toString("utf8");
    assert.match(prompt, /fenced ```json block/);
  });

  it("restores the cached runtime around the clone and carries local changes in", async () => {
    const cwd = await makeRepo();
    await writeFile(join(cwd, "README.md"), "edited locally\n");
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = await mkdtemp(join(tmpdir(), "autopilot-cache-xdg-"));
    directories.push(process.env.XDG_CONFIG_HOME);
    const { _resetWorkerCacheForTests } = await import("./hotcell-worker-cache.js");
    _resetWorkerCacheForTests();
    try {
      const calls: string[][] = [];
      const runner: HotcellProcessRunner = async (_exe, args) => {
        calls.push(args);
        const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", aborted: false });
        if (args[0] === "create") return ok(args.includes("--repo") ? cellId : "Created sandbox bbbbccccdddd");
        if (args[0] === "backup") return ok("Backed up bbbbccccdddd -> bk987654321 (1 bytes).");
        if (args[0] === "exec" && args[2]?.includes("--format json")) return ok(JSON.stringify({ text: "found it" }));
        if (args[0] === "stats") return ok("Cost: 0.01");
        return ok();
      };
      const result = await runHotcellWorker({
        task: "Research", model: "openai/gpt-6-luna", cwd, processRunner: runner, useRuntimeCache: true,
      });
      assert.equal(result.status, "completed");
      assert.match(result.snapshotNote ?? "", /cloned origin\/main and applied your 1 local change/);

      const workerCalls = calls.filter((a) => a.includes(cellId) || a[0] === "files");
      const kinds = workerCalls.map((a) => (a[0] === "exec" ? (a[2]!.includes("--format json") ? "research" : a[2]!.includes("autopilot-repo-aside") && a[2]!.includes("find /workspace") ? "locate" : "setup") : a[0]));
      assert.deepEqual(kinds, ["locate", "restore", "files", "setup", "research", "stats", "rm"]);
      const restore = workerCalls.find((a) => a[0] === "restore")!;
      assert.deepEqual(restore, ["restore", cellId, "bk987654321"]);
      const setup = workerCalls.find((a) => a[0] === "exec" && !a[2]!.includes("find /workspace") && !a[2]!.includes("--format json"))![2]!;
      assert.match(setup, /^mv \/tmp\/autopilot-repo-aside "\$\(cat \/tmp\/autopilot-repo-root\)"/);
      assert.match(setup, /git -C "\$REPO_ROOT" apply --binary/);
      assert.match(setup, /test -x \/workspace\/.autopilot-worker\/node_modules\/.bin\/autopilot$/);
      assert.ok(!setup.includes("npm install"), "cached runtime: no install in the subagent's sandbox");
      assert.ok(calls.some((a) => a[0] === "rm" && a[1] === "bbbbccccdddd"), "build sandbox removed");
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });

  it("streams the working tree in by default: no clone, so private repos work", async () => {
    const cwd = await makeRepo();
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/example/private.git"], { cwd });
    await writeFile(join(cwd, "README.md"), "edited locally\n");
    const calls: string[][] = [];
    const runner: HotcellProcessRunner = async (_exe, args) => {
      calls.push(args);
      if (args[0] === "start") return { code: 0, stdout: "started", stderr: "", aborted: false };
      if (args[0] === "create") return { code: 0, stdout: cellId, stderr: "", aborted: false };
      if (args[0] === "exec" && args[2]?.includes("--format json")) return { code: 0, stdout: JSON.stringify({ text: "found it" }), stderr: "", aborted: false };
      if (args[0] === "stats") return { code: 0, stdout: "Cost: 0.01", stderr: "", aborted: false };
      return { code: 0, stdout: "", stderr: "", aborted: false };
    };
    const result = await runHotcellWorker({
      task: "Research", model: "openai/gpt-6-luna", cwd, processRunner: runner, useArchive: true, useRuntimeCache: false,
    });
    assert.equal(result.status, "completed");
    assert.match(result.snapshotNote ?? "", /saw your current working tree \(1 file, uncommitted changes included\)/);
    const create = calls.find((a) => a[0] === "create")!;
    assert.ok(!create.includes("--repo"), "no clone: works without GitHub credentials");
    assert.deepEqual(calls.map((a) => a[0]), ["start", "create", "files", "exec", "exec", "stats", "rm"]);
    const setup = calls.filter((a) => a[0] === "exec")[0]![2]!;
    assert.match(setup, /cat \/workspace\/.autopilot-snapshot-\* \| base64 -d \| tar -xzf - -C \/workspace\/repo/);
    assert.match(setup, /printf "%s" \/workspace\/repo > \/tmp\/autopilot-repo-root/);
    assert.ok(!setup.includes("git -C"), "no git fetch or checkout");
    const research = calls.filter((a) => a[0] === "exec")[1]![2]!;
    assert.match(research, /REPO_ROOT="\$\(cat \/tmp\/autopilot-repo-root\)"/);
  });
});
