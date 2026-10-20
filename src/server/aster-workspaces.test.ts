import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterConfigError, findAsterWorkspace, loadAsterServerConfig, localAsterConfigPath, resolveAsterServerConfigPath } from "./aster-workspaces.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Aster workspace registry", () => {
  it("loads only configured workspace IDs and display names with canonical roots", async () => {
    const root = await fixture();
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({
      models: ["provider/model-a"],
      workspaces: [{ id: "default", displayName: "My project", rootPath: workspaceRoot }],
    }));

    const config = await loadAsterServerConfig(configPath);
    assert.deepEqual(config.models, ["provider/model-a"]);
    assert.deepEqual(config.workspaces.map(({ id, displayName }) => ({ id, displayName })), [{ id: "default", displayName: "My project" }]);
    assert.equal(config.workspaces[0]?.rootPath, await realpath(workspaceRoot));
    assert.equal(findAsterWorkspace(config, "default")?.displayName, "My project");
    assert.equal(findAsterWorkspace(config, workspaceRoot), undefined);
  });

  it("rejects duplicate IDs and overlapping configured roots", async () => {
    const root = await fixture();
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    await mkdir(inner, { recursive: true });
    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({
      models: ["provider/model-a"],
      workspaces: [
        { id: "outer", displayName: "Outer", rootPath: outer },
        { id: "inner", displayName: "Inner", rootPath: inner },
      ],
    }));
    await assert.rejects(loadAsterServerConfig(configPath), AsterConfigError);
  });

  it("fails closed when configuration or a configured root is missing", async () => {
    const root = await fixture();
    await assert.rejects(loadAsterServerConfig(join(root, "missing.json")), AsterConfigError);
    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({ models: ["provider/model-a"], workspaces: [{ id: "gone", displayName: "Gone", rootPath: join(root, "gone") }] }));
    await assert.rejects(loadAsterServerConfig(configPath), AsterConfigError);
  });
});

describe("Aster config path resolution", () => {
  it("prefers an explicit path, then a user-local config, then the system config", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-config-path-")));
    roots.push(root);
    const configHome = join(root, "config-home");
    const env = { XDG_CONFIG_HOME: configHome };
    const localPath = localAsterConfigPath(env);

    assert.equal(localPath, join(configHome, "autopilot", "aster.json"));
    assert.equal(resolveAsterServerConfigPath(env), "/etc/autopilot/aster.json");

    await mkdir(join(configHome, "autopilot"), { recursive: true });
    await writeFile(localPath, "{}");
    assert.equal(resolveAsterServerConfigPath(env), localPath);
    assert.equal(resolveAsterServerConfigPath({ ...env, AUTOPILOT_ASTER_CONFIG: join(root, "override.json") }), join(root, "override.json"));
  });
});

async function fixture(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-workspaces-")));
  roots.push(root);
  return root;
}
