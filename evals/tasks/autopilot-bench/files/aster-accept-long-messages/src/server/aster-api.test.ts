import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KimiConfig } from "../config.js";
import { AsterGitHub, AsterGitHubError } from "./aster-github.js";
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
  it("runs follow-up turns through an injected cell runtime with SSE replay", async () => {
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

    const turns: AsterTurnStart[] = [];
    const server = await startServer({
      port: 0,
      hostname: "127.0.0.1",
      config: { openrouterApiKey: "test-provider-key", model: "test/model" } as KimiConfig,
      asterRuntime: {
        provisionConversation: async (input) => {
          input.onCellCreated(`cell-${input.conversationId}`);
          return { cellId: `cell-${input.conversationId}` };
        },
        startTurn: (turn) => {
          turns.push(turn);
          const text = turns.length === 1 ? "FIRST_REPLIED" : "SECOND_REPLIED";
          setTimeout(() => {
            turn.publishEvent("assistant.delta", { text });
            turn.onCellCursor?.(turn.cellEventCursor + 1);
            turn.finish("completed");
          }, 10);
        },
        cancelRun: () => {},
      },
    });
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const base = `http://127.0.0.1:${address.port}`;
      const basic = `Basic ${Buffer.from("kimiflare:legacy-only-secret").toString("base64")}`;
      assert.equal((await fetch(`${base}/api/v1/health`, { headers: { Authorization: basic } })).status, 401);
      const health = await fetch(`${base}/api/v1/health`, { headers: { Authorization: `Bearer ${credential.token}` } });
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("access-control-allow-origin"), null);

      const missingKey = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "default", model: "test/model" }),
      });
      assert.equal(missingKey.status, 400);
      assert.equal((await missingKey.json() as { error: { code: string } }).error.code, "idempotency_key_required");

      const arbitraryWorkspace = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", "Idempotency-Key": "create-1" },
        body: JSON.stringify({ workspaceId: "/etc", model: "test/model" }),
      });
      assert.equal(arbitraryWorkspace.status, 403);
      const arbitraryModel = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", "Idempotency-Key": "create-2" },
        body: JSON.stringify({ workspaceId: "default", model: "unconfigured/model" }),
      });
      assert.equal(arbitraryModel.status, 400);

      const createHeaders = { Authorization: `Bearer ${credential.token}`, "Content-Type": "application/json", "Idempotency-Key": "create-main" };
      const createBody = JSON.stringify({ workspaceId: "default", model: "test/model" });
      const create = await fetch(`${base}/api/v1/conversations`, { method: "POST", headers: createHeaders, body: createBody });
      assert.equal(create.status, 201);
      const conversation = await create.json() as { conversationId: string; lastEventId: number };
      const createRetry = await fetch(`${base}/api/v1/conversations`, { method: "POST", headers: createHeaders, body: createBody });
      assert.equal(createRetry.status, 200);
      assert.equal((await createRetry.json() as { conversationId: string }).conversationId, conversation.conversationId);
      const createConflict = await fetch(`${base}/api/v1/conversations`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify({ workspaceId: "default", model: "test/model" }),
      });
      assert.equal(createConflict.status, 200);

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
      assert.equal(turns.length, 2);
      assert.equal(turns[1]!.userText, "second turn");
      assert.equal(turns[1]!.cellId, turns[0]!.cellId);
      assert.equal(turns[1]!.cellEventCursor, 1);
    } finally {
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
      assert.equal(harness.turns[1]!.userText, "second turn");
      assert.equal(harness.turns[1]!.cellId, harness.turns[0]!.cellId);
      assert.equal(harness.turns[1]!.conversation.sessionId, harness.turns[0]!.conversation.sessionId);

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

  it("binds one cell per conversation, isolates credentials, and pauses/resumes/destroys idempotently", async () => {
    const harness = await createHarness("complete");
    try {
      const firstCreate = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" }, "cell-key-a");
      assert.equal(firstCreate.status, 201);
      const first = await firstCreate.json() as { conversationId: string };
      const secondCreate = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" }, "cell-key-b");
      assert.equal(secondCreate.status, 201);
      const second = await secondCreate.json() as { conversationId: string };

      const store = new AsterStore();
      try {
        const firstMapping = store.getCellMapping(first.conversationId)!;
        const secondMapping = store.getCellMapping(second.conversationId)!;
        assert.equal(firstMapping.cellId, `cell-${first.conversationId}`);
        assert.equal(secondMapping.cellId, `cell-${second.conversationId}`);
        assert.notEqual(firstMapping.cellId, secondMapping.cellId);
        assert.notEqual(firstMapping.sessionId, secondMapping.sessionId);
      } finally {
        store.close();
      }

      // Cross-credential access is invisible even within the same workspace scope.
      const otherStore = new AsterStore();
      let otherToken: string;
      try {
        otherToken = otherStore.createCredential({
          name: "other-client",
          workspaceIds: ["default"],
          scopes: ["conversations:read", "conversations:write"],
          expiresAt: Date.now() + 60_000,
        }).token;
      } finally {
        otherStore.close();
      }
      const crossRead = await fetch(`${harness.baseUrl}/api/v1/conversations/${first.conversationId}`, { headers: { Authorization: `Bearer ${otherToken}` } });
      assert.equal(crossRead.status, 404);
      const crossDestroy = await fetch(`${harness.baseUrl}/api/v1/conversations/${first.conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${otherToken}` } });
      assert.equal(crossDestroy.status, 404);

      // Pause is idempotent at a safe boundary and rejects new turns while paused.
      const pause = await request(harness, "POST", `/api/v1/conversations/${first.conversationId}/pause`);
      assert.equal(pause.status, 200);
      const pauseAgain = await request(harness, "POST", `/api/v1/conversations/${first.conversationId}/pause`);
      assert.equal(pauseAgain.status, 200);
      assert.deepEqual(harness.pausedCells, [`cell-${first.conversationId}`]);
      const pausedTurn = await request(harness, "POST", `/api/v1/conversations/${first.conversationId}/turns`, { clientTurnId: "while-paused", text: "should reject" });
      assert.equal(pausedTurn.status, 409);
      assert.equal(((await pausedTurn.json() as { error: { code: string } }).error).code, "conversation_paused");

      const resume = await request(harness, "POST", `/api/v1/conversations/${first.conversationId}/resume`);
      assert.equal(resume.status, 200);
      assert.deepEqual(harness.resumedCells, [`cell-${first.conversationId}`]);
      const turn = await request(harness, "POST", `/api/v1/conversations/${first.conversationId}/turns`, { clientTurnId: "after-resume", text: "continue" });
      assert.equal(turn.status, 202);
      await waitForStatus(harness, first.conversationId, "completed");
      assert.equal(harness.turns[0]!.cellId, `cell-${first.conversationId}`);

      // Destroy is retryable, revokes through the provider, and poisons the create key.
      const destroy = await fetch(`${harness.baseUrl}/api/v1/conversations/${first.conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${harness.token}` } });
      assert.equal(destroy.status, 200);
      assert.equal((await destroy.json() as { status: string }).status, "destroyed");
      const destroyRetry = await fetch(`${harness.baseUrl}/api/v1/conversations/${first.conversationId}`, { method: "DELETE", headers: { Authorization: `Bearer ${harness.token}` } });
      assert.equal(destroyRetry.status, 200);
      assert.deepEqual(harness.destroyedCells, [`cell-${first.conversationId}`]);
      const recreate = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" }, "cell-key-a");
      assert.equal(recreate.status, 410);
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
        workspaceId: "default", model: "test/model", extra: "x".repeat(4 * 1024 * 1024 + 1),
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
      assert.equal(harness.turns.at(-1)?.cellId, `cell-${conversation.conversationId}`);
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

