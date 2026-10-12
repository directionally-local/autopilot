import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KimiConfig } from "../config.js";
import { AsterApi, type AsterTurnStart } from "./aster-api.js";
import { AsterStore } from "./aster-store.js";
import { startServer } from "./index.js";
import { RunStore } from "../runs/store.js";
import { saveSession } from "../sessions.js";

const originalEnv = new Map<string, string | undefined>();
const tempDirs: string[] = [];

afterEach(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Aster control-plane API", () => {
  it("runs persisted follow-up turns through the shared server runner with SSE replay", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-live-route-")));
    tempDirs.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    git(["init", "--quiet", "--initial-branch=main"], workspaceRoot);
    git(["config", "user.name", "Aster integration test"], workspaceRoot);
    git(["config", "user.email", "aster-integration@example.invalid"], workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "starter\n");
    git(["add", "."], workspaceRoot);
    git(["commit", "--quiet", "-m", "initial"], workspaceRoot);

    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({ models: ["test/model"], workspaces: [{ id: "default", displayName: "Default", rootPath: workspaceRoot }] }));
    setEnv("AUTOPILOT_ASTER_CONFIG", configPath);
    setEnv("AUTOPILOT_ASTER_DB", join(root, "state", "aster.db"));
    setEnv("AUTOPILOT_RUNS_DB", join(root, "state", "runs.db"));
    setEnv("XDG_DATA_HOME", join(root, "data"));
    setEnv("XDG_STATE_HOME", join(root, "state-home"));
    setEnv("KIMIFLARE_SERVER_PASSWORD", "legacy-only-secret");
    const credentialStore = new AsterStore();
    const credential = credentialStore.createCredential({
      name: "integration",
      workspaceIds: ["default"],
      scopes: ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"],
      expiresAt: Date.now() + 60_000,
    });
    credentialStore.close();

    const realFetch = globalThis.fetch;
    const modelMessages: Array<Array<{ role: string; content: unknown }>> = [];
    let modelCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
      if (!url.includes("openrouter.ai")) return realFetch(input, init);
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
      modelMessages.push(requestBody.messages ?? []);
      modelCalls++;
      return openRouterResponse(modelCalls === 1 ? "FIRST_REPLIED" : "SECOND_REPLIED");
    };

    const server = await startServer({ port: 0, hostname: "127.0.0.1", config: { openrouterApiKey: "test-provider-key", model: "test/model" } as KimiConfig });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const basic = `Basic ${Buffer.from("kimiflare:legacy-only-secret").toString("base64")}`;
      assert.equal((await fetch(`${base}/api/v1/health`, { headers: { Authorization: basic } })).status, 401);
      const health = await fetch(`${base}/api/v1/health`, { headers: { Authorization: `Bearer ${credential.token}` } });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("access-control-allow-origin"), null);
      const arbitraryWorkspace = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "/etc", model: "test/model" }),
      });
      assert.equal(arbitraryWorkspace.status, 403);
      const arbitraryModel = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "default", model: "unconfigured/model" }),
      });
      assert.equal(arbitraryModel.status, 400);

      const create = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "default", model: "test/model" }),
      });
      assert.equal(create.status, 201);
      const conversation = await create.json() as { conversationId: string; lastEventId: number };
      const firstEventsPromise = readUntil(await fetch(`${base}/api/v1/conversations/${conversation.conversationId}/events?after=${conversation.lastEventId}`, {
        headers: { Authorization: `Bearer ${credential.token}` },
      }), "event: completed");
      const firstTurn = await fetch(`${base}/api/v1/conversations/${conversation.conversationId}/turns`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientTurnId: "turn-first", text: "first turn" }),
      });
      assert.equal(firstTurn.status, 202);
      await waitForStatusAt(base, credential.token, conversation.conversationId, "completed");
      const firstEvents = await firstEventsPromise;
      assert.match(firstEvents, /event: assistant\.delta/);
      assert.match(firstEvents, /FIRST_REPLIED/);
      assert.match(firstEvents, /id: \d+/);
      assert.doesNotMatch(firstEvents, /arguments|tool\.result/);

      const firstState = await fetch(`${base}/api/v1/conversations/${conversation.conversationId}`, { headers: { Authorization: `Bearer ${credential.token}` } });
      const cursor = (await firstState.json() as { lastEventId: number }).lastEventId;
      const secondEventsPromise = readUntil(await fetch(`${base}/api/v1/conversations/${conversation.conversationId}/events`, {
        headers: { Authorization: `Bearer ${credential.token}`, "Last-Event-ID": String(cursor) },
      }), "event: completed");
      const secondTurn = await fetch(`${base}/api/v1/conversations/${conversation.conversationId}/turns`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ clientTurnId: "turn-second", text: "second turn" }),
      });
      assert.equal(secondTurn.status, 202);
      await waitForStatusAt(base, credential.token, conversation.conversationId, "completed");
      const secondEvents = await secondEventsPromise;
      assert.match(secondEvents, /SECOND_REPLIED/);
      assert.ok(modelMessages[1]!.some((message) => message.role === "user" && message.content === "first turn"));
      assert.ok(modelMessages[1]!.some((message) => message.role === "assistant" && message.content === "FIRST_REPLIED"));
      assert.ok(modelMessages[1]!.some((message) => message.role === "user" && message.content === "second turn"));
    } finally {
      globalThis.fetch = realFetch;
      await closeServer(server);
    }
  });

  it("uses Bearer auth for Aster routes and keeps legacy Basic auth separate", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-auth-")));
    tempDirs.push(root);
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    git(["init", "--quiet", "--initial-branch=main"], workspaceRoot);
    git(["config", "user.name", "Aster test"], workspaceRoot);
    git(["config", "user.email", "aster-test@example.invalid"], workspaceRoot);
    await writeFile(join(workspaceRoot, "README.md"), "initial\n");
    git(["add", "."], workspaceRoot);
    git(["commit", "--quiet", "-m", "initial"], workspaceRoot);
    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({ models: ["test/model"], workspaces: [{ id: "default", displayName: "Default", rootPath: workspaceRoot }] }));
    setEnv("AUTOPILOT_ASTER_CONFIG", configPath);
    setEnv("AUTOPILOT_ASTER_DB", join(root, "state", "aster.db"));
    setEnv("AUTOPILOT_RUNS_DB", join(root, "state", "runs.db"));
    setEnv("XDG_DATA_HOME", join(root, "data"));
    setEnv("XDG_STATE_HOME", join(root, "state-home"));
    setEnv("KIMIFLARE_SERVER_PASSWORD", "legacy-only-secret");
    const tokens = new AsterStore();
    const credential = tokens.createCredential({
      name: "auth-test",
      workspaceIds: ["default"],
      scopes: ["workspaces:read"],
      expiresAt: Date.now() + 60_000,
    });
    tokens.close();

    const server = await startServer({ port: 0, hostname: "127.0.0.1", config: { openrouterApiKey: "test-key", model: "test/model" } as KimiConfig });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const basicOnly = await fetch(`${baseUrl}/api/v1/health`, {
        headers: { Authorization: `Basic ${Buffer.from("kimiflare:legacy-only-secret").toString("base64")}` },
      });
      assert.equal(basicOnly.status, 401);
      const aster = await fetch(`${baseUrl}/api/v1/health`, { headers: { Authorization: `Bearer ${credential.token}` } });
      assert.equal(aster.status, 200);
      assert.equal(aster.headers.get("access-control-allow-origin"), null);
      const legacyUnauthorized = await fetch(`${baseUrl}/`);
      assert.equal(legacyUnauthorized.status, 401);
      const legacyAuthorized = await fetch(`${baseUrl}/`, {
        headers: { Authorization: `Basic ${Buffer.from("kimiflare:legacy-only-secret").toString("base64")}` },
      });
      assert.equal(legacyAuthorized.status, 200);
      assert.equal(legacyAuthorized.headers.get("access-control-allow-origin"), "*");
    } finally {
      await closeServer(server);
    }
  });

  it("authenticates scoped tokens, hides paths, persists/resumes conversations, and replays events", async () => {
    const harness = await createHarness("complete");
    try {
      const unauthorized = await fetch(`${harness.baseUrl}/api/v1/health`);
      assert.equal(unauthorized.status, 401);
      const wrongAuth = await fetch(`${harness.baseUrl}/api/v1/health`, { headers: { Authorization: `Basic ${harness.token}` } });
      assert.equal(wrongAuth.status, 401);

      const health = await request(harness, "GET", "/api/v1/health");
      assert.equal(health.status, 200);
      assert.equal((await health.json() as { apiVersion: string }).apiVersion, "v1");
      const workspacesResponse = await request(harness, "GET", "/api/v1/workspaces");
      const workspacesText = await workspacesResponse.text();
      assert.match(workspacesText, /Default workspace/);
      assert.doesNotMatch(workspacesText, new RegExp(escapeRegExp(harness.workspaceRoot)));

      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      assert.equal(created.status, 201);
      const conversation = await created.json() as { conversationId: string; workspaceId: string; status: string; lastEventId: number };
      assert.equal(conversation.workspaceId, "default");
      assert.equal(conversation.status, "ready");
      assert.doesNotMatch(JSON.stringify(conversation), new RegExp(escapeRegExp(harness.workspaceRoot)));

      const first = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-first", text: "first turn" });
      assert.equal(first.status, 202);
      const firstRun = await first.json() as { clientTurnId: string; runId: string; status: string };
      await waitForStatus(harness, conversation.conversationId, "completed");
      const exactRetry = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-first", text: "first turn" });
      assert.equal(exactRetry.status, 202);
      assert.deepEqual(await exactRetry.json(), firstRun);
      assert.equal(harness.turns.length, 1);
      const cursorResponse = await request(harness, "GET", `/api/v1/conversations/${conversation.conversationId}`);
      const firstState = await cursorResponse.json() as { lastEventId: number };

      const second = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-second", text: "second turn" });
      assert.equal(second.status, 202);
      const secondRun = await second.json() as { runId: string };
      assert.notEqual(secondRun.runId, firstRun.runId);
      await waitForStatus(harness, conversation.conversationId, "completed");
      assert.equal(harness.turns.length, 2);
      assert.ok(harness.turns[1]!.messages.some((message) => message.role === "user" && message.content === "first turn"));
      assert.ok(harness.turns[1]!.messages.some((message) => message.role === "assistant" && message.content === "reply-1"));

      const stream = await request(harness, "GET", `/api/v1/conversations/${conversation.conversationId}/events?after=${firstState.lastEventId}`);
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
      const eventText = await readUntil(stream, "event: completed");
      assert.match(eventText, /id: \d+/);
      assert.match(eventText, /event: assistant\.delta/);
      assert.match(eventText, /reply-2/);
      assert.doesNotMatch(eventText, /arguments|content\\":\\"reply-2/);
    } finally {
      await harness.close();
    }
  });

  it("accepts legacy text-only turns without deduplicating their text", async () => {
    const harness = await createHarness("hang");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turnsPath = "/api/v1/conversations/" + conversation.conversationId + "/turns";

      const malformedKey = await request(harness, "POST", turnsPath, { clientTurnId: null, text: "legacy text" });
      assert.equal(malformedKey.status, 400);
      assert.equal(((await malformedKey.json() as { error: { code: string } }).error).code, "invalid_client_turn_id");

      const first = await request(harness, "POST", turnsPath, { text: "legacy text" });
      assert.equal(first.status, 202);
      const firstBody = await first.json() as { conversationId: string; runId: string; status: string; clientTurnId?: string };
      assert.equal(firstBody.clientTurnId, undefined);
      const overlappingSameText = await request(harness, "POST", turnsPath, { text: "legacy text" });
      assert.equal(overlappingSameText.status, 409);
      assert.equal(((await overlappingSameText.json() as { error: { code: string } }).error).code, "conversation_busy");

      await request(harness, "POST", "/api/v1/conversations/" + conversation.conversationId + "/cancel");
      const second = await request(harness, "POST", turnsPath, { text: "legacy text" });
      assert.equal(second.status, 202);
      const secondBody = await second.json() as { runId: string };
      assert.notEqual(secondBody.runId, firstBody.runId);
      assert.equal(harness.turns.length, 2);
      await request(harness, "POST", "/api/v1/conversations/" + conversation.conversationId + "/cancel");
    } finally {
      await harness.close();
    }
  });

  it("makes turn submissions idempotent across concurrent retries and busy responses", async () => {
    const harness = await createHarness("hang");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turnsPath = "/api/v1/conversations/" + conversation.conversationId + "/turns";

      const payload = { clientTurnId: "client-turn-001", text: "do exactly once" };
      const [first, concurrentRetry] = await Promise.all([
        request(harness, "POST", turnsPath, payload),
        request(harness, "POST", turnsPath, payload),
      ]);
      assert.equal(first.status, 202);
      assert.equal(concurrentRetry.status, 202);
      const accepted = await first.json() as { conversationId: string; clientTurnId: string; runId: string; status: string };
      assert.deepEqual(await concurrentRetry.json(), accepted);
      assert.equal(accepted.clientTurnId, payload.clientTurnId);
      assert.equal(harness.turns.length, 1);
      assert.equal(harness.turns[0]!.messages.filter((message) => message.role === "user" && message.content === payload.text).length, 1);

      const exactRetry = await request(harness, "POST", turnsPath, payload);
      assert.equal(exactRetry.status, 202);
      assert.deepEqual(await exactRetry.json(), accepted);

      const conflict = await request(harness, "POST", turnsPath, { clientTurnId: payload.clientTurnId, text: "different text" });
      assert.equal(conflict.status, 409);
      assert.equal(((await conflict.json() as { error: { code: string } }).error).code, "idempotency_conflict");

      const notConsumed = { clientTurnId: "busy-retry-key", text: "retry when ready" };
      const busy = await request(harness, "POST", turnsPath, notConsumed);
      assert.equal(busy.status, 409);
      assert.equal(((await busy.json() as { error: { code: string } }).error).code, "conversation_busy");

      const cancelFirst = await request(harness, "POST", "/api/v1/conversations/" + conversation.conversationId + "/cancel");
      assert.equal(cancelFirst.status, 200);
      const retriedAfterBusy = await request(harness, "POST", turnsPath, notConsumed);
      assert.equal(retriedAfterBusy.status, 202);
      const secondRun = await retriedAfterBusy.json() as { runId: string };
      assert.notEqual(secondRun.runId, accepted.runId);
      assert.equal(harness.turns.length, 2);
      const cancelSecond = await request(harness, "POST", "/api/v1/conversations/" + conversation.conversationId + "/cancel");
      assert.equal(cancelSecond.status, 200);
    } finally {
      await harness.close();
    }
  });

  it("cancels an active turn and does not accept arbitrary cwd input", async () => {
    const harness = await createHarness("hang");
    try {
      const invalid = await request(harness, "POST", "/api/v1/conversations", {
        workspaceId: "default", model: "test/model", cwd: "/etc",
      });
      assert.equal(invalid.status, 400);
      const tooLarge = await request(harness, "POST", "/api/v1/conversations", {
        workspaceId: "default", model: "test/model", extra: "x".repeat(70_000),
      });
      assert.equal(tooLarge.status, 413);

      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turn = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-long-task", text: "long task" });
      assert.equal(turn.status, 202);
      const runId = (await turn.json() as { runId: string }).runId;
      const overlapping = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-overlap", text: "overlapping turn" });
      assert.equal(overlapping.status, 409);
      const cancelled = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/cancel`);
      assert.equal(cancelled.status, 200);
      assert.deepEqual(harness.cancelledRuns, [runId]);
      const again = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/cancel`);
      assert.equal(again.status, 200);
    } finally {
      await harness.close();
    }
  });

  it("allows an explicitly approved write and makes resolution idempotent", async () => {
    const harness = await createHarness("approval");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turn = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-write-approval", text: "write after approval" });
      assert.equal(turn.status, 202);
      const approval = await waitForApproval(harness, conversation.conversationId);

      const allowed = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "allow" });
      assert.equal(allowed.status, 200);
      const duplicate = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "allow" });
      assert.equal(duplicate.status, 200);
      const conflict = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "deny" });
      assert.equal(conflict.status, 409);
      assert.equal(harness.permissionDecisions.at(-1), "allow");
      await waitForStatus(harness, conversation.conversationId, "completed");
      assert.equal(await readFile(join(harness.worktreeRoot, conversation.conversationId, "created.txt"), "utf8"), "safe content");
    } finally {
      await harness.close();
    }
  });

  it("expires an unanswered approval and never executes its write", async () => {
    const harness = await createHarness("approval");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turn = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-expiry", text: "write but let approval expire" });
      assert.equal(turn.status, 202);
      const approval = await waitForApproval(harness, conversation.conversationId);
      await waitForStatus(harness, conversation.conversationId, "completed");
      const store = new AsterStore();
      try {
        assert.equal(store.getApproval(approval.id)?.status, "expired");
        const lateAllow = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "allow" });
        assert.equal(lateAllow.status, 410);
      } finally {
        store.close();
      }
      assert.equal(harness.permissionDecisions.at(-1), "deny");
      assert.equal(await exists(join(harness.worktreeRoot, conversation.conversationId, "created.txt")), false);
    } finally {
      await harness.close();
    }
  });

  it("requires an explicit approval and never executes a denied write", async () => {
    const harness = await createHarness("approval");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const turn = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { clientTurnId: "turn-write-file", text: "write a file" });
      assert.equal(turn.status, 202);
      const approval = await waitForApproval(harness, conversation.conversationId);

      const details = await request(harness, "GET", `/api/v1/approvals/${approval.id}`);
      assert.equal(details.status, 200);
      const approvalBody = await details.json() as { arguments: { path: string; content: string } };
      assert.deepEqual(approvalBody.arguments, { path: "created.txt", content: "safe content" });
      const eventResponse = await request(harness, "GET", `/api/v1/conversations/${conversation.conversationId}/events?after=0`);
      const eventText = await readUntil(eventResponse, "event: approval.required");
      assert.match(eventText, /approvalId/);
      assert.doesNotMatch(eventText, /safe content|arguments/);

      const denied = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "deny" });
      assert.equal(denied.status, 200);
      const duplicate = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "deny" });
      assert.equal(duplicate.status, 200);
      const conflict = await request(harness, "POST", `/api/v1/approvals/${approval.id}`, { decision: "allow" });
      assert.equal(conflict.status, 409);
      assert.equal(harness.permissionDecisions.at(-1), "deny");
      assert.equal(await exists(join(harness.worktreeRoot, conversation.conversationId, "created.txt")), false);
      await waitForStatus(harness, conversation.conversationId, "completed");
    } finally {
      await harness.close();
    }
  });
});

