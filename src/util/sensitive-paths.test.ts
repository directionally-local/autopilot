import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, type PermissionAsker, type PermissionRequest } from "../tools/executor.js";
import { readTool } from "../tools/read.js";
import { grepTool } from "../tools/grep.js";
import { assertWebUrl } from "../tools/browser.js";
import { createDefaultPermissionHandler } from "../sdk/permissions.js";
import { sensitivePathReason, sensitiveSearchRootReason } from "./sensitive-paths.js";

let home: string;
let proj: string;
const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(() => {
  home = mkdtempSync(join(tmpdir(), "sens-home-"));
  proj = mkdtempSync(join(tmpdir(), "sens-proj-"));
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
  mkdirSync(join(home, ".config", "kimiflare"), { recursive: true });
  writeFileSync(join(home, ".config", "kimiflare", "config.json"), '{"apiKey":"sk-or-secret"}\n');
  writeFileSync(join(proj, "README.md"), "hello\n");
  writeFileSync(join(proj, ".env"), "OPENAI_API_KEY=sk-secret\n");
  writeFileSync(join(proj, ".env.example"), "OPENAI_API_KEY=\n");
  symlinkSync(join(home, ".ssh", "id_ed25519"), join(proj, "notes.md"));
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("sensitivePathReason", () => {
  it("flags credentials files, process environments and .env files", () => {
    for (const p of [
      join(home, ".ssh", "id_ed25519"),
      join(home, ".config", "kimiflare", "config.json"),
      join(home, ".aws", "credentials"),
      join(home, ".netrc"),
      "/proc/self/environ",
      "/proc/1/task/1/environ",
      join(proj, ".env"),
      join(proj, ".env.local"),
      join(proj, "keys", "id_rsa"),
    ]) {
      assert.ok(sensitivePathReason(p), p);
    }
  });

  it("follows symlinks out of the project", () => {
    assert.ok(sensitivePathReason(join(proj, "notes.md")));
  });

  it("leaves ordinary project files and .env templates alone", () => {
    for (const p of [join(proj, "README.md"), join(proj, ".env.example"), join(proj, "src", "env.ts"), "/proc/cpuinfo"]) {
      assert.strictEqual(sensitivePathReason(p), null, p);
    }
  });

  it("honours XDG_CONFIG_HOME", () => {
    process.env.XDG_CONFIG_HOME = join(home, "xdg");
    try {
      assert.ok(sensitivePathReason(join(home, "xdg", "kimiflare", "config.json")));
    } finally {
      delete process.env.XDG_CONFIG_HOME;
    }
  });
});

describe("sensitiveSearchRootReason", () => {
  it("flags roots whose walk reaches credentials through visible names", () => {
    assert.ok(sensitiveSearchRootReason(join(home, ".config")));
    assert.ok(sensitiveSearchRootReason(join(home, ".ssh")));
    assert.ok(sensitiveSearchRootReason("/"));
  });

  it("allows roots whose walk would only reach them through hidden directories", () => {
    assert.strictEqual(sensitiveSearchRootReason(home), null);
    assert.strictEqual(sensitiveSearchRootReason(proj), null);
  });
});

describe("read and grep ask before touching credentials", () => {
  const ctx = () => ({ cwd: proj });

  it("prompt for a credentials read, and do not read on deny", async () => {
    const exec = new ToolExecutor([readTool]);
    const asked: PermissionRequest[] = [];
    const ask: PermissionAsker = async (req) => {
      asked.push(req);
      return "deny";
    };
    for (const path of ["~/.ssh/id_ed25519", "~/.config/kimiflare/config.json", "notes.md", ".env"]) {
      const res = await exec.run({ id: path, name: "read", arguments: JSON.stringify({ path }) }, ask, ctx());
      assert.strictEqual(res.ok, false, path);
      assert.ok(!res.content.includes("secret") && !res.content.includes("PRIVATE KEY"), path);
    }
    assert.strictEqual(asked.length, 4);
    assert.ok(asked.every((r) => r.sensitiveReason?.startsWith("reads ")));
  });

  it("read ordinary files without a prompt", async () => {
    const exec = new ToolExecutor([readTool]);
    let asked = 0;
    const res = await exec.run({ id: "r", name: "read", arguments: JSON.stringify({ path: "README.md" }) }, async () => {
      asked++;
      return "deny";
    }, ctx());
    assert.strictEqual(res.ok, true);
    assert.strictEqual(asked, 0);
  });

  it("an approval for one credentials file does not cover another", async () => {
    const exec = new ToolExecutor([readTool]);
    let asked = 0;
    const ask: PermissionAsker = async () => {
      asked++;
      return { decision: "allow", scope: "session" };
    };
    await exec.run({ id: "a", name: "read", arguments: JSON.stringify({ path: ".env" }) }, ask, ctx());
    await exec.run({ id: "b", name: "read", arguments: JSON.stringify({ path: ".env" }) }, ask, ctx());
    await exec.run({ id: "c", name: "read", arguments: JSON.stringify({ path: "~/.ssh/id_ed25519" }) }, ask, ctx());
    assert.strictEqual(asked, 2);
  });

  it("grep rooted at the config home prompts", async () => {
    const exec = new ToolExecutor([grepTool]);
    let asked = 0;
    const res = await exec.run({ id: "g", name: "grep", arguments: JSON.stringify({ pattern: "sk-", path: "~/.config" }) }, async () => {
      asked++;
      return "deny";
    }, ctx());
    assert.strictEqual(asked, 1);
    assert.strictEqual(res.ok, false);
  });

  it("the SDK's plan-mode handler asks instead of allowing", async () => {
    const requests: PermissionRequest[] = [];
    const handler = createDefaultPermissionHandler({ mode: "plan", onRequest: (r) => requests.push(r) });
    const base = { tool: readTool, sessionKey: "k" };
    assert.strictEqual(await handler({ ...base, args: { path: "README.md" } }), "allow");
    assert.strictEqual(await handler({ ...base, args: { path: ".env" }, sensitiveReason: "reads an environment file (.env)" }), "deny");
    assert.strictEqual(requests.length, 1);
  });
});

describe("browser_fetch", () => {
  it("only opens http(s) URLs", () => {
    assert.doesNotThrow(() => assertWebUrl("https://example.com/"));
    assert.doesNotThrow(() => assertWebUrl("http://localhost:3000"));
    assert.throws(() => assertWebUrl(`file://${home}/.ssh/id_ed25519`), /only opens http/);
    assert.throws(() => assertWebUrl("view-source:file:///etc/passwd"), /only opens http/);
    assert.throws(() => assertWebUrl("not a url"), /absolute http/);
  });
});
