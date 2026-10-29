import { SqliteDatabase } from "../util/sqlite.js";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterStore, asterConversationState } from "./aster-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("AsterStore", () => {
  it("issues workspace-scoped bearer credentials and revokes them", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const created = store.createCredential({
        name: "iPhone",
        workspaceIds: ["default"],
        scopes: ["workspaces:read", "conversations:read", "conversations:write"],
        expiresAt: Date.now() + 60_000,
      });
      assert.match(created.token, /^aster_[A-Za-z0-9_-]{40,}$/);
      const principal = store.authenticate(`Bearer ${created.token}`);
      assert.equal(principal?.credentialId, created.id);
      assert.deepEqual(principal?.workspaceIds, ["default"]);
      assert.equal(store.authenticate(`Basic ${created.token}`), undefined);
      assert.equal(store.revokeCredential(created.id), true);
      assert.equal(store.authenticate(`Bearer ${created.token}`), undefined);
      assert.equal(store.revokeCredential(created.id), true);
    } finally {
      store.close();
    }
  });

  it("persists conversations, serializes turns, and replays events after a cursor", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "aster.db");
    let store = new AsterStore(dbPath);
    const conversation = store.createConversation({
      id: "conv-opaque-1",
      workspaceId: "default",
      model: "test/model",
      sessionId: "session-opaque-1",
      worktreePath: join(root, "worktrees", "conv-opaque-1"),
      cwd: join(root, "worktrees", "conv-opaque-1"),
      branch: "autopilot/run/conv-opaque-1",
    });
    try {
      assert.equal(conversation.status, "ready");
      assert.equal(store.beginTurn(conversation.id, "run-1"), true);
      assert.equal(store.beginTurn(conversation.id, "run-2"), false);
      assert.equal(store.updateConversationStatus(conversation.id, "run-1", "waiting_approval"), true);
      store.appendEvent(conversation.id, "run-1", "approval.required", { approvalId: "approval-1" });
      assert.equal(store.updateConversationStatus(conversation.id, "run-1", "running"), true);
      assert.equal(store.updateConversationStatus(conversation.id, "run-1", "completed"), true);
      assert.equal(store.beginTurn(conversation.id, "run-2"), true);
      assert.deepEqual(store.eventsAfter(conversation.id, 1).map((event) => event.sequence), [2, 3, 4, 5, 6, 7]);
      store.close();
      store = new AsterStore(dbPath);
      const restored = store.getConversation(conversation.id);
      assert.equal(restored?.workspaceId, "default");
      assert.equal(restored?.model, "test/model");
      assert.equal(restored?.status, "running");
      assert.equal(restored?.activeRunId, "run-2");
    } finally {
      try { store.close(); } catch { /* closed before reopening */ }
    }
  });

  it("resolves only hashed GitHub grants bound to their code conversation", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      store.createConversation({
        id: "conv-code-grant",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-code-grant",
        worktreePath: join(root, "workspace"),
        cwd: join(root, "workspace"),
        branch: "aster/12345678",
        kind: "code",
        repository: "me/app",
        baseBranch: "main",
      });
      const token = "grant-token-" + "x".repeat(40);
      store.createGitHubGrant("conv-code-grant", token);
      assert.deepEqual(store.resolveGitHubGrant(token), {
        conversationId: "conv-code-grant",
        repository: "me/app",
        branch: "aster/12345678",
      });
      assert.equal(store.resolveGitHubGrant("not-the-grant"), undefined);
    } finally {
      store.close();
    }
  });

  it("migrates an existing database additively and persists accepted turn replay across reopen", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "aster.db");
    await mkdir(join(root, "state"));
    const now = Date.now();
    const legacy = new SqliteDatabase(dbPath);
    legacy.exec("CREATE TABLE aster_conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, worktree_path TEXT NOT NULL, cwd TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, last_event_sequence INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    legacy.prepare("INSERT INTO aster_conversations (id, workspace_id, model, session_id, worktree_path, cwd, branch, status, active_run_id, last_event_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("conv-legacy", "default", "test/model", "session-legacy", join(root, "worktree"), join(root, "worktree"), "branch", "ready", null, 0, now, now);
    legacy.close();

    let store = new AsterStore(dbPath);
    try {
      assert.equal(store.getConversation("conv-legacy")?.workspaceId, "default");
      const response = { conversationId: "conv-legacy", clientTurnId: "retry-1", runId: "run-legacy", status: "running" };
      assert.deepEqual(store.reserveTurn({
        conversationId: "conv-legacy",
        clientTurnId: "retry-1",
        requestText: "accepted text",
        acceptedText: "accepted text",
        runId: "run-legacy",
        response,
      }), { kind: "reserved" });
      store.close();
      store = new AsterStore(dbPath);
      const replay = store.lookupTurn("conv-legacy", "retry-1", "accepted text");
      assert.equal(replay.kind, "replay");
      if (replay.kind === "replay") {
        assert.equal(replay.runId, "run-legacy");
        assert.equal(replay.responseStatus, 202);
        assert.deepEqual(replay.response, response);
      }
      assert.equal(store.lookupTurn("conv-legacy", "retry-1", "different text").kind, "conflict");
    } finally {
      try { store.close(); } catch { /* closed before reopening */ }
    }
  });

  it("makes approval resolution single-use and idempotent; expiry denies", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      store.createConversation({
        id: "conv-approval",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-approval",
        worktreePath: join(root, "worktrees", "approval"),
        cwd: join(root, "worktrees", "approval"),
        branch: "autopilot/run/approval",
      });
      const pending = store.createApproval({
        conversationId: "conv-approval",
        runId: "run-approval",
        toolName: "write",
        explanation: "Create a source file",
        arguments: { path: "src/a.ts", content: "safe" },
        expiresAt: Date.now() + 60_000,
      });
      const allowed = store.resolveApproval(pending.id, "allow");
      assert.equal(allowed.approval?.status, "approved");
      assert.equal(allowed.changed, true);
      assert.equal(store.resolveApproval(pending.id, "allow").changed, false);
      assert.equal(store.resolveApproval(pending.id, "allow").conflict, false);
      assert.equal(store.resolveApproval(pending.id, "deny").conflict, true);

      const expiring = store.createApproval({
        conversationId: "conv-approval",
        runId: "run-expiring",
        toolName: "edit",
        explanation: "Edit a source file",
        arguments: { path: "src/a.ts", old_string: "a", new_string: "b" },
        expiresAt: 100,
      });
      const expired = store.resolveApproval(expiring.id, "allow", 101);
      assert.equal(expired.approval?.status, "expired");
      assert.equal(expired.conflict, true);
      assert.equal(expired.changed, true);
    } finally {
      store.close();
    }
  });

  it("pairs a device: pending until approved, then exactly one client credential", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const now = Date.now();
      const started = store.createDeviceAuthorization({ clientName: "Laptop", ttlMs: 600_000, maxPending: 5 }, now)!;
      assert.match(started.userCode, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
      assert.equal(store.redeemDeviceAuthorization(started.deviceCode, now).kind, "pending");
      assert.equal(store.redeemDeviceAuthorization(started.deviceCode, now + 1_000).kind, "slow_down");
      assert.equal(store.redeemDeviceAuthorization(started.deviceCode, now + 10_000).kind, "pending");
      assert.deepEqual(store.listPendingDeviceAuthorizations(now).map((entry) => entry.userCode), [started.userCode]);

      // Codes are accepted however they're typed.
      const typed = started.userCode.toLowerCase().replace("-", " ");
      assert.equal(store.resolveDeviceAuthorization(typed, "approve", { workspaceIds: ["default"], credentialTtlMs: 60_000 }, now), "approved");
      assert.equal(store.resolveDeviceAuthorization(started.userCode, "deny", { workspaceIds: ["default"], credentialTtlMs: 60_000 }, now), "already_resolved");

      const issued = store.redeemDeviceAuthorization(started.deviceCode, now + 20_000);
      assert.ok(issued.kind === "issued");
      assert.equal(issued.credential.name, "Laptop");
      assert.deepEqual(issued.credential.workspaceIds, ["default"]);
      assert.ok(!issued.credential.scopes.includes("pairing:approve"));
      assert.equal(store.authenticate(`Bearer ${issued.credential.token}`, now + 20_000)?.credentialId, issued.credential.id);
      assert.equal(store.redeemDeviceAuthorization(started.deviceCode, now + 30_000).kind, "expired", "a device code is single-use");

      const denied = store.createDeviceAuthorization({ clientName: "Stranger", ttlMs: 600_000, maxPending: 5 }, now)!;
      assert.equal(store.resolveDeviceAuthorization(denied.userCode, "deny", { workspaceIds: ["default"], credentialTtlMs: 60_000 }, now), "denied");
      assert.equal(store.redeemDeviceAuthorization(denied.deviceCode, now).kind, "denied");

      const stale = store.createDeviceAuthorization({ clientName: "Late", ttlMs: 1_000, maxPending: 5 }, now)!;
      assert.equal(store.resolveDeviceAuthorization(stale.userCode, "approve", { workspaceIds: ["default"], credentialTtlMs: 60_000 }, now + 2_000), "expired");
      assert.equal(store.redeemDeviceAuthorization(stale.deviceCode, now + 2_000).kind, "expired");
      assert.equal(store.resolveDeviceAuthorization("ZZZZ-ZZZZ", "approve", { workspaceIds: ["default"], credentialTtlMs: 60_000 }, now), "not_found");
    } finally {
      store.close();
    }
  });

  it("caps pending pairings so unauthenticated callers can't fill the table", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const now = Date.now();
      assert.ok(store.createDeviceAuthorization({ clientName: "a", ttlMs: 1_000, maxPending: 2 }, now));
      assert.ok(store.createDeviceAuthorization({ clientName: "b", ttlMs: 1_000, maxPending: 2 }, now));
      assert.equal(store.createDeviceAuthorization({ clientName: "c", ttlMs: 1_000, maxPending: 2 }, now), undefined);
      assert.ok(store.createDeviceAuthorization({ clientName: "d", ttlMs: 1_000, maxPending: 2 }, now + 5_000), "expired codes stop counting");
    } finally {
      store.close();
    }
  });

  it("lists credentials without tokens, with their status", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const laptop = store.createCredential({ name: "MacBook", workspaceIds: ["default"], scopes: ["conversations:read"], expiresAt: Date.now() + 60_000 });
      const old = store.createCredential({ name: "Old phone", workspaceIds: ["default"], scopes: ["conversations:read"], expiresAt: Date.now() + 60_000 });
      store.revokeCredential(old.id);
      store.authenticate(`Bearer ${laptop.token}`);
      const listed = store.listCredentials();
      assert.deepEqual(listed.map((entry) => [entry.name, entry.status]).sort(), [["MacBook", "active"], ["Old phone", "revoked"]]);
      assert.ok(listed.find((entry) => entry.name === "MacBook")?.lastUsedAt);
      assert.ok(!JSON.stringify(listed).includes(laptop.token), "tokens are never listed");
      assert.equal(store.listCredentials(Date.now() + 120_000).find((entry) => entry.name === "MacBook")?.status, "expired");
    } finally {
      store.close();
    }
  });

  it("lists every credential's runs, newest first, with who started each", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const laptop = store.createCredential({ name: "MacBook", workspaceIds: ["default"], scopes: ["conversations:read"], expiresAt: Date.now() + 60_000 });
      for (const [index, id] of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].entries()) {
        store.reserveCellConversation({ conversationId: id, credentialId: laptop.id, workspaceId: "default", model: "m", sessionId: `s-${index}`, cellName: `aster-${id}`, idempotencyKey: `k-${index}` });
        store.createConversation({ id, workspaceId: "default", model: "m", sessionId: `s-${index}`, worktreePath: "/workspace", cwd: "/workspace", branch: `aster/${index}`, kind: "code", repository: "me/app", baseBranch: "main" });
      }
      const runs = store.listAllConversations(10);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.credentialName === "MacBook" && run.repository === "me/app"));
      assert.equal(store.listAllConversations(1).length, 1);
    } finally {
      store.close();
    }
  });

  it("redeems an owner claim once for a pairing:approve-only credential", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const claim = store.createOwnerClaim(60_000);
      assert.match(claim.token, /^aster_claim_/);
      const owner = store.redeemOwnerClaim(claim.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 });
      assert.deepEqual(owner?.scopes, ["pairing:approve"]);
      assert.equal(store.redeemOwnerClaim(claim.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
      const expired = store.createOwnerClaim(1_000, Date.now() - 10_000);
      assert.equal(store.redeemOwnerClaim(expired.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
      assert.equal(store.redeemOwnerClaim("aster_claim_short", { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
    } finally {
      store.close();
    }
  });

  it("keeps a sidebar summary per conversation without replaying events", async () => {
    const root = await fixture();
    const store = new AsterStore(join(root, "state", "aster.db"));
    try {
      const conversation = store.createConversation({
        id: "conv-summary",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-summary",
        worktreePath: join(root, "workspace"),
        cwd: join(root, "workspace"),
        branch: "aster/12345678",
      });
      assert.equal(conversation.title, null);
      assert.equal(conversation.costUsd, 0);
      assert.equal(conversation.lastError, null);
      assert.equal(conversation.lastActivityAt, conversation.updatedAt);

      store.setConversationTitle(conversation.id, "  Fix the flaky test  \nand keep it short");
      store.setConversationTitle(conversation.id, "a later turn never renames it");
      assert.equal(store.getConversation(conversation.id)?.title, "Fix the flaky test");

      assert.equal(store.beginTurn(conversation.id, "run-1"), true);
      store.appendEvent(conversation.id, "run-1", "usage", { inputTokens: 10, outputTokens: 2, costUsd: 0.25, cumulative: true });
      store.appendEvent(conversation.id, "run-1", "usage", { inputTokens: 20, outputTokens: 4, costUsd: 0.5, cumulative: true });
      assert.equal(store.getConversation(conversation.id)?.costUsd, 0.5, "cumulative usage replaces, never double-counts");
      assert.equal(store.updateConversationStatus(conversation.id, "run-1", "failed", { reason: "cell_turn_stalled" }), true);
      const failed = store.getConversation(conversation.id)!;
      assert.equal(failed.lastError, "cell_turn_stalled");
      assert.equal(asterConversationState(failed.status), "failed");

      assert.equal(store.beginTurn(conversation.id, "run-2"), true);
      assert.equal(store.getConversation(conversation.id)?.lastError, null, "a new turn clears the previous error");
      store.appendEvent(conversation.id, "run-2", "usage", { inputTokens: 5, outputTokens: 1, costUsd: 0.125, cumulative: true });
      assert.equal(store.getConversation(conversation.id)?.costUsd, 0.625, "each run's usage adds to the conversation total");

      const approval = store.createApproval({
        conversationId: conversation.id,
        runId: "run-2",
        toolName: "write",
        explanation: "Create or replace created.txt\nin this workspace",
        arguments: { path: "created.txt" },
        expiresAt: Date.now() + 60_000,
      });
      assert.deepEqual(store.pendingApprovalSummaries([conversation.id]).get(conversation.id), {
        tool: "write",
        summary: "Create or replace created.txt in this workspace",
      });
      assert.equal(store.pendingApprovalSummaries([]).size, 0);
      store.resolveApproval(approval.id, "allow");
      assert.equal(store.pendingApprovalSummaries([conversation.id]).size, 0);

      const before = store.getConversation(conversation.id)!.lastActivityAt;
      await new Promise((resolve) => setTimeout(resolve, 5));
      store.appendEvent(conversation.id, "run-2", "assistant.delta", { text: "hi" });
      assert.ok(store.getConversation(conversation.id)!.lastActivityAt > before);

      assert.equal(asterConversationState("provisioning"), "working");
      assert.equal(asterConversationState("running"), "working");
      assert.equal(asterConversationState("waiting_approval"), "blocked");
      assert.equal(asterConversationState("ready"), "idle");
      assert.equal(asterConversationState("paused"), "idle");
      assert.equal(asterConversationState("completed"), "done");
      assert.equal(asterConversationState("merged"), "done");
      assert.equal(asterConversationState("failed"), "failed");
      assert.equal(asterConversationState("cancelled"), "failed");
      assert.equal(asterConversationState("interrupted"), "failed");
    } finally {
      store.close();
    }
  });
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-store-")));
  roots.push(root);
  return root;
}
