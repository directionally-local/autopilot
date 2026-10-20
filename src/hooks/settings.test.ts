import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  loadHooksSettings,
  appendHook,
  setHookEnabled,
  globalSettingsPath,
  projectSettingsPath,
  deriveHookId,
  SettingsFileError,
} from "./settings.js";
import { getRecommendedHook, LEGACY_RECOMMENDED_COMMANDS } from "./recommended.js";

let projectDir: string;
let xdgDir: string;
let originalXdg: string | undefined;

before(() => {
  // Sandbox both global (via XDG_CONFIG_HOME) and project paths so
  // these tests can't pollute the user's real config.
  originalXdg = process.env.XDG_CONFIG_HOME;
  xdgDir = mkdtempSync(join(tmpdir(), "hooks-xdg-"));
  process.env.XDG_CONFIG_HOME = xdgDir;
});

after(() => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  rmSync(xdgDir, { recursive: true, force: true });
});

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hooks-project-"));
  // Wipe the sandboxed global settings between tests so tests don't
  // see each other's writes.
  const gp = globalSettingsPath();
  if (existsSync(gp)) rmSync(gp, { force: true });
});

describe("loadHooksSettings", () => {
  it("returns empty hooks when no settings files exist", () => {
    const cfg = loadHooksSettings(projectDir);
    assert.deepStrictEqual(cfg, { hooks: {} });
  });

  it("loads + normalizes a project settings file", () => {
    mkdirSync(join(projectDir, ".kimiflare"), { recursive: true });
    writeFileSync(
      projectSettingsPath(projectDir),
      JSON.stringify({
        hooks: {
          Stop: [{ command: "printf '\\a'", description: "bell" }],
        },
      }),
      "utf8",
    );
    const cfg = loadHooksSettings(projectDir);
    assert.strictEqual(cfg.hooks?.Stop?.length, 1);
    assert.strictEqual(cfg.hooks!.Stop![0]!.enabled, true);
    assert.strictEqual(cfg.hooks!.Stop![0]!.source, "project");
    assert.strictEqual(typeof cfg.hooks!.Stop![0]!.id, "string");
  });

  it("drops malformed hook entries silently", () => {
    mkdirSync(join(projectDir, ".kimiflare"), { recursive: true });
    writeFileSync(
      projectSettingsPath(projectDir),
      JSON.stringify({
        hooks: {
          Stop: [
            { command: "good" },
            { description: "no command" },
            null,
            "not-an-object",
          ],
        },
      }),
      "utf8",
    );
    const cfg = loadHooksSettings(projectDir);
    assert.strictEqual(cfg.hooks?.Stop?.length, 1);
    assert.strictEqual(cfg.hooks!.Stop![0]!.command, "good");
  });

  it("does not crash on invalid JSON", () => {
    mkdirSync(join(projectDir, ".kimiflare"), { recursive: true });
    writeFileSync(projectSettingsPath(projectDir), "{not valid json", "utf8");
    const cfg = loadHooksSettings(projectDir);
    assert.deepStrictEqual(cfg, { hooks: {} });
  });

  it("merges global + project (project entries listed after global)", () => {
    mkdirSync(join(xdgDir, "kimiflare"), { recursive: true });
    writeFileSync(
      globalSettingsPath(),
      JSON.stringify({
        hooks: {
          Stop: [{ command: "global-bell" }],
        },
      }),
      "utf8",
    );
    mkdirSync(join(projectDir, ".kimiflare"), { recursive: true });
    writeFileSync(
      projectSettingsPath(projectDir),
      JSON.stringify({
        hooks: {
          Stop: [{ command: "project-bell" }],
        },
      }),
      "utf8",
    );
    const cfg = loadHooksSettings(projectDir);
    assert.strictEqual(cfg.hooks?.Stop?.length, 2);
    assert.strictEqual(cfg.hooks!.Stop![0]!.source, "global");
    assert.strictEqual(cfg.hooks!.Stop![0]!.command, "global-bell");
    assert.strictEqual(cfg.hooks!.Stop![1]!.source, "project");
    assert.strictEqual(cfg.hooks!.Stop![1]!.command, "project-bell");
  });

  it("preserves explicit enabled=false", () => {
    mkdirSync(join(projectDir, ".kimiflare"), { recursive: true });
    writeFileSync(
      projectSettingsPath(projectDir),
      JSON.stringify({
        hooks: { Stop: [{ command: "x", enabled: false }] },
      }),
      "utf8",
    );
    const cfg = loadHooksSettings(projectDir);
    assert.strictEqual(cfg.hooks?.Stop?.[0]?.enabled, false);
  });
});

