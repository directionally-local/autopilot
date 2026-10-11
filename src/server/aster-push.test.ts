import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsterPush } from "./aster-push.js";

describe("Aster push", () => {
  it("signs an ES256 provider token, sends to each device's environment, and drops dead tokens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aster-push-"));
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const keyPath = join(dir, "AuthKey_TEST.p8");
    writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    const sent: Array<{ host: string; token: string; headers: Record<string, string>; payload: string }> = [];
    const push = new AsterPush(join(dir, "aster.db"), {
      keyPath, keyId: "KEY123", teamId: "TEAM456", topic: "com.aster.ai",
      deliver: async (input) => { sent.push(input); return input.token.startsWith("dead") ? 410 : 200; },
    }, {});
    try {
      assert.equal(push.register("not-hex", "production"), false);
      const live = "a".repeat(64);
      const dead = "dead" + "b".repeat(60);
      assert.ok(push.register(live, "production"));
      assert.ok(push.register(dead, "development"));

      await push.notify({ title: "Fix the login page\nplease", body: "✅ Opened PR #12", conversationId: "conv-1" });
      assert.deepEqual(sent.map((s) => s.host).sort(), ["api.push.apple.com", "api.sandbox.push.apple.com"]);
      const payload = JSON.parse(sent[0]!.payload) as { aps: { alert: { title: string; body: string }; category?: string }; conversationId: string; approvalId?: string };
      assert.equal(payload.conversationId, "conv-1");
      assert.equal(payload.aps.alert.title, "Fix the login page please");
      assert.equal(payload.aps.category, undefined);
      assert.equal(payload.approvalId, undefined);
      assert.equal(sent[0]!.headers["apns-topic"], "com.aster.ai");

      await push.notify({
        title: "Approval required",
        body: "write: Edit src/example.ts in this workspace",
        conversationId: "conv-1",
        category: "APPROVAL",
        approvalId: "approval-1",
      });
      const approvalPayload = JSON.parse(sent.at(-1)!.payload) as typeof payload;
      assert.equal(approvalPayload.aps.category, "APPROVAL");
      assert.equal(approvalPayload.aps.alert.body, "write: Edit src/example.ts in this workspace");
      assert.equal(approvalPayload.conversationId, "conv-1");
      assert.equal(approvalPayload.approvalId, "approval-1");
      assert.deepEqual(Object.keys(approvalPayload).filter((key) => key !== "aps").sort(), ["approvalId", "conversationId"]);

      const jwt = sent[0]!.headers.authorization!.replace(/^bearer /, "");
      const [header, claims, signature] = jwt.split(".");
      assert.deepEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), { alg: "ES256", kid: "KEY123" });
      assert.equal((JSON.parse(Buffer.from(claims!, "base64url").toString()) as { iss: string }).iss, "TEAM456");
      const valid = createVerify("SHA256").update(`${header}.${claims}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"));
      assert.ok(valid, "provider token verifies with the key's public half");

      assert.equal(push.deviceCount(), 1, "a token Apple reports as unregistered is removed");
    } finally {
      push.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records devices but stays silent without an APNs key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aster-push-"));
    const push = new AsterPush(join(dir, "aster.db"), {}, {});
    try {
      assert.equal(push.configured, false);
      assert.ok(push.register("c".repeat(64), "production"));
      await push.notify({ title: "t", body: "b", conversationId: "c" });
    } finally {
      push.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