describe("Aster chat/code projects, GitHub, and artifacts", () => {
  it("lists and creates repositories and provisions code and chat conversations", async () => {
    const harness = await createHarness("complete");
    try {
      const listed = await (await request(harness, "GET", "/api/v1/github/repositories?q=app")).json() as { repositories: Array<{ fullName: string }> };
      assert.deepEqual(listed.repositories.map((r) => r.fullName), ["me/app"]);
      const created = await request(harness, "POST", "/api/v1/github/repositories", { name: "fresh", private: true });
      assert.equal(created.status, 201);
      assert.deepEqual(harness.createdRepositories, ["me/fresh"]);

      const missing = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "code", repository: "me/nope" });
      assert.equal(missing.status, 404);
      const noRepo = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "code" });
      assert.equal(noRepo.status, 400);

      const code = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "code", repository: "me/app" });
      assert.equal(code.status, 201);
      const codeBody = await code.json() as { conversationId: string; kind: string; repository: string; branch: string };
      assert.equal(codeBody.kind, "code");
      assert.equal(codeBody.repository, "me/app");
      assert.equal(codeBody.branch, `aster/${codeBody.conversationId.slice(0, 8)}`);
      assert.deepEqual(harness.provisionedProjects.at(-1), { kind: "code", repository: "me/app", baseBranch: "main", branch: codeBody.branch });

      const chat = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "chat" });
      assert.equal(chat.status, 201);
      assert.deepEqual(harness.provisionedProjects.at(-1), { kind: "chat" });
      const fetched = await (await request(harness, "GET", `/api/v1/conversations/${codeBody.conversationId}`)).json() as { kind: string };
      assert.equal(fetched.kind, "code");

      const legacy = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      assert.equal(legacy.status, 201);
      assert.equal(harness.provisionedProjects.at(-1), undefined);
    } finally {
      await harness.close();
    }
  });

  it("accepts long pasted documents as a turn", async () => {
    const harness = await createHarness("hang");
    try {
      const created = await (await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "chat" })).json() as { conversationId: string };
      const document = "Section about the product strategy and roadmap. ".repeat(2_100); // ~100k characters
      const turn = await request(harness, "POST", `/api/v1/conversations/${created.conversationId}/turns`, { clientTurnId: "long-1", text: `Summarize this:\n${document}` });
      assert.equal(turn.status, 202);
      assert.equal(harness.turns.at(-1)!.userText.length > 100_000, true);
    } finally {
      await harness.close();
    }
  });

  it("lists artifacts and downloads one as an attachment", async () => {
    const harness = await createHarness("complete");
    try {
      const created = await (await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model", kind: "chat" })).json() as { conversationId: string };
      const base = `/api/v1/conversations/${created.conversationId}/artifacts`;
      const list = await (await request(harness, "GET", base)).json() as { artifacts: Array<{ path: string }> };
      assert.deepEqual(list.artifacts.map((a) => a.path), ["deck.pdf"]);
      const file = await request(harness, "GET", `${base}/file?path=deck.pdf`);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get("content-type"), "application/pdf");
      assert.match(file.headers.get("content-disposition") ?? "", /deck\.pdf/);
      assert.equal(await file.text(), "%PDF");
      assert.equal((await request(harness, "GET", `${base}/file?path=../secret`)).status, 400);
      assert.equal((await request(harness, "GET", `${base}/file?path=missing.pdf`)).status, 404);
    } finally {
      await harness.close();
    }
  });
});

