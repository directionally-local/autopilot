import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  findProjectLspConfigPath,
  loadProjectLspConfig,
  saveProjectLspConfig,
  resolveLspConfig,
} from "./lsp-config.js";
import type { KimiConfig } from "../config.js";

// saveProjectLspConfig records trust: keep the user's real trust store out
// of it. Loading is covered with trust on; the gate itself is tested in
// project-trust.test.ts.
let savedXdg: string | undefined;
let savedTrust: string | undefined;
before(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  savedTrust = process.env.AUTOPILOT_TRUST_PROJECT;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "lsp-config-xdg-"));
  process.env.AUTOPILOT_TRUST_PROJECT = "1";
});
after(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedTrust === undefined) delete process.env.AUTOPILOT_TRUST_PROJECT;
  else process.env.AUTOPILOT_TRUST_PROJECT = savedTrust;
});

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lsp-config-test-"));
}

describe("findProjectLspConfigPath", () => {
  it("prefers .autopilot/lsp.json over the legacy .kimiflare one", async () => {
    const root = makeTmpDir();
    for (const name of [".autopilot", ".kimiflare"]) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, "lsp.json"), "{}", "utf8");
    }
    assert.strictEqual(findProjectLspConfigPath(root), join(root, ".autopilot", "lsp.json"));
    await rm(root, { recursive: true });
  });

  it("finds config in cwd", async () => {
    const root = makeTmpDir();
    const dir = join(root, ".kimiflare");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lsp.json"), "{}", "utf8");
    const path = findProjectLspConfigPath(root);
    assert.strictEqual(path, join(root, ".kimiflare", "lsp.json"));
    await rm(root, { recursive: true });
  });

  it("finds config in parent when missing in cwd", async () => {
    const root = makeTmpDir();
    const dir = join(root, ".kimiflare");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lsp.json"), "{}", "utf8");
    const child = join(root, "packages", "frontend");
    await mkdir(child, { recursive: true });
    const path = findProjectLspConfigPath(child);
    assert.strictEqual(path, join(root, ".kimiflare", "lsp.json"));
    await rm(root, { recursive: true });
  });

  it("stops at git root", async () => {
    const root = makeTmpDir();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "", "utf8");
    const dir = join(root, "..", ".kimiflare");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "lsp.json"), "{}", "utf8");
    const path = findProjectLspConfigPath(root);
    assert.strictEqual(path, null);
    await rm(join(root, "..", ".kimiflare"), { recursive: true });
    await rm(root, { recursive: true });
  });

  it("returns null when no config exists", () => {
    const root = makeTmpDir();
    const path = findProjectLspConfigPath(root);
    assert.strictEqual(path, null);
    rm(root, { recursive: true });
  });
});

describe("loadProjectLspConfig", () => {
  it("loads lspEnabled and lspServers", async () => {
    const root = makeTmpDir();
    const dir = join(root, ".kimiflare");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "lsp.json"),
      JSON.stringify({ lspEnabled: true, lspServers: { ts: { command: ["tsserver"] } } }),
      "utf8",
    );
    const cfg = await loadProjectLspConfig(root);
    assert.strictEqual(cfg?.lspEnabled, true);
    assert.deepStrictEqual(cfg?.lspServers, { ts: { command: ["tsserver"] } });
    await rm(root, { recursive: true });
  });

  it("returns null when file is missing", async () => {
    const root = makeTmpDir();
    const cfg = await loadProjectLspConfig(root);
    assert.strictEqual(cfg, null);
    await rm(root, { recursive: true });
  });
});

describe("saveProjectLspConfig", () => {
  it("writes config and appends to .gitignore", async () => {
    const root = makeTmpDir();
    await writeFile(join(root, ".gitignore"), "node_modules/\n", "utf8");
    const path = await saveProjectLspConfig(root, {
      lspEnabled: true,
      lspServers: { ts: { command: ["tsserver"] } },
    });
    assert.strictEqual(path, join(root, ".autopilot", "lsp.json"));
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".autopilot/lsp.json"));
    await rm(root, { recursive: true });
  });

  it("does not duplicate gitignore entry", async () => {
    const root = makeTmpDir();
    await writeFile(join(root, ".gitignore"), ".autopilot/lsp.json\n", "utf8");
    await saveProjectLspConfig(root, { lspEnabled: true });
    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    const matches = gitignore.match(/\.autopilot\/lsp\.json/g);
    assert.strictEqual(matches?.length, 1);
    await rm(root, { recursive: true });
  });
});

describe("resolveLspConfig", () => {
  const globalCfg: KimiConfig = {
    accountId: "x",
    apiToken: "x",
    model: "x",
    lspEnabled: true,
    lspServers: { ts: { command: ["tsserver"] } },
  };

  it("falls back to global when no project config", async () => {
    const root = makeTmpDir();
    const resolved = await resolveLspConfig(globalCfg, root);
    assert.strictEqual(resolved.scope, "global");
    assert.strictEqual(resolved.lspEnabled, true);
    assert.deepStrictEqual(resolved.lspServers, { ts: { command: ["tsserver"] } });
    await rm(root, { recursive: true });
  });

  it("uses project config when present", async () => {
    const root = makeTmpDir();
    await saveProjectLspConfig(root, {
      lspEnabled: false,
      lspServers: { py: { command: ["pyright"] } },
    });
    const resolved = await resolveLspConfig(globalCfg, root);
    assert.strictEqual(resolved.scope, "project");
    assert.strictEqual(resolved.lspEnabled, false);
    assert.deepStrictEqual(resolved.lspServers, { py: { command: ["pyright"] } });
    await rm(root, { recursive: true });
  });

  it("falls back to global lspEnabled when project omits it", async () => {
    const root = makeTmpDir();
    await saveProjectLspConfig(root, {
      lspServers: { py: { command: ["pyright"] } },
    });
    const resolved = await resolveLspConfig(globalCfg, root);
    assert.strictEqual(resolved.lspEnabled, true); // from global
    assert.deepStrictEqual(resolved.lspServers, { py: { command: ["pyright"] } });
    await rm(root, { recursive: true });
  });

  it("falls back to global lspServers when project omits it", async () => {
    const root = makeTmpDir();
    await saveProjectLspConfig(root, { lspEnabled: false });
    const resolved = await resolveLspConfig(globalCfg, root);
    assert.strictEqual(resolved.lspEnabled, false);
    assert.deepStrictEqual(resolved.lspServers, { ts: { command: ["tsserver"] } });
    await rm(root, { recursive: true });
  });
});