describe("legacy recommended guards", () => {
  it("loads the old exit-1 commands as the current exit-2 ones, keeping their id", () => {
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    const [oldCommand] = [...LEGACY_RECOMMENDED_COMMANDS.keys()];
    assert.match(oldCommand!, /exit 1/);
    writeFileSync(
      settingsFile,
      JSON.stringify({ hooks: { PreToolUse: [{ id: "block-env-file-writes", matcher: "^(edit|write)$", command: oldCommand }] } }),
      "utf8",
    );
    const hook = loadHooksSettings(projectDir).hooks!.PreToolUse![0]!;
    assert.strictEqual(hook.id, "block-env-file-writes");
    assert.strictEqual(hook.command, getRecommendedHook("block-env-file-writes")!.hook.command);
    assert.match(hook.command, />&2; exit 2/);
  });
});

describe("deriveHookId", () => {
  it("is stable across runs", () => {
    assert.strictEqual(
      deriveHookId("Stop", "printf '\\a'"),
      deriveHookId("Stop", "printf '\\a'"),
    );
  });

  it("varies with event + command", () => {
    assert.notStrictEqual(
      deriveHookId("Stop", "x"),
      deriveHookId("PreToolUse", "x"),
    );
    assert.notStrictEqual(
      deriveHookId("Stop", "a"),
      deriveHookId("Stop", "b"),
    );
  });

  it("is 8 hex chars", () => {
    assert.match(deriveHookId("Stop", "x"), /^[0-9a-f]{8}$/);
  });
});

