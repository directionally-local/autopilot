/**
 * Proves the test suite runs in an isolated home (scripts/test-setup.mjs) and
 * that app-dirs refuses the real home during tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { configDir, configPath, dataDir, dataPath, isAutopilotTestRun, legacyDataDirs, stateDir, statePath } from "./app-dirs.js";

function inside(root: string, path: string): boolean {
  const rel = relative(root, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("test isolation", () => {
  const root = process.env.AUTOPILOT_TEST_ROOT;

  it("runs under the temporary root from scripts/test-setup.mjs", () => {
    assert.ok(root, "AUTOPILOT_TEST_ROOT is unset: run tests with `npm test` or `npm run test:file -- <file>`");
    assert.ok(inside(realpathSync(tmpdir()), root) || inside(tmpdir(), root));
    assert.ok(!inside(userInfo().homedir, root), "the temporary root must not be inside the real home");
  });

  it("points the home, XDG and Autopilot directories inside it", () => {
    assert.ok(root);
    assert.ok(inside(root, homedir()), `os.homedir() = ${homedir()}`);
    for (const name of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "CLAUDE_CONFIG_DIR", "AUTOPILOT_SERVER_CONFIG"]) {
      const value = process.env[name];
      assert.ok(value && inside(root, value), `${name} = ${value}`);
    }
    for (const path of [configDir(), dataDir(), stateDir(), configPath("config.json"), dataPath("sessions"), statePath("runs.db"), ...legacyDataDirs()]) {
      assert.ok(inside(root, path), path);
    }
    for (const name of ["AUTOPILOT_TRACE_DIR", "AUTOPILOT_DUMP_LLM_DIR", "AUTOPILOT_REMOTES_FILE"]) {
      assert.equal(process.env[name], undefined, `${name} is inherited`);
    }
  });

  it("refuses the real home during tests", () => {
    assert.ok(isAutopilotTestRun());
    const real = userInfo().homedir;
    assert.throws(() => configDir({ HOME: real }), /must not use the real home directory/);
    assert.throws(() => stateDir({ HOME: real }), /must not use the real home directory/);
    assert.throws(() => dataDir({ XDG_DATA_HOME: join(real, ".local", "share") }), /must not use the real home directory/);
  });

  it("still accepts a test's own fake home", () => {
    const fake = mkdtempSync(join(tmpdir(), "autopilot-fake-home-"));
    try {
      assert.equal(configDir({ HOME: fake }), join(fake, ".config", "autopilot"));
      assert.equal(stateDir({ HOME: fake }), join(fake, ".local", "state", "autopilot"));
      assert.equal(dataDir({ XDG_DATA_HOME: join(fake, "data") }), join(fake, "data", "autopilot"));
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("detects a test run from NODE_ENV or the test runner, not otherwise", () => {
    assert.equal(isAutopilotTestRun({ NODE_ENV: "test" }), true);
    assert.equal(isAutopilotTestRun({ NODE_TEST_CONTEXT: "child-v8" }), true);
    assert.equal(isAutopilotTestRun({ AUTOPILOT_TEST_ROOT: "/tmp/x" }), true);
    assert.equal(isAutopilotTestRun({}), false);
  });
});