interface Harness {
  baseUrl: string;
  token: string;
  workspaceRoot: string;
  worktreeRoot: string;
  turns: AsterTurnStart[];
  cancelledRuns: string[];
  permissionDecisions: string[];
  close(): Promise<void>;
}

async function createHarness(mode: "complete" | "hang" | "approval"): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-api-")));
  tempDirs.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot);
  git(["init", "--quiet", "--initial-branch=main"], workspaceRoot);
  git(["config", "user.name", "Aster test"], workspaceRoot);
  git(["config", "user.email", "aster-test@example.invalid"], workspaceRoot);
  await writeFile(join(workspaceRoot, "README.md"), "starter\n");
  git(["add", "."], workspaceRoot);
  git(["commit", "--quiet", "-m", "initial"], workspaceRoot);

  const dataHome = join(root, "data");
  const stateHome = join(root, "state-home");
  const asterDb = join(root, "state", "aster.db");
  const runsDb = join(root, "state", "runs.db");
  const configPath = join(root, "aster.json");
  await writeFile(configPath, JSON.stringify({
    models: ["test/model"],
    approvalTtlMs: 1500,
    workspaces: [{ id: "default", displayName: "Default workspace", rootPath: workspaceRoot }],
  }));
  setEnv("XDG_DATA_HOME", dataHome);
  setEnv("XDG_STATE_HOME", stateHome);
  setEnv("AUTOPILOT_ASTER_DB", asterDb);
  setEnv("AUTOPILOT_RUNS_DB", runsDb);
  setEnv("AUTOPILOT_ASTER_CONFIG", configPath);
  setEnv("KIMIFLARE_SERVER_PASSWORD", "legacy-only-secret");

  const asterStore = new AsterStore(asterDb);
  const credential = asterStore.createCredential({
    name: "test-client",
    workspaceIds: ["default"],
    scopes: ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"],
    expiresAt: Date.now() + 60_000,
  });
  asterStore.close();

  const turns: AsterTurnStart[] = [];
  const cancelledRuns: string[] = [];
  const permissionDecisions: string[] = [];
  const api = new AsterApi({ openrouterApiKey: "test-key", model: "test/model" } as KimiConfig, {
    startTurn: (turn) => {
      turns.push(turn);
      if (mode === "complete") void completeTurn(turn, `reply-${turns.length}`);
      else if (mode === "approval") void approveWriteTurn(turn, permissionDecisions);
    },
    cancelRun: (runId) => { cancelledRuns.push(runId); },
  });
  const server = createServer((req, res) => { void api.handle(req, res); });
  const port = await listen(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async () => {
    api.close();
    await closeServer(server);
  };
  return {
    baseUrl,
    token: credential.token,
    workspaceRoot,
    worktreeRoot: join(dataHome, "autopilot", "worktrees"),
    turns,
    cancelledRuns,
    permissionDecisions,
    close,
  };
}

