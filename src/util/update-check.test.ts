import { describe, it } from "node:test";
import assert from "node:assert";
import { checkForUpdate, updateNotice } from "./update-check.js";

const DL = { AUTOPILOT_LAUNCHED_BY: "dl" };
const cmd = () => "curl -fsSL https://directionallylocal.run | sh";

describe("update check under dl", () => {
  it("compares the running dl with npm's directionallylocal", async () => {
    const asked: string[] = [];
    const r = await checkForUpdate(true, { env: DL, dlVersion: () => "0.14.1", fetchLatest: async (name) => (asked.push(name), "0.15.0") });
    assert.deepStrictEqual(asked, ["directionallylocal"]);
    assert.deepStrictEqual(r, { hasUpdate: true, localVersion: "0.14.1", latestVersion: "0.15.0", product: "dl" });
    const lines = updateNotice(r, { updateCommand: cmd });
    assert.deepStrictEqual(lines, ["dl 0.15.0 is out (this is 0.14.1) · run:  curl -fsSL https://directionallylocal.run | sh"]);
    assert.ok(lines.every((l) => !/autopilot-ai|npm i -g/.test(l)));
  });

  it("caches dl's latest version separately (the next unforced check doesn't fetch)", async () => {
    await checkForUpdate(true, { env: DL, dlVersion: () => "0.14.1", fetchLatest: async () => "0.16.0" });
    const r = await checkForUpdate(false, { env: DL, dlVersion: () => "0.14.1", fetchLatest: async () => assert.fail("fetched despite cache") });
    assert.strictEqual(r.latestVersion, "0.16.0");
    assert.strictEqual(r.hasUpdate, true);
  });

  it("same version: nothing at startup, up to date on /update", async () => {
    const r = await checkForUpdate(true, { env: DL, dlVersion: () => "0.15.0", fetchLatest: async () => "0.15.0" });
    assert.strictEqual(r.hasUpdate, false);
    assert.deepStrictEqual(updateNotice(r, { updateCommand: cmd }), []);
    assert.deepStrictEqual(updateNotice(r, { explicit: true, updateCommand: cmd }), ["dl 0.15.0 is up to date"]);
  });

  it("unknown dl version: never checks, nothing at startup, /update says how to get the latest", async () => {
    const r = await checkForUpdate(true, { env: DL, dlVersion: () => null, fetchLatest: async () => assert.fail("fetched without a version") });
    assert.deepStrictEqual(r, { hasUpdate: false, localVersion: null, latestVersion: null, product: "dl" });
    assert.deepStrictEqual(updateNotice(r, { updateCommand: cmd }), []);
    assert.deepStrictEqual(updateNotice(r, { explicit: true, updateCommand: cmd }), ["To get the latest dl, run:  curl -fsSL https://directionallylocal.run | sh"]);
  });

  it("registry error: no update, nothing at startup, /update says it couldn't check", async () => {
    const r = await checkForUpdate(true, { env: DL, dlVersion: () => "0.14.1", fetchLatest: async () => null });
    assert.deepStrictEqual(r, { hasUpdate: false, localVersion: "0.14.1", latestVersion: null, product: "dl" });
    assert.deepStrictEqual(updateNotice(r, { updateCommand: cmd }), []);
    assert.match(updateNotice(r, { explicit: true, updateCommand: cmd })[0]!, /^couldn't check for a newer dl/);
  });
});

describe("update check standalone", () => {
  it("checks autopilot-ai and keeps the npm advice", async () => {
    const asked: string[] = [];
    const r = await checkForUpdate(true, { env: {}, fetchLatest: async (name) => (asked.push(name), "999.0.0") });
    assert.deepStrictEqual(asked, ["autopilot-ai"]);
    assert.strictEqual(r.hasUpdate, true);
    assert.strictEqual(r.product, undefined);
    assert.deepStrictEqual(updateNotice(r), [`update available: ${r.localVersion} → 999.0.0`, "run:  npm i -g autopilot-ai@latest  then restart"]);
  });

  it("no update: nothing at startup, 'no update available' on /update", () => {
    const r = { hasUpdate: false, localVersion: "3.9.0", latestVersion: "3.9.0" };
    assert.deepStrictEqual(updateNotice(r), []);
    assert.deepStrictEqual(updateNotice(r, { explicit: true }), ["no update available"]);
  });
});
