import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterConfigError, findAsterWorkspace, loadAsterServerConfig, localAsterConfigPath, parseProvider, resolveAsterServerConfigPath } from "./aster-workspaces.js";

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
    assert.equal(config.modelCatalog, "fixed");
    assert.equal(config.provider.id, "openrouter", "no provider block means OpenRouter, as before the block existed");
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

describe("Aster provider configuration", () => {
  it("keeps every existing aster.json working: no provider is OpenRouter and models \"openrouter\" is the live catalog", async () => {
    const root = await fixture();
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const configPath = join(root, "aster.json");
    await writeFile(configPath, JSON.stringify({ models: "openrouter", workspaces: [{ id: "default", displayName: "P", rootPath: workspaceRoot }] }));
    const config = await loadAsterServerConfig(configPath);
    assert.equal(config.modelCatalog, "catalog");
    assert.deepEqual(config.models, []);
    assert.deepEqual(config.provider, { id: "openrouter", name: "OpenRouter", apiKeyEnv: "OPENROUTER_API_KEY", keyRequired: true, defaultModel: "moonshotai/kimi-k2.6" });
  });

  it("reads a provider block, filling the base URL and key env from the preset", async () => {
    const root = await fixture();
    const workspaceRoot = join(root, "repo");
    await mkdir(workspaceRoot);
    const configPath = join(root, "aster.json");
    const workspaces = [{ id: "default", displayName: "P", rootPath: workspaceRoot }];
    await writeFile(configPath, JSON.stringify({ provider: { id: "deepseek" }, models: "catalog", workspaces }));
    const deepseek = await loadAsterServerConfig(configPath);
    assert.equal(deepseek.modelCatalog, "catalog");
    assert.deepEqual(deepseek.provider, { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY", keyRequired: true, defaultModel: "deepseek-v4-pro" });

    await writeFile(configPath, JSON.stringify({ provider: { id: "ollama", baseUrl: "http://gpu-box:11434/v1/" }, models: ["qwen3:32b"], workspaces }));
    const ollama = await loadAsterServerConfig(configPath);
    assert.equal(ollama.modelCatalog, "fixed", "a fixed list works for any provider");
    assert.deepEqual(ollama.models, ["qwen3:32b"]);
    assert.deepEqual(ollama.provider, { id: "ollama", name: "Ollama", baseUrl: "http://gpu-box:11434/v1", apiKeyEnv: "OLLAMA_API_KEY", keyRequired: false });

    assert.equal(parseProvider({ id: "openai", apiKeyEnv: "ASTER_OPENAI_KEY" }).apiKeyEnv, "ASTER_OPENAI_KEY");
  });

  it("rejects unknown providers, bad URLs and key env names, and a custom endpoint without a URL", () => {
    assert.throws(() => parseProvider({ id: "not-a-provider" }), AsterConfigError);
    assert.throws(() => parseProvider("deepseek"), AsterConfigError);
    assert.throws(() => parseProvider({ id: "deepseek", baseUrl: "api.deepseek.com" }), AsterConfigError);
    assert.throws(() => parseProvider({ id: "deepseek", baseUrl: "ftp://api.deepseek.com" }), AsterConfigError);
    assert.throws(() => parseProvider({ id: "deepseek", apiKeyEnv: "not an env name" }), AsterConfigError);
    assert.throws(() => parseProvider({ id: "custom" }), /needs provider.baseUrl/);
    assert.equal(parseProvider({ id: "custom", baseUrl: "https://llm.example.com/v1" }).apiKeyEnv, "AUTOPILOT_API_KEY");
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
