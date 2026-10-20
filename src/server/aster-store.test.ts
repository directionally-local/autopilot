import Database from "better-sqlite3";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterStore } from "./aster-store.js";

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
    const legacy = new Database(dbPath);
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
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-store-")));
  roots.push(root);
  return root;
}
