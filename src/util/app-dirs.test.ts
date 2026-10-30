import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configDir,
  configPath,
  dataDir,
  dataPath,
  migrateLegacyDirs,
  migrationNoticeText,
  projectDirsToRead,
  projectPath,
  stateDir,
} from "./app-dirs.js";
import { writeState } from "./state.js";
import { saveProjectLspConfig } from "./lsp-config.js";
import { hookSettingsLocations } from "../hooks/settings.js";

const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "AUTOPILOT_TRUST_PROJECT"] as const;
let saved: Record<string, string | undefined>;
let home: string;

function write(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Every path under `root` (not following symlinks). */
function walk(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    out.push(p);
    const st = lstatSync(p);
    if (st.isDirectory() && !st.isSymbolicLink()) out.push(...walk(p));
  }
  return out;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = realpathSync(mkdtempSync(join(tmpdir(), "app-dirs-")));
  process.env.HOME = home;
  for (const k of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("app dirs", () => {
  it("uses autopilot dirs under ~/.config, ~/.local/share and ~/.local/state", () => {
    assert.equal(configDir(), join(home, ".config", "autopilot"));
    assert.equal(dataDir(), join(home, ".local", "share", "autopilot"));
    assert.equal(stateDir(), join(home, ".local", "state", "autopilot"));
  });

  it("honours XDG overrides, for the new dirs and the legacy ones it migrates", () => {
    const xdg = join(home, "xdg");
    process.env.XDG_CONFIG_HOME = join(xdg, "c");
    process.env.XDG_DATA_HOME = join(xdg, "d");
    process.env.XDG_STATE_HOME = join(xdg, "s");
    assert.equal(configDir(), join(xdg, "c", "autopilot"));
    assert.equal(dataDir(), join(xdg, "d", "autopilot"));
    assert.equal(stateDir(), join(xdg, "s", "autopilot"));

    write(join(xdg, "c", "kimiflare", "config.json"), "{}");
    write(join(xdg, "d", "kimiflare", "usage.json"), "{}");
    migrateLegacyDirs();
    assert.ok(existsSync(join(xdg, "c", "autopilot", "config.json")));
    assert.ok(existsSync(join(xdg, "d", "autopilot", "usage.json")));
    assert.ok(!existsSync(join(home, ".config")), "default config home untouched");
  });

  it("a new install creates no kimiflare path", async () => {
    process.env.AUTOPILOT_TRUST_PROJECT = "1";
    const report = migrateLegacyDirs();
    assert.equal(migrationNoticeText(report), null);
    await writeState({ hooksExitCodeNoticeShown: true });
    write(configPath("config.json"), "{}");
    write(dataPath("sessions", "s.json"), "{}");
    const repo = join(home, "repo");
    mkdirSync(repo);
    await saveProjectLspConfig(repo, { lspEnabled: true });
    write(projectPath(repo, "memory.db"), "");

    assert.ok(existsSync(join(home, ".config", "autopilot", "state.json")));
    assert.ok(existsSync(join(repo, ".autopilot", "lsp.json")));
    assert.deepEqual(walk(home).filter((p) => /kimiflare/i.test(p)), []);
  });
});

describe("migrateLegacyDirs", () => {
  function seedLegacy(): void {
    write(join(home, ".config", "kimiflare", "config.json"), '{"openrouterApiKey":"sk-dummy"}', 0o600);
    write(join(home, ".config", "kimiflare", "logs", "2026-10-30.jsonl"), "{}\n");
    write(join(home, ".local", "share", "kimiflare", "sessions", "a.json"), '{"id":"a"}');
    write(join(home, ".local", "share", "kimiflare", "traces", "a", "trace.jsonl"), "{}\n");
    write(join(home, ".kimiflare", "memory.db"), "mem");
    write(join(home, ".local", "state", "kimiflare", "tool-audit.log"), "x\n");
    // Already present from attach-remote: must be kept.
    write(join(home, ".config", "autopilot", "remotes.json"), '{"remotes":[]}', 0o600);
  }

  it("moves config, data and home state, keeps modes, and leaves symlinks", () => {
    seedLegacy();
    const report = migrateLegacyDirs();

    const cfg = join(home, ".config", "autopilot", "config.json");
    assert.equal(readFileSync(cfg, "utf8"), '{"openrouterApiKey":"sk-dummy"}');
    assert.equal(statSync(cfg).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(home, ".config", "autopilot", "remotes.json"), "utf8"), '{"remotes":[]}');
    assert.ok(existsSync(join(home, ".config", "autopilot", "logs", "2026-10-30.jsonl")));
    assert.ok(existsSync(join(home, ".local", "share", "autopilot", "sessions", "a.json")));
    assert.ok(existsSync(join(home, ".local", "share", "autopilot", "traces", "a", "trace.jsonl")));
    assert.equal(readFileSync(join(home, ".local", "share", "autopilot", "memory.db"), "utf8"), "mem");
    assert.ok(existsSync(join(home, ".local", "state", "autopilot", "tool-audit.log")));

    for (const [legacy, target] of [
      [join(home, ".config", "kimiflare"), configDir()],
      [join(home, ".local", "share", "kimiflare"), dataDir()],
      [join(home, ".kimiflare"), dataDir()],
      [join(home, ".local", "state", "kimiflare"), stateDir()],
    ] as const) {
      assert.ok(lstatSync(legacy).isSymbolicLink(), `${legacy} is a symlink`);
      assert.equal(readlinkSync(legacy), target);
    }
    // An older binary using the old path sees the same file.
    assert.equal(readFileSync(join(home, ".config", "kimiflare", "config.json"), "utf8"), '{"openrouterApiKey":"sk-dummy"}');
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(report.failed, []);
    assert.match(migrationNoticeText(report) ?? "", /kimiflare -> .*autopilot/);
    assert.ok(!existsSync(join(configDir(), ".migrate.lock")));
  });

  it("is a no-op the second time", () => {
    seedLegacy();
    migrateLegacyDirs();
    const before = walk(home).sort();
    const report = migrateLegacyDirs();
    assert.deepEqual(report, { moved: [], conflicts: [], failed: [], linked: [], dirs: [] });
    assert.equal(migrationNoticeText(report), null);
    assert.deepEqual(walk(home).sort(), before);
  });

  it("never overwrites: a conflicting entry stays in the legacy dir and is reported", () => {
    write(join(home, ".config", "kimiflare", "settings.json"), '{"legacy":true}');
    write(join(home, ".config", "kimiflare", "config.json"), "{}", 0o600);
    write(join(home, ".config", "kimiflare", "commands", "old.md"), "old");
    write(join(home, ".config", "kimiflare", "commands", "both.md"), "legacy");
    write(join(home, ".config", "autopilot", "settings.json"), '{"new":true}');
    write(join(home, ".config", "autopilot", "commands", "both.md"), "new");

    const report = migrateLegacyDirs();
    const legacy = join(home, ".config", "kimiflare");
    assert.equal(readFileSync(join(configDir(), "settings.json"), "utf8"), '{"new":true}');
    assert.equal(readFileSync(join(legacy, "settings.json"), "utf8"), '{"legacy":true}');
    assert.equal(readFileSync(join(configDir(), "commands", "both.md"), "utf8"), "new");
    assert.equal(readFileSync(join(configDir(), "commands", "old.md"), "utf8"), "old");
    assert.ok(existsSync(join(configDir(), "config.json")));
    assert.deepEqual(
      report.conflicts.map((c) => c.from).sort(),
      [join(legacy, "commands", "both.md"), join(legacy, "settings.json")].sort(),
    );
    // Not emptied: the legacy dir stays a real directory.
    assert.ok(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink());
    assert.match(migrationNoticeText(report) ?? "", /Left in place.*settings\.json/);
  });

  it("reads new-then-legacy per entry while a legacy dir is still in place", () => {
    write(join(home, ".local", "share", "kimiflare", "usage.json"), "old");
    assert.equal(dataPath("usage.json"), join(home, ".local", "share", "kimiflare", "usage.json"));
    write(join(home, ".local", "share", "autopilot", "usage.json"), "new");
    assert.equal(dataPath("usage.json"), join(dataDir(), "usage.json"));
    assert.equal(dataPath("missing.json"), join(dataDir(), "missing.json"));
  });

  it("hooks read the migrated global settings file once, not via the symlink too", () => {
    write(join(home, ".config", "kimiflare", "settings.json"), '{"hooks":{}}');
    migrateLegacyDirs();
    const globals = hookSettingsLocations(join(home, "repo")).filter((l) => l.scope === "global");
    assert.deepEqual(globals.map((l) => l.legacy), [false]);
  });

  it("concurrent starts move every entry exactly once", async () => {
    for (let i = 0; i < 40; i++) {
      write(join(home, ".local", "share", "kimiflare", "sessions", `s${i}.json`), String(i));
      write(join(home, ".config", "kimiflare", `f${i}.json`), String(i), 0o600);
    }
    const mod = join(dirname(fileURLToPath(import.meta.url)), "app-dirs.ts");
    const script = `import(${JSON.stringify(mod)}).then((m) => { const r = m.migrateLegacyDirs(); process.stdout.write(JSON.stringify(r)); });`;
    const run = () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
          env: { ...process.env, HOME: home },
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (d) => (out += d));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      });
    const reports = (await Promise.all(Array.from({ length: 6 }, run))).map((o) => JSON.parse(o) as ReturnType<typeof migrateLegacyDirs>);

    for (const r of reports) {
      assert.deepEqual(r.failed, []);
      assert.deepEqual(r.conflicts, []);
    }
    const sessions = readdirSync(join(dataDir(), "sessions")).sort();
    assert.equal(sessions.length, 40);
    for (let i = 0; i < 40; i++) {
      assert.equal(readFileSync(join(dataDir(), "sessions", `s${i}.json`), "utf8"), String(i));
      assert.equal(statSync(join(configDir(), `f${i}.json`)).mode & 0o777, 0o600);
    }
    assert.ok(lstatSync(join(home, ".config", "kimiflare")).isSymbolicLink());
    assert.ok(lstatSync(join(home, ".local", "share", "kimiflare")).isSymbolicLink());
    assert.ok(!existsSync(join(configDir(), ".migrate.lock")));
    assert.ok(!existsSync(join(dataDir(), ".migrate.lock")));
  });
});

describe("project dir", () => {
  it("reads .autopilot first, falls back to .kimiflare, creates .autopilot", () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    assert.equal(projectPath(repo, "memory.db"), join(repo, ".autopilot", "memory.db"));
    assert.deepEqual(projectDirsToRead(repo), []);

    write(join(repo, ".kimiflare", "memory.db"), "legacy");
    assert.equal(projectPath(repo, "memory.db"), join(repo, ".kimiflare", "memory.db"));
    assert.deepEqual(projectDirsToRead(repo), [join(repo, ".kimiflare")]);

    write(join(repo, ".autopilot", "memory.db"), "new");
    assert.equal(projectPath(repo, "memory.db"), join(repo, ".autopilot", "memory.db"));
    assert.deepEqual(projectDirsToRead(repo), [join(repo, ".autopilot"), join(repo, ".kimiflare")]);

    migrateLegacyDirs();
    assert.ok(existsSync(join(repo, ".kimiflare", "memory.db")), "project dirs are never moved");
  });
});
