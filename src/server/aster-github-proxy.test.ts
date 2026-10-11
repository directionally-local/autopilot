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

describe("Aster GitHub proxy", () => {
  it("only reaches the grant's repository and injects the server token", async () => {
    const seen: Array<{ method: string; url: string; authorization: string; body: string }> = [];
    const upstream = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? "", body });
        res.writeHead(201, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const upstreamPort = await listen(upstream);
    const revoked = new Set<string>();
    const authorizedWrites: Array<{ kind: string; method: string; path: string; conversationId: string }> = [];
    let allowWrites = true;
    const proxy = new AsterGitHubProxy({
      token: "real-pat",
      gitUpstream: `http://127.0.0.1:${upstreamPort}`,
      apiUpstream: `http://127.0.0.1:${upstreamPort}`,
      resolveGrant: (grant) => (grant === "grant-a" && !revoked.has(grant) ? { conversationId: "c1", repository: "me/app" } : undefined),
      authorizeWrite: async (grant, operation) => {
        authorizedWrites.push({ ...operation, conversationId: grant.conversationId });
        return allowWrites;
      },
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
      assert.equal((await fetch(`${base}/api/repos/someone/else/pulls`, { method: "POST", headers: { authorization: "Bearer grant-a" }, body: "{}" })).status, 403);
      assert.equal((await fetch(`${base}/api/user/repos`, { headers: { authorization: "Bearer grant-a" } })).status, 404);

      const refs = await fetch(`${base}/git/Me/App.git/info/refs?service=git-receive-pack`, { headers: { authorization: basic("grant-a") } });
      assert.equal(refs.status, 201);
      const pr = await fetch(`${base}/api/repos/me/app/pulls`, { method: "POST", headers: { authorization: "Bearer grant-a", "content-type": "application/json" }, body: '{"title":"t"}' });
      assert.equal(pr.status, 201);
      const push = await fetch(`${base}/git/me/app.git/git-receive-pack`, { method: "POST", headers: { authorization: basic("grant-a") }, body: "PACKDATA" });
      assert.equal(push.status, 201);

      assert.deepEqual(seen.map((request) => `${request.method} ${request.url}`), [
        "GET /Me/App.git/info/refs?service=git-receive-pack",
        "POST /repos/me/app/pulls",
        "POST /me/app.git/git-receive-pack",
      ]);
      assert.equal(seen[0]!.authorization, "Basic " + Buffer.from("x-access-token:real-pat").toString("base64"));
      assert.equal(seen[1]!.authorization, "Bearer real-pat");
      assert.equal(seen[1]!.body, '{"title":"t"}');
      assert.equal(seen[2]!.body, "PACKDATA");
      assert.ok(seen.every((request) => !request.authorization.includes("grant-a")), "the grant token never reaches GitHub");

      assert.deepEqual(authorizedWrites, [
        { kind: "github_api", method: "POST", path: "/repos/me/app/pulls", conversationId: "c1" },
        { kind: "git_push", method: "POST", path: "/me/app.git/git-receive-pack", conversationId: "c1" },
      ]);

      allowWrites = false;
      assert.equal((await fetch(base + "/api/repos/me/app/pulls", { method: "POST", headers: { authorization: "Bearer grant-a" }, body: "{}" })).status, 403);
      assert.equal((await fetch(base + "/git/me/app.git/git-receive-pack", { method: "POST", headers: { authorization: basic("grant-a") }, body: "PACKDATA" })).status, 403);
      assert.equal(seen.length, 3, "denied external operations never reach GitHub");

      revoked.add("grant-a");
      assert.equal((await fetch(base + "/api/repos/me/app", { headers: { authorization: "Bearer grant-a" } })).status, 403);
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});