async function openRouterResponse(text: string): Promise<Response> {
  const encoder = new TextEncoder();
  const chunks = [
    { id: "gen-test", object: "chat.completion.chunk", created: 1, model: "test/model", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "gen-test", object: "chat.completion.chunk", created: 1, model: "test/model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { id: "gen-test", object: "chat.completion.chunk", created: 1, model: "test/model", choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, cost: 0.001 } },
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function waitForStatusAt(base: string, token: string, conversationId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/v1/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json() as { status: string };
    if (body.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`conversation did not reach ${expected}`);
}

async function completeTurn(turn: AsterTurnStart, text: string): Promise<void> {
  turn.messages.push({ role: "assistant", content: text });
  turn.sessionFile.messages = turn.messages;
  turn.sessionFile.updatedAt = new Date().toISOString();
  await saveSession(turn.sessionFile);
  const runs = new RunStore();
  try {
    if (runs.getRun(turn.runId)?.status === "running") runs.transition(turn.runId, "completed");
  } finally {
    runs.close();
  }
  turn.publishEvent("assistant.delta", { delta: text });
  turn.finish("completed");
}

async function approveWriteTurn(turn: AsterTurnStart, decisions: string[]): Promise<void> {
  const tool = turn.executor.list().find((item) => item.name === "write");
  assert.ok(tool);
  const args = { path: "created.txt", content: "safe content" };
  const result = await turn.executor.run(
    { id: "tool-call-1", name: "write", arguments: JSON.stringify(args) },
    async (request) => {
      const decision = await turn.askPermission(request);
      decisions.push(typeof decision === "string" ? decision : decision.decision);
      return decision;
    },
    { cwd: turn.sessionFile.cwd, runId: turn.runId, sessionId: turn.sessionFile.id, runsDbPath: process.env.AUTOPILOT_RUNS_DB },
  );
  assert.equal(result.ok, decisions.at(-1) === "allow");
  await completeTurn(turn, result.ok ? "The write was approved." : "The write was denied.");
}

async function waitForStatus(harness: Harness, conversationId: string, expected: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await request(harness, "GET", `/api/v1/conversations/${conversationId}`);
    const body = await response.json() as { status: string };
    if (body.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`conversation did not reach ${expected}`);
}

async function waitForApproval(harness: Harness, conversationId: string): Promise<{ id: string }> {
  const store = new AsterStore();
  const deadline = Date.now() + 3000;
  try {
    while (Date.now() < deadline) {
      const approvals = store.pendingApprovalsForConversation(conversationId);
      if (approvals[0]) return { id: approvals[0].id };
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    store.close();
  }
  assert.fail("approval was not created");
}

async function request(harness: Harness, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${harness.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function readUntil(response: Response, target: string): Promise<string> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 3000;
  try {
    while (!output.includes(target) && Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE event timeout")), 3000)),
      ]);
      if (next.done) break;
      output += decoder.decode(next.value, { stream: true });
    }
    return output;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
      if (!address || typeof address === "string") return reject(new Error("expected TCP address"));
      resolve(address.port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
