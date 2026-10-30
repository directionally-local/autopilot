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
    assert.equal(first.config.modelCatalog, "catalog");
    assert.equal(first.config.provider.id, "openrouter");
    assert.equal(JSON.parse(await readFile(first.path, "utf8")).provider, undefined, "no block is written for the default provider");

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

  it("writes the provider block for --provider, with an optional base URL override", async () => {
    const root = await fixture();
    const repository = await gitRepository(root, "repo");
    const configPath = join(root, "aster.json");
    const setup = await setupLocalAsterConfig({ workspacePaths: [repository], provider: "deepseek", configPath });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).provider, { id: "deepseek" });
    assert.equal(setup.config.provider.baseUrl, "https://api.deepseek.com");
    assert.equal(setup.config.modelCatalog, "catalog");

    const withUrl = join(root, "ollama.json");
    const ollama = await setupLocalAsterConfig({ workspacePaths: [repository], provider: "ollama", baseUrl: "http://gpu-box:11434/v1", models: ["qwen3:32b"], configPath: withUrl });
    assert.deepEqual(JSON.parse(await readFile(withUrl, "utf8")).provider, { id: "ollama", baseUrl: "http://gpu-box:11434/v1" });
    assert.equal(ollama.config.provider.baseUrl, "http://gpu-box:11434/v1");
    assert.deepEqual(ollama.config.models, ["qwen3:32b"]);

    await assert.rejects(setupLocalAsterConfig({ workspacePaths: [repository], provider: "acme-llm", configPath: join(root, "x.json") }), /unknown provider "acme-llm"/);
    await assert.rejects(setupLocalAsterConfig({ workspacePaths: [repository], baseUrl: "https://x", configPath: join(root, "y.json") }), /--base-url needs --provider/);
    await assert.rejects(setupLocalAsterConfig({ workspacePaths: [repository], provider: "custom", configPath: join(root, "z.json") }), /needs provider.baseUrl/);
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
