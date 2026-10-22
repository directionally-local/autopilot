import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KimiConfig } from "../config.js";
import { AsterApi, type AsterTurnStart } from "../server/aster-api.js";
import type { AsterCellProject } from "../server/aster-cell-runtime.js";
import { AsterGitHubError, type AsterGitHub } from "../server/aster-github.js";
import { AsterStore } from "../server/aster-store.js";
import { RunStore } from "../runs/store.js";
import { saveSession } from "../sessions.js";
import { listRuns, pullRun, remoteAdd, runOnRemote, watchRun, type RemoteIO } from "./cli.js";
import { loadRemotes } from "./config.js";

const originalEnv = new Map<string, string | undefined>();
const roots: string[] = [];

afterEach(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("autopilot remote client against the Aster API", () => {
  it("pairs, runs a task with local changes, lists, replays, and pulls the run's branch", { timeout: 30_000 }, async () => {
    const server = await startAsterServer();
    const stopPairing = new AbortController();
    let pairing: Promise<unknown> = Promise.resolve();
    try {
      // Pair: the owner approves on the server (`autopilot aster pair approve`) while the CLI polls.
      const io = captureIO();
      const paired = remoteAdd({
        url: server.baseUrl, name: "box", open: false, signal: stopPairing.signal,
        sleep: () => new Promise((resolve) => setTimeout(resolve, 20)),
      }, io);
      pairing = paired.catch(() => {});
      // The code is read from what the CLI printed, as a user would.
      const userCode = await waitFor(() => io.text().match(/approve code ([A-Z]{4}-[A-Z]{4}) at:/)?.[1]);
      assert.match(io.text(), new RegExp(`approve code ${userCode} at:\\n  ${server.baseUrl}/api/v1/auth/approve\\?code=${userCode}`));
      const approver = new AsterStore();
      assert.equal(approver.resolveDeviceAuthorization(userCode, "approve", { workspaceIds: ["default"], credentialTtlMs: 60_000 }), "approved");
      approver.close();
      const remote = await paired;
      assert.match(io.text(), /Paired as "box"/);
      assert.deepEqual((await loadRemotes()).map((entry) => entry.name), ["box"]);
      assert.match(remote.token, /^aster_/);

      // Run: base on the pushed commit, with the uncommitted edit uploaded as a patch.
      const { checkout, origin } = await clonedRepository(server.root);
      const base = git(checkout, "rev-parse", "HEAD");
      await writeFile(join(checkout, "README.md"), "hello\nlocal edit\n");
      const runIO = captureIO();
      const code = await runOnRemote({ remote: "box", task: "Fix the flaky test", cwd: checkout, repository: "me/app" }, runIO);
      assert.equal(code, 0, runIO.text());
      const project = server.projects.at(-1)!;
      assert.equal(project.baseCommit, base);
      assert.match(project.patch ?? "", /\+local edit/);
      assert.equal(server.turns.at(-1)?.userText, "Fix the flaky test");
      const output = runIO.text();
      assert.match(output, /with 1 changed file · test\/model/);
      assert.match(output, /› shell npm test/);
      assert.match(output, /Fixed the flaky test\./);
      assert.match(output, /✓ [0-9a-f]{8} completed: https:\/\/github\.com\/me\/app\/pull\/42/);
      const runId = output.match(/Run ([0-9a-f]{8})/)![1]!;

      const listIO = captureIO();
      await listRuns({}, listIO);
      assert.match(listIO.text(), new RegExp(`^${runId}  box  completed\\s+me/app  https://github.com/me/app/pull/42`));

      const replayIO = captureIO();
      assert.equal(await watchRun({ id: runId }, replayIO), 0, "replaying a finished run ends on its own");
      assert.match(replayIO.text(), /Fixed the flaky test\./);

      // Pull: the cell pushed the branch to origin; the CLI checks it out.
      const branch = `aster/${runId}`;
      git(checkout, "stash", "--quiet");
      git(checkout, "push", "--quiet", "origin", `HEAD:refs/heads/${branch}`);
      const pullIO = captureIO();
      await pullRun({ id: runId, cwd: checkout }, pullIO);
      assert.equal(git(checkout, "branch", "--show-current"), branch);
      assert.match(pullIO.text(), new RegExp(`On ${branch} · https://github.com/me/app/pull/42`));
      assert.ok(origin);
    } finally {
      // Never leave the pairing poll running past the test, even when an assertion fails.
      stopPairing.abort();
      await pairing;
      await server.close();
    }
  });

  it("detaches on abort without cancelling the run", { timeout: 30_000 }, async () => {
    const server = await startAsterServer({ hang: true });
    try {
      const store = new AsterStore();
      const credential = store.createCredential({
        name: "laptop", workspaceIds: ["default"], expiresAt: Date.now() + 60_000,
        scopes: ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"],
      });
      store.close();
      await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify({ version: 1, remotes: [{
        name: "box", url: server.baseUrl, token: credential.token, credentialId: credential.id, expiresAt: "2099-01-01T00:00:00.000Z", addedAt: "2026-10-01T00:00:00.000Z",
      }] }));
      const { checkout } = await clonedRepository(server.root);
      const controller = new AbortController();
      const io = captureIO();
      const running = runOnRemote({ task: "Long task", cwd: checkout, repository: "me/app", signal: controller.signal }, io);
      await waitFor(() => server.turns.length > 0 || undefined);
      controller.abort();
      assert.equal(await running, 0);
      assert.match(io.text(), /Detached from [0-9a-f]{8}; it keeps running on box/);
      assert.equal(server.cancelled.length, 0);
    } finally {
      await server.close();
    }
  });

  it("detaches when aborted before the run starts streaming", { timeout: 30_000 }, async () => {
    const server = await startAsterServer({ hang: true });
    try {
      const store = new AsterStore();
      const credential = store.createCredential({
        name: "laptop", workspaceIds: ["default"], expiresAt: Date.now() + 60_000,
        scopes: ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"],
      });
      store.close();
      await writeFile(process.env.AUTOPILOT_REMOTES_FILE!, JSON.stringify({ version: 1, remotes: [{
        name: "box", url: server.baseUrl, token: credential.token, credentialId: credential.id, expiresAt: "2099-01-01T00:00:00.000Z", addedAt: "2026-10-01T00:00:00.000Z",
      }] }));
      const { checkout } = await clonedRepository(server.root);
      // Ctrl-C while the run is still being created: the abort lands before the watch listens.
      const controller = new AbortController();
      controller.abort();
      const io = captureIO();
      assert.equal(await runOnRemote({ task: "Long task", cwd: checkout, repository: "me/app", signal: controller.signal }, io), 0);
      assert.match(io.text(), /Detached from [0-9a-f]{8}; it keeps running on box/);
      assert.equal(server.turns.length, 1);
      assert.equal(server.cancelled.length, 0);
    } finally {
      await server.close();
    }
  });
});

