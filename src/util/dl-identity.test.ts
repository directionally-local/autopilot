import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCoauthor,
  DL_REINSTALL_LINE,
  DL_NPM_UPDATE,
  DL_SCRIPT_UPDATE,
  DL_SERVER_UPDATE,
  dlUpdateCommand,
  dlVersion,
  findDlPackage,
  headerTitle,
  productName,
  versionText,
} from "./dl-identity.js";

const DL = { AUTOPILOT_LAUNCHED_BY: "dl" };
const none = () => null;

function tree(): string {
  return mkdtempSync(join(tmpdir(), "dl-identity-"));
}

function write(path: string, json: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(json));
}

describe("commit co-author", () => {
  it("is dl under dl, Autopilot otherwise, with a directionallylocal.com address", () => {
    assert.deepStrictEqual(defaultCoauthor({ AUTOPILOT_LAUNCHED_BY: "dl" }), { name: "dl", email: "dl@directionallylocal.com" });
    assert.deepStrictEqual(defaultCoauthor({}), { name: "Autopilot", email: "autopilot@directionallylocal.com" });
    assert.strictEqual(DL_REINSTALL_LINE, "Reinstall dl: curl -fsSL https://dl.new | sh");
  });
});

describe("header title", () => {
  it("is autopilot <version> when started standalone", () => {
    assert.strictEqual(headerTitle("3.9.0", { env: {}, findPackage: () => ({ root: "/x", version: "0.14.1" }) }), "autopilot 3.9.0");
    assert.strictEqual(productName({}), "autopilot");
  });

  it("is dl <dl version> when dl started it", () => {
    assert.strictEqual(headerTitle("3.9.0", { env: { ...DL, DL_VERSION: "0.14.1" } }), "dl 0.14.1");
    assert.strictEqual(productName(DL), "dl");
  });

  it("is plain dl when dl's version isn't known", () => {
    assert.strictEqual(headerTitle("3.9.0", { env: DL, findPackage: none }), "dl");
  });
});

describe("--version text", () => {
  it("is the bare version standalone, dl X (autopilot Y) under dl", () => {
    assert.strictEqual(versionText("3.9.0", { env: {} }), "3.9.0");
    assert.strictEqual(versionText("3.9.0", { env: { ...DL, DL_VERSION: "0.14.1" } }), "dl 0.14.1 (autopilot 3.9.0)");
    assert.strictEqual(versionText("3.9.0", { env: DL, findPackage: none }), "dl (autopilot 3.9.0)");
  });
});

describe("dl version", () => {
  it("prefers DL_VERSION", () => {
    assert.strictEqual(dlVersion({ env: { DL_VERSION: " v0.14.1 " }, findPackage: () => ({ root: "/x", version: "0.1.0" }) }), "0.14.1");
  });

  it("ignores a DL_VERSION that isn't a version and falls back to the package", () => {
    assert.strictEqual(dlVersion({ env: { DL_VERSION: "latest" }, findPackage: () => ({ root: "/x", version: "0.13.0" }) }), "0.13.0");
  });

  it("is null when neither is found", () => {
    assert.strictEqual(dlVersion({ env: {}, findPackage: none }), null);
  });

  it("finds dl's package above a nested Autopilot", () => {
    const root = tree();
    const dl = join(root, "dl", "lib", "node_modules", "directionallylocal");
    write(join(dl, "package.json"), { name: "directionallylocal", version: "0.14.1" });
    const ap = join(dl, "node_modules", "autopilot-ai");
    write(join(ap, "package.json"), { name: "autopilot-ai", version: "3.9.0" });
    mkdirSync(join(ap, "dist"), { recursive: true });
    assert.deepStrictEqual(findDlPackage(join(ap, "dist")), { root: dl, version: "0.14.1" });
  });

  it("finds dl's package beside a hoisted Autopilot", () => {
    const root = tree();
    const dl = join(root, "node_modules", "directionallylocal");
    write(join(dl, "package.json"), { name: "directionallylocal", version: "0.12.0" });
    const ap = join(root, "node_modules", "autopilot-ai", "dist");
    mkdirSync(ap, { recursive: true });
    assert.deepStrictEqual(findDlPackage(ap), { root: dl, version: "0.12.0" });
  });

  it("finds nothing for a standalone Autopilot", () => {
    const root = tree();
    const ap = join(root, "lib", "node_modules", "autopilot-ai", "dist");
    mkdirSync(ap, { recursive: true });
    write(join(root, "lib", "node_modules", "autopilot-ai", "package.json"), { name: "autopilot-ai", version: "3.9.0" });
    assert.strictEqual(findDlPackage(ap), null);
  });
});

describe("dl update command", () => {
  const facts = { env: {}, platform: "darwin" as const, uid: 501, exists: () => false };
  it("prefers DL_UPDATE_COMMAND", () => {
    assert.strictEqual(dlUpdateCommand({ ...facts, env: { DL_UPDATE_COMMAND: "brew upgrade dl" }, packageRoot: null }), "brew upgrade dl");
  });
  it("is the install script for the script's layout or an unknown install", () => {
    assert.strictEqual(dlUpdateCommand({ ...facts, packageRoot: "/Users/a/.directionallylocal/dl/lib/node_modules/directionallylocal" }), DL_SCRIPT_UPDATE);
    assert.strictEqual(dlUpdateCommand({ ...facts, packageRoot: null }), DL_SCRIPT_UPDATE);
  });
  it("is the sudo script on a server, npm otherwise", () => {
    assert.strictEqual(dlUpdateCommand({ ...facts, platform: "linux", uid: 0, packageRoot: "/usr/lib/node_modules/directionallylocal" }), DL_SERVER_UPDATE);
    assert.strictEqual(dlUpdateCommand({ ...facts, packageRoot: "/opt/homebrew/lib/node_modules/directionallylocal" }), DL_NPM_UPDATE);
  });
  it("never suggests autopilot-ai", () => {
    for (const packageRoot of [null, "/x/node_modules/directionallylocal"]) assert.doesNotMatch(dlUpdateCommand({ ...facts, packageRoot }), /autopilot-ai/);
  });
});
