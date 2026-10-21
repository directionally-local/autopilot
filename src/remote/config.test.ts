import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultRemoteName, loadRemotes, normalizeServerUrl, removeRemote, resolveRemote, saveRemote, type RemoteServer } from "./config.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function remote(name: string): RemoteServer {
  return { name, url: `https://${name}.example.com`, token: `aster_${name}`, credentialId: `cred-${name}`, expiresAt: "2027-01-01T00:00:00.000Z", addedAt: "2026-10-01T00:00:00.000Z" };
}

describe("remote server config", () => {
  it("requires https except on loopback and strips trailing slashes", () => {
    assert.equal(normalizeServerUrl("https://acme.example.com/"), "https://acme.example.com");
    assert.equal(normalizeServerUrl("acme.example.com"), "https://acme.example.com");
    assert.equal(normalizeServerUrl("http://127.0.0.1:4096"), "http://127.0.0.1:4096");
    assert.throws(() => normalizeServerUrl("http://acme.example.com"), /https/);
    assert.throws(() => normalizeServerUrl("https://user:pw@acme.example.com"), /credentials/);
  });

  it("derives a short default name from the host", () => {
    assert.equal(defaultRemoteName("https://acme.example.com"), "acme");
    assert.equal(defaultRemoteName("https://box.tail1234.ts.net"), "box");
    assert.equal(defaultRemoteName("http://127.0.0.1:4096"), "127-0-0-1");
  });

  it("stores tokens in a private file and resolves by name or the only entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "autopilot-remotes-"));
    roots.push(root);
    const path = join(root, "autopilot", "remotes.json");
    await assert.rejects(() => resolveRemote(undefined, path), /autopilot remote add/);

    await saveRemote(remote("acme"), path);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "autopilot"))).mode & 0o777, 0o700);
    assert.equal((await resolveRemote(undefined, path)).name, "acme");

    await saveRemote(remote("home"), path);
    await saveRemote({ ...remote("acme"), token: "aster_replaced" }, path);
    assert.deepEqual((await loadRemotes(path)).map((entry) => entry.name), ["home", "acme"]);
    assert.equal((await resolveRemote("acme", path)).token, "aster_replaced");
    await assert.rejects(() => resolveRemote(undefined, path), /pick one with --on/);
    await assert.rejects(() => resolveRemote("nope", path), /No server named "nope"/);

    assert.equal(await removeRemote("home", path), true);
    assert.equal(await removeRemote("home", path), false);
    assert.deepEqual((await loadRemotes(path)).map((entry) => entry.name), ["acme"]);
  });
});
