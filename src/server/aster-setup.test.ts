import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setupLocalAsterConfig } from "./aster-setup.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local Aster setup", () => {
  it("writes a private config for an existing Git root and reuses it on repeat", async () => {
    const root = await fixture();
    const repository = await gitRepository(root, "aster-project");
    const configHome = join(root, "config-home");
    const env = { ...process.env, XDG_CONFIG_HOME: configHome, AUTOPILOT_ASTER_CONFIG: undefined };

    const first = await setupLocalAsterConfig({ workspacePaths: [repository], env });
    assert.equal(first.path, join(configHome, "autopilot", "aster.json"));
    assert.equal(first.selectedWorkspaces.length, 1);
    assert.equal(first.selectedWorkspaces[0]?.id, "aster-project");
    assert.equal(first.selectedWorkspaces[0]?.rootPath, await realpath(repository));
    assert.equal(first.config.modelCatalog, "openrouter");

    const fileMode = (await stat(first.path)).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal((await stat(join(configHome, "autopilot"))).mode & 0o777, 0o700);

    const original = await readFile(first.path, "utf8");
    const repeated = await setupLocalAsterConfig({ workspacePaths: [repository], env });
    assert.deepEqual(repeated.selectedWorkspaces, first.selectedWorkspaces);
    assert.equal(await readFile(first.path, "utf8"), original);
  });

  it("does not overwrite a config that does not contain the requested root", async () => {
    const root = await fixture();
    const configuredRepo = await gitRepository(root, "configured");
    const otherRepo = await gitRepository(root, "other");
    const configPath = join(root, "aster.json");
    const env = { ...process.env, AUTOPILOT_ASTER_CONFIG: configPath };
    await setupLocalAsterConfig({ workspacePaths: [configuredRepo], env });
    const original = await readFile(configPath, "utf8");

    await assert.rejects(
      setupLocalAsterConfig({ workspacePaths: [otherRepo], env }),
      /already exists.*does not include.*left unchanged/,
    );
    assert.equal(await readFile(configPath, "utf8"), original);
  });

  it("rejects a subdirectory instead of silently widening the workspace root", async () => {
    const root = await fixture();
    const repository = await gitRepository(root, "repo");
    const nested = join(repository, "nested");
    await mkdir(nested);
    await assert.rejects(
      setupLocalAsterConfig({ workspacePaths: [nested], configPath: join(root, "aster.json") }),
      /workspace must be the Git repository root/,
    );
  });

  it("rejects paths that are not Git repositories", async () => {
    const root = await fixture();
    const directory = join(root, "plain-directory");
    await mkdir(directory);
    await assert.rejects(
      setupLocalAsterConfig({ workspacePaths: [directory], configPath: join(root, "aster.json") }),
      /existing Git repository root/,
    );
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "autopilot-aster-setup-"));
  roots.push(root);
  return root;
}

async function gitRepository(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path);
  execFileSync("git", ["-C", path, "init", "--quiet"]);
  return path;
}