describe("appendHook + setHookEnabled", () => {
  it("creates the settings file if it doesn't exist", () => {
    const path = appendHook("project", projectDir, "Stop", {
      command: "printf '\\a'",
      description: "bell",
    });
    assert.ok(existsSync(path));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.strictEqual(parsed.hooks.Stop.length, 1);
    assert.strictEqual(parsed.hooks.Stop[0].command, "printf '\\a'");
    // `source` is internal — must not bleed into the written file.
    assert.strictEqual(parsed.hooks.Stop[0].source, undefined);
  });

  it("appends to an existing settings file", () => {
    appendHook("project", projectDir, "Stop", { command: "first" });
    appendHook("project", projectDir, "Stop", { command: "second" });
    const parsed = JSON.parse(readFileSync(projectSettingsPath(projectDir), "utf8"));
    assert.strictEqual(parsed.hooks.Stop.length, 2);
    assert.strictEqual(parsed.hooks.Stop[0].command, "first");
    assert.strictEqual(parsed.hooks.Stop[1].command, "second");
  });

  it("is idempotent — repeated appendHook with same id does not duplicate", () => {
    appendHook("project", projectDir, "Stop", { id: "my-hook", command: "x", enabled: true });
    appendHook("project", projectDir, "Stop", { id: "my-hook", command: "x", enabled: true });
    appendHook("project", projectDir, "Stop", { id: "my-hook", command: "x", enabled: true });
    const parsed = JSON.parse(readFileSync(projectSettingsPath(projectDir), "utf8"));
    assert.strictEqual(parsed.hooks.Stop.length, 1);
  });

  it("appendHook updates an existing entry rather than adding a duplicate", () => {
    appendHook("project", projectDir, "Stop", { id: "my-hook", command: "old", enabled: true });
    appendHook("project", projectDir, "Stop", { id: "my-hook", command: "new", enabled: false });
    const parsed = JSON.parse(readFileSync(projectSettingsPath(projectDir), "utf8"));
    assert.strictEqual(parsed.hooks.Stop.length, 1);
    assert.strictEqual(parsed.hooks.Stop[0].command, "new");
    assert.strictEqual(parsed.hooks.Stop[0].enabled, false);
  });

  it("dedupes leftover duplicates from older bugs on next write", () => {
    // Simulate a settings.json that already contains 3 copies of the
    // same id (the pre-fix double-Enter bug). Next mutation should
    // collapse them.
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(
      settingsFile,
      JSON.stringify({
        hooks: {
          Stop: [
            { id: "dup", command: "x", enabled: true },
            { id: "dup", command: "x", enabled: true },
            { id: "dup", command: "x", enabled: true },
          ],
        },
      }),
      "utf8",
    );
    appendHook("project", projectDir, "Stop", { id: "another", command: "y", enabled: true });
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.strictEqual(parsed.hooks.Stop.length, 2);
    assert.strictEqual(parsed.hooks.Stop[0].id, "dup");
    assert.strictEqual(parsed.hooks.Stop[1].id, "another");
  });

  it("setHookEnabled flips a hook with a matching id", () => {
    appendHook("project", projectDir, "Stop", {
      id: "my-hook",
      command: "x",
      enabled: true,
    });
    const path = setHookEnabled(projectDir, "my-hook", false);
    assert.strictEqual(path, projectSettingsPath(projectDir));
    const parsed = JSON.parse(readFileSync(projectSettingsPath(projectDir), "utf8"));
    assert.strictEqual(parsed.hooks.Stop[0].enabled, false);
  });

  it("appendHook refuses (and does not touch) a settings file that isn't valid JSON", () => {
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    const broken = '{ "hooks": { "Stop": [ ] }, "theme": "dark", }\n'; // trailing comma
    writeFileSync(settingsFile, broken, "utf8");
    assert.throws(
      () => appendHook("project", projectDir, "Stop", { command: "printf '\\a'" }),
      (e: unknown) => e instanceof SettingsFileError && /not valid JSON/.test(e.message) && e.message.includes(settingsFile),
    );
    assert.strictEqual(readFileSync(settingsFile, "utf8"), broken);
  });

  it("appendHook refuses a JSON file that isn't an object, or whose hooks aren't the right shape", () => {
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    for (const body of ["[]", "null", '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
      writeFileSync(settingsFile, body, "utf8");
      assert.throws(() => appendHook("project", projectDir, "Stop", { command: "x" }), SettingsFileError, body);
      assert.strictEqual(readFileSync(settingsFile, "utf8"), body);
    }
  });

  it("appendHook keeps unrelated keys in a valid file", () => {
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ theme: "dark" }), "utf8");
    appendHook("project", projectDir, "Stop", { command: "x" });
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.strictEqual(parsed.theme, "dark");
    assert.strictEqual(parsed.hooks.Stop.length, 1);
  });

  it("setHookEnabled leaves an invalid JSON file untouched", () => {
    const settingsFile = projectSettingsPath(projectDir);
    mkdirSync(dirname(settingsFile), { recursive: true });
    writeFileSync(settingsFile, "{oops", "utf8");
    assert.strictEqual(setHookEnabled(projectDir, "anything", false), null);
    assert.strictEqual(readFileSync(settingsFile, "utf8"), "{oops");
  });

  it("setHookEnabled returns null when no hook matches", () => {
    assert.strictEqual(setHookEnabled(projectDir, "nonexistent", false), null);
  });
});

// Silence unused homedir import in some test environments.
void homedir;