interface AsterTestServer {
  root: string;
  baseUrl: string;
  projects: AsterCellProject[];
  turns: AsterTurnStart[];
  cancelled: string[];
  close(): Promise<void>;
}

async function startAsterServer(options: { hang?: boolean } = {}): Promise<AsterTestServer> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-remote-cli-")));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", workspaceRoot]);
  const configPath = join(root, "aster.json");
  await writeFile(configPath, JSON.stringify({ models: ["test/model"], workspaces: [{ id: "default", displayName: "Default", rootPath: workspaceRoot }] }));
  setEnv("AUTOPILOT_ASTER_CONFIG", configPath);
  setEnv("AUTOPILOT_ASTER_DB", join(root, "state", "aster.db"));
  setEnv("AUTOPILOT_RUNS_DB", join(root, "state", "runs.db"));
  setEnv("XDG_DATA_HOME", join(root, "data"));
  setEnv("XDG_STATE_HOME", join(root, "state-home"));
  setEnv("AUTOPILOT_ASTER_MEMORY", "off");
  setEnv("AUTOPILOT_REMOTES_FILE", join(root, "remotes.json"));
  setEnv("KIMIFLARE_NO_BROWSER", "1");

  const projects: AsterCellProject[] = [];
  const turns: AsterTurnStart[] = [];
  const cancelled: string[] = [];
  const repo = (fullName: string) => ({ fullName, name: "app", owner: "me", private: true, description: null, defaultBranch: "main", updatedAt: null });
  const github = {
    configured: true,
    getRepository: async (fullName: string) => {
      if (fullName !== "me/app") throw new AsterGitHubError("Repository not found", 404, "repository_not_found");
      return repo(fullName);
    },
    createPullRequest: async (repository: string, input: { title: string; head: string; base: string }) =>
      ({ number: 42, url: `https://github.com/${repository}/pull/42`, title: input.title, state: "open", headBranch: input.head, baseBranch: input.base, merged: false }),
  } as unknown as AsterGitHub;
  const api = new AsterApi({ openrouterApiKey: "test-key", model: "test/model" } as KimiConfig, {
    provisionConversation: async (input) => {
      if (input.project) projects.push(input.project);
      input.onCellCreated(`cell-${input.conversationId}`);
      return { cellId: `cell-${input.conversationId}` };
    },
    startTurn: (turn) => {
      turns.push(turn);
      if (!options.hang) void completeTurn(turn);
    },
    cancelRun: (runId) => { cancelled.push(runId); },
  }, github, undefined, { configured: false, notify: async () => {}, register: () => true, unregister: () => {}, close: () => {} });
  const server = createServer((req, res) => { void api.handle(req, res); });
  const port = await listen(server);
  return {
    root,
    baseUrl: `http://127.0.0.1:${port}`,
    projects,
    turns,
    cancelled,
    close: async () => {
      api.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function completeTurn(turn: AsterTurnStart): Promise<void> {
  await saveSession(turn.sessionFile);
  const runs = new RunStore();
  try {
    if (runs.getRun(turn.runId)?.status === "running") runs.transition(turn.runId, "completed");
  } finally {
    runs.close();
  }
  turn.publishEvent("tool.activity", { tool: "shell", toolCallId: "t1", activity: "started", input: "npm test" });
  turn.publishEvent("assistant.delta", { text: "Fixed the flaky test." });
  await turn.beforeFinish?.();
  turn.finish("completed");
}

async function clonedRepository(root: string): Promise<{ checkout: string; origin: string }> {
  const origin = join(root, "origin.git");
  const checkout = join(root, `checkout-${Math.random().toString(36).slice(2)}`);
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  execFileSync("git", ["clone", "--quiet", origin, checkout], { stdio: "ignore" });
  await writeFile(join(checkout, "README.md"), "hello\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "--quiet", "-m", "initial");
  git(checkout, "push", "--quiet", "origin", "main");
  return { checkout, origin };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

function captureIO(): RemoteIO & { text(): string } {
  let text = "";
  return { out: (chunk) => { text += chunk; }, err: (chunk) => { text += chunk; }, text: () => text };
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function setEnv(name: string, value: string): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  process.env[name] = value;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      resolve(address.port);
    });
  });
}
