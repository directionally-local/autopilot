import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AsterGitHubProxy } from "./aster-github-proxy.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  }));
}

function pktLine(payload: string): Buffer {
  const content = Buffer.from(payload);
  return Buffer.concat([Buffer.from((content.length + 4).toString(16).padStart(4, "0")), content]);
}

function pushBody(ref: string, deleting = false): Buffer {
  const oldObjectId = "0".repeat(40);
  const newObjectId = deleting ? "0".repeat(40) : "1".repeat(40);
  return Buffer.concat([
    pktLine(`${oldObjectId} ${newObjectId} ${ref}\0report-status side-band-64k\n`),
    Buffer.from("0000PACKDATA"),
  ]);
}

describe("Aster GitHub proxy", () => {
  it("limits reads to one repository and pushes to its feature branch only", async () => {
    const seen: Array<{ method: string; url: string; authorization: string; body: string }> = [];
    const upstream = createServer((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (chunk: Buffer) => { body.push(chunk); });
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? "", body: Buffer.concat(body).toString("binary") });
        res.writeHead(201, { "content-type": "application/x-git-receive-pack-result", connection: "close" });
        res.end("upstream-ok");
      });
    });
    const upstreamPort = await listen(upstream);
    const revoked = new Set<string>();
    const proxy = new AsterGitHubProxy({
      token: "real-pat",
      gitUpstream: `http://127.0.0.1:${upstreamPort}`,
      resolveGrant: (grant) => (grant === "grant-a" && !revoked.has(grant)
        ? { conversationId: "c1", repository: "me/app", branch: "aster/12345678" }
        : undefined),
    });
    const port = await proxy.listen(0, "127.0.0.1");
    const base = `http://127.0.0.1:${port}`;
    const basic = (password: string) => "Basic " + Buffer.from(`x-access-token:${password}`).toString("base64");
    try {
      const anonymous = await fetch(`${base}/git/me/app.git/info/refs?service=git-upload-pack`);
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.headers.get("www-authenticate") ?? "", /Basic/);

      assert.equal((await fetch(`${base}/git/me/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic("nope") } })).status, 403);
      assert.equal((await fetch(`${base}/git/me/other.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic("grant-a") } })).status, 403);
      assert.equal((await fetch(`${base}/api/repos/me/app/pulls`, { method: "POST", headers: { authorization: "Bearer grant-a" }, body: "{}" })).status, 404);

      const refs = await fetch(`${base}/git/Me/App.git/info/refs?service=git-upload-pack`, { headers: { authorization: basic("grant-a") } });
      assert.equal(refs.status, 201);
      const mainPush = await fetch(`${base}/git/me/app.git/git-receive-pack`, {
        method: "POST", headers: { authorization: basic("grant-a") }, body: pushBody("refs/heads/main").toString("ascii"),
      });
      assert.equal(mainPush.status, 403);
      const deletePush = await fetch(`${base}/git/me/app.git/git-receive-pack`, {
        method: "POST", headers: { authorization: basic("grant-a") }, body: pushBody("refs/heads/aster/12345678", true).toString("ascii"),
      });
      assert.equal(deletePush.status, 403);
      const featurePush = await fetch(`${base}/git/me/app.git/git-receive-pack`, {
        method: "POST", headers: { authorization: basic("grant-a") }, body: pushBody("refs/heads/aster/12345678").toString("ascii"),
      });
      assert.equal(featurePush.status, 201);

      assert.deepEqual(seen.map((request) => `${request.method} ${request.url}`), [
        "GET /Me/App.git/info/refs?service=git-upload-pack",
        "POST /me/app.git/git-receive-pack",
      ]);
      assert.equal(seen[0]!.authorization, "Basic " + Buffer.from("x-access-token:real-pat").toString("base64"));
      assert.ok(seen.every((request) => !request.authorization.includes("grant-a")), "the grant token never reaches GitHub");
      assert.ok(seen[1]!.body.includes("refs/heads/aster/12345678"));

      revoked.add("grant-a");
      assert.equal((await fetch(`${base}/git/me/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: "Bearer grant-a" } })).status, 403);
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});