describe("Aster model catalog, model switching, and checkpoints", () => {
  it("offers the tool-capable OpenRouter catalog and switches models between turns", async () => {
    const harness = await createHarness("complete", { openRouterCatalog: true });
    try {
      const models = await request(harness, "GET", "/api/v1/models");
      assert.equal(models.status, 200);
      const body = await models.json() as { models: string[]; catalog: Array<{ id: string; contextWindow: number }> };
      assert.deepEqual(body.models, ["test/model", "vendor/other-model"]);
      assert.equal(body.catalog[0]!.contextWindow, 200_000);

      const rejected = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "vendor/no-tools" });
      assert.equal(rejected.status, 400);

      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      assert.equal(created.status, 201);
      const conversation = await created.json() as { conversationId: string };

      const first = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { text: "hi", model: "test/model" });
      assert.equal(first.status, 202);
      await waitForStatus(harness, conversation.conversationId, "completed");
      assert.deepEqual(harness.modelSwitches, []);

      const badModel = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { text: "hi", model: "vendor/unknown" });
      assert.equal(badModel.status, 400);

      const switched = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { text: "again", model: "vendor/other-model" });
      assert.equal(switched.status, 202);
      await waitForStatus(harness, conversation.conversationId, "completed");
      assert.deepEqual(harness.modelSwitches, [{ cellId: `cell-${conversation.conversationId}`, model: "vendor/other-model" }]);
      const fetched = await (await request(harness, "GET", `/api/v1/conversations/${conversation.conversationId}`)).json() as { model: string };
      assert.equal(fetched.model, "vendor/other-model");
    } finally {
      await harness.close();
    }
  });

  it("lists and restores checkpoints only between turns", async () => {
    const harness = await createHarness("hang");
    try {
      const created = await request(harness, "POST", "/api/v1/conversations", { workspaceId: "default", model: "test/model" });
      const conversation = await created.json() as { conversationId: string };
      const base = `/api/v1/conversations/${conversation.conversationId}/checkpoints`;

      const list = await request(harness, "GET", base);
      assert.equal(list.status, 200);
      const listed = await list.json() as { checkpoints: Array<{ id: string; message: string }> };
      assert.deepEqual(listed.checkpoints.map((checkpoint) => checkpoint.message), ["second", "Workspace created"]);

      const missing = await request(harness, "POST", `${base}/${"d".repeat(40)}/restore`, {});
      assert.equal(missing.status, 404);
      const restored = await request(harness, "POST", `${base}/${"a".repeat(40)}/restore`, {});
      assert.equal(restored.status, 200);
      assert.deepEqual(harness.restores, [{ cellId: `cell-${conversation.conversationId}`, checkpointId: "a".repeat(40) }]);

      const turn = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { text: "work" });
      assert.equal(turn.status, 202);
      const busy = await request(harness, "POST", `${base}/${"a".repeat(40)}/restore`, {});
      assert.equal(busy.status, 409);
      const busySwitch = await request(harness, "POST", `/api/v1/conversations/${conversation.conversationId}/turns`, { text: "x", model: "test/model" });
      assert.equal(busySwitch.status, 409);
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
  destroyedCells: string[];
  pausedCells: string[];
  resumedCells: string[];
  modelSwitches: Array<{ cellId: string; model: string }>;
  restores: Array<{ cellId: string; checkpointId: string }>;
  provisionedProjects: Array<unknown>;
  createdRepositories: string[];
  close(): Promise<void>;
}

async function createHarness(mode: "complete" | "hang" | "approval", options: { openRouterCatalog?: boolean } = {}): Promise<Harness> {
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
    models: options.openRouterCatalog ? "openrouter" : ["test/model"],
    approvalTtlMs: 1500,
    workspaces: [{ id: "default", displayName: "Default workspace", rootPath: workspaceRoot }],
  }));
  setEnv("XDG_DATA_HOME", dataHome);
  setEnv("XDG_STATE_HOME", stateHome);
  setEnv("AUTOPILOT_ASTER_DB", asterDb);
  setEnv("AUTOPILOT_RUNS_DB", runsDb);
  setEnv("AUTOPILOT_ASTER_CONFIG", configPath);
  setEnv("KIMIFLARE_SERVER_PASSWORD", "legacy-only-secret");
  setEnv("AUTOPILOT_ASTER_MEMORY", "off");
  if (options.openRouterCatalog) {
    // A fresh on-disk catalog cache, so the test never reaches the network.
    const configHome = join(root, "config-home");
    await mkdir(join(configHome, "kimiflare"), { recursive: true });
    const entry = (id: string, tools: boolean) => ({
      id, name: id, contextWindow: 200_000, maxOutputTokens: 8_000,
      pricing: { inputPerMtok: 1, outputPerMtok: 2 }, supports: { tools, reasoning: true, streaming: true },
    });
    await writeFile(join(configHome, "kimiflare", "openrouter-models.json"), JSON.stringify({
      version: 4,
      fetchedAt: new Date().toISOString(),
      models: [entry("test/model", true), entry("vendor/other-model", true), entry("vendor/no-tools", false)],
    }));
    setEnv("XDG_CONFIG_HOME", configHome);
  }

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
  const destroyedCells: string[] = [];
  const pausedCells: string[] = [];
  const resumedCells: string[] = [];
  const modelSwitches: Array<{ cellId: string; model: string }> = [];
  const restores: Array<{ cellId: string; checkpointId: string }> = [];
  const provisionedProjects: Array<unknown> = [];
  const createdRepositories: string[] = [];
  const repo = (fullName: string) => ({
    fullName, name: fullName.split("/")[1]!, owner: fullName.split("/")[0]!, private: true,
    description: null, defaultBranch: "main", updatedAt: null,
  });
  const fakeGitHub = {
    configured: true,
    listRepositories: async (query: string) => [repo("me/app"), repo("me/site")].filter((r) => r.fullName.includes(query)),
    getRepository: async (fullName: string) => {
      if (fullName !== "me/app" && !createdRepositories.includes(fullName)) throw new AsterGitHubError("Repository not found", 404, "repository_not_found");
      return repo(fullName);
    },
    createRepository: async (input: { name: string }) => {
      createdRepositories.push(`me/${input.name}`);
      return repo(`me/${input.name}`);
    },
  } as unknown as AsterGitHub;
  const api = new AsterApi({ openrouterApiKey: "test-key", model: "test/model" } as KimiConfig, {
    provisionConversation: async (input) => {
      provisionedProjects.push(input.project);
      input.onCellCreated(`cell-${input.conversationId}`);
      return { cellId: `cell-${input.conversationId}` };
    },
    destroyCell: async (cellId) => { destroyedCells.push(cellId); },
    pauseCell: async (cellId) => { pausedCells.push(cellId); },
    resumeCell: async (cellId) => { resumedCells.push(cellId); },
    startTurn: (turn) => {
      turns.push(turn);
      if (mode === "complete") void completeTurn(turn, `reply-${turns.length}`);
      else if (mode === "approval") void approveWriteTurn(turn, permissionDecisions);
    },
    cancelRun: (runId) => { cancelledRuns.push(runId); },
    setModel: async (cellId, model) => { modelSwitches.push({ cellId, model }); },
    listCheckpoints: async () => [
      { id: "b".repeat(40), message: "second", createdAt: "2026-10-05T10:01:00Z" },
      { id: "a".repeat(40), message: "Workspace created", createdAt: "2026-10-05T10:00:00Z" },
    ],
    restoreCheckpoint: async (cellId, _conversationId, checkpointId) => {
      if (checkpointId !== "a".repeat(40)) throw new Error("checkpoint_not_found");
      restores.push({ cellId, checkpointId });
      return { id: "c".repeat(40), message: "Restore checkpoint aaaaaaa", createdAt: "2026-10-05T10:02:00Z" };
    },
    listArtifacts: async () => [{ path: "deck.pdf", name: "deck.pdf", size: 4, modifiedAt: "2026-10-05T10:03:00Z", mimeType: "application/pdf" }],
    readArtifact: async (_cellId, path) => {
      if (path.includes("..")) throw new Error("invalid_artifact_path");
      if (path !== "deck.pdf") throw new Error("artifact_not_found");
      return { data: Buffer.from("%PDF"), mimeType: "application/pdf", name: "deck.pdf" };
    },
  }, fakeGitHub);
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
    destroyedCells,
    pausedCells,
    resumedCells,
    modelSwitches,
    restores,
    provisionedProjects,
    createdRepositories,
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
  const decision = await turn.askPermission({
    tool: { name: "write" },
    args: { path: "created.txt", content: "safe content" },
  } as never);
  decisions.push(typeof decision === "string" ? decision : decision.decision);
  await completeTurn(turn, decisions.at(-1) === "allow" ? "The write was approved." : "The write was denied.");
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

async function request(harness: Harness, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${harness.token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(path === "/api/v1/conversations" && method === "POST"
        ? { "Idempotency-Key": idempotencyKey ?? `test-create-${Math.random().toString(36).slice(2)}` }
        : {}),
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
