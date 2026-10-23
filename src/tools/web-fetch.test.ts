import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { webFetchTool } from "./web-fetch.js";
import { browserFetchTool, createRequestChecker } from "./browser.js";
import { ToolExecutor, type PermissionAsker, type PermissionRequest } from "./executor.js";
import { setLookupForTests } from "../util/network-target.js";

const ctx = { cwd: process.cwd() };

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function recorder(decision: "allow" | "deny" | "session") {
  const asked: PermissionRequest[] = [];
  const ask: PermissionAsker = async (req) => {
    asked.push(req);
    return decision === "session" ? { decision: "allow", scope: "session" } : decision;
  };
  return { asked, ask };
}

function call(url: string, id = url) {
  return { id, name: "web_fetch", arguments: JSON.stringify({ url }) };
}

describe("web_fetch and local or private network addresses", () => {
  let local: { server: Server; base: string };
  let other: { server: Server; base: string };
  let hits: string[] = [];

  before(async () => {
    other = await listen((req, res) => {
      hits.push(`other${req.url}`);
      res.end("other-service-secret");
    });
    local = await listen((req, res) => {
      hits.push(`local${req.url}`);
      if (req.url === "/same-origin") {
        res.writeHead(302, { location: "/final" });
        res.end();
      } else if (req.url === "/cross") {
        res.writeHead(302, { location: `${other.base}/admin` });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(`local-secret ${req.url}`);
      }
    });
  });
  after(() => {
    local.server.close();
    other.server.close();
  });
  afterEach(() => {
    hits = [];
    setLookupForTests(null);
  });

  for (const url of [
    "http://localhost:1/",
    "http://127.0.0.1:1/",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[::1]:1/",
    "http://[::ffff:169.254.169.254]/",
    "http://2130706433:1/",
    "http://10.0.0.1/",
    "http://0.0.0.0:1/",
  ]) {
    it(`asks before fetching ${url}, and does not fetch on deny`, async () => {
      setLookupForTests(async () => {
        throw new Error("no DNS in tests");
      });
      const { asked, ask } = recorder("deny");
      const res = await new ToolExecutor([webFetchTool]).run(call(url), ask, ctx);
      assert.strictEqual(res.ok, false);
      assert.strictEqual(asked.length, 1);
      assert.match(asked[0]!.sensitiveReason ?? "", /^fetches a local or private network address \(/);
    });
  }

  it("asks for a hostname that resolves to loopback", async () => {
    setLookupForTests(async (name) => (name === "rebind.attacker.test" ? ["127.0.0.1"] : []));
    const { asked, ask } = recorder("deny");
    const port = new URL(local.base).port;
    const res = await new ToolExecutor([webFetchTool]).run(call(`http://rebind.attacker.test:${port}/`), ask, ctx);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(asked[0]?.sensitiveReason, "fetches a local or private network address (rebind.attacker.test → 127.0.0.1, loopback)");
    assert.deepStrictEqual(hits, []);
  });

  it("does not ask for a public address", async () => {
    setLookupForTests(async () => ["93.184.216.34"]);
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetched.push(String(input));
      return new Response("public page", { status: 200, headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    try {
      const { asked, ask } = recorder("deny");
      const res = await new ToolExecutor([webFetchTool]).run(call("https://example.test/doc"), ask, ctx);
      assert.strictEqual(res.ok, true, res.content);
      assert.match(res.content, /public page/);
      assert.strictEqual(asked.length, 0);
      assert.deepStrictEqual(fetched, ["https://example.test/doc"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fetches an approved local address and follows same-origin redirects", async () => {
    const { asked, ask } = recorder("allow");
    const res = await new ToolExecutor([webFetchTool]).run(call(`${local.base}/same-origin`), ask, ctx);
    assert.strictEqual(res.ok, true, res.content);
    assert.match(res.content, /local-secret \/final/);
    assert.match(res.content, /redirected to/);
    assert.strictEqual(asked.length, 1);
    assert.deepStrictEqual(hits, ["local/same-origin", "local/final"]);
  });

  it("an approved origin does not cover a redirect to another local service", async () => {
    const { ask } = recorder("allow");
    const res = await new ToolExecutor([webFetchTool]).run(call(`${local.base}/cross`), ask, ctx);
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /was not followed: it points to a local or private network address/);
    assert.match(res.content, /call web_fetch with http:\/\/127\.0\.0\.1:\d+\/admin directly/);
    assert.ok(!res.content.includes("other-service-secret"));
    assert.deepStrictEqual(hits, ["local/cross"]);
  });

  it("does not follow a redirect from a public URL to cloud metadata", async () => {
    setLookupForTests(async () => ["93.184.216.34"]);
    const realFetch = globalThis.fetch;
    const fetched: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      fetched.push(String(input));
      assert.strictEqual(init?.redirect, "manual");
      if (String(input).startsWith("https://attacker.test/")) {
        return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      }
      return new Response("AKIA-metadata-credentials", { status: 200 });
    }) as typeof fetch;
    try {
      const { asked, ask } = recorder("allow");
      const res = await new ToolExecutor([webFetchTool]).run(call("https://attacker.test/r"), ask, ctx);
      assert.strictEqual(asked.length, 0);
      assert.strictEqual(res.ok, false);
      assert.match(res.content, /Redirect from https:\/\/attacker\.test\/r to http:\/\/169\.254\.169\.254\/latest\/meta-data\/ was not followed/);
      assert.match(res.content, /169\.254\.169\.254, link-local/);
      assert.ok(!res.content.includes("AKIA"));
      assert.deepStrictEqual(fetched, ["https://attacker.test/r"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("refuses a target that turned private after the permission check", async () => {
    let calls = 0;
    // First answer (permission check) public, then loopback: a rebinding name.
    setLookupForTests(async () => (calls++ === 0 ? ["93.184.216.34"] : ["127.0.0.1"]));
    const { asked, ask } = recorder("allow");
    const res = await new ToolExecutor([webFetchTool]).run(call(`http://flip.test:${new URL(local.base).port}/`), ask, ctx);
    assert.strictEqual(asked.length, 0);
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /needs the user's approval; it was not approved for this call/);
    assert.deepStrictEqual(hits, []);
  });

  it("caps redirects", async () => {
    const { ask } = recorder("allow");
    const res = await new ToolExecutor([webFetchTool]).run(call(`${local.base}/loop`), ask, ctx);
    assert.strictEqual(res.ok, false);
    assert.match(res.content, /Too many redirects/);
    assert.strictEqual(hits.length, 6);
  });

  it("a session approval covers the origin, not other local origins", async () => {
    const { asked, ask } = recorder("session");
    const exec = new ToolExecutor([webFetchTool]);
    assert.strictEqual((await exec.run(call(`${local.base}/a`), ask, ctx)).ok, true);
    assert.strictEqual((await exec.run(call(`${local.base}/b`), ask, ctx)).ok, true);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual((await exec.run(call(`${other.base}/c`), ask, ctx)).ok, true);
    assert.strictEqual(asked.length, 2);
  });

  it("rejects non-http(s) URLs", async () => {
    const { asked, ask } = recorder("allow");
    for (const url of ["file:///etc/passwd", "data:text/plain,hi"]) {
      const res = await new ToolExecutor([webFetchTool]).run(call(url), ask, ctx);
      assert.strictEqual(res.ok, false, url);
      assert.match(res.content, /only opens http\(s\) URLs/);
    }
    assert.strictEqual(asked.length, 0);
  });
});

describe("browser_fetch and local or private network addresses", () => {
  afterEach(() => setLookupForTests(null));

  it("asks before opening a local address", async () => {
    const { asked, ask } = recorder("deny");
    const res = await new ToolExecutor([browserFetchTool]).run(
      { id: "b", name: "browser_fetch", arguments: JSON.stringify({ url: "http://169.254.169.254/" }) },
      ask,
      ctx,
    );
    assert.strictEqual(res.ok, false);
    assert.strictEqual(asked[0]?.sensitiveReason, "fetches a local or private network address (169.254.169.254, link-local)");
  });

  it("blocks page requests to non-public addresses other than the approved origin", async () => {
    setLookupForTests(async (name) => (name === "cdn.test" ? ["93.184.216.34"] : ["10.1.2.3"]));
    const check = createRequestChecker("http://localhost:3000");
    assert.strictEqual(await check("http://localhost:3000/app.js"), null);
    assert.strictEqual(await check("https://cdn.test/lib.js"), null);
    assert.strictEqual(await check("data:text/plain,x"), null);
    assert.match((await check("http://localhost:3001/")) ?? "", /loopback/);
    assert.match((await check("http://169.254.169.254/latest/")) ?? "", /link-local/);
    assert.match((await check("http://intranet.test/")) ?? "", /10\.1\.2\.3, private/);
    const unapproved = createRequestChecker(null);
    assert.match((await unapproved("http://localhost:3000/")) ?? "", /loopback/);
  });
});
