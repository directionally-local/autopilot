import { SqliteDatabase } from "../util/sqlite.js";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CREDENTIAL_RENEWAL_GRACE_MS, CREDENTIAL_RENEWAL_MIN_INTERVAL_MS, DL_CLIENT_SCOPES, DlStore } from "./dl-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DlStore", () => {
  it("issues workspace-scoped bearer credentials and revokes them", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const created = store.createCredential({
        name: "iPhone",
        workspaceIds: ["default"],
        scopes: ["workspaces:read", "conversations:read", "conversations:write"],
        expiresAt: Date.now() + 60_000,
      });
      assert.match(created.token, /^dl_[A-Za-z0-9_-]{40,}$/);
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

  it("accepts credentials issued before the rename with the aster_ prefix", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "dl.db");
    const store = new DlStore(dbPath);
    try {
      const created = store.createCredential({
        name: "Old phone",
        workspaceIds: ["default"],
        scopes: ["conversations:read"],
        expiresAt: Date.now() + 60_000,
      });
      const legacyToken = `aster_${"a".repeat(43)}`;
      const db = new SqliteDatabase(dbPath);
      db.prepare("UPDATE aster_credentials SET token_hash = ? WHERE id = ?")
        .run(createHash("sha256").update(legacyToken).digest("hex"), created.id);
      db.close();
      assert.equal(store.authenticate(`Bearer ${legacyToken}`)?.credentialId, created.id);
    } finally {
      store.close();
    }
  });

  it("persists conversations, serializes turns, and replays events after a cursor", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "dl.db");
    let store = new DlStore(dbPath);
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
      store = new DlStore(dbPath);
      const restored = store.getConversation(conversation.id);
      assert.equal(restored?.workspaceId, "default");
      assert.equal(restored?.model, "test/model");
      assert.equal(restored?.status, "running");
      assert.equal(restored?.activeRunId, "run-2");
    } finally {
      try { store.close(); } catch { /* closed before reopening */ }
    }
  });

  it("detaches a cleaned cell while retaining the conversation and its events", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const conversation = store.createConversation({
        id: "conv-cleaned-1",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-cleaned-1",
        worktreePath: join(root, "workspace"),
        cwd: join(root, "workspace"),
        branch: "dl/cleaned",
        kind: "code",
        repository: "me/app",
        baseBranch: "main",
      });
      store.reserveCellConversation({
        conversationId: conversation.id,
        credentialId: "cred-1",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-cleaned-1",
        cellName: "dl-conv-cleaned-1",
        idempotencyKey: "create-cleaned-1",
        kind: "code",
        repository: "me/app",
        baseCommit: "a".repeat(40),
      });
      store.setCellId(conversation.id, "cell-cleaned-1");
      store.setCellStatus(conversation.id, "paused");
      store.setConversationStatus(conversation.id, "paused");
      store.appendEvent(conversation.id, null, "conversation.paused", {});

      assert.equal(store.beginCellCleanup(conversation.id, "cell-cleaned-1"), true);
      assert.equal(store.markCellCleaned(conversation.id, "cell-cleaned-1"), true);
      const cleaned = store.getCellMapping(conversation.id);
      assert.equal(cleaned?.status, "cleaned");
      assert.equal(cleaned?.cellId, null);
      assert.equal(store.getConversation(conversation.id)?.id, conversation.id);
      assert.ok(store.eventsAfter(conversation.id, 0).some((event) => event.type === "conversation.paused"));

      assert.equal(store.reopenCleanedCell(conversation.id, "session-cleaned-2"), true);
      const reopened = store.getCellMapping(conversation.id);
      assert.equal(reopened?.status, "provisioning");
      assert.equal(reopened?.sessionId, "session-cleaned-2");
      assert.equal(reopened?.createAttempted, false);
    } finally {
      store.close();
    }
  });

  it("refuses to clean a cell with an active run or a pending approval", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const conversation = store.createConversation({
        id: "conv-busy-1",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-busy-1",
        worktreePath: join(root, "workspace"),
        cwd: join(root, "workspace"),
        branch: "dl/busy",
      });
      store.reserveCellConversation({
        conversationId: conversation.id,
        credentialId: "cred-1",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-busy-1",
        cellName: "dl-conv-busy-1",
        idempotencyKey: "create-busy-1",
      });
      store.setCellId(conversation.id, "cell-busy-1");
      store.setCellStatus(conversation.id, "paused");
      store.setConversationStatus(conversation.id, "paused");
      assert.equal(store.beginTurn(conversation.id, "run-busy-1"), true);
      assert.equal(store.beginCellCleanup(conversation.id, "cell-busy-1"), false);
      store.updateConversationStatus(conversation.id, "run-busy-1", "completed");
      store.createApproval({
        conversationId: conversation.id,
        runId: "run-busy-1",
        toolName: "bash",
        explanation: "run a command",
        arguments: {},
        expiresAt: Date.now() + 60_000,
      });
      assert.equal(store.beginCellCleanup(conversation.id, "cell-busy-1"), false);
    } finally {
      store.close();
    }
  });

  it("resolves only hashed GitHub grants bound to their code conversation", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      store.createConversation({
        id: "conv-code-grant",
        workspaceId: "default",
        model: "test/model",
        sessionId: "session-code-grant",
        worktreePath: join(root, "workspace"),
        cwd: join(root, "workspace"),
        branch: "dl/12345678",
        kind: "code",
        repository: "me/app",
        baseBranch: "main",
      });
      const token = "grant-token-" + "x".repeat(40);
      store.createGitHubGrant("conv-code-grant", token);
      assert.deepEqual(store.resolveGitHubGrant(token), {
        conversationId: "conv-code-grant",
        repository: "me/app",
        branch: "dl/12345678",
      });
      assert.equal(store.resolveGitHubGrant("not-the-grant"), undefined);
    } finally {
      store.close();
    }
  });

  it("migrates an existing database additively and persists accepted turn replay across reopen", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "dl.db");
    await mkdir(join(root, "state"));
    const now = Date.now();
    const legacy = new SqliteDatabase(dbPath);
    legacy.exec("CREATE TABLE aster_conversations (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, model TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE, worktree_path TEXT NOT NULL, cwd TEXT NOT NULL, branch TEXT NOT NULL, status TEXT NOT NULL, active_run_id TEXT, last_event_sequence INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    legacy.prepare("INSERT INTO aster_conversations (id, workspace_id, model, session_id, worktree_path, cwd, branch, status, active_run_id, last_event_sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("conv-legacy", "default", "test/model", "session-legacy", join(root, "worktree"), join(root, "worktree"), "branch", "ready", null, 0, now, now);
    legacy.close();

    let store = new DlStore(dbPath);
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
      store = new DlStore(dbPath);
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
    const store = new DlStore(join(root, "state", "dl.db"));
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
    const store = new DlStore(join(root, "state", "dl.db"));
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

  it("renews a credential in place: same id, new token and expiry, old token valid for a grace period", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const issuedAt = Date.now();
      const phone = store.createCredential({ name: "iPhone", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: issuedAt + 90 * 24 * 60 * 60 * 1000 });
      const lifetime = phone.expiresAt - phone.createdAt;
      store.reserveCellConversation({ conversationId: "conv-1", credentialId: phone.id, workspaceId: "default", model: "m", sessionId: "s-1", cellName: "cell-1", idempotencyKey: "k-1" });

      const at = issuedAt + 80 * 24 * 60 * 60 * 1000;
      const renewal = store.renewCredential(`Bearer ${phone.token}`, at);
      assert.ok(renewal.kind === "renewed");
      assert.equal(renewal.credential.id, phone.id, "renewal keeps the credential, and with it the conversations");
      assert.notEqual(renewal.credential.token, phone.token);
      assert.equal(renewal.credential.expiresAt, at + lifetime, "the same lifetime it was granted, counted from now");
      assert.equal(renewal.credential.name, "iPhone");
      assert.deepEqual(renewal.credential.scopes, DL_CLIENT_SCOPES);
      assert.equal(renewal.previousTokenValidUntil, at + CREDENTIAL_RENEWAL_GRACE_MS);
      assert.equal(store.getCredentialCellMapping("conv-1", renewal.credential.id)?.credentialId, phone.id);

      const fresh = store.checkCredential(`Bearer ${renewal.credential.token}`, at + 1);
      assert.ok(fresh.kind === "active");
      assert.equal(fresh.principal.credentialId, phone.id);
      assert.equal(fresh.principal.expiresAt, at + lifetime);
      assert.equal(fresh.principal.superseded, false);

      // The old token keeps working (with its grace expiry) only until the grace period ends.
      const inGrace = store.checkCredential(`Bearer ${phone.token}`, at + CREDENTIAL_RENEWAL_GRACE_MS - 1);
      assert.ok(inGrace.kind === "active");
      assert.equal(inGrace.principal.credentialId, phone.id);
      assert.equal(inGrace.principal.superseded, true);
      assert.equal(inGrace.principal.expiresAt, at + CREDENTIAL_RENEWAL_GRACE_MS);
      assert.equal(store.checkCredential(`Bearer ${phone.token}`, at + CREDENTIAL_RENEWAL_GRACE_MS).kind, "expired");
      assert.equal(store.authenticate(`Bearer ${renewal.credential.token}`, at + CREDENTIAL_RENEWAL_GRACE_MS)?.credentialId, phone.id);

      // A replaced token can't renew again, and renewals are spaced out.
      assert.equal(store.renewCredential(`Bearer ${phone.token}`, at + 1_000).kind, "superseded");
      const tooSoon = store.renewCredential(`Bearer ${renewal.credential.token}`, at + 1_000);
      assert.ok(tooSoon.kind === "too_soon");
      assert.equal(tooSoon.retryAfterMs, CREDENTIAL_RENEWAL_MIN_INTERVAL_MS - 1_000);
      const later = at + CREDENTIAL_RENEWAL_MIN_INTERVAL_MS;
      const second = store.renewCredential(`Bearer ${renewal.credential.token}`, later);
      assert.ok(second.kind === "renewed");
      assert.equal(second.credential.expiresAt, later + lifetime);
      assert.equal(store.checkCredential(`Bearer ${phone.token}`, later + 1).kind, "invalid", "only the latest replaced token has a grace period");

      assert.deepEqual(store.listCredentialAudit(phone.id).map((entry) => [entry.event, entry.createdAt]), [["renewed", at], ["renewed", later]]);
      const auditRows = JSON.stringify(store.listCredentialAudit(phone.id));
      for (const token of [phone.token, renewal.credential.token, second.credential.token]) assert.ok(!auditRows.includes(token));
    } finally {
      store.close();
    }
  });

  it("refuses to renew expired, revoked, unknown, or owner credentials, and tells expired from revoked", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const now = Date.now();
      const expiring = store.createCredential({ name: "Old", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      assert.equal(store.renewCredential(`Bearer ${expiring.token}`, now + 60_000).kind, "expired");
      assert.equal(store.checkCredential(`Bearer ${expiring.token}`, now + 60_000).kind, "expired");

      const revoked = store.createCredential({ name: "Lost", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      store.revokeCredential(revoked.id, now);
      assert.equal(store.renewCredential(`Bearer ${revoked.token}`, now).kind, "revoked");
      assert.equal(store.checkCredential(`Bearer ${revoked.token}`, now).kind, "revoked");
      assert.equal(store.checkCredential(`Bearer ${revoked.token}`, now + 120_000).kind, "revoked", "revocation wins over expiry");

      assert.equal(store.renewCredential(`Bearer dl_${"x".repeat(43)}`, now).kind, "invalid");
      assert.equal(store.renewCredential("Bearer nope", now).kind, "invalid");
      assert.equal(store.renewCredential(undefined, now).kind, "invalid");
      assert.equal(store.checkCredential(`Basic ${expiring.token}`, now).kind, "invalid");

      const owner = store.createCredential({ name: "Owner (browser)", workspaceIds: ["default"], scopes: ["pairing:approve"], expiresAt: now + 60_000 });
      assert.equal(store.renewCredential(`Bearer ${owner.token}`, now).kind, "not_renewable");

      // Revoking a renewed credential also ends its old token's grace period.
      const phone = store.createCredential({ name: "Phone", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      const renewed = store.renewCredential(`Bearer ${phone.token}`, now);
      assert.ok(renewed.kind === "renewed");
      store.revokeCredential(phone.id, now + 1);
      assert.equal(store.checkCredential(`Bearer ${phone.token}`, now + 2).kind, "revoked");
      assert.equal(store.checkCredential(`Bearer ${renewed.credential.token}`, now + 2).kind, "revoked");
    } finally {
      store.close();
    }
  });

  it("renews an expired, unrevoked credential through an approved pairing that offers it", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const now = Date.now();
      const grant = { workspaceIds: ["default"], credentialTtlMs: 90 * 24 * 60 * 60 * 1000 };
      const phone = store.createCredential({ name: "iPhone", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      store.reserveCellConversation({ conversationId: "conv-1", credentialId: phone.id, workspaceId: "default", model: "m", sessionId: "s-1", cellName: "cell-1", idempotencyKey: "k-1" });
      const later = now + 120_000;

      const pairing = store.createDeviceAuthorization({ clientName: "iPhone", ttlMs: 600_000, maxPending: 5, replacesToken: phone.token }, later)!;
      assert.equal(store.getDeviceAuthorization(pairing.userCode, later)?.renewsCredentialName, "iPhone", "the owner sees what approval renews");
      // Offering the token grants nothing by itself.
      assert.equal(store.redeemDeviceAuthorization(pairing.deviceCode, later).kind, "pending");
      assert.equal(store.checkCredential(`Bearer ${phone.token}`, later).kind, "expired");

      assert.equal(store.resolveDeviceAuthorization(pairing.userCode, "approve", grant, later), "approved");
      const issued = store.redeemDeviceAuthorization(pairing.deviceCode, later + 10_000);
      assert.ok(issued.kind === "issued");
      assert.equal(issued.renewed, true);
      assert.equal(issued.credential.id, phone.id, "the same credential, so its conversations stay with the phone");
      assert.equal(issued.credential.expiresAt, later + 10_000 + grant.credentialTtlMs);
      assert.notEqual(issued.credential.token, phone.token);
      assert.equal(store.authenticate(`Bearer ${issued.credential.token}`, later + 10_000)?.credentialId, phone.id);
      assert.equal(store.checkCredential(`Bearer ${phone.token}`, later + 10_000).kind, "invalid", "the expired token gets no grace period");
      assert.equal(store.getCredentialCellMapping("conv-1", phone.id)?.credentialId, phone.id);
      assert.deepEqual(store.listCredentialAudit(phone.id).map((entry) => entry.event), ["renewed_by_pairing"]);
      assert.equal(store.listCredentials(later + 10_000).length, 1, "no second credential was created");

      // A second pairing offering the same (now replaced) token gets a new credential.
      const again = store.createDeviceAuthorization({ clientName: "iPhone", ttlMs: 600_000, maxPending: 5, replacesToken: phone.token }, later + 20_000)!;
      assert.equal(store.getDeviceAuthorization(again.userCode, later + 20_000)?.renewsCredentialName, null);
      store.resolveDeviceAuthorization(again.userCode, "approve", grant, later + 20_000);
      const separate = store.redeemDeviceAuthorization(again.deviceCode, later + 30_000);
      assert.ok(separate.kind === "issued");
      assert.equal(separate.renewed, false);
      assert.notEqual(separate.credential.id, phone.id);
    } finally {
      store.close();
    }
  });

  it("never revives a revoked credential and ignores replacesToken that doesn't qualify", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const now = Date.now();
      const later = now + 120_000;
      const grant = { workspaceIds: ["default"], credentialTtlMs: 60_000 };
      const pairAndRedeem = (replacesToken: unknown, revokeBeforeRedeem?: string) => {
        const pairing = store.createDeviceAuthorization({ clientName: "iPhone", ttlMs: 600_000, maxPending: 50, replacesToken }, later)!;
        if (revokeBeforeRedeem) store.revokeCredential(revokeBeforeRedeem, later);
        assert.equal(store.resolveDeviceAuthorization(pairing.userCode, "approve", grant, later), "approved");
        const issued = store.redeemDeviceAuthorization(pairing.deviceCode, later + 10_000);
        assert.ok(issued.kind === "issued");
        return issued;
      };

      const revoked = store.createCredential({ name: "Stolen phone", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      store.revokeCredential(revoked.id, now);
      const afterRevoked = pairAndRedeem(revoked.token);
      assert.equal(afterRevoked.renewed, false);
      assert.notEqual(afterRevoked.credential.id, revoked.id);
      assert.equal(store.checkCredential(`Bearer ${revoked.token}`, later).kind, "revoked");

      // Revoked between starting the pairing and redeeming it: still not revived.
      const revokedLate = store.createCredential({ name: "Phone", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      const afterRevokedLate = pairAndRedeem(revokedLate.token, revokedLate.id);
      assert.equal(afterRevokedLate.renewed, false);
      assert.notEqual(afterRevokedLate.credential.id, revokedLate.id);
      assert.equal(store.listCredentials(later).find((entry) => entry.id === revokedLate.id)?.status, "revoked");

      // Still active: renew instead; pairing doesn't take it over.
      const active = store.createCredential({ name: "Laptop", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 10 * 60_000 });
      const afterActive = pairAndRedeem(active.token);
      assert.equal(afterActive.renewed, false);
      assert.equal(store.authenticate(`Bearer ${active.token}`, later)?.credentialId, active.id, "the active credential is untouched");

      // The owner's browser credential is never taken over by a client.
      const owner = store.createCredential({ name: "Owner (browser)", workspaceIds: ["default"], scopes: ["pairing:approve"], expiresAt: now + 60_000 });
      assert.equal(pairAndRedeem(owner.token).renewed, false);

      for (const offered of [`dl_${"x".repeat(43)}`, "not a token", 42, "", `Bearer ${active.token}`, "x".repeat(10_000), undefined]) {
        assert.equal(pairAndRedeem(offered).renewed, false);
      }

      // A denied pairing renews nothing.
      const expired = store.createCredential({ name: "Tablet", workspaceIds: ["default"], scopes: DL_CLIENT_SCOPES, expiresAt: now + 60_000 });
      const denied = store.createDeviceAuthorization({ clientName: "Tablet", ttlMs: 600_000, maxPending: 50, replacesToken: expired.token }, later)!;
      store.resolveDeviceAuthorization(denied.userCode, "deny", grant, later);
      assert.equal(store.redeemDeviceAuthorization(denied.deviceCode, later).kind, "denied");
      assert.equal(store.checkCredential(`Bearer ${expired.token}`, later).kind, "expired");
      assert.deepEqual(store.listCredentialAudit(expired.id), []);
    } finally {
      store.close();
    }
  });

  it("adds the renewal columns to a database created before them", async () => {
    const root = await fixture();
    const dbPath = join(root, "state", "dl.db");
    await mkdir(join(root, "state"), { recursive: true });
    const legacy = new SqliteDatabase(dbPath);
    legacy.exec(`CREATE TABLE aster_credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
      workspace_ids_json TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      revoked_at INTEGER, last_used_at INTEGER);
      CREATE TABLE aster_device_authorizations (device_code_hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, client_name TEXT NOT NULL,
      status TEXT NOT NULL, workspace_ids_json TEXT, credential_ttl_ms INTEGER, credential_id TEXT, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, resolved_at INTEGER, last_polled_at INTEGER);`);
    const now = Date.now();
    const token = `dl_${"a".repeat(43)}`;
    legacy.prepare("INSERT INTO aster_credentials (id, name, token_hash, workspace_ids_json, scopes_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-id", "Old iPhone", createHash("sha256").update(token).digest("hex"), JSON.stringify(["default"]), JSON.stringify(DL_CLIENT_SCOPES), now - 1_000, now + 59_000);
    legacy.close();
    const store = new DlStore(dbPath);
    try {
      const renewal = store.renewCredential(`Bearer ${token}`, now);
      assert.ok(renewal.kind === "renewed");
      assert.equal(renewal.credential.id, "legacy-id");
      assert.equal(renewal.credential.expiresAt, now + 60_000, "lifetime from the original grant");
    } finally {
      store.close();
    }
  });

  it("caps pending pairings so unauthenticated callers can't fill the table", async () => {
    const root = await fixture();
    const store = new DlStore(join(root, "state", "dl.db"));
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
    const store = new DlStore(join(root, "state", "dl.db"));
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
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const laptop = store.createCredential({ name: "MacBook", workspaceIds: ["default"], scopes: ["conversations:read"], expiresAt: Date.now() + 60_000 });
      for (const [index, id] of ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"].entries()) {
        store.reserveCellConversation({ conversationId: id, credentialId: laptop.id, workspaceId: "default", model: "m", sessionId: `s-${index}`, cellName: `dl-${id}`, idempotencyKey: `k-${index}` });
        store.createConversation({ id, workspaceId: "default", model: "m", sessionId: `s-${index}`, worktreePath: "/workspace", cwd: "/workspace", branch: `dl/${index}`, kind: "code", repository: "me/app", baseBranch: "main" });
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
    const store = new DlStore(join(root, "state", "dl.db"));
    try {
      const claim = store.createOwnerClaim(60_000);
      assert.match(claim.token, /^dl_claim_/);
      const owner = store.redeemOwnerClaim(claim.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 });
      assert.deepEqual(owner?.scopes, ["pairing:approve"]);
      assert.equal(store.redeemOwnerClaim(claim.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
      const expired = store.createOwnerClaim(1_000, Date.now() - 10_000);
      assert.equal(store.redeemOwnerClaim(expired.token, { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
      assert.equal(store.redeemOwnerClaim("dl_claim_short", { workspaceIds: ["default"], credentialTtlMs: 60_000 }), undefined);
    } finally {
      store.close();
    }
  });
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-dl-store-")));
  roots.push(root);
  return root;
}
